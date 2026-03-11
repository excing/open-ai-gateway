import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, tool } from '@ai-sdk/provider-utils';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { convertToModelMessages, generateText, streamText } from 'ai';
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
  ASR: 'asr',
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
  const path = url.pathname.replace(/^\/api/, '') || '/';

  if (request.method === 'POST' && path === '/generate') {
    const body = await safeReadJson(request);
    return handleGenerateRequest({ body, env, request, url });
  }

  if (request.method === 'POST' && path === '/stream') {
    const body = await safeReadJson(request);
    return handleStreamRequest({ body, env, request, url });
  }

  return jsonResponse({ error: { message: `Unsupported API route: ${path}` } }, 404);
}

async function v1({ request, env, url }) {
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    return jsonResponse({ object: 'list', data: buildModelList(env) });
  }

  const body = await safeReadJson(request);
  let resolved;

  try {
    resolved = resolveModel({
      env,
      model: body?.model || url.searchParams.get('model'),
      allowFailover: false,
    });
  } catch (error) {
    return jsonResponse({ error: { message: error instanceof Error ? error.message : 'Bad Request' } }, 400);
  }

  if (!resolved.supportsGatewayProxy) {
    return jsonResponse(
      {
        error: {
          message: `Model \`${resolved.model}\` resolved to channel \`${resolved.channel}\` using provider \`${resolved.provider}\`, which only supports local AI SDK routes in this worker. Use /api/generate or /api/stream.`,
        },
      },
      400,
    );
  }

  const upstreamUrl = buildUpstreamUrl(resolved.baseURL, url);

  console.info('Proxying request', {
    method: request.method,
    path: url.pathname,
    channel: resolved.channel,
    provider: resolved.provider,
    model: resolved.model,
    upstreamUrl,
  });

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: buildUpstreamHeaders(request.headers, resolved),
    body: buildUpstreamRequestBody(request, body, resolved),
    redirect: 'follow',
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set('x-gateway-channel', resolved.channel);
  responseHeaders.set('x-gateway-provider', resolved.provider);
  responseHeaders.set('x-gateway-model', resolved.model || '');

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

async function handleGenerateRequest({ body, env, url }) {
  try {
    const { call, resolved } = await buildAiSdkRequest({ body, env, url });
    const result = await generateText(call);
    return new Response(
      JSON.stringify(
        {
          content: result.content,
          finishReason: result.finishReason,
          usage: result.usage,
        },
        null,
        2,
      ),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-gateway-channel': resolved.channel,
          'x-gateway-provider': resolved.provider,
          'x-gateway-model': resolved.model || '',
        },
      },
    );
  } catch (error) {
    return jsonResponse({ error: { message: error instanceof Error ? error.message : 'Bad Request' } }, 400);
  }
}

async function handleStreamRequest({ body, env, url }) {
  try {
    const { call, resolved } = await buildAiSdkRequest({ body, env, url });
    const result = streamText(call);
    return result.toUIMessageStreamResponse({
      headers: {
        'x-gateway-channel': resolved.channel,
        'x-gateway-provider': resolved.provider,
        'x-gateway-model': resolved.model || '',
      },
    });
  } catch (error) {
    return jsonResponse({ error: { message: error instanceof Error ? error.message : 'Bad Request' } }, 400);
  }
}

async function buildAiSdkRequest({ body, env, url }) {
  if (!isPlainObject(body)) {
    throw new Error('Request body must be a JSON object.');
  }

  rejectLegacyApiAliases(body);
  rejectUnsupportedAiSdkOptions(body);

  const resolved = resolveModel({
    env,
    model: body?.model || url.searchParams.get('model'),
  });
  const tools = buildDeclarativeTools(body.tools);
  const promptInput = await normalizeAiSdkPromptInput(body, tools);

  if (!resolved.languageModel || !resolved.model) {
    throw new Error(`No AI SDK channel resolved for model \`${resolved.model || 'unknown'}\`.`);
  }

  return {
    resolved,
    call: compactObject({
      model: resolved.languageModel,
      system: promptInput.system,
      prompt: promptInput.prompt,
      messages: promptInput.messages,
      tools,
      toolChoice: normalizeToolChoice(body.toolChoice),
      activeTools: normalizeActiveTools(body.activeTools),
      headers: isPlainObject(body?.headers) ? sanitizeRequestHeaders(body.headers) : undefined,
      providerOptions: isPlainObject(body?.providerOptions) ? body.providerOptions : undefined,
      temperature: toNumber(body?.temperature),
      topP: toNumber(body?.topP),
      topK: toInteger(body?.topK),
      maxOutputTokens: toInteger(body?.maxOutputTokens),
      presencePenalty: toNumber(body?.presencePenalty),
      frequencyPenalty: toNumber(body?.frequencyPenalty),
      stopSequences: normalizeStopSequences(body?.stopSequences),
      seed: toInteger(body?.seed),
      maxRetries: toInteger(body?.maxRetries),
      timeout: normalizeTimeout(body?.timeout),
    }),
  };
}

