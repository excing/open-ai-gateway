import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, streamText } from 'ai';
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
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return withCors(index({ env }));
      }

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

function index({ env }) {
  const config = buildPublicConfig(env);
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Open AI Gateway</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0b1020; color: #e5e7eb; }
      main { max-width: 960px; margin: 0 auto; padding: 32px 20px 48px; }
      h1, h2 { margin: 0 0 12px; }
      p { color: #cbd5e1; }
      .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
      .card { background: #11182d; border: 1px solid #23304f; border-radius: 12px; padding: 16px; }
      code, pre { font-family: ui-monospace, SFMono-Regular, monospace; }
      pre { white-space: pre-wrap; word-break: break-word; background: #0f172a; border-radius: 10px; padding: 12px; overflow: auto; }
      .muted { color: #94a3b8; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Open AI Gateway</h1>
      <p>这是一个运行在 Cloudflare Workers 上的 Vercel AI SDK 网关，已接入 OpenAI、Google Gemini、Claude、OpenRouter、Pollinations，并保留了管理页和 OpenAI 风格接口。</p>

      <div class="grid">
        <section class="card">
          <h2>网关状态</h2>
          <pre id="health">loading...</pre>
        </section>
        <section class="card">
          <h2>公开配置</h2>
          <pre id="config">${escapeHtml(JSON.stringify(config, null, 2))}</pre>
        </section>
      </div>

      <section class="card" style="margin-top: 16px;">
        <h2>已暴露模型</h2>
        <pre id="models">loading...</pre>
      </section>

      <section class="card" style="margin-top: 16px;">
        <h2>调用示例</h2>
        <pre id="example">curl ${'\\'}
  -X POST ${'\\'}
  -H "Content-Type: application/json" ${'\\'}
  "__GATEWAY_ORIGIN__/api/generate" ${'\\'}
  -d '{"provider":"${config.defaultProvider || 'openai'}","model":"${config.defaultModel || 'gpt-4o-mini'}","prompt":"你好，介绍一下你自己。"}'</pre>
        <p class="muted">流式输出请调用 <code>/api/stream</code>；如果要使用 OpenAI 风格请求体，可继续调用 <code>/v1/chat/completions</code>。</p>
      </section>
    </main>

    <script>
      const exampleElement = document.getElementById('example');

      if (exampleElement) {
        exampleElement.textContent = exampleElement.textContent.replace('__GATEWAY_ORIGIN__', location.origin);
      }

      async function load() {
        const [health, models] = await Promise.all([
          fetch('/api/health').then((r) => r.json()),
          fetch('/api/models').then((r) => r.json()),
        ]);

        document.getElementById('health').textContent = JSON.stringify(health, null, 2);
        document.getElementById('models').textContent = JSON.stringify(models, null, 2);
      }

      load().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        document.getElementById('health').textContent = message;
        document.getElementById('models').textContent = message;
      });
    </script>
  </body>
</html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  });
}

async function api({ request, env, url }) {
  const path = url.pathname.replace(/^\/api/, '') || '/';

  if (request.method === 'GET' && (path === '/' || path === '/config')) {
    return jsonResponse(buildPublicConfig(env));
  }

  if (request.method === 'GET' && path === '/models') {
    return jsonResponse({ object: 'list', data: buildModelList(env) });
  }

  if (request.method === 'GET' && path === '/health') {
    return jsonResponse(buildHealth(env));
  }

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
    const { call, resolved } = buildTextGenerationRequest({ body, env, request, url });
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
    const { call, resolved } = buildTextGenerationRequest({ body, env, request, url });
    const result = streamText(call);
    return result.toTextStreamResponse({
      headers: {
        'x-gateway-provider': resolved.provider,
        'x-gateway-model': resolved.model || '',
      },
    });
  } catch (error) {
    return jsonResponse({ error: { message: error instanceof Error ? error.message : 'Bad Request' } }, 400);
  }
}

function buildTextGenerationRequest({ body, env, request, url }) {
  const resolved = resolveProvider({
    env,
    provider: body?.provider || request.headers.get('x-provider') || url.searchParams.get('provider'),
    model: body?.model || url.searchParams.get('model'),
  });
  const promptInput = extractPromptInput(body);

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
      headers: isPlainObject(body?.headers) ? sanitizeHeaders(body.headers) : undefined,
      providerOptions: isPlainObject(body?.providerOptions) ? body.providerOptions : undefined,
      temperature: toNumber(body?.temperature),
      topP: toNumber(body?.topP ?? body?.top_p),
      topK: toInteger(body?.topK ?? body?.top_k),
      maxOutputTokens: toInteger(body?.maxOutputTokens ?? body?.maxTokens ?? body?.max_tokens),
      presencePenalty: toNumber(body?.presencePenalty ?? body?.presence_penalty),
      frequencyPenalty: toNumber(body?.frequencyPenalty ?? body?.frequency_penalty),
      stopSequences: normalizeStopSequences(body?.stopSequences ?? body?.stop),
      seed: toInteger(body?.seed),
    }),
  };
}

function extractPromptInput(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be JSON and include either `prompt` or `messages`.');
  }

  const prompt = firstString(body.prompt, body.input);
  const messages = body.messages == null ? null : normalizeChatMessages(body.messages);
  const system = typeof body.system === 'string' && body.system.trim() ? body.system : undefined;

  if (prompt && messages) {
    throw new Error('Use either `prompt` or `messages`, not both.');
  }

  if (!prompt && !messages) {
    throw new Error('Request body must include either `prompt` or `messages`.');
  }

  return { prompt, messages, system };
}

function normalizeChatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('`messages` must be a non-empty array.');
  }

  return messages.map((message) => {
    if (!message || typeof message !== 'object') {
      throw new Error('Each message must be an object.');
    }

    const role = String(message.role || '').trim();

    if (!['system', 'user', 'assistant'].includes(role)) {
      throw new Error('Only `system`, `user`, and `assistant` roles are currently supported.');
    }

    return {
      role,
      content: normalizeMessageContent(message.content),
    };
  });
}

function normalizeMessageContent(content) {
  if (typeof content === 'string' && content.trim()) {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text' || part.type === 'input_text') {
          return typeof part.text === 'string' ? part.text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');

    if (text) {
      return text;
    }
  }

  throw new Error('Only text message content is currently supported for AI SDK routes.');
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

function buildPublicConfig(env) {
  const gatewayConfig = getGatewayConfig(env);
  const providers = gatewayConfig.providers;
  const publicProviders = Object.values(providers).map((provider) => ({
    name: provider.name,
    kind: provider.kind,
    baseURL: provider.baseURL || null,
    defaultModel: provider.defaultModel || null,
    models: provider.models || [],
    hasApiKey: Boolean(provider.apiKey),
    headerKeys: Object.keys(provider.headers || {}),
    supportsGatewayProxy: supportsGatewayProxy(provider.kind),
  }));

  return {
    defaultProvider: gatewayConfig.defaultProvider || publicProviders[0]?.name || null,
    defaultModel: gatewayConfig.defaultModel || publicProviders[0]?.defaultModel || null,
    providerCount: publicProviders.length,
    routes: ['/api/generate', '/api/stream', '/v1/models', '/v1/chat/completions'],
    providers: publicProviders,
    modelProviderMap: gatewayConfig.modelProviderMap,
    configSource: gatewayConfig.source,
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

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export { api, buildModelList, buildPublicConfig, createModelFromProvider, getProviders, resolveProvider, v1 };