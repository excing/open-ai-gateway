import { recordCallFailure, recordCallSuccess } from '../call-result.js';
import { createGatewayRepository } from '../db-repository.js';
import { CALL_TYPES, MODEL_STATUS, selectChannelModels } from '../model-selection.js';
import { createExacgAdapter } from './adapters/exacg.js';
import { createOpenAICompatibleAdapter } from './adapters/openai-compatible.js';

const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

const METHODS = {
  GET: 'GET',
  POST: 'POST',
};

const HEADERS = {
  AUTHORIZATION: 'authorization',
  CHANNEL_ID: 'x-channel-id',
  CONTENT_TYPE: 'content-type',
};

const BEARER_PREFIX = 'Bearer ';
const JSON_CONTENT_TYPE = 'application/json';
const MULTIPART_CONTENT_TYPE = 'multipart/form-data';
const DEFAULT_PROVIDER = 'openai';

const V1_ROUTES = {
  PREFIX: '/v1',
  MODELS: '/v1/models',
  CHAT_COMPLETIONS: '/v1/chat/completions',
  COMPLETIONS: '/v1/completions',
  RESPONSES: '/v1/responses',
  IMAGE_GENERATIONS: '/v1/images/generations',
  AUDIO_SPEECH: '/v1/audio/speech',
  AUDIO_TRANSCRIPTIONS: '/v1/audio/transcriptions',
  EMBEDDINGS: '/v1/embeddings',
  VIDEO_GENERATIONS: '/v1/video/generations',
};

const V1_ENDPOINTS = [
  { key: 'models', path: V1_ROUTES.MODELS, method: METHODS.GET },
  { key: 'chat_completions', path: V1_ROUTES.CHAT_COMPLETIONS, method: METHODS.POST, callType: CALL_TYPES.CHAT },
  { key: 'completions', path: V1_ROUTES.COMPLETIONS, method: METHODS.POST, callType: CALL_TYPES.CHAT },
  { key: 'responses', path: V1_ROUTES.RESPONSES, method: METHODS.POST, callType: CALL_TYPES.CHAT },
  { key: 'image_generations', path: V1_ROUTES.IMAGE_GENERATIONS, method: METHODS.POST, callType: CALL_TYPES.IMAGE_GEN },
  { key: 'audio_speech', path: V1_ROUTES.AUDIO_SPEECH, method: METHODS.POST, callType: CALL_TYPES.AUDIO_GEN },
  { key: 'audio_transcriptions', path: V1_ROUTES.AUDIO_TRANSCRIPTIONS, method: METHODS.POST, callType: CALL_TYPES.TRANSCRIBE },
  { key: 'embeddings', path: V1_ROUTES.EMBEDDINGS, method: METHODS.POST, callType: CALL_TYPES.EMBEDDING },
  { key: 'video_generations', path: V1_ROUTES.VIDEO_GENERATIONS, method: METHODS.POST, callType: CALL_TYPES.VIDEO_GEN },
];

const MODEL_CHECK_LIMITS = {
  DEFAULT_TIMEOUT_MS: 30_000,
  MIN_TIMEOUT_MS: 1,
  MAX_TIMEOUT_MS: 120_000,
};

const ERROR_MESSAGES = {
  UNAUTHORIZED: 'Missing or invalid authorization token',
  NOT_FOUND: 'Resource not found',
  INVALID_REQUEST_BODY: 'Invalid request body',
  NO_MODEL_AVAILABLE: 'All models for this identifier are currently unavailable (cooldown, disabled, or unsupported provider)',
  PROVIDER_ERROR: 'Upstream AI provider returned an error',
};

const ENDPOINTS_BY_ROUTE = new Map(V1_ENDPOINTS.map((endpoint) => [`${endpoint.method} ${endpoint.path}`, endpoint]));

function jsonResponse(data, status = HTTP_STATUS.OK) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { [HEADERS.CONTENT_TYPE]: JSON_CONTENT_TYPE },
  });
}

function errorResponse(message, status) {
  return jsonResponse({ success: false, error: message }, status);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function invalidRequestBodyResponse(message = '') {
  const suffix = message ? `: ${message}` : '';
  return errorResponse(`${ERROR_MESSAGES.INVALID_REQUEST_BODY}${suffix}`, HTTP_STATUS.BAD_REQUEST);
}

function extractBearerToken(request) {
  const auth = request.headers.get(HEADERS.AUTHORIZATION);
  if (!auth || !auth.startsWith(BEARER_PREFIX)) return null;
  return auth.slice(BEARER_PREFIX.length).trim();
}

function authenticateGatewayRequest(request, env) {
  const token = extractBearerToken(request);
  return Boolean(token && env.ADMIN_KEY && token === env.ADMIN_KEY);
}

function resolveV1Endpoint(pathname, method) {
  return ENDPOINTS_BY_ROUTE.get(`${method} ${pathname}`) || null;
}

async function parseJsonRequestBody(request) {
  try {
    return { ok: true, body: await request.json() };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

async function parseV1RequestBody(request, endpoint) {
  if (endpoint.method === METHODS.GET) return {};
  const contentType = request.headers.get(HEADERS.CONTENT_TYPE) || '';
  if (contentType.includes(MULTIPART_CONTENT_TYPE)) return request.formData();
  return request.json();
}

function readModelFromBody(body) {
  if (body instanceof FormData) return String(body.get('model') || '').trim();
  return String(body?.model || '').trim();
}

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function getEpochSeconds(now) {
  return Math.floor(now.getTime() / 1000);
}

function collectModelIdentifiers(row) {
  const identifiers = [String(row.code || '').trim()];
  for (const alias of parseJsonArray(row.aliases)) identifiers.push(String(alias || '').trim());
  return identifiers.filter(Boolean);
}

function buildOpenAIModelList(rows, now) {
  const seen = new Set();
  const created = getEpochSeconds(now);
  const data = [];
  for (const row of rows) {
    if (row.status === MODEL_STATUS.DISABLE) continue;
    for (const id of collectModelIdentifiers(row)) {
      if (seen.has(id)) continue;
      seen.add(id);
      data.push({
        id,
        object: 'model',
        created,
        owned_by: row.channel_name || row.ch_name || 'unknown',
      });
    }
  }
  return data;
}

function normalizeProvider(provider) {
  return String(provider || DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
}

function normalizeConnection(raw) {
  return {
    provider: normalizeProvider(raw?.provider),
    apiKey: String(raw?.apiKey ?? raw?.api_key ?? '').trim(),
    baseURL: String(raw?.baseURL ?? raw?.base_url ?? '').trim(),
    headers: parseJsonObject(raw?.headers, raw?.headers || {}),
  };
}

function validateConnectionInput(raw) {
  const errors = [];
  const connection = normalizeConnection(raw);
  if (!connection.apiKey) errors.push('apiKey: Required');
  if (connection.baseURL) {
    try {
      new URL(connection.baseURL);
    } catch {
      errors.push('baseURL: Invalid URL');
    }
  }
  return { connection, errors };
}

function validateModelCheckInput(raw) {
  const { connection, errors } = validateConnectionInput(raw);
  const model = String(raw?.model || '').trim();
  const callType = String(raw?.callType || raw?.call_type || '').trim();
  const timeoutMs = Number(raw?.timeoutMs ?? MODEL_CHECK_LIMITS.DEFAULT_TIMEOUT_MS);
  if (!model) errors.push('model: Required');
  if (!Object.values(CALL_TYPES).includes(callType)) errors.push('callType: Invalid');
  if (!Number.isInteger(timeoutMs) || timeoutMs < MODEL_CHECK_LIMITS.MIN_TIMEOUT_MS || timeoutMs > MODEL_CHECK_LIMITS.MAX_TIMEOUT_MS) {
    errors.push(`timeoutMs: Must be an integer between ${MODEL_CHECK_LIMITS.MIN_TIMEOUT_MS} and ${MODEL_CHECK_LIMITS.MAX_TIMEOUT_MS}`);
  }
  return { input: { ...connection, model, callType, timeoutMs }, errors };
}

function createUnavailableCheckResult(input, error) {
  return {
    model_code: input.model || '',
    call_type: input.callType || '',
    api_accessible: false,
    data_available: false,
    latency_ms: 0,
    error_message: formatError(error),
  };
}

function createV1Gateway(deps = {}) {
  const nowFn = deps.now || (() => new Date());
  const uuidFn = deps.uuid || (() => crypto.randomUUID());
  const getRepo = (env) => deps.repository || createGatewayRepository(env.DB);
  const getFetchFn = (env) => (env?.ENV === 'dev' && deps.fetch ? deps.fetch : fetch);

  function getProviderAdapter(provider, env) {
    const adapters = [
      createOpenAICompatibleAdapter({ fetch: getFetchFn(env), now: nowFn }),
      createExacgAdapter({ fetch: getFetchFn(env), now: nowFn }),
    ];
    const adapter = adapters.find((item) => item.supports(provider));
    if (!adapter) throw new Error(`Unsupported provider: ${provider}`);
    return adapter;
  }

  async function listConfiguredModels(env) {
    return buildOpenAIModelList(await getRepo(env).getStatusRows(), nowFn());
  }

  async function handleV1Models(request, env) {
    return jsonResponse({ object: 'list', data: await listConfiguredModels(env) }, HTTP_STATUS.OK);
  }

  async function handleV1Proxy(request, env, ctx, endpoint) {
    let body;
    try {
      body = await parseV1RequestBody(request, endpoint);
    } catch (error) {
      return invalidRequestBodyResponse(formatError(error));
    }

    const requestModel = readModelFromBody(body);
    if (!requestModel) return invalidRequestBodyResponse('model: Required');

    const selections = await selectChannelModels(env.DB, {
      model: requestModel,
      callType: endpoint.callType,
      channelId: request.headers.get(HEADERS.CHANNEL_ID) || '',
      now: nowFn(),
    });
    if (!selections.length) return errorResponse(ERROR_MESSAGES.NO_MODEL_AVAILABLE, HTTP_STATUS.SERVICE_UNAVAILABLE);

    let lastError = null;
    let lastResponse = null;
    for (const selection of selections) {
      const startedAt = nowFn().getTime();
      try {
        const adapter = getProviderAdapter(selection.channel.provider, env);
        const result = await adapter.invoke({ endpoint, selection, requestBody: body });
        await recordCallSuccess(env.DB, {
          requestBody: { model: requestModel },
          responseBody: result.responseBody,
          selection,
          callType: endpoint.callType,
          latencyMs: Math.max(0, nowFn().getTime() - startedAt),
          now: nowFn(),
          uuid: uuidFn,
        });
        return result.response;
      } catch (error) {
        lastError = error;
        if (error?.response) lastResponse = error.response;
        await recordCallFailure(env.DB, {
          requestBody: { model: requestModel },
          selection,
          callType: endpoint.callType,
          error,
          latencyMs: Math.max(0, nowFn().getTime() - startedAt),
          now: nowFn(),
          uuid: uuidFn,
        });
      }
    }

    if (lastResponse) return lastResponse;
    return errorResponse(lastError?.message || ERROR_MESSAGES.PROVIDER_ERROR, HTTP_STATUS.INTERNAL_ERROR);
  }

  async function handleV1Request(request, env, ctx) {
    if (!authenticateGatewayRequest(request, env)) {
      return errorResponse(ERROR_MESSAGES.UNAUTHORIZED, HTTP_STATUS.UNAUTHORIZED);
    }
    const { pathname } = new URL(request.url);
    const endpoint = resolveV1Endpoint(pathname, request.method);
    if (!endpoint) return errorResponse(ERROR_MESSAGES.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    if (endpoint.key === 'models') return handleV1Models(request, env);
    return handleV1Proxy(request, env, ctx, endpoint);
  }

  async function handleProviderModels(connection, env) {
    try {
      const normalized = normalizeConnection(connection);
      const adapter = getProviderAdapter(normalized.provider, env);
      return jsonResponse({ success: true, data: await adapter.listModels(normalized) }, HTTP_STATUS.OK);
    } catch (error) {
      return jsonResponse({ success: false, data: [], error: formatError(error) }, HTTP_STATUS.OK);
    }
  }

  async function handleProviderModelsByRequest(request, env) {
    const parsed = await parseJsonRequestBody(request);
    if (!parsed.ok) return invalidRequestBodyResponse(parsed.error);
    const { connection, errors } = validateConnectionInput(parsed.body);
    if (errors.length) return invalidRequestBodyResponse(errors.join('; '));
    return handleProviderModels(connection, env);
  }

  async function handleModelCheck(request, env) {
    const parsed = await parseJsonRequestBody(request);
    if (!parsed.ok) return invalidRequestBodyResponse(parsed.error);
    const { input, errors } = validateModelCheckInput(parsed.body);
    if (errors.length) return invalidRequestBodyResponse(errors.join('; '));

    try {
      const adapter = getProviderAdapter(input.provider, env);
      return jsonResponse({ success: true, data: await adapter.checkAvailability(input) }, HTTP_STATUS.OK);
    } catch (error) {
      return jsonResponse({ success: true, data: createUnavailableCheckResult(input, error) }, HTTP_STATUS.OK);
    }
  }

  return {
    handleV1Request,
    handleV1Models,
    handleV1Proxy,
    handleProviderModels,
    handleProviderModelsByRequest,
    handleModelCheck,
    listConfiguredModels,
  };
}

export {
  ERROR_MESSAGES,
  HTTP_STATUS,
  MODEL_CHECK_LIMITS,
  V1_ENDPOINTS,
  V1_ROUTES,
  authenticateGatewayRequest,
  buildOpenAIModelList,
  createV1Gateway,
  parseJsonObject,
  parseV1RequestBody,
  readModelFromBody,
  normalizeProvider,
  resolveV1Endpoint,
};