async function normalizeAiSdkPromptInput(body, tools) {
  const prompt = body.prompt == null ? undefined : await normalizePromptValue(body.prompt, tools);
  const messages = body.messages == null ? undefined : await normalizeMessageInput(body.messages, '`messages`', tools);
  const system = body.system == null ? undefined : normalizeSystemInput(body.system);

  if (prompt !== undefined && messages !== undefined) {
    throw new Error('Use either `prompt` or `messages`, not both.');
  }

  if (prompt === undefined && messages === undefined) {
    throw new Error('Request body must include either `prompt` or `messages`.');
  }

  return { prompt, messages, system };
}

async function normalizePromptValue(value, tools) {
  if (typeof value === 'string') {
    return value;
  }

  return normalizeMessageInput(value, '`prompt`', tools);
}

function normalizeSystemInput(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (isPlainObject(value)) {
    return normalizeSystemMessage(value);
  }

  if (Array.isArray(value)) {
    return value.map((message) => normalizeSystemMessage(message));
  }

  throw new Error('`system` must be a string, a system message object, or an array of system message objects.');
}

function normalizeSystemMessage(message) {
  if (!isPlainObject(message)) {
    throw new Error('Each `system` message must be an object.');
  }

  if (message.role != null && message.role !== 'system') {
    throw new Error('`system` message objects must use role `system`.');
  }

  if (typeof message.content !== 'string') {
    throw new Error('`system` message content must be a string.');
  }

  return compactObject({
    role: 'system',
    content: message.content,
    providerOptions: isPlainObject(message.providerOptions) ? message.providerOptions : undefined,
  });
}

async function normalizeMessageInput(messages, label, tools) {
  if (!Array.isArray(messages)) {
    throw new Error(`${label} must be an array of AI SDK UI messages or ModelMessages.`);
  }

  const normalized = messages.map((message) => {
    if (!isPlainObject(message)) {
      throw new Error(`Each ${label} entry must be an object.`);
    }

    return message;
  });

  const usesUiMessages = normalized.some((message) => Array.isArray(message.parts));
  const usesModelMessages = normalized.some((message) => 'content' in message);

  if (usesUiMessages && usesModelMessages) {
    throw new Error(`${label} must contain either UI messages with \`parts\` or ModelMessages with \`content\`, not a mix.`);
  }

  if (usesUiMessages) {
    return convertToModelMessages(normalized.map(stripUiMessageId), { tools });
  }

  if (usesModelMessages) {
    return normalized;
  }

  throw new Error(`${label} messages must use either \`parts\` (UI messages) or \`content\` (ModelMessages).`);
}

function stripUiMessageId(message) {
  const { id: _id, ...rest } = message;
  return rest;
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

function rejectLegacyApiAliases(body) {
  const legacyAliases = {
    input: 'prompt',
    top_p: 'topP',
    top_k: 'topK',
    max_tokens: 'maxOutputTokens',
    maxTokens: 'maxOutputTokens',
    presence_penalty: 'presencePenalty',
    frequency_penalty: 'frequencyPenalty',
    stop: 'stopSequences',
  };

  for (const [legacyKey, replacement] of Object.entries(legacyAliases)) {
    if (legacyKey in body) {
      throw new Error(`\`${legacyKey}\` is not supported on \`/api\` routes. Use AI SDK field \`${replacement}\` instead.`);
    }
  }
}

function rejectUnsupportedAiSdkOptions(body) {
  const unsupportedOptions = ['output', 'experimental_output', 'stopWhen', 'prepareStep', 'experimental_prepareStep', 'experimental_download', 'abortSignal'];

  for (const key of unsupportedOptions) {
    if (key in body) {
      throw new Error(`\`${key}\` is not supported on \`/api\` routes because it requires non-JSON runtime behavior.`);
    }
  }
}

function buildResolvedChannel(channel, modelCode) {
  const providerInput = String(firstString(channel?.provider) || '').toLowerCase();
  const kind = inferProviderKind(firstString(channel?.kind) || providerInput);
  const defaults = DEFAULT_PROVIDER_CATALOG[providerInput] || DEFAULT_PROVIDER_CATALOG[kind] || {};
  const models = Array.isArray(channel?.models) ? channel.models : [];
  const callType = firstString(models[0]?.callType) || CALL_TYPES.CHAT;
  const finalModel = firstString(modelCode) || firstString(models[0]?.code) || '';
  const key = firstString(channel?.key) || '';
  const name = firstString(channel?.name) || key;
  const baseURL = normalizeBaseURL(firstString(channel?.baseURL) || defaults.baseURL || '');
  const apiKey = firstString(channel?.apiKey) || '';
  const headers = sanitizeHeaders(channel?.headers);

  return {
    key,
    provider: kind,
    model: finalModel,
    callType,
    baseURL,
    apiKey,
    headers,
    supportsGatewayProxy: supportsGatewayProxy(kind),
    languageModel: finalModel
      ? createGatewayLanguageModel({
          channelKey: key,
          model: finalModel,
          languageModel: instantiateLanguageModel(
            {
              ...channel,
              name,
              provider: kind,
              baseURL,
              apiKey,
              callType,
              headers,
            },
            finalModel,
          ),
        })
      : null,
  };
}

function resolveModel({ env, model, random = Math.random, allowFailover = true }) {
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

      return matchedModel ? [buildResolvedChannel(channel, firstString(matchedModel.code))] : [];
    }),
    random,
  );

  if (orderedCandidates.length === 0) {
    throw new Error(`No channel supports model \`${requestedModel}\`.`);
  }

  const candidates = allowFailover ? orderedCandidates : orderedCandidates.slice(0, 1);
  const primary = candidates[0];

  if (!primary) {
    throw new Error(`Could not resolve a channel for model \`${model}\`.`);
  }

  const languageModel = buildLanguageModelWithFailover(candidates);
  const getActiveCandidate = () => getActiveResolvedCandidate(candidates, languageModel) || primary;

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
    get supportsGatewayProxy() {
      return getActiveCandidate().supportsGatewayProxy;
    },
  };
}

