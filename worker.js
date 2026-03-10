import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { jsonSchema, tool } from '@ai-sdk/provider-utils';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { convertToModelMessages, generateText, streamText } from 'ai';
import { createFallback, defaultShouldRetryThisError } from 'ai-fallback';
import { createPollinations } from 'ai-sdk-pollinations';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-provider, x-admin-token',
};

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

  if (request.method === 'POST' && path === '/resolve') {
    const body = await safeReadJson(request);
    const resolved = resolveProvider({
      env,
      provider: body?.provider || request.headers.get('x-provider') || url.searchParams.get('provider'),
      model: body?.model || url.searchParams.get('model'),
    });

    return jsonResponse({
      provider: resolved.provider,
      sdkProvider: resolved.kind,
      model: resolved.model || null,
      baseURL: resolved.baseURL || null,
      supportsModels: resolved.models,
      supportsGatewayProxy: resolved.supportsGatewayProxy,
      supportsTextGeneration: Boolean(resolved.languageModel),
      hasApiKey: Boolean(resolved.apiKey),
      headers: Object.keys(resolved.headers || {}),
    });
  }

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
  const resolved = resolveProvider({
    env,
    provider: request.headers.get('x-provider') || url.searchParams.get('provider'),
    model: body?.model || url.searchParams.get('model'),
    allowFailover: false,
  });

  if (!resolved.supportsGatewayProxy) {
    return jsonResponse(
      {
        error: {
          message: `Provider \`${resolved.provider}\` only supports local AI SDK routes in this worker. Use /api/generate or /api/stream.`,
        },
      },
      400,
    );
  }

  const upstreamUrl = buildUpstreamUrl(resolved.baseURL, url);

  console.info('Proxying request', {
    method: request.method,
    path: url.pathname,
    provider: resolved.provider,
    model: resolved.model,
    upstreamUrl,
  });

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: buildUpstreamHeaders(request.headers, resolved),
    body: canHaveRequestBody(request.method) ? request.body : undefined,
    redirect: 'follow',
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set('x-gateway-provider', resolved.provider);
  responseHeaders.set('x-gateway-model', resolved.model || '');

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

async function handleGenerateRequest({ body, env, request, url }) {
  try {
    const { call, resolved } = await buildAiSdkRequest({ body, env, request, url });
    const result = await generateText(call);
    return result.toJsonResponse({
      headers: {
        'x-gateway-provider': resolved.provider,
        'x-gateway-model': resolved.model || '',
      },
    });
  } catch (error) {
    return jsonResponse({ error: { message: error instanceof Error ? error.message : 'Bad Request' } }, 400);
  }
}

async function handleStreamRequest({ body, env, request, url }) {
  try {
    const { call, resolved } = await buildAiSdkRequest({ body, env, request, url });
    const result = streamText(call);
    return result.toUIMessageStreamResponse({
      headers: {
        'x-gateway-provider': resolved.provider,
        'x-gateway-model': resolved.model || '',
      },
    });
  } catch (error) {
    return jsonResponse({ error: { message: error instanceof Error ? error.message : 'Bad Request' } }, 400);
  }
}

async function buildAiSdkRequest({ body, env, request, url }) {
  if (!isPlainObject(body)) {
    throw new Error('Request body must be a JSON object.');
  }

  rejectLegacyApiAliases(body);
  rejectUnsupportedAiSdkOptions(body);

  const resolved = resolveProvider({
    env,
    provider: body?.provider || request.headers.get('x-provider') || url.searchParams.get('provider'),
    model: body?.model || url.searchParams.get('model'),
  });
  const tools = buildDeclarativeTools(body.tools);
  const promptInput = await normalizeAiSdkPromptInput(body, tools);

  if (!resolved.languageModel || !resolved.model) {
    throw new Error(`No model resolved for provider \`${resolved.provider}\`. Set it in \`GATEWAY_CONFIG_JSON\` or pass \`model\` in the request body.`);
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

function createModelFromProvider(provider, model, env, providers) {
  const catalog = providers || getProviders(env);
  const config = catalog[provider];
  const gatewayConfig = getGatewayConfig(env);

  if (!config) {
    throw new Error(`Provider not configured: ${provider}`);
  }

  const finalModel = model || config.defaultModel || gatewayConfig.defaultModel || config.models?.[0] || '';
  const kind = config.kind || inferProviderKind(provider);

  return {
    provider,
    kind,
    model: finalModel,
    baseURL: normalizeBaseURL(config.baseURL),
    apiKey: config.apiKey || '',
    headers: config.headers || {},
    models: config.models || [],
    referrer: config.referrer || '',
    compatibility: config.compatibility || '',
    supportsGatewayProxy: supportsGatewayProxy(kind),
    languageModel: finalModel
      ? createGatewayLanguageModel({
          provider,
          model: finalModel,
          languageModel: instantiateLanguageModel(
            {
              ...config,
              name: provider,
              kind,
            },
            finalModel,
          ),
        })
      : null,
  };
}

function resolveProvider({ env, provider, model, random = Math.random, allowFailover = true }) {
  const gatewayConfig = getGatewayConfig(env);
  const providers = getProviders(env);
  const names = Object.keys(providers);

  if (names.length === 0) {
    throw new Error('No providers configured in `GATEWAY_CONFIG_JSON`.');
  }

  const candidates = buildResolvedCandidates({
    env,
    provider,
    model,
    providers,
    gatewayConfig,
    random,
    allowFailover,
  });
  const primary = candidates[0];

  if (!primary) {
    throw new Error('Could not resolve a provider from `GATEWAY_CONFIG_JSON`.');
  }

  const languageModel = buildLanguageModelWithFailover(candidates);
  const candidateMetadata = candidates.map((candidate) => ({
    provider: candidate.provider,
    sdkProvider: candidate.kind,
    model: candidate.model || null,
    baseURL: candidate.baseURL || null,
    supportsGatewayProxy: candidate.supportsGatewayProxy,
    supportsTextGeneration: Boolean(candidate.languageModel),
  }));

  return {
    requestedProvider: provider || null,
    requestedModel: model || null,
    primaryProvider: primary.provider,
    primaryModel: primary.model || null,
    failoverEnabled: candidates.filter((candidate) => candidate.languageModel).length > 1,
    candidates: candidateMetadata,
    languageModel,
    get provider() {
      return getActiveResolvedCandidate(candidates, languageModel)?.provider || primary.provider;
    },
    get kind() {
      return getActiveResolvedCandidate(candidates, languageModel)?.kind || primary.kind;
    },
    get model() {
      return getActiveResolvedCandidate(candidates, languageModel)?.model || primary.model;
    },
    get baseURL() {
      return getActiveResolvedCandidate(candidates, languageModel)?.baseURL || primary.baseURL;
    },
    get apiKey() {
      return getActiveResolvedCandidate(candidates, languageModel)?.apiKey || primary.apiKey;
    },
    get headers() {
      return getActiveResolvedCandidate(candidates, languageModel)?.headers || primary.headers;
    },
    get models() {
      return getActiveResolvedCandidate(candidates, languageModel)?.models || primary.models;
    },
    get referrer() {
      return getActiveResolvedCandidate(candidates, languageModel)?.referrer || primary.referrer;
    },
    get compatibility() {
      return getActiveResolvedCandidate(candidates, languageModel)?.compatibility || primary.compatibility;
    },
    get supportsGatewayProxy() {
      return getActiveResolvedCandidate(candidates, languageModel)?.supportsGatewayProxy ?? primary.supportsGatewayProxy;
    },
  };
}

function buildResolvedCandidates({ env, provider, model, providers, gatewayConfig, random = Math.random, allowFailover = true }) {
  const names = Object.keys(providers);

  if (provider) {
    return [createModelFromProvider(provider, model, env, providers)];
  }

  const modelProviderMap = gatewayConfig.modelProviderMap || {};

  if (model) {
    const directMatches = names.filter((name) => (providers[name].models || []).includes(model));

    if (allowFailover && directMatches.length > 1) {
      return shuffleArray(directMatches, random).map((name) => createModelFromProvider(name, model, env, providers));
    }

    if (modelProviderMap[model]) {
      return [createModelFromProvider(modelProviderMap[model], model, env, providers)];
    }

    if (directMatches.length > 0) {
      return [createModelFromProvider(directMatches[0], model, env, providers)];
    }
  }

  if (gatewayConfig.defaultProvider && providers[gatewayConfig.defaultProvider]) {
    return [createModelFromProvider(gatewayConfig.defaultProvider, model, env, providers)];
  }

  return [createModelFromProvider(names[0], model, env, providers)];
}

function createGatewayLanguageModel({ provider, model, languageModel }) {
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
      return provider;
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

  return createFallback({
    models: languageModels,
    shouldRetryThisError: defaultShouldRetryThisError,
    onError(error, modelId) {
      console.warn('Language model failover triggered', {
        modelId,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

function getActiveResolvedCandidate(candidates, languageModel) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const activeProvider = firstString(languageModel?.provider);
  const activeModel = firstString(languageModel?.modelId);

  if (activeProvider && activeModel) {
    const exactMatch = candidates.find((candidate) => candidate.provider === activeProvider && candidate.model === activeModel);
    if (exactMatch) {
      return exactMatch;
    }
  }

  if (activeProvider) {
    const providerMatch = candidates.find((candidate) => candidate.provider === activeProvider);
    if (providerMatch) {
      return providerMatch;
    }
  }

  return candidates[0];
}

function shuffleArray(items, random = Math.random) {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[nextIndex]] = [shuffled[nextIndex], shuffled[index]];
  }

  return shuffled;
}

function instantiateLanguageModel(config, model) {
  const apiKey = config.apiKey || undefined;
  const baseURL = config.baseURL ? normalizeBaseURL(config.baseURL) : undefined;
  const headers = sanitizeHeaders(config.headers);

  switch (config.kind) {
    case 'google':
      return createGoogleGenerativeAI({ apiKey, baseURL, headers }).chat(model);

    case 'anthropic':
      return createAnthropic({ apiKey, baseURL, headers }).chat(model);

    case 'openrouter': {
      const compatibility =
        config.compatibility || (baseURL && baseURL.includes('openrouter.ai') ? 'strict' : 'compatible');
      return createOpenRouter({ apiKey, baseURL, headers, compatibility }).chat(model);
    }

    case 'pollinations':
      return createPollinations({ apiKey, baseURL, headers, referrer: config.referrer, name: config.name }).chat(model);

    case 'openai':
      return createOpenAI({ apiKey, baseURL, headers, name: config.name }).chat(model);

    case 'openai-compatible':
    default:
      return createOpenAI({ apiKey, baseURL, headers, name: config.name }).chat(model);
  }
}

function getProviders(env) {
  return { ...getGatewayConfig(env).providers };
}

function getGatewayConfig(env) {
  const rawConfig = firstString(env?.GATEWAY_CONFIG_JSON);

  if (!rawConfig) {
    throw new Error('Missing `GATEWAY_CONFIG_JSON`. Set the complete gateway configuration JSON in this environment variable.');
  }

  return parseGatewayConfig(rawConfig);
}

function parseGatewayConfig(value) {
  let parsed;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('`GATEWAY_CONFIG_JSON` must be valid JSON.');
  }

  if (!isPlainObject(parsed)) {
    throw new Error('`GATEWAY_CONFIG_JSON` must be a JSON object.');
  }

  return {
    source: 'GATEWAY_CONFIG_JSON',
    defaultProvider: firstString(parsed.defaultProvider) || null,
    defaultModel: firstString(parsed.defaultModel) || null,
    modelProviderMap: normalizeModelProviderMap(parsed.modelProviderMap),
    providers: Object.fromEntries(
      normalizeProviderEntries(parsed.providers).map((item) => [item.name, normalizeProviderConfig(item.name, item)]),
    ),
  };
}

function buildModelList(env) {
  const providers = getProviders(env);
  const data = [];
  const seen = new Set();

  for (const provider of Object.values(providers)) {
    const models = provider.models?.length
      ? provider.models
      : provider.defaultModel
        ? [provider.defaultModel]
        : [];

    for (const id of models) {
      const key = `${provider.name}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      data.push({
        id,
        object: 'model',
        owned_by: provider.name,
        sdk_provider: provider.kind,
      });
    }
  }

  return data;
}

function buildHealth(env) {
  const gatewayConfig = getGatewayConfig(env);
  const providers = gatewayConfig.providers;
  return {
    ok: Object.keys(providers).length > 0,
    timestamp: new Date().toISOString(),
    providerCount: Object.keys(providers).length,
    defaultProvider: gatewayConfig.defaultProvider || Object.keys(providers)[0] || null,
    sdkProviders: Object.values(providers).map((provider) => ({ name: provider.name, kind: provider.kind })),
  };
}

function buildUpstreamUrl(baseURL, url) {
  const normalizedBaseURL = normalizeBaseURL(baseURL);
  const upstreamPath = url.pathname.replace(/^\/v1/, '') || '/models';
  const upstreamUrl = new URL(`${normalizedBaseURL}${upstreamPath}`);
  upstreamUrl.search = url.search;
  upstreamUrl.searchParams.delete('provider');
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
  headers.delete('x-provider');

  if (resolved.apiKey) {
    headers.set('authorization', `Bearer ${resolved.apiKey}`);
  }

  for (const [key, value] of Object.entries(resolved.headers || {})) {
    headers.set(key, value);
  }

  return headers;
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

function normalizeProviderEntries(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item && item.name);
  }

  if (isPlainObject(value)) {
    return Object.entries(value).map(([name, config]) => ({ name, ...(isPlainObject(config) ? config : {}) }));
  }

  return [];
}

function normalizeProviderConfig(name, config) {
  const defaults = DEFAULT_PROVIDER_CATALOG[name] || {};

  return {
    name,
    kind: String(config.kind || config.type || config.sdk || defaults.kind || inferProviderKind(name)).toLowerCase(),
    baseURL: normalizeBaseURL(config.baseURL || config.baseUrl || defaults.baseURL || ''),
    apiKey: firstString(config.apiKey) || '',
    models: normalizeModelList(config.models),
    defaultModel: firstString(config.defaultModel) || '',
    headers: sanitizeHeaders(config.headers),
    compatibility: firstString(config.compatibility) || '',
    referrer: firstString(config.referrer) || '',
  };
}

function normalizeModelProviderMap(value) {
  if (isPlainObject(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    return parseJsonObject(value);
  }

  return {};
}

function normalizeModelList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return parseStringList(value);
  }

  return [];
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
  const disallowed = new Set(['authorization', 'api-key', 'x-api-key', 'cookie']);

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

function parseStringList(value) {
  if (!value) return [];
  const trimmed = value.trim();

  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  }

  return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseJsonObject(value) {
  if (!value) return {};
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
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


export { api, buildAiSdkRequest, buildModelList, createModelFromProvider, getProviders, resolveProvider, v1 };