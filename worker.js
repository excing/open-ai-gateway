import { z } from 'zod';
import { LOG_STATUS as CALL_RESULT_LOG_STATUS } from './call-result.js';
import { createGatewayRepository } from './db-repository.js';
import {
  CALL_TYPES as MODEL_SELECTION_CALL_TYPES,
  MODEL_STATUS as MODEL_SELECTION_MODEL_STATUS,
} from './model-selection.js';

const CONSTANTS = {
  PROVIDERS: {
    OPENAI: 'openai',
    OPENAI_COMPATIBLE: 'openai-compatible',
    GOOGLE: 'google',
    GEMINI: 'gemini',
    ANTHROPIC: 'anthropic',
    CLAUDE: 'claude',
    OPENROUTER: 'openrouter',
    POLLINATIONS: 'pollinations',
    EXACG: 'exacg',
    MICROSOFT_TTS: 'microsoft-tts',
  },
  CALL_TYPES: MODEL_SELECTION_CALL_TYPES,
  MODEL_STATUS: MODEL_SELECTION_MODEL_STATUS,
  LOG_STATUS: CALL_RESULT_LOG_STATUS,
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  HTTP_STATUS: {
    OK: 200,
    CREATED: 201,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    INTERNAL_ERROR: 500,
  },
  ERROR_MESSAGES: {
    UNAUTHORIZED: 'Missing or invalid authorization token',
    NOT_FOUND: 'Resource not found',
    MODEL_NOT_FOUND: 'No available model found for the requested model identifier',
    CHANNEL_NOT_FOUND: 'Channel not found',
    CHANNEL_KEY_ALREADY_EXISTS: 'Channel key already exists',
    INVALID_REQUEST_BODY: 'Invalid request body',
    INTERNAL_ERROR: 'Internal server error',
  },
  CORS_HEADERS: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-channel-id, *',
    'Access-Control-Max-Age': '86400',
  },
  METHODS: {
    GET: 'GET',
    POST: 'POST',
    PUT: 'PUT',
    DELETE: 'DELETE',
    OPTIONS: 'OPTIONS',
  },
  ROUTES: {
    STATUS: '/status',
    API_PREFIX: '/api',
    API_CHANNEL: '/api/channel',
    API_CHANNEL_PREFIX: '/api/channel/',
    API_CHANNEL_MODELS: '/api/channel/models',
    API_CHANNELS: '/api/channels',
    API_MODEL: '/api/model',
    API_MODEL_PREFIX: '/api/model/',
    API_MODEL_CHECK_REMOVED: '/api/model/check',
    API_LOG: '/api/log',
    API_CHANNEL_MODELS_SUFFIX: '/models',
  },
  UPSTREAM_MODEL_OBJECTS: {
    LIST: 'list',
    MODEL: 'model',
  },
  HEADERS: {
    AUTHORIZATION: 'authorization',
    CONTENT_TYPE: 'content-type',
  },
  BEARER_PREFIX: 'Bearer ',
  JSON_CONTENT_TYPE: 'application/json',
  MULTIPART_CONTENT_TYPE: 'multipart/form-data',
  UPSTREAM_OPENAI_MODELS_SUFFIX: '/v1/models',
};

const {
  PROVIDERS,
  CALL_TYPES,
  MODEL_STATUS,
  LOG_STATUS,
  HTTP_STATUS,
  ERROR_MESSAGES,
  CORS_HEADERS,
  METHODS,
  ROUTES,
  UPSTREAM_MODEL_OBJECTS,
  HEADERS,
  BEARER_PREFIX,
  JSON_CONTENT_TYPE,
  MULTIPART_CONTENT_TYPE,
  UPSTREAM_OPENAI_MODELS_SUFFIX,
} = CONSTANTS;

const MODEL_SYNC_SCOPES = {
  SINGLE: 'single',
  BY_CODE: 'by_code',
};

const MODEL_UPDATE_SKIPPED_REASONS = {
  MODEL_NOT_FOUND: 'model_not_found',
  MISSING_REQUIRED_FIELDS: 'missing_required_fields',
};

const SCHEMAS = (() => {
  const ProviderEnum = z.enum([
    PROVIDERS.OPENAI,
    PROVIDERS.OPENAI_COMPATIBLE,
    PROVIDERS.GOOGLE,
    PROVIDERS.GEMINI,
    PROVIDERS.ANTHROPIC,
    PROVIDERS.CLAUDE,
    PROVIDERS.OPENROUTER,
    PROVIDERS.POLLINATIONS,
    PROVIDERS.EXACG,
    PROVIDERS.MICROSOFT_TTS,
  ]);

  const CallTypeEnum = z.enum([
    CALL_TYPES.CHAT,
    CALL_TYPES.MIX,
    CALL_TYPES.IMAGE_GEN,
    CALL_TYPES.AUDIO_GEN,
    CALL_TYPES.VIDEO_GEN,
    CALL_TYPES.TRANSCRIBE,
    CALL_TYPES.EMBEDDING,
  ]);

  const ChannelModelSchema = z.object({
    code: z.string().min(1),
    name: z.string().min(1),
    desc: z.string().default(''),
    aliases: z.array(z.string()).default([]),
    callType: CallTypeEnum.default(CALL_TYPES.CHAT),
    capabilities: z.array(z.string()).default([CALL_TYPES.CHAT]),
    inputPrice: z.string().default('0'),
    outputPrice: z.string().default('0'),
    weight: z.number().min(0).max(100).default(1.0),
    headers: z.record(z.string(), z.string()).default({}),
  });

  const CreateChannelSchema = z.object({
    name: z.string().min(1).max(100),
    key: z.string().regex(/^[a-z0-9-]+$/).min(1).max(50),
    provider: ProviderEnum.default(PROVIDERS.OPENAI),
    apiKey: z.string(),
    baseURL: z.string().url().or(z.literal('')).default(''),
    weight: z.number().min(0).max(100).default(1.0),
    models: z.array(ChannelModelSchema).default([]),
  });

  const UpdateChannelModelSchema = z.object({
    id: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    desc: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    callType: CallTypeEnum.optional(),
    capabilities: z.array(z.string()).optional(),
    inputPrice: z.string().optional(),
    outputPrice: z.string().optional(),
    status: z.enum([MODEL_STATUS.ACTIVE, MODEL_STATUS.OPEN, MODEL_STATUS.DISABLE]).optional(),
    weight: z.number().min(0).max(100).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }).partial();

  const UpdateChannelSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    key: z.string().regex(/^[a-z0-9-]+$/).min(1).max(50).optional(),
    provider: ProviderEnum.optional(),
    apiKey: z.string().optional(),
    baseURL: z.string().url().or(z.literal('')).optional(),
    weight: z.number().min(0).max(100).optional(),
    models: z.array(UpdateChannelModelSchema).optional(),
    deletedModelIds: z.array(z.string().min(1)).optional(),
  });

  const PaginationSchema = z.object({
    page: z.coerce.number().int().min(1).default(CONSTANTS.DEFAULT_PAGE),
    limit: z.coerce.number().int().min(1).max(CONSTANTS.MAX_PAGE_SIZE).default(CONSTANTS.DEFAULT_PAGE_SIZE),
  });

  const LogQuerySchema = PaginationSchema.extend({
    channel_key: z.string().optional(),
    model_code: z.string().optional(),
    status: z.enum([LOG_STATUS.SUCCESS, LOG_STATUS.ERROR]).optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
  });

  const UpstreamModelListSchema = z.object({
    provider: ProviderEnum.default(PROVIDERS.OPENAI),
    apiKey: z.string().min(1),
    baseURL: z.string().url().or(z.literal('')).default(''),
  });

  return {
    ProviderEnum,
    CallTypeEnum,
    CreateChannelSchema,
    UpdateChannelSchema,
    UpdateModelSchema: UpdateChannelModelSchema.omit({ id: true }),
    PaginationSchema,
    LogQuerySchema,
    UpstreamModelListSchema,
  };
})();

const {
  CreateChannelSchema,
  UpdateChannelSchema,
  UpdateModelSchema,
  PaginationSchema,
  LogQuerySchema,
  UpstreamModelListSchema,
} = SCHEMAS;

const generateUUID = () => crypto.randomUUID();
const nowIso = (nowFn) => nowFn().toISOString();

function applyCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonResponse(data, status = HTTP_STATUS.OK) {
  const headers = new Headers({ [HEADERS.CONTENT_TYPE]: JSON_CONTENT_TYPE });
  Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(message, status = HTTP_STATUS.INTERNAL_ERROR) {
  return jsonResponse({ success: false, error: message }, status);
}

function handleCorsPreflightRequest() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function invalidRequestBodyResponse(parseErrorMessage) {
  const message = parseErrorMessage
    ? `${ERROR_MESSAGES.INVALID_REQUEST_BODY}: ${parseErrorMessage}`
    : ERROR_MESSAGES.INVALID_REQUEST_BODY;
  return errorResponse(message, HTTP_STATUS.BAD_REQUEST);
}

function formatValidationError(error) {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'root'}: ${issue.message}`)
      .join('; ') || 'Validation failed';
  }
  return error instanceof Error ? error.message : String(error);
}

async function parseRequestBody(request) {
  try {
    const contentType = request.headers.get(HEADERS.CONTENT_TYPE) || '';
    if (contentType.includes(MULTIPART_CONTENT_TYPE)) {
      const form = await request.formData();
      const body = {};
      for (const [key, value] of form.entries()) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
          body[key] = Array.isArray(body[key]) ? [...body[key], value] : [body[key], value];
        } else {
          body[key] = value;
        }
      }
      return { success: true, body };
    }
    return { success: true, body: await request.json() };
  } catch (error) {
    console.warn(error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function parsePagination(url) {
  return PaginationSchema.parse(Object.fromEntries(url.searchParams.entries()));
}

function parseModelBatchOptions(request) {
  const url = new URL(request.url);
  const syncScope = url.searchParams.get('sync_scope') || MODEL_SYNC_SCOPES.SINGLE;
  const channelId = url.searchParams.get('channel_id') || '';
  if (!Object.values(MODEL_SYNC_SCOPES).includes(syncScope)) {
    throw new Error(`sync_scope must be one of: ${Object.values(MODEL_SYNC_SCOPES).join(', ')}`);
  }
  return { syncScope, channelId };
}

function buildPaginatedResponse(data, total, pagination) {
  return {
    data,
    total,
    page: pagination.page,
    limit: pagination.limit,
    total_pages: Math.ceil(total / pagination.limit) || 1,
  };
}

function extractBearerToken(request) {
  const auth = request.headers.get(HEADERS.AUTHORIZATION);
  if (!auth || !auth.startsWith(BEARER_PREFIX)) return null;
  return auth.slice(BEARER_PREFIX.length).trim();
}

function extractPathParam(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const value = pathname.slice(prefix.length);
  return value.length > 0 ? value : null;
}

function normalizeProvider(provider) {
  if (provider === PROVIDERS.GEMINI) return PROVIDERS.GOOGLE;
  if (provider === PROVIDERS.CLAUDE) return PROVIDERS.ANTHROPIC;
  return provider;
}

function buildModelsUrl(baseURL) {
  const normalizedBaseURL = (baseURL || '').replace(/\/+$/, '');
  if (/\/v\d+(?:[a-z]+\d*)?$/i.test(normalizedBaseURL)) {
    return `${normalizedBaseURL}${ROUTES.API_CHANNEL_MODELS_SUFFIX}`;
  }
  return `${normalizedBaseURL}${UPSTREAM_OPENAI_MODELS_SUFFIX}`;
}

function toChannelUpdateRow(parsed, updatedAt) {
  return {
    name: parsed.name,
    key: parsed.key,
    provider: parsed.provider,
    api_key: parsed.apiKey,
    base_url: parsed.baseURL,
    weight: parsed.weight,
    updated_at: updatedAt,
  };
}

function toModelUpdateRow(model, updatedAt) {
  return {
    code: model.code,
    name: model.name,
    desc: model.desc,
    aliases: model.aliases === undefined ? undefined : JSON.stringify(model.aliases),
    call_type: model.callType,
    capabilities: model.capabilities === undefined ? undefined : JSON.stringify(model.capabilities),
    input_price: model.inputPrice,
    output_price: model.outputPrice,
    status: model.status,
    weight: model.weight,
    headers: model.headers === undefined ? undefined : JSON.stringify(model.headers),
    last_updated: updatedAt,
  };
}

async function depsFetch(input, init) {
  const url = typeof input === 'string' ? input : input.url;
  const method = init?.method || METHODS.GET;
  console.log(`Request: ${method} ${url}`);
  if (init?.headers) console.log('Request Headers:', init.headers);
  if (init?.body) console.log('Request Body:', await getRequestBody(init.body));
  const response = await fetch(input, init);
  console.log(`Response: ${response.status} ${response.statusText}`);
  console.log('Response Body:', (await response.clone().text()).substring(0, 2000));
  return response;
}

async function getRequestBody(body) {
  if (body instanceof FormData) return '[FormData]';
  if (body instanceof Blob) return '[Blob]';
  if (typeof body === 'string') return body;
  if (body) return JSON.stringify(body);
  return '';
}

function createApp(deps = {}) {
  const nowFn = deps.now || (() => new Date());
  const uuidFn = deps.uuid || generateUUID;
  const getFetchFn = (env) => (env?.ENV === 'dev' && deps.fetch ? deps.fetch : fetch);
  const getRepo = (env) => deps.repository || createGatewayRepository(env.DB);

  const authenticate = (request, env) => {
    const token = extractBearerToken(request);
    return Boolean(token && env.ADMIN_KEY && token === env.ADMIN_KEY);
  };
  const isAdmin = (request, env) => authenticate(request, env);

  async function handleCreateChannel(request, env) {
    const parsedRequestBody = await parseRequestBody(request);
    if (!parsedRequestBody.success) return invalidRequestBodyResponse(parsedRequestBody.error);

    let parsed;
    try {
      parsed = CreateChannelSchema.parse(parsedRequestBody.body);
    } catch (error) {
      return invalidRequestBodyResponse(formatValidationError(error));
    }

    const repo = getRepo(env);
    if (await repo.getChannelByKey(parsed.key)) {
      return errorResponse(ERROR_MESSAGES.CHANNEL_KEY_ALREADY_EXISTS, HTTP_STATUS.FORBIDDEN);
    }

    const channelId = uuidFn();
    const timestamp = nowIso(nowFn);
    await repo.createChannelWithModels({
      channel: {
        id: channelId,
        name: parsed.name,
        key: parsed.key,
        provider: parsed.provider,
        api_key: parsed.apiKey,
        base_url: parsed.baseURL,
        weight: parsed.weight,
        created_at: timestamp,
        updated_at: timestamp,
      },
      models: parsed.models,
      modelIds: parsed.models.map(() => uuidFn()),
      timestamp,
    });

    return handleGetChannel(channelId, env, HTTP_STATUS.CREATED);
  }

  async function handleGetChannel(channelId, env, status = HTTP_STATUS.OK, extra = {}) {
    const channel = await getRepo(env).getChannelWithModels(channelId);
    if (!channel) return errorResponse(ERROR_MESSAGES.CHANNEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    return jsonResponse({ success: true, data: channel, ...extra }, status);
  }

  async function handleUpdateChannel(channelId, request, env) {
    const repo = getRepo(env);
    if (!(await repo.getChannelById(channelId))) {
      return errorResponse(ERROR_MESSAGES.CHANNEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }

    const parsedRequestBody = await parseRequestBody(request);
    if (!parsedRequestBody.success) return invalidRequestBodyResponse(parsedRequestBody.error);

    let parsed;
    try {
      parsed = UpdateChannelSchema.parse(parsedRequestBody.body);
    } catch (error) {
      return invalidRequestBodyResponse(formatValidationError(error));
    }

    const timestamp = nowIso(nowFn);
    await repo.updateChannel(channelId, toChannelUpdateRow(parsed, timestamp));

    const modelChanges = { updated_count: 0, created_count: 0, skipped: [], deleted_count: 0, delete_skipped: [] };
    for (const modelId of parsed.deletedModelIds || []) {
      const existingModel = await repo.getModelById(modelId);
      if (!existingModel || existingModel.channel_id !== channelId) {
        modelChanges.delete_skipped.push({ id: modelId, reason: MODEL_UPDATE_SKIPPED_REASONS.MODEL_NOT_FOUND });
        continue;
      }
      await repo.deleteModelById(modelId);
      modelChanges.deleted_count += 1;
    }

    for (const model of parsed.models || []) {
      if (model.id) {
        const existingModel = await repo.getModelById(model.id);
        if (!existingModel || existingModel.channel_id !== channelId) {
          modelChanges.skipped.push({ id: model.id, reason: MODEL_UPDATE_SKIPPED_REASONS.MODEL_NOT_FOUND });
          continue;
        }
        await repo.updateModelById(model.id, toModelUpdateRow(model, timestamp));
        modelChanges.updated_count += 1;
        continue;
      }

      if (!model.code || !model.name) {
        modelChanges.skipped.push({ id: '', reason: MODEL_UPDATE_SKIPPED_REASONS.MISSING_REQUIRED_FIELDS });
        continue;
      }
      await repo.createModels(channelId, [model], [uuidFn()], timestamp);
      modelChanges.created_count += 1;
    }

    return handleGetChannel(channelId, env, HTTP_STATUS.OK, { model_changes: modelChanges });
  }

  async function handleDeleteChannel(channelId, env) {
    const repo = getRepo(env);
    if (!(await repo.getChannelById(channelId))) {
      return errorResponse(ERROR_MESSAGES.CHANNEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    await repo.deleteChannel(channelId);
    return jsonResponse({ success: true }, HTTP_STATUS.OK);
  }

  async function handleListChannels(request, env) {
    let pagination;
    try {
      pagination = parsePagination(new URL(request.url));
    } catch (error) {
      return invalidRequestBodyResponse(formatValidationError(error));
    }
    const { data, total } = await getRepo(env).listChannelsWithModels(pagination);
    return jsonResponse(buildPaginatedResponse(data, total, pagination), HTTP_STATUS.OK);
  }

  async function handleGetModel(modelId, env) {
    const model = await getRepo(env).getModelById(modelId);
    if (!model) return errorResponse(ERROR_MESSAGES.MODEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    return jsonResponse({ success: true, data: model }, HTTP_STATUS.OK);
  }

  async function handleUpdateModel(modelId, request, env) {
    const repo = getRepo(env);
    const model = await repo.getModelById(modelId);
    if (!model) return errorResponse(ERROR_MESSAGES.MODEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    let batchOptions;
    try {
      batchOptions = parseModelBatchOptions(request);
    } catch (error) {
      return invalidRequestBodyResponse(error instanceof Error ? error.message : String(error));
    }

    const parsedRequestBody = await parseRequestBody(request);
    if (!parsedRequestBody.success) return invalidRequestBodyResponse(parsedRequestBody.error);

    let parsed;
    try {
      parsed = UpdateModelSchema.parse(parsedRequestBody.body);
    } catch (error) {
      return invalidRequestBodyResponse(formatValidationError(error));
    }

    const updates = toModelUpdateRow(parsed, nowIso(nowFn));
    if (batchOptions.syncScope === MODEL_SYNC_SCOPES.BY_CODE) {
      const rows = await repo.updateModelsByCode(model.code, updates, batchOptions.channelId);
      return jsonResponse({
        success: true,
        data: rows.find((row) => row.id === modelId) || rows[0] || null,
        affected: { scope: batchOptions.syncScope, channel_id: batchOptions.channelId, count: rows.length },
      }, HTTP_STATUS.OK);
    }

    await repo.updateModelById(modelId, updates);
    const updatedModel = await repo.getModelById(modelId);
    return jsonResponse({
      success: true,
      data: updatedModel,
      affected: { scope: batchOptions.syncScope, channel_id: '', count: updatedModel ? 1 : 0 },
    }, HTTP_STATUS.OK);
  }

  async function handleDeleteModel(modelId, request, env) {
    const repo = getRepo(env);
    const model = await repo.getModelById(modelId);
    if (!model) return errorResponse(ERROR_MESSAGES.MODEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    let batchOptions;
    try {
      batchOptions = parseModelBatchOptions(request);
    } catch (error) {
      return invalidRequestBodyResponse(error instanceof Error ? error.message : String(error));
    }

    if (batchOptions.syncScope === MODEL_SYNC_SCOPES.BY_CODE) {
      const count = await repo.deleteModelsByCode(model.code, batchOptions.channelId);
      return jsonResponse({
        success: true,
        affected: { scope: batchOptions.syncScope, channel_id: batchOptions.channelId, count },
      }, HTTP_STATUS.OK);
    }

    await repo.deleteModelById(modelId);
    return jsonResponse({ success: true, affected: { scope: batchOptions.syncScope, channel_id: '', count: 1 } }, HTTP_STATUS.OK);
  }

  async function handleGetLogs(request, env) {
    let parsed;
    try {
      parsed = LogQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    } catch (error) {
      return invalidRequestBodyResponse(formatValidationError(error));
    }
    const { data, total } = await getRepo(env).getLogs(parsed);
    return jsonResponse(buildPaginatedResponse(data, total, parsed), HTTP_STATUS.OK);
  }

  async function handleStatus(env) {
    const rows = await getRepo(env).getStatusRows();
    return jsonResponse({
      models: rows.map((row) => ({
        code: row.code,
        name: row.name,
        status: row.status,
        channel_name: row.channel_name,
        provider: row.provider,
        call_type: row.call_type,
        success_rate: row.success_rate,
        avg_latency_ms: row.avg_latency_ms,
        consecutive_failures: row.consecutive_failures,
        cooldown_until: row.cooldown_until,
        request_count: row.request_count,
        input_usage: row.input_usage,
        outpu_usage: row.outpu_usage,
        total_cost: row.total_cost,
      })),
    }, HTTP_STATUS.OK);
  }

  async function handleGetChannelModels(channelId, env) {
    const channel = await getRepo(env).getChannelById(channelId);
    if (!channel) return errorResponse(ERROR_MESSAGES.CHANNEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    return getChannelModels(channel, env);
  }

  async function handleGetChannelModelsByConnection(request, env) {
    const parsedRequestBody = await parseRequestBody(request);
    if (!parsedRequestBody.success) return invalidRequestBodyResponse(parsedRequestBody.error);

    let parsed;
    try {
      parsed = UpstreamModelListSchema.parse(parsedRequestBody.body);
    } catch (error) {
      return invalidRequestBodyResponse(formatValidationError(error));
    }
    return getChannelModels({ provider: parsed.provider, api_key: parsed.apiKey, base_url: parsed.baseURL }, env);
  }

  async function getChannelModels(channel, env) {
    try {
      return jsonResponse({ success: true, data: await fetchUpstreamModels(channel, env) }, HTTP_STATUS.OK);
    } catch (error) {
      return jsonResponse({ success: false, data: [], error: error.message || 'Failed to fetch upstream models' }, HTTP_STATUS.OK);
    }
  }

  async function fetchUpstreamModels(channel, env) {
    const normalizedProvider = normalizeProvider(channel.provider);
    if ([PROVIDERS.ANTHROPIC, PROVIDERS.EXACG, PROVIDERS.MICROSOFT_TTS].includes(normalizedProvider)) return [];

    const modelsURL = buildModelsUrl(channel.base_url || getDefaultBaseURL(normalizedProvider));
    const headers = { [HEADERS.CONTENT_TYPE]: JSON_CONTENT_TYPE };
    if (normalizedProvider === PROVIDERS.GOOGLE) {
      const url = new URL(modelsURL);
      url.searchParams.set('key', channel.api_key);
      return fetchModelsFromUpstream(url.toString(), headers, env);
    }
    headers[HEADERS.AUTHORIZATION] = BEARER_PREFIX + channel.api_key;
    return fetchModelsFromUpstream(modelsURL, headers, env);
  }

  async function fetchModelsFromUpstream(url, headers, env) {
    const response = await getFetchFn(env)(url, { method: METHODS.GET, headers });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    const data = await response.json();

    if (data.object === UPSTREAM_MODEL_OBJECTS.LIST && Array.isArray(data.data)) {
      return data.data.map((model) => ({
        id: model.id,
        object: model.object || UPSTREAM_MODEL_OBJECTS.MODEL,
        created: model.created || 0,
        owned_by: model.owned_by || 'unknown',
      }));
    }
    if (Array.isArray(data)) {
      return data.map((model) => ({ id: model.id || model.name || model, object: UPSTREAM_MODEL_OBJECTS.MODEL, created: 0, owned_by: 'unknown' }));
    }
    return [];
  }

  function getDefaultBaseURL(provider) {
    switch (provider) {
      case PROVIDERS.OPENAI:
      case PROVIDERS.OPENAI_COMPATIBLE:
        return 'https://api.openai.com/v1';
      case PROVIDERS.GOOGLE:
        return 'https://generativelanguage.googleapis.com/v1beta';
      case PROVIDERS.OPENROUTER:
        return 'https://openrouter.ai/api/v1';
      case PROVIDERS.POLLINATIONS:
        return 'https://gen.pollinations.ai/v1';
      default:
        return '';
    }
  }

  async function routeAdminApi(request, env) {
    const { pathname } = new URL(request.url);
    if (!isAdmin(request, env)) return errorResponse(ERROR_MESSAGES.UNAUTHORIZED, HTTP_STATUS.UNAUTHORIZED);
    if (pathname === ROUTES.API_MODEL_CHECK_REMOVED) return errorResponse(ERROR_MESSAGES.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    if (pathname === ROUTES.API_CHANNELS && request.method === METHODS.GET) return handleListChannels(request, env);
    if (pathname === ROUTES.API_LOG && request.method === METHODS.GET) return handleGetLogs(request, env);
    if (pathname === ROUTES.API_CHANNEL && request.method === METHODS.POST) return handleCreateChannel(request, env);
    if (pathname === ROUTES.API_CHANNEL_MODELS && request.method === METHODS.POST) return handleGetChannelModelsByConnection(request, env);

    const channelModelsMatch = pathname.match(new RegExp(`^${ROUTES.API_CHANNEL_PREFIX}([^/]+)${ROUTES.API_CHANNEL_MODELS_SUFFIX}$`));
    if (channelModelsMatch && request.method === METHODS.GET) return handleGetChannelModels(channelModelsMatch[1], env);

    const channelId = extractPathParam(pathname, ROUTES.API_CHANNEL_PREFIX);
    if (channelId) {
      if (request.method === METHODS.GET) return handleGetChannel(channelId, env);
      if (request.method === METHODS.PUT) return handleUpdateChannel(channelId, request, env);
      if (request.method === METHODS.DELETE) return handleDeleteChannel(channelId, env);
    }

    const modelId = extractPathParam(pathname, ROUTES.API_MODEL_PREFIX);
    if (modelId) {
      if (request.method === METHODS.GET) return handleGetModel(modelId, env);
      if (request.method === METHODS.PUT) return handleUpdateModel(modelId, request, env);
      if (request.method === METHODS.DELETE) return handleDeleteModel(modelId, request, env);
    }

    return errorResponse(ERROR_MESSAGES.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }

  async function routeRequest(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === ROUTES.STATUS && request.method === METHODS.GET) return handleStatus(env);
    if (pathname.startsWith(ROUTES.API_PREFIX)) return routeAdminApi(request, env, ctx);
    return errorResponse(ERROR_MESSAGES.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }

  async function handleRequest(request, env, ctx) {
    try {
      if (request.method === METHODS.OPTIONS) return handleCorsPreflightRequest();
      return applyCors(await routeRequest(request, env, ctx));
    } catch (error) {
      console.error(error);
      return errorResponse(ERROR_MESSAGES.INTERNAL_ERROR, HTTP_STATUS.INTERNAL_ERROR);
    }
  }

  return {
    fetch: handleRequest,
    handleRequest,
    routeRequest,
    authenticate,
    isAdmin,
    routeAdminApi,
    handleCreateChannel,
    handleGetChannel,
    handleUpdateChannel,
    handleDeleteChannel,
    handleListChannels,
    handleGetModel,
    handleUpdateModel,
    handleDeleteModel,
    handleGetLogs,
    handleStatus,
    handleGetChannelModels,
    handleGetChannelModelsByConnection,
    getChannelModels,
    fetchUpstreamModels,
    fetchModelsFromUpstream,
    getDefaultBaseURL,
  };
}

const worker = createApp({ fetch: depsFetch });

export default worker;
export { CONSTANTS, SCHEMAS, createApp };