function createGatewayLanguageModel({ channelKey, model, languageModel }) {
  if (!languageModel) {
    return null;
  }

  const doGenerate = languageModel.doGenerate.bind(languageModel);
  const doStream = languageModel.doStream.bind(languageModel);

  return {
    specificationVersion: languageModel.specificationVersion,
    get supportedUrls() {
      return languageModel.supportedUrls;
    },
    get provider() {
      return channelKey;
    },
    get modelId() {
      return model;
    },
    doGenerate(options) {
      return doGenerate(options);
    },
    doStream(options) {
      return doStream(options);
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

  const activeChannel = firstString(languageModel?.provider);
  const activeModel = firstString(languageModel?.modelId);

  if (activeChannel && activeModel) {
    const exactMatch = candidates.find((candidate) => candidate.key === activeChannel && candidate.model === activeModel);
    if (exactMatch) {
      return exactMatch;
    }
  }

  if (activeChannel) {
    const channelMatch = candidates.find((candidate) => candidate.key === activeChannel);
    if (channelMatch) {
      return channelMatch;
    }
  }

  return candidates[0];
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
    case 'google': {
      const provider = createGoogleGenerativeAI({ apiKey, baseURL, headers });
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

    case 'anthropic': {
      const provider = createAnthropic({ apiKey, baseURL, headers });
      switch (callType) {
        case CALL_TYPES.CHAT:
          return provider.chat(model);
        case CALL_TYPES.EMBEDDING:
          return provider.embedding(model);
        default:
          return unsupportedCallType();
      }
    }

    case 'openrouter': {
      const provider = createOpenRouter({ apiKey, baseURL, headers });
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
        case CALL_TYPES.ASR:
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

function buildUpstreamUrl(baseURL, url) {
  const normalizedBaseURL = normalizeBaseURL(baseURL);
  const upstreamPath = url.pathname.replace(/^\/v1/, '') || '/models';
  const upstreamUrl = new URL(`${normalizedBaseURL}${upstreamPath}`);
  upstreamUrl.search = url.search;
  upstreamUrl.searchParams.delete('provider');
  upstreamUrl.searchParams.delete('channel');
  return upstreamUrl.toString();
}

function buildUpstreamHeaders(requestHeaders, resolved) {
  const headers = new Headers(requestHeaders);

  headers.delete('host');
  headers.delete('content-length');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ipcountry');
  headers.delete('cf-ray');
  headers.delete('x-forwarded-proto');
  headers.delete('authorization');
  headers.delete('x-provider');
  headers.delete('x-channel');
  headers.delete('x-admin-key');
  headers.delete('x-admin-token');

  if (resolved.apiKey) {
    headers.set('authorization', `Bearer ${resolved.apiKey}`);
  }

  for (const [key, value] of Object.entries(resolved.headers || {})) {
    headers.set(key, value);
  }

  return headers;
}

function buildUpstreamRequestBody(request, body, resolved) {
  if (!canHaveRequestBody(request.method)) {
    return undefined;
  }

  if (!isPlainObject(body) || !Object.prototype.hasOwnProperty.call(body, 'model') || !resolved.model) {
    return request.body;
  }

  if (body.model === resolved.model) {
    return request.body;
  }

  return JSON.stringify({ ...body, model: resolved.model });
}

function inferProviderKind(name) {
  switch (String(name || '').toLowerCase()) {
    case 'openai':
      return 'openai';
    case 'openrouter':
      return 'openrouter';
    case 'google':
    case 'gemini':
      return 'google';
    case 'anthropic':
    case 'claude':
      return 'anthropic';
    case 'pollinations':
      return 'pollinations';
    default:
      return 'openai-compatible';
  }
}

function supportsGatewayProxy(kind) {
  return ['openai', 'openai-compatible', 'openrouter'].includes(kind);
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


export { api, buildAiSdkRequest, buildModelList, resolveModel, v1 };