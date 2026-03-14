import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, tool } from '@ai-sdk/provider-utils';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { convertToModelMessages, generateImage, generateText, stepCountIs, streamText, embedMany } from 'ai';
import { experimental_generateVideo as generateVideo } from 'ai';
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { experimental_transcribe as transcribe } from 'ai';
import { createFallback } from 'ai-fallback';
import { createPollinations } from 'ai-sdk-pollinations';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-provider, x-channel, x-admin-key',
};

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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/favicon.ico') {
        return withCors(new Response(null, { status: 204 }));
      }

      if (routeRequiresAdminAuth(url.pathname)) {
        const unauthorized = requireAdminAuth(request, env);
        if (unauthorized) {
          return withCors(unauthorized);
        }
      }

      if (url.pathname === '/healthz') {
        return withCors(jsonResponse(buildHealth(env)));
      }

      if (url.pathname.startsWith('/api')) {
        return withCors(await api({ request, env, url }));
      }

      if (url.pathname.startsWith('/v1')) {
        return withCors(await v1({ request, env, url }));
      }

      return withCors(jsonResponse({ error: { message: 'Not Found' } }, 404));
    } catch (error) {
      console.error('Unhandled worker error', error);
      return withCors(
        jsonResponse(
          { error: { message: error instanceof Error ? error.message : 'Internal Server Error' } },
          500,
        ),
      );
    }
  },
};

async function api({ request, env, url }) {
  const body = await safeReadJson(request);

  if (!isPlainObject(body)) {
    throw new Error('Request body must be a JSON object.');
  }

  rejectUnsupportedAiSdkOptions(body);

  const path = url.pathname.replace(/^\/api/, '') || '/';

  if (request.method === 'POST' && path === '/generate') {
    return handleGenerateRequest({ body, env, request, url });
  }

  if (request.method === 'POST' && path === '/stream') {
    return handleStreamRequest({ body, env, request, url });
  }

  return jsonResponse({ error: { message: `Unsupported API route: ${path}` } }, 404);
}

async function v1({ request, env, url }) {
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    return jsonResponse({ object: 'list', data: buildModelList(env) });
  } else if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await safeReadJson(request);
    return handleStreamRequest({ body, env, request, url });
  }
  return jsonResponse({ error: { message: `Unsupported API route: ${url.pathname}` } }, 404);
}

async function handleGenerateRequest({ body, env, url }) {
  try {
    const orderedCandidates = resolveChannels({
      env,
      model: body?.model || url.searchParams.get('model')
    });

    if (0 == orderedCandidates.length) {
      return jsonResponse({ error: { message: `No channel supports model \`${body?.model || 'unknown'}\`.` } }, 400);
    }

    let chatCall;
    let nonChatCall;

    for (const candidate of orderedCandidates) {
      try {
        const call = candidate.callType === CALL_TYPES.CHAT
          ? (chatCall ??= await buildAiSdkRequest(body, { includeServerFetchTool: true }))
          : (nonChatCall ??= await buildAiSdkRequest(body));
        let result;
        switch (candidate.callType) {
          case CALL_TYPES.IMAGE_GEN:
            result = await generateImage({ model: candidate.languageModel, ...call });
            break;
          case CALL_TYPES.VIDEO_GEN:
            result = await generateVideo({ model: candidate.languageModel, ...call });
            break;
          case CALL_TYPES.AUDIO_GEN:
            result = await generateSpeech({ model: candidate.languageModel, ...call });
            break;
          case CALL_TYPES.EMBEDDING:
            result = await embedMany({ model: candidate.languageModel, ...call });
            break;
          case CALL_TYPES.TRANSCRIBE:
            result = await transcribe({ model: candidate.languageModel, ...call });
            break;
          case CALL_TYPES.CHAT:
          default:
            result = await generateText({ model: candidate.languageModel, ...call });
            break;
        }
        return new Response(
          JSON.stringify(result),
          {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=UTF-8',
              'x-gateway-channel': candidate.key,
              'x-gateway-provider': candidate.provider,
              'x-gateway-model': candidate.model || '',
            },
          },
        );
      } catch (error) {
        console.warn('Language model failover triggered', {
          channel: candidate.provider,
          modelId: candidate.model,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return jsonResponse({ error: { message: `Failed for model \`${body?.model || 'unknown'}\`.` } }, 500);
  } catch (error) {
    return jsonResponse({ error: { message: error instanceof Error ? error.message : 'Bad Request' } }, 400);
  }
}

async function handleStreamRequest({ body, env, url }) {
  try {
    const orderedCandidates = resolveChannels({
      env,
      model: body?.model || url.searchParams.get('model')
    });

    const resolved = buildActiveModelCandidate(...orderedCandidates);
    if (!resolved.languageModel || !resolved.model) {
      throw new Error(`No AI SDK channel resolved for model \`${resolved.model || 'unknown'}\`.`);
    }
    const call = await buildAiSdkRequest(body, { includeServerFetchTool: true });
    const result = streamText({ model: resolved.languageModel, ...call });
    return result.toUIMessageStreamResponse({
      headers: {
        'x-gateway-channel': resolved.channel,
        'x-gateway-provider': resolved.provider,
        'x-gateway-model': resolved.model || '',
      },
      messageMetadata: ({ part }) => {
        if (part.type === 'finish') {
          return { usage: part.totalUsage, finishReason: part.finishReason };
        }
      },
    });
  } catch (error) {
    return jsonResponse({ error: { message: error instanceof Error ? error.message : 'Bad Request' } }, 400);
  }
}

async function buildAiSdkRequest(body, options = {}) {
  const tools = buildRequestTools(body?.tools, options);

  return compactObject({
    system: body?.system,
    prompt: body?.prompt ?? body?.input,
    messages: body.messages ? convertToModelMessages(body.messages, { tools }) : undefined,
    tools,
    stopWhen: buildRequestStopWhen(options),
    toolChoice: normalizeToolChoice(body.toolChoice ?? body?.tool_choice),
    activeTools: normalizeActiveTools(body.activeTools ?? body?.active_tools),
    headers: isPlainObject(body?.headers) ? sanitizeRequestHeaders(body.headers) : undefined,
    providerOptions: isPlainObject(body?.providerOptions ?? body?.provider_options)
      ? (body.providerOptions ?? body.provider_options)
      : undefined,
    temperature: toNumber(body?.temperature),
    topP: toNumber(body?.topP ?? body?.top_p),
    topK: toInteger(body?.topK ?? body?.top_k),
    maxOutputTokens: toInteger(body?.maxOutputTokens ?? body?.max_tokens ?? body?.maxTokens),
    presencePenalty: toNumber(body?.presencePenalty ?? body?.presence_penalty),
    frequencyPenalty: toNumber(body?.frequencyPenalty ?? body?.frequency_penalty),
    stopSequences: normalizeStopSequences(body?.stopSequences ?? body?.stop_sequences ?? body?.stop),
    seed: toInteger(body?.seed),
    n: toInteger(body?.n),
    maxImagesPerCall: toInteger(body?.maxImagesPerCall ?? body?.max_images_per_call),
    size: firstString(body?.size),
    aspectRatio: firstString(body?.aspectRatio, body?.aspect_ratio),
    maxVideosPerCall: toInteger(body?.maxVideosPerCall ?? body?.max_videos_per_call),
    resolution: firstString(body?.resolution),
    duration: toNumber(body?.duration),
    fps: toNumber(body?.fps),
    text: firstString(body?.text),
    voice: firstString(body?.voice),
    outputFormat: firstString(body?.outputFormat, body?.output_format),
    instructions: firstString(body?.instructions),
    speed: toNumber(body?.speed),
    language: firstString(body?.language),
    values: Array.isArray(body?.values) ? body.values.map((value) => String(value)) : undefined,
    maxParallelCalls: toInteger(body?.maxParallelCalls ?? body?.max_parallel_calls),
    audio: typeof body?.audio === 'string' ? new URL(body.audio) : body?.audio,
    maxRetries: toInteger(body?.maxRetries ?? body?.max_retries),
    timeout: normalizeTimeout(body?.timeout),
  });
}

function buildDeclarativeTools(value) {
  if (value == null) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    throw new Error('`tools` must be an object keyed by tool name.');
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, definition]) => [name, buildDeclarativeTool(name, definition)]),
  );
}

function buildRequestTools(value, options = {}) {
  const tools = buildDeclarativeTools(value);

  if (!options.includeServerFetchTool) {
    return tools;
  }

  return {
    ...(tools || {}),
    fetch: buildServerFetchTool(),
  };
}

function buildRequestStopWhen(options = {}) {
  if (!options.includeServerFetchTool) {
    return undefined;
  }

  return stepCountIs(5);
}

function buildServerFetchTool() {
  return tool({
    description: 'Fetch an HTTP or HTTPS URL and return the response status, headers, and body.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        body: {},
      },
      required: ['url'],
      additionalProperties: false,
    }),
    outputSchema: jsonSchema({
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        url: { type: 'string' },
        status: { type: 'number' },
        statusText: { type: 'string' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        body: {},
      },
      required: ['ok', 'url', 'status', 'statusText', 'headers', 'body'],
      additionalProperties: false,
    }),
    execute: executeServerFetchTool,
  });
}

function buildDeclarativeTool(name, definition) {
  if (!name.trim()) {
    throw new Error('Tool names must be non-empty strings.');
  }

  if (!isPlainObject(definition)) {
    throw new Error(`\`tools.${name}\` must be an object.`);
  }

  if ('execute' in definition || 'toModelOutput' in definition) {
    throw new Error(`\`tools.${name}\` must be declarative JSON only. Runtime functions are not supported on \`/api\` routes.`);
  }

  const inputSchema = normalizeJsonSchema(definition.inputSchema, `tools.${name}.inputSchema`);
  const outputSchema = normalizeJsonSchema(definition.outputSchema, `tools.${name}.outputSchema`);

  return tool(
    compactObject({
      title: firstString(definition.title),
      description: firstString(definition.description),
      providerOptions: isPlainObject(definition.providerOptions) ? definition.providerOptions : undefined,
      inputSchema: jsonSchema(inputSchema),
      inputExamples: Array.isArray(definition.inputExamples) ? definition.inputExamples : undefined,
      needsApproval: typeof definition.needsApproval === 'boolean' ? definition.needsApproval : undefined,
      strict: typeof definition.strict === 'boolean' ? definition.strict : undefined,
      outputSchema: jsonSchema(outputSchema),
    }),
  );
}

function normalizeJsonSchema(schema, label) {
  if (isPlainObject(schema)) {
    return schema;
  }

  throw new Error(`\`${label}\` must be a JSON schema object.`);
}

async function executeServerFetchTool(input, options = {}) {
  if (!isPlainObject(input)) {
    throw new Error('`tools.fetch` input must be a JSON object.');
  }

  const url = firstString(input.url);
  if (!url) {
    throw new Error('`tools.fetch.url` must be a non-empty string.');
  }

  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('`tools.fetch.url` must use `http:` or `https:`.');
  }

  const method = String(firstString(input.method) || (input.body === undefined ? 'GET' : 'POST')).toUpperCase();
  const headers = sanitizeHeaders(input.headers);
  const init = {
    method,
    headers,
    signal: options.abortSignal,
  };

  if (canHaveRequestBody(method) && input.body !== undefined) {
    init.body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
    if (typeof input.body !== 'string' && headers['content-type'] == null) {
      init.headers = { ...headers, 'content-type': 'application/json' };
    }
  }

  try {
    const response = await fetch(target, init);

    return {
      ok: response.ok,
      url: response.url || target.toString(),
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: await readFetchToolResponseBody(response),
    };
  } catch (error) {
    return {
      ok: false,
      url: target.toString(),
      status: 404,
      statusText: 'Failed',
      headers: {},
      body: String(error),
    };
  }
}

async function readFetchToolResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return await response.clone().json();
    } catch {
      // fall through to text body below.
    }
  }

  return response.text();
}

function normalizeToolChoice(value) {
  if (value == null) {
    return undefined;
  }

  if (typeof value === 'string' || isPlainObject(value)) {
    return value;
  }

  throw new Error('`toolChoice` must be a string or an object.');
}

function normalizeActiveTools(value) {
  if (value == null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error('`activeTools` must be an array of tool names.');
  }

  return value.map((name) => String(name).trim());
}

function normalizeTimeout(value) {
  if (value == null) {
    return undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (!isPlainObject(value)) {
    throw new Error('`timeout` must be a number or an object with `totalMs`, `stepMs`, or `chunkMs`.');
  }

  const timeout = compactObject({
    totalMs: toInteger(value.totalMs),
    stepMs: toInteger(value.stepMs),
    chunkMs: toInteger(value.chunkMs),
  });

  if (Object.keys(timeout).length === 0) {
    throw new Error('`timeout` must include at least one of `totalMs`, `stepMs`, or `chunkMs`.');
  }

  return timeout;
}

function rejectUnsupportedAiSdkOptions(body) {
  const unsupportedOptions = ['output', 'experimental_output', 'stopWhen', 'prepareStep', 'experimental_prepareStep', 'experimental_download', 'abortSignal'];

  for (const key of unsupportedOptions) {
    if (key in body) {
      throw new Error(`\`${key}\` is not supported on \`/api\` routes because it requires non-JSON runtime behavior.`);
    }
  }
}

function buildResolvedChannel(channel, model) {
  const provider = String(firstString(channel?.provider) || '').toLowerCase();
  const defaults = DEFAULT_PROVIDER_CATALOG[provider] || DEFAULT_PROVIDER_CATALOG[provider] || {};
  const callType = firstString(model?.callType) || CALL_TYPES.CHAT;
  const finalModelCode = firstString(model.code) || '';
  const key = firstString(channel?.key) || '';
  const baseURL = normalizeBaseURL(firstString(channel?.baseURL) || defaults.baseURL || '');
  const apiKey = firstString(channel?.apiKey) || '';
  const headers = sanitizeHeaders(channel?.headers);
  const languageModel = finalModelCode
    ? instantiateLanguageModel(
      { name: key, provider, baseURL, apiKey, callType, headers, },
      finalModelCode,
    )
    : null;

  return { key, provider, model: finalModelCode, callType, baseURL, apiKey, headers, languageModel, };
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
    throw new Error(`No candidates provided.`);
  }
  const languageModel = buildLanguageModelWithFailover(candidates);
  const getActiveCandidate = () => getActiveResolvedCandidate(candidates, languageModel);

  return {
    languageModel,
    get channel() {
      return getActiveCandidate().key;
    },
    get provider() {
      return getActiveCandidate().provider;
    },
    get model() {
      return getActiveCandidate().model;
    },
    get baseURL() {
      return getActiveCandidate().baseURL;
    },
    get apiKey() {
      return getActiveCandidate().apiKey;
    },
    get headers() {
      return getActiveCandidate().headers;
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
      console.warn('Language model failover triggered', {
        channel: fallback.provider,
        modelId,
        message: error instanceof Error ? error.message : String(error),
      });
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
  const channelKey = provider?.split(".")[0] || provider;
  return candidates.find((candidate) => candidate.key === channelKey && candidate.model === activeModel);
}

function shuffleArray(items, random = Math.random) {
  const shuffled = [...items];

  for (let index = 0; index < shuffled.length; index += 1) {
    const nextIndex = Math.floor(random() * (shuffled.length));
    [shuffled[index], shuffled[nextIndex]] = [shuffled[nextIndex], shuffled[index]];
  }

  return shuffled;
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
          return provider.audio(model);
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

function getGatewayConfig(env) {
  const rawConfig = firstString(env?.GATEWAY_CONFIG_JSON);

  if (!rawConfig) {
    throw new Error('Missing `GATEWAY_CONFIG_JSON`. Set the complete gateway configuration JSON in this environment variable.');
  }

  try {
    return JSON.parse(rawConfig);
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

function lowerCaseModelId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeStopSequences(value) {
  if (typeof value === 'string' && value.trim()) {
    return [value];
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => String(item || '').trim()).filter(Boolean);
    return items.length ? items : undefined;
  }

  return undefined;
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

function sanitizeRequestHeaders(value) {
  const disallowed = new Set(['authorization', 'api-key', 'x-api-key', 'cookie', 'x-admin-key', 'x-admin-token']);

  return Object.fromEntries(
    Object.entries(sanitizeHeaders(value)).filter(([key]) => !disallowed.has(key.toLowerCase())),
  );
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function routeRequiresAdminAuth(pathname) {
  return pathname === '/healthz' || pathname.startsWith('/api') || pathname.startsWith('/v1');
}

function requireAdminAuth(request, env) {
  const expectedAdminKey = getAdminKey(env);
  const providedAdminKey = getRequestAdminKey(request);

  if (providedAdminKey && providedAdminKey === expectedAdminKey) {
    return null;
  }

  return jsonResponse(
    {
      error: {
        message: 'Unauthorized. Provide `Authorization: Bearer <adminKey>` or `x-admin-key`.',
      },
    },
    401,
  );
}

function getAdminKey(env) {
  const adminKey = firstString(env?.ADMIN_KEY);

  if (!adminKey) {
    throw new Error('Missing `ADMIN_KEY`. Set the gateway admin key in this top-level environment variable.');
  }

  return adminKey;
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

function toNumber(value) {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toInteger(value) {
  if (value == null || value === '') return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function normalizeBaseURL(baseURL) {
  return String(baseURL || '').replace(/\/+$/, '');
}

function canHaveRequestBody(method) {
  return !['GET', 'HEAD'].includes(method.toUpperCase());
}

function jsonResponse(data, status = 200) {
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


export { api, buildAiSdkRequest, buildModelList, v1 };