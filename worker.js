import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { embedMany, generateImage, generateText, streamText } from 'ai';
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { experimental_generateVideo as generateVideo } from 'ai';
import { experimental_transcribe as transcribe } from 'ai';
import { createFallback } from 'ai-fallback';
import { createPollinations } from 'ai-sdk-pollinations';
import { extractMediaResources } from './media-utils.js';

/**
 * Single-file gateway organization:
 * 1) constants / JSDoc typedefs
 * 2) common + HTTP/auth helpers
 * 3) config / channel / provider resolution
 * 4) protocol adapters
 * 5) core execution helpers
 * 6) route handlers + fetch entrypoint
 */

/**
 * @typedef {{ ADMIN_KEY?: string, GATEWAY_CONFIG_JSON?: string }} GatewayEnv
 * @typedef {{ code?: string, aliases?: string[], callType?: string }} GatewayModel
 * @typedef {{ key?: string, provider?: string, apiKey?: string, baseURL?: string, headers?: Record<string, unknown>, models?: GatewayModel[] }} GatewayChannel
 * @typedef {{ channels?: GatewayChannel[] }} GatewayConfig
 * @typedef {{ key: string, provider: string, model: string, callType: string, baseURL: string, apiKey: string, headers: Record<string, string>, languageModel: unknown }} ResolvedCandidate
 */

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-provider, x-channel, x-admin-key',
};

const PROTECTED_PATH_PREFIXES = ['/healthz', '/v1', '/vercel'];

const CALL_TYPES = Object.freeze({
  CHAT: 'chat',
  IMAGE_GEN: 'image_gen',
  VIDEO_GEN: 'video_gen',
  AUDIO_GEN: 'audio_gen',
  EMBEDDING: 'embedding',
  TRANSCRIBE: 'transcribe',
});

const DEFAULT_PROVIDER_CATALOG = {
  openai: { kind: 'openai', baseURL: 'https://api.openai.com/v1' },
  openrouter: { kind: 'openrouter', baseURL: 'https://openrouter.ai/api/v1' },
  google: { kind: 'google', baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  gemini: { kind: 'google', baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  anthropic: { kind: 'anthropic', baseURL: 'https://api.anthropic.com/v1' },
  claude: { kind: 'anthropic', baseURL: 'https://api.anthropic.com/v1' },
  pollinations: { kind: 'pollinations', baseURL: 'https://text.pollinations.ai/openai' },
  deepseek: { kind: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1' },
  groq: { kind: 'openai-compatible', baseURL: 'https://api.groq.com/openai/v1' },
  together: { kind: 'openai-compatible', baseURL: 'https://api.together.xyz/v1' },
  moonshot: { kind: 'openai-compatible', baseURL: 'https://api.moonshot.cn/v1' },
  siliconflow: { kind: 'openai-compatible', baseURL: 'https://api.siliconflow.cn/v1' },
  xai: { kind: 'openai-compatible', baseURL: 'https://api.x.ai/v1' },
};

let cachedGatewayConfigJson;
let cachedGatewayConfig;

// -------------------------- common helpers

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function lowerCaseModelId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function sanitizeHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, headerValue]) => headerValue != null)
      .map(([key, headerValue]) => [key, String(headerValue)]),
  );
}

function normalizeBaseURL(baseURL) {
  return String(baseURL || '').replace(/\/+$/, '');
}

function shuffleArray(items, random = Math.random) {
  const shuffled = [...items];

  for (let index = 0; index < shuffled.length; index += 1) {
    const nextIndex = Math.floor(random() * shuffled.length);
    [shuffled[index], shuffled[nextIndex]] = [shuffled[nextIndex], shuffled[index]];
  }

  return shuffled;
}

function getRequestedModel(body, url) {
  return body?.model || url.searchParams.get('model');
}

function logRequest(request) {
  console.info('request', request.url);
}

function logFailover(channelKey, modelID, error) {
  console.warn('Language model failover triggered', {
    channel: channelKey,
    modelId: modelID,
    message: error instanceof Error ? error.message : String(error),
  });
}

// -------------------------- HTTP + auth helpers

function canHaveRequestBody(method) {
  return !['GET', 'HEAD'].includes(method.toUpperCase());
}

async function safeReadJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json') || !canHaveRequestBody(request.method)) {
    return null;
  }

  try {
    return await request.clone().json();
  } catch {
    return null;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function routeRequiresAdminAuth(pathname) {
  return PROTECTED_PATH_PREFIXES.some((path) => pathname.startsWith(path));
}

function getRequestAdminKey(request) {
  const headerAdminKey = firstString(request.headers.get('x-admin-key'));
  if (headerAdminKey) {
    return headerAdminKey;
  }

  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? firstString(match[1]) : undefined;
}

function getAdminKey(env) {
  const adminKey = firstString(env?.ADMIN_KEY);

  if (!adminKey) {
    throw new Error('Missing `ADMIN_KEY`. Set the gateway admin key in this top-level environment variable.');
  }

  return adminKey;
}

function requireAdminAuth(request, env) {
  const expectedAdminKey = getAdminKey(env);
  const providedAdminKey = getRequestAdminKey(request);

  if (providedAdminKey && providedAdminKey === expectedAdminKey) {
    return null;
  }

  return json(
    {
      error: {
        message: 'Unauthorized. Provide `Authorization: Bearer <adminKey>` or `x-admin-key`.',
      },
    },
    401,
  );
}

function invalidRequestErrorResponse(error, fallbackMessage = 'Bad Request') {
  return json(
    {
      error: {
        message: error instanceof Error ? error.message : fallbackMessage,
        type: 'invalid_request_error',
      },
    },
    400,
  );
}

function unsupportedApiRouteResponse(pathname) {
  return json(
    {
      error: {
        message: `Unsupported API route: ${pathname}`,
        type: 'invalid_request_error',
      },
    },
    404,
  );
}

function notFoundResponse() {
  return json({ error: { message: 'Not Found' } }, 404);
}

function internalServerErrorResponse(error) {
  return json(
    {
      error: {
        message: error instanceof Error ? error.message : 'Internal Server Error',
      },
    },
    500,
  );
}

// -------------------------- config / channel / provider resolution

function getGatewayConfig(env) {
  const rawConfig = firstString(env?.GATEWAY_CONFIG_JSON);

  if (!rawConfig) {
    throw new Error('Missing `GATEWAY_CONFIG_JSON`. Set the complete gateway configuration JSON in this environment variable.');
  }

  if (rawConfig === cachedGatewayConfigJson && cachedGatewayConfig) {
    return cachedGatewayConfig;
  }

  try {
    cachedGatewayConfig = JSON.parse(rawConfig);
    cachedGatewayConfigJson = rawConfig;
    return cachedGatewayConfig;
  } catch {
    throw new Error('`GATEWAY_CONFIG_JSON` must be valid JSON.');
  }
}

function buildModelList(env) {
  const gatewayConfig = getGatewayConfig(env);
  const channels = Array.isArray(gatewayConfig?.channels) ? gatewayConfig.channels : [];
  const data = [];
  const seen = new Set();

  for (const channel of channels) {
    for (const model of Array.isArray(channel?.models) ? channel.models : []) {
      const code = firstString(model?.code);
      const key = lowerCaseModelId(code);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      data.push({
        id: code,
        object: 'model',
        owned_by: 'gateway',
      });
    }
  }

  return data;
}

function buildHealth(env) {
  const gatewayConfig = getGatewayConfig(env);
  const channels = Array.isArray(gatewayConfig?.channels) ? gatewayConfig.channels : [];
  return {
    ok: channels.length > 0,
    timestamp: new Date().toISOString(),
    channelCount: channels.length,
    providerTypes: [...new Set(channels.map((channel) => firstString(channel?.provider)).filter(Boolean))],
  };
}

function buildResolvedChannel(channel, model) {
  const provider = String(firstString(channel?.provider) || '').toLowerCase();
  const defaults = DEFAULT_PROVIDER_CATALOG[provider] || {};
  const callType = firstString(model?.callType) || CALL_TYPES.CHAT;
  const finalModelCode = firstString(model?.code) || '';
  const key = firstString(channel?.key) || '';
  const baseURL = normalizeBaseURL(firstString(channel?.baseURL) || defaults.baseURL || '');
  const apiKey = firstString(channel?.apiKey) || '';
  const headers = sanitizeHeaders(channel?.headers);
  const languageModel = finalModelCode
    ? instantiateLanguageModel(
      { name: key, provider, baseURL, apiKey, callType, headers },
      finalModelCode,
    )
    : null;

  return {
    key,
    provider,
    model: finalModelCode,
    callType,
    baseURL,
    apiKey,
    headers,
    languageModel,
  };
}

function resolveChannels({ env, model, random = Math.random }) {
  const requestedModel = firstString(model);
  const gatewayConfig = getGatewayConfig(env);
  const channels = Array.isArray(gatewayConfig?.channels) ? gatewayConfig.channels : [];
  const requestedId = lowerCaseModelId(requestedModel);

  if (!requestedModel) {
    throw new Error('`model` is required.');
  }

  if (channels.length === 0) {
    throw new Error('No channels configured in `GATEWAY_CONFIG_JSON`.');
  }

  const orderedCandidates = shuffleArray(
    channels.flatMap((channel) => {
      const matchedModel = (Array.isArray(channel?.models) ? channel.models : []).find((candidate) => {
        const code = firstString(candidate?.code);
        if (!code) return false;

        return [code, ...(Array.isArray(candidate?.aliases) ? candidate.aliases : [])].some(
          (value) => lowerCaseModelId(value) === requestedId,
        );
      });

      return matchedModel ? [buildResolvedChannel(channel, matchedModel)] : [];
    }),
    random,
  );

  if (orderedCandidates.length === 0) {
    throw new Error(`No channel supports model \`${requestedModel}\`.`);
  }

  return orderedCandidates;
}

function buildActiveModelCandidate(...candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { languageModel: null, candidate: null };
  }

  const languageModel = buildLanguageModelWithFailover(candidates);

  return {
    languageModel,
    get candidate() {
      return getActiveResolvedCandidate(candidates, languageModel);
    },
  };
}

function buildLanguageModelWithFailover(candidates) {
  const languageModels = candidates.map((candidate) => candidate.languageModel).filter(Boolean);

  if (languageModels.length === 0) {
    return null;
  }

  if (languageModels.length === 1) {
    return languageModels[0];
  }

  let fallback;
  fallback = createFallback({
    models: languageModels,
    shouldRetryThisError: () => true,
    onError(error, modelId) {
      logFailover(fallback.provider, modelId, error);
    },
  });

  return fallback;
}

function getActiveResolvedCandidate(candidates, languageModel) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const provider = firstString(languageModel?.provider);
  const activeModel = firstString(languageModel?.modelId);
  const channelKey = provider?.split('.')[0] || provider;
  return candidates.find((candidate) => candidate.key === channelKey && candidate.model === activeModel);
}

function instantiateLanguageModel(config, model) {
  const apiKey = config.apiKey || undefined;
  const baseURL = config.baseURL ? normalizeBaseURL(config.baseURL) : undefined;
  const headers = sanitizeHeaders(config.headers);
  const callType = firstString(config.callType) || CALL_TYPES.CHAT;

  const unsupportedCallType = () => {
    throw new Error(`Provider \`${config.provider}\` does not support callType \`${callType}\` for model \`${model}\`.`);
  };

  switch (config.provider) {
    case 'gemini':
    case 'google': {
      const provider = createGoogleGenerativeAI({ apiKey, baseURL, headers, name: config.name });
      switch (callType) {
        case CALL_TYPES.IMAGE_GEN:
          return provider.image(model);
        case CALL_TYPES.VIDEO_GEN:
          return provider.video(model);
        case CALL_TYPES.AUDIO_GEN:
        case CALL_TYPES.CHAT:
          return provider.chat(model);
        case CALL_TYPES.EMBEDDING:
          return provider.embedding(model);
        default:
          return unsupportedCallType();
      }
    }

    case 'claude':
    case 'anthropic': {
      const provider = createAnthropic({ apiKey, baseURL, headers, name: config.name });
      switch (callType) {
        case CALL_TYPES.CHAT:
          return provider.chat(model);
        case CALL_TYPES.EMBEDDING:
          return provider.embeddingModel(model);
        default:
          return unsupportedCallType();
      }
    }

    case 'openrouter': {
      const provider = createOpenRouter({ apiKey, baseURL, headers, name: config.name });
      switch (callType) {
        case CALL_TYPES.IMAGE_GEN:
          return provider.imageModel(model);
        case CALL_TYPES.CHAT:
          return provider.chat(model);
        case CALL_TYPES.EMBEDDING:
          return provider.textEmbeddingModel(model);
        default:
          return unsupportedCallType();
      }
    }

    case 'pollinations': {
      const provider = createPollinations({ apiKey, baseURL, headers, name: config.name });
      switch (callType) {
        case CALL_TYPES.IMAGE_GEN:
          return provider.image(model);
        case CALL_TYPES.AUDIO_GEN:
          return provider.speechModel(model);
        case CALL_TYPES.CHAT:
          return provider.chat(model);
        default:
          return unsupportedCallType();
      }
    }

    case 'openai':
    case 'openai-compatible':
    default: {
      const provider = createOpenAI({ apiKey, baseURL, headers, name: config.name });
      switch (callType) {
        case CALL_TYPES.IMAGE_GEN:
          return provider.image(model);
        case CALL_TYPES.AUDIO_GEN:
          return provider.speech(model);
        case CALL_TYPES.CHAT:
          return provider.chat(model);
        case CALL_TYPES.EMBEDDING:
          return provider.embedding(model);
        case CALL_TYPES.TRANSCRIBE:
          return provider.transcription(model);
        default:
          return unsupportedCallType();
      }
    }
  }
}

// -------------------------- protocol adapters

function mapOpenAIToAISDKParams(body) {
  if (!body) return {};

  const params = {};
  if (body.messages) params.messages = body.messages;
  if (body.temperature != null) params.temperature = body.temperature;
  if (body.max_tokens != null) params.maxTokens = body.max_tokens;
  if (body.max_completion_tokens != null) params.maxTokens = body.max_completion_tokens;
  if (body.top_p != null) params.topP = body.top_p;
  if (body.frequency_penalty != null) params.frequencyPenalty = body.frequency_penalty;
  if (body.presence_penalty != null) params.presencePenalty = body.presence_penalty;
  if (body.seed != null) params.seed = body.seed;
  if (body.stop != null) {
    params.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }

  return params;
}

function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'content_filter';
    case 'tool-calls':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

function mapUsage(usage) {
  if (!usage) {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }

  const promptTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
  const completionTokens = usage.completionTokens ?? usage.outputTokens ?? 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens ?? (promptTokens + completionTokens),
  };
}

function sseChunk(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function openAIStreamResponse({ result, completionId, created, modelId, includeUsage }) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(sseChunk({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        })));

        for await (const text of result.textStream) {
          controller.enqueue(encoder.encode(sseChunk({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          })));
        }

        const [finishReason, usage] = await Promise.all([result.finishReason, result.usage]);
        const finalChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(finishReason) }],
        };

        if (includeUsage) {
          finalChunk.usage = mapUsage(usage);
        }

        controller.enqueue(encoder.encode(sseChunk(finalChunk)));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch {
        controller.enqueue(encoder.encode(sseChunk({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
}

// -------------------------- core execution helpers

function resolveOrderedCandidatesForRequest({ env, body, url }) {
  return resolveChannels({ env, model: getRequestedModel(body, url) });
}

function resolveActiveLanguageModel(orderedCandidates, callType) {
  const candidates = orderedCandidates.filter((candidate) => candidate.callType === callType);
  return buildActiveModelCandidate(...candidates);
}

async function generateMediaFromText({ orderedCandidates, params }) {
  const result = await handleGenerateText({ orderedCandidates, params });
  const media = await extractMediaResources({ text: result.text, files: result.files });
  return { media, result };
}

function mapTextGenerationUsage(result) {
  return {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    totalTokens: result.usage.totalTokens,
  };
}

async function handleGenerateText({ orderedCandidates, params }) {
  const resolved = resolveActiveLanguageModel(orderedCandidates, CALL_TYPES.CHAT);
  return generateText({ ...params, model: resolved.languageModel });
}

/**
 * Multi-modal generation intentionally tries generateText first.
 * Some upstream platforms and relays return media as text + url/files,
 * so this path is part of the supported behavior and not an accidental fallback.
 */
async function handleGenerateImage({ orderedCandidates, params }) {
  try {
    const { media, result } = await generateMediaFromText({ orderedCandidates, params });
    return {
      image: media[0],
      images: media,
      warnings: result.warnings ?? [],
      providerMetadata: result.providerMetadata,
      response: result.response,
      usage: mapTextGenerationUsage(result),
    };
  } catch (error) {
    console.warn('handleGenerateImage', error);
    const imageResolved = resolveActiveLanguageModel(orderedCandidates, CALL_TYPES.IMAGE_GEN);
    return generateImage({ ...params, model: imageResolved.languageModel });
  }
}

async function handleGenerateAudio({ orderedCandidates, params }) {
  try {
    const { media, result } = await generateMediaFromText({ orderedCandidates, params });
    return {
      audio: media[0],
      warnings: result.warnings ?? [],
      providerMetadata: result.providerMetadata,
      response: result.response,
    };
  } catch (error) {
    console.warn('handleGenerateAudio', error);
    const audioResolved = resolveActiveLanguageModel(orderedCandidates, CALL_TYPES.AUDIO_GEN);
    const speechResult = await generateSpeech({ ...params, model: audioResolved.languageModel });
    return {
      audio: {
        base64: speechResult.audio.base64,
        format: speechResult.audio.format,
        mediaType: speechResult.audio.mediaType,
      },
      warnings: speechResult.warnings ?? [],
      providerMetadata: speechResult.providerMetadata,
      responses: speechResult.responses,
    };
  }
}

async function handleGenerateVideo({ orderedCandidates, params }) {
  try {
    const { media, result } = await generateMediaFromText({ orderedCandidates, params });
    return {
      video: media[0],
      videos: media,
      warnings: result.warnings ?? [],
      providerMetadata: result.providerMetadata,
      response: result.response,
    };
  } catch (error) {
    console.warn('handleGenerateVideo', error);
    const videoResolved = resolveActiveLanguageModel(orderedCandidates, CALL_TYPES.VIDEO_GEN);
    return generateVideo({ ...params, model: videoResolved.languageModel });
  }
}

async function handleGenerateTranscribe({ orderedCandidates, params }) {
  try {
    const result = await handleGenerateText({ orderedCandidates, params });
    return {
      text: result.text,
      warnings: result.warnings ?? [],
      providerMetadata: result.providerMetadata,
      response: result.response,
    };
  } catch (error) {
    console.warn('handleGenerateTranscribe', error);
    const transcriptionResolved = resolveActiveLanguageModel(orderedCandidates, CALL_TYPES.TRANSCRIBE);
    return transcribe({ ...params, model: transcriptionResolved.languageModel });
  }
}

async function handleGenerateEmbedding({ orderedCandidates, params }) {
  const resolved = resolveActiveLanguageModel(orderedCandidates, CALL_TYPES.EMBEDDING);
  return embedMany({ ...params, model: resolved.languageModel });
}

// -------------------------- route handlers

async function v1({ request, env, url }) {
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    return json({ object: 'list', data: buildModelList(env) });
  }

  if (request.method !== 'POST') {
    return unsupportedApiRouteResponse(url.pathname);
  }

  const body = await safeReadJson(request);

  switch (url.pathname) {
    case '/v1/chat/completions':
      return handleV1ChatCompletions({ body, env, url });
    case '/v1/embeddings':
      return handleV1Embeddings({ body, env, url });
    case '/v1/images/generations':
      return handleV1ImageGenerations({ body, env, url });
    case '/v1/audio/speech':
      return handleV1AudioSpeech({ body, env, url });
    case '/v1/audio/transcriptions':
      return handleV1AudioTranscriptions({ body, env, url });
    default:
      return unsupportedApiRouteResponse(url.pathname);
  }
}

async function vercel({ request, env, url }) {
  if (request.method === 'GET' && url.pathname === '/vercel/models') {
    return json({ object: 'list', data: buildModelList(env) });
  }

  if (request.method === 'POST') {
    const body = await safeReadJson(request);
    const orderedCandidates = resolveOrderedCandidatesForRequest({ env, body, url });

    if (url.pathname === '/vercel/text') {
      const result = await handleGenerateText({ orderedCandidates, params: body });
      return json({
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage,
      });
    }

    if (url.pathname === '/vercel/image') {
      const result = await handleGenerateImage({ orderedCandidates, params: body });
      return json({
        image: result.image,
        images: result.images,
        usage: result.usage,
      });
    }

    if (url.pathname === '/vercel/audio') {
      const result = await handleGenerateAudio({ orderedCandidates, params: body });
      return json({ audio: result.audio });
    }

    if (url.pathname === '/vercel/video') {
      const result = await handleGenerateVideo({ orderedCandidates, params: body });
      return json({
        video: result.video,
        videos: result.videos,
      });
    }

    if (url.pathname === '/vercel/transcribe') {
      const result = await handleGenerateTranscribe({ orderedCandidates, params: body });
      return json({ text: result.text });
    }

    if (url.pathname === '/vercel/embedding') {
      const result = await handleGenerateEmbedding({ orderedCandidates, params: body });
      return json({
        values: result.values,
        embeddings: result.embeddings,
        usage: result.usage,
      });
    }
  }

  return json({ error: { message: `Unsupported API route: ${url.pathname}` } }, 404);
}

async function handleV1ChatCompletions({ body, env, url }) {
  try {
    const orderedCandidates = resolveOrderedCandidatesForRequest({ env, body, url });
    const resolved = resolveActiveLanguageModel(orderedCandidates, CALL_TYPES.CHAT);

    if (!resolved.languageModel) {
      return json({ error: { message: `No channel resolved for model \`${body?.model || 'unknown'}\`.`, type: 'invalid_request_error' } }, 400);
    }

    const aiParams = mapOpenAIToAISDKParams(body);
    const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);
    const modelId = body?.model || 'unknown';

    if (body?.stream === true) {
      const result = streamText({ ...aiParams, model: resolved.languageModel });
      return openAIStreamResponse({
        result,
        completionId,
        created,
        modelId,
        includeUsage: body?.stream_options?.include_usage,
      });
    }

    const result = await generateText({ ...aiParams, model: resolved.languageModel });
    return json({
      id: completionId,
      object: 'chat.completion',
      created,
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: mapFinishReason(result.finishReason),
      }],
      usage: mapUsage(result.usage),
    });
  } catch (error) {
    return invalidRequestErrorResponse(error);
  }
}

async function handleV1Embeddings({ body, env, url }) {
  try {
    const orderedCandidates = resolveOrderedCandidatesForRequest({ env, body, url });
    const resolved = resolveActiveLanguageModel(orderedCandidates, CALL_TYPES.EMBEDDING);

    if (!resolved.languageModel) {
      return json({ error: { message: `No channel resolved for embedding model \`${body?.model || 'unknown'}\`.`, type: 'invalid_request_error' } }, 400);
    }

    const input = body?.input;
    const values = Array.isArray(input) ? input : [input];
    const result = await embedMany({ model: resolved.languageModel, values });

    return json({
      object: 'list',
      data: result.embeddings.map((embedding, index) => ({
        object: 'embedding',
        embedding,
        index,
      })),
      model: body?.model || 'unknown',
      usage: {
        prompt_tokens: result.usage?.tokens ?? 0,
        total_tokens: result.usage?.tokens ?? 0,
      },
    });
  } catch (error) {
    return invalidRequestErrorResponse(error);
  }
}

async function handleV1ImageGenerations({ body, env, url }) {
  try {
    const orderedCandidates = resolveOrderedCandidatesForRequest({ env, body, url });
    const params = compactObject({
      ...body,
      messages: [{ role: 'user', content: body?.prompt || '' }],
      prompt: undefined,
    });
    const result = await handleGenerateImage({ orderedCandidates, params });
    const images = result.images || (result.image ? [result.image] : []);

    return json({
      created: Math.floor(Date.now() / 1000),
      data: images.map((img) => {
        if (body?.response_format === 'b64_json' || img.base64) {
          return { b64_json: img.base64 || img };
        }

        if (img.url) {
          return { url: img.url };
        }

        return { b64_json: typeof img === 'string' ? img : '' };
      }),
    });
  } catch (error) {
    return invalidRequestErrorResponse(error);
  }
}

async function handleV1AudioSpeech({ body, env, url }) {
  try {
    const orderedCandidates = resolveOrderedCandidatesForRequest({ env, body, url });
    const params = {
      text: body?.input || '',
      voice: body?.voice,
      messages: [{ role: 'user', content: body?.input || '' }],
    };
    const result = await handleGenerateAudio({ orderedCandidates, params });

    if (result.audio?.base64) {
      const binaryStr = atob(result.audio.base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i += 1) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const format = body?.response_format || 'mp3';
      return new Response(bytes, {
        headers: { 'content-type': result.audio.mediaType || `audio/${format}` },
      });
    }

    return json({ error: { message: 'Failed to generate audio', type: 'server_error' } }, 500);
  } catch (error) {
    return invalidRequestErrorResponse(error);
  }
}

async function handleV1AudioTranscriptions({ body, env, url }) {
  try {
    const orderedCandidates = resolveOrderedCandidatesForRequest({ env, body, url });
    const result = await handleGenerateTranscribe({ orderedCandidates, params: body });

    if (body?.response_format === 'text') {
      return new Response(result.text, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    return json({ text: result.text });
  } catch (error) {
    return invalidRequestErrorResponse(error);
  }
}

async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return withCors(new Response(null, { status: 204 }));
  }

  logRequest(request);
  const url = new URL(request.url);

  try {
    if (routeRequiresAdminAuth(url.pathname)) {
      const unauthorized = requireAdminAuth(request, env);
      if (unauthorized) {
        return withCors(unauthorized);
      }
    }

    if (url.pathname === '/healthz') {
      return withCors(json(buildHealth(env)));
    }

    if (url.pathname.startsWith('/v1')) {
      return withCors(await v1({ request, env, url }));
    }

    if (url.pathname.startsWith('/vercel')) {
      return withCors(await vercel({ request, env, url }));
    }

    return withCors(notFoundResponse());
  } catch (error) {
    console.error('Unhandled worker error', error);
    return withCors(internalServerErrorResponse(error));
  }
}

const worker = {
  fetch: handleRequest,
};

export default worker;

export {
  v1,
  vercel,
  buildModelList,
  buildHealth,
  buildResolvedChannel,
  canHaveRequestBody,
  compactObject,
  firstString,
  getGatewayConfig,
  getRequestAdminKey,
  getAdminKey,
  handleV1ChatCompletions,
  handleV1Embeddings,
  handleV1ImageGenerations,
  handleV1AudioSpeech,
  handleV1AudioTranscriptions,
  handleGenerateText,
  handleGenerateImage,
  handleGenerateAudio,
  handleGenerateVideo,
  handleGenerateTranscribe,
  handleGenerateEmbedding,
  json,
  lowerCaseModelId,
  mapFinishReason,
  mapOpenAIToAISDKParams,
  mapUsage,
  normalizeBaseURL,
  requireAdminAuth,
  resolveChannels,
  routeRequiresAdminAuth,
  safeReadJson,
  sanitizeHeaders,
  shuffleArray,
  withCors,
};