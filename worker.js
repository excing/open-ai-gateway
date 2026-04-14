import { z } from 'zod';
import {
  generateText,
  streamText,
  generateImage,
  experimental_generateVideo,
  experimental_generateSpeech,
  experimental_transcribe,
  embed,
} from 'ai';
import { createFallback } from 'ai-fallback';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createPollinations } from './pollinations.js';
import { createExacg } from './exacg.js';

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
  },
  CALL_TYPES: {
    CHAT: 'chat',
    IMAGE_GEN: 'image_gen',
    AUDIO_GEN: 'audio_gen',
    VIDEO_GEN: 'video_gen',
    TRANSCRIBE: 'transcribe',
    EMBEDDING: 'embedding',
  },
  MODEL_CAPABILITIES: {
    CHAT: 'chat',
    IMAGE_IN: 'image_in',
    IMAGE_OUT: 'image_out',
    AUDIO_IN: 'audio_in',
    AUDIO_OUT: 'audio_out',
    VIDEO_IN: 'video_in',
    VIDEO_OUT: 'video_out',
    EMBEDDING: 'embedding',
  },
  MODEL_STATUS: {
    ACTIVE: 'active',
    OPEN: 'open',
    DISABLE: 'disable',
  },
  LOG_STATUS: {
    SUCCESS: 'success',
    ERROR: 'error',
  },
  COST_UNITS: {
    IMAGE: '/img',
    MILLION: '/M',
    SECOND: '/sec',
    REQUEST: '/req',
  },
  COOLDOWN_TIERS: [
    { minFailures: 2, maxFailures: 4, durationMs: 60_000 },
    { minFailures: 4, maxFailures: 8, durationMs: 300_000 },
    { minFailures: 8, maxFailures: 24, durationMs: 3_600_000 },
    { minFailures: 24, maxFailures: 32, durationMs: 86_400_000 },
    { minFailures: 32, maxFailures: Infinity, durationMs: 259_200_000 },
  ],
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  SCORE_WEIGHTS: {
    WEIGHT_FACTOR: 10,
    SUCCESS_RATE_FACTOR: 50,
    LATENCY_PENALTY: 0.01,
    FAILURE_PENALTY: 20,
  },
  EMA_ALPHA: 0.3,
  MODEL_CHECK: {
    TEST_PROMPT: 'Say "OK" if you can read this message.',
    TEST_EMBEDDING_INPUT: 'test',
    TEST_SPEECH_TEXT: 'test',
    TEST_IMAGE_PROMPT: 'a white circle on black background',
    TEST_TRANSCRIBE_AUDIO_PATH: '/hellowhatareyoudoing.mp3',
    TIMEOUT_ERROR_PREFIX: 'Model check timed out after ',
    DEFAULT_TIMEOUT_MS: 30_000,
    MIN_TIMEOUT_MS: 1,
    MAX_TIMEOUT_MS: 120_000,
  },
  HTTP_STATUS: {
    OK: 200,
    CREATED: 201,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    INTERNAL_ERROR: 500,
    SERVICE_UNAVAILABLE: 503,
  },
  ERROR_MESSAGES: {
    UNAUTHORIZED: 'Missing or invalid authorization token',
    FORBIDDEN: 'Insufficient permissions',
    NOT_FOUND: 'Resource not found',
    MODEL_NOT_FOUND: 'No available model found for the requested model identifier',
    CHANNEL_NOT_FOUND: 'Channel not found',
    METHOD_NOT_ALLOWED: 'Method not allowed',
    INVALID_REQUEST_BODY: 'Invalid request body',
    NO_MODEL_AVAILABLE: 'All models for this identifier are currently unavailable (cooldown or disabled)',
    PROVIDER_ERROR: 'Upstream AI provider returned an error',
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
    V1_MODELS: '/v1/models',
    V1_CHAT: '/v1/chat/completions',
    V1_IMAGES: '/v1/images/generations',
    V1_VIDEO: '/v1/video/generations',
    V1_AUDIO: '/v1/audio/speech',
    V1_TRANSCRIBE: '/v1/audio/transcriptions',
    V1_EMBEDDINGS: '/v1/embeddings',
    API_PREFIX: '/api',
    API_CHANNEL: '/api/channel',
    API_CHANNEL_PREFIX: '/api/channel/',
    API_CHANNEL_MODELS: '/api/channel/models',
    API_CHANNELS: '/api/channels',
    API_MODEL: '/api/model',
    API_MODEL_PREFIX: '/api/model/',
    API_LOG: '/api/log',
    API_CHANNEL_MODELS_SUFFIX: '/models',
    API_MODEL_CHECK_SUFFIX: '/check',
  },
  HEADERS: {
    AUTHORIZATION: 'authorization',
    CONTENT_TYPE: 'content-type',
    CHANNEL_ID: 'x-channel-id',
  },
  BEARER_PREFIX: 'Bearer ',
  JSON_CONTENT_TYPE: 'application/json',
  MULTIPART_CONTENT_TYPE: 'multipart/form-data',
  SSE_CONTENT_TYPE: 'text/event-stream',
  OPENAI_OBJECTS: {
    LIST: 'list',
    MODEL: 'model',
    EMBEDDING: 'embedding',
    CHAT_COMPLETION: 'chat.completion',
    CHAT_COMPLETION_CHUNK: 'chat.completion.chunk',
  },
  STREAM_DONE: '[DONE]',
  UUID_PREFIX: 'uuid-',
  SQL: {
    INSERT_CHANNEL: `INSERT INTO channels (id, name, key, provider, api_key, base_url, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    INSERT_MODEL: `INSERT INTO channel_models (id, channel_id, code, name, desc, aliases, call_type, capabilities, cost, status, weight, avg_latency_ms, success_rate, error_rate, consecutive_failures, cooldown_until, last_updated, headers) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
    SELECT_CHANNEL_BY_ID: `SELECT * FROM channels WHERE id = ?1`,
    SELECT_CHANNEL_BY_KEY: `SELECT * FROM channels WHERE key = ?1`,
    SELECT_MODELS_BY_CHANNEL_ID: `SELECT * FROM channel_models WHERE channel_id = ?1`,
    DELETE_MODELS_BY_CHANNEL_ID: `DELETE FROM channel_models WHERE channel_id = ?1`,
    DELETE_CHANNEL: `DELETE FROM channels WHERE id = ?1`,
    COUNT_CHANNELS: `SELECT COUNT(*) as total FROM channels`,
    SELECT_CHANNELS_PAGED: `SELECT * FROM channels ORDER BY created_at DESC LIMIT ?1 OFFSET ?2`,
    SELECT_MODEL_BY_ID: `SELECT * FROM channel_models WHERE id = ?1`,
    DELETE_MODEL: `DELETE FROM channel_models WHERE id = ?1`,
    INSERT_LOG: `INSERT INTO request_logs (id, channel_id, channel_name, model_id, model_code, call_type, request_model, status, error_message, latency_ms, input_tokens, output_tokens, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    SELECT_LOGS_BASE: `SELECT * FROM request_logs`,
    COUNT_LOGS_BASE: `SELECT COUNT(*) as total FROM request_logs`,
    SELECT_STATUS_BASE: `SELECT cm.*, c.name as channel_name FROM channel_models cm JOIN channels c ON cm.channel_id = c.id`,
    SELECT_MODELS_BY_IDENTIFIER_BASE: `SELECT cm.*, c.id as ch_id, c.name as ch_name, c.key as ch_key, c.provider, c.api_key, c.base_url FROM channel_models cm JOIN channels c ON cm.channel_id = c.id WHERE (cm.code = ?1 OR cm.aliases LIKE ?2) AND cm.status != ?3 AND (cm.cooldown_until IS NULL OR cm.cooldown_until < ?4)`,
    UPDATE_MODEL_STATS_BASE: `UPDATE channel_models SET `,
    UPDATE_CHANNEL_BASE: `UPDATE channels SET `,
    UPDATE_MODEL_BASE: `UPDATE channel_models SET `,
    SELECT_MODEL_FOR_STATS: `SELECT * FROM channel_models WHERE id = ?1`,
    DDL: {
      CREATE_CHANNELS_TABLE: `CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL DEFAULT 'openai',
        api_key TEXT NOT NULL,
        base_url TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      CREATE_CHANNEL_MODELS_TABLE: `CREATE TABLE IF NOT EXISTS channel_models (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        desc TEXT DEFAULT '',
        aliases TEXT DEFAULT '[]',
        call_type TEXT NOT NULL DEFAULT 'chat',
        capabilities TEXT DEFAULT '["chat"]',
        cost TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        weight REAL NOT NULL DEFAULT 1.0,
        avg_latency_ms REAL NOT NULL DEFAULT 0.0,
        success_rate REAL NOT NULL DEFAULT 1.0,
        error_rate REAL NOT NULL DEFAULT 0.0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        cooldown_until TEXT DEFAULT NULL,
        last_updated TEXT NOT NULL DEFAULT (datetime('now')),
        headers TEXT DEFAULT '{}',
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      )`,
      CREATE_REQUEST_LOGS_TABLE: `CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_code TEXT NOT NULL,
        call_type TEXT NOT NULL,
        request_model TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT DEFAULT '',
        latency_ms INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      CREATE_INDEX_CHANNEL_MODELS_CHANNEL_ID: `CREATE INDEX IF NOT EXISTS idx_channel_models_channel_id ON channel_models(channel_id)`,
      CREATE_INDEX_CHANNEL_MODELS_CODE: `CREATE INDEX IF NOT EXISTS idx_channel_models_code ON channel_models(code)`,
      CREATE_INDEX_CHANNEL_MODELS_STATUS: `CREATE INDEX IF NOT EXISTS idx_channel_models_status ON channel_models(status)`,
      CREATE_INDEX_CHANNEL_MODELS_CALL_TYPE: `CREATE INDEX IF NOT EXISTS idx_channel_models_call_type ON channel_models(call_type)`,
      CREATE_INDEX_REQUEST_LOGS_CREATED_AT: `CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at)`,
      CREATE_INDEX_REQUEST_LOGS_CHANNEL_ID: `CREATE INDEX IF NOT EXISTS idx_request_logs_channel_id ON request_logs(channel_id)`,
      CREATE_INDEX_REQUEST_LOGS_MODEL_ID: `CREATE INDEX IF NOT EXISTS idx_request_logs_model_id ON request_logs(model_id)`,
      CREATE_INDEX_REQUEST_LOGS_STATUS: `CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status)`,
    },
  },
};

const {
  PROVIDERS,
  CALL_TYPES,
  MODEL_STATUS,
  LOG_STATUS,
  SCORE_WEIGHTS,
  EMA_ALPHA,
  HTTP_STATUS,
  ERROR_MESSAGES,
  CORS_HEADERS,
  METHODS,
  ROUTES,
  HEADERS,
  BEARER_PREFIX,
  JSON_CONTENT_TYPE,
  MULTIPART_CONTENT_TYPE,
  SSE_CONTENT_TYPE,
  OPENAI_OBJECTS,
  STREAM_DONE,
  SQL,
} = CONSTANTS;

const CALL_TYPE_TO_PATH = {
  [CALL_TYPES.CHAT]: ROUTES.V1_CHAT,
  [CALL_TYPES.IMAGE_GEN]: ROUTES.V1_IMAGES,
  [CALL_TYPES.VIDEO_GEN]: ROUTES.V1_VIDEO,
  [CALL_TYPES.AUDIO_GEN]: ROUTES.V1_AUDIO,
  [CALL_TYPES.TRANSCRIBE]: ROUTES.V1_TRANSCRIBE,
  [CALL_TYPES.EMBEDDING]: ROUTES.V1_EMBEDDINGS,
};

const PATH_TO_CALL_TYPE = Object.fromEntries(
  Object.entries(CALL_TYPE_TO_PATH).map(([callType, path]) => [path, callType]),
);

CONSTANTS.CALL_TYPE_TO_PATH = CALL_TYPE_TO_PATH;
CONSTANTS.PATH_TO_CALL_TYPE = PATH_TO_CALL_TYPE;

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
  ]);

  const CallTypeEnum = z.enum([
    CALL_TYPES.CHAT,
    CALL_TYPES.IMAGE_GEN,
    CALL_TYPES.AUDIO_GEN,
    CALL_TYPES.VIDEO_GEN,
    CALL_TYPES.TRANSCRIBE,
    CALL_TYPES.EMBEDDING,
  ]);

  const CreateChannelSchema = z.object({
    name: z.string().min(1).max(100),
    key: z.string().regex(/^[a-z0-9-]+$/).min(1).max(50),
    provider: ProviderEnum.default(PROVIDERS.OPENAI),
    apiKey: z.string(),
    baseURL: z.string().url().or(z.literal('')).default(''),
    models: z
      .array(
        z.object({
          code: z.string().min(1),
          name: z.string().min(1),
          desc: z.string().default(''),
          aliases: z.array(z.string()).default([]),
          callType: CallTypeEnum.default(CALL_TYPES.CHAT),
          capabilities: z.array(z.string()).default([CALL_TYPES.CHAT]),
          cost: z.string().default(''),
          weight: z.number().min(0).max(100).default(1.0),
          headers: z.record(z.string()).default({}),
        }),
      )
      .default([]),
  });

  const UpdateChannelSchema = CreateChannelSchema.partial();

  const UpdateModelSchema = z
    .object({
      code: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      desc: z.string().optional(),
      aliases: z.array(z.string()).optional(),
      callType: CallTypeEnum.optional(),
      capabilities: z.array(z.string()).optional(),
      cost: z.string().optional(),
      status: z.enum([MODEL_STATUS.ACTIVE, MODEL_STATUS.OPEN, MODEL_STATUS.DISABLE]).optional(),
      weight: z.number().min(0).max(100).optional(),
      headers: z.record(z.string()).optional(),
    })
    .partial();

  const PaginationSchema = z.object({
    page: z.coerce.number().int().min(1).default(CONSTANTS.DEFAULT_PAGE),
    limit: z
      .coerce
      .number()
      .int()
      .min(1)
      .max(CONSTANTS.MAX_PAGE_SIZE)
      .default(CONSTANTS.DEFAULT_PAGE_SIZE),
  });

  const LogQuerySchema = PaginationSchema.extend({
    channel_id: z.string().optional(),
    model_id: z.string().optional(),
    status: z.enum([LOG_STATUS.SUCCESS, LOG_STATUS.ERROR]).optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
  });

  const UpstreamConnectionSchema = z.object({
    provider: ProviderEnum.default(PROVIDERS.OPENAI),
    apiKey: z.string().min(1),
    baseURL: z.string().url().or(z.literal('')).default(''),
  });

  const UpstreamModelListSchema = UpstreamConnectionSchema;

  const UpstreamModelCheckSchema = UpstreamConnectionSchema.extend({
    model: z.string().min(1),
    callType: CallTypeEnum,
    headers: z.record(z.string()).default({}),
    timeoutMs: z
      .coerce
      .number()
      .int()
      .min(CONSTANTS.MODEL_CHECK.MIN_TIMEOUT_MS)
      .max(CONSTANTS.MODEL_CHECK.MAX_TIMEOUT_MS)
      .default(CONSTANTS.MODEL_CHECK.DEFAULT_TIMEOUT_MS),
  });

  const ModelCheckSchema = UpstreamModelCheckSchema;

  return {
    ProviderEnum,
    CallTypeEnum,
    CreateChannelSchema,
    UpdateChannelSchema,
    UpdateModelSchema,
    PaginationSchema,
    LogQuerySchema,
    UpstreamModelListSchema,
    UpstreamModelCheckSchema,
    ModelCheckSchema,
  };
})();

const {
  CreateChannelSchema,
  UpdateChannelSchema,
  UpdateModelSchema,
  PaginationSchema,
  LogQuerySchema,
  UpstreamModelListSchema,
  UpstreamModelCheckSchema,
  ModelCheckSchema,
} = SCHEMAS;

function generateUUID() {
  return crypto.randomUUID();
}

function applyCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    headers.set(key, value);
  });
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

function parsePagination(url) {
  const params = Object.fromEntries(url.searchParams.entries());
  return PaginationSchema.parse(params);
}

async function parseRequestBody(request) {
  try {
    const contentType = request.headers.get(HEADERS.CONTENT_TYPE) || '';
    let body;
    if (contentType.includes(JSON_CONTENT_TYPE)) {
      body = await request.json();
    } else if (contentType.includes(MULTIPART_CONTENT_TYPE)) {
      const form = await request.formData();
      body = {};
      for (const [key, value] of form.entries()) {
        body[key] = value;
      }
    } else {
      body = await request.json();
    }
    return { success: true, body };
  } catch (error) {
    console.warn(error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function invalidRequestBodyResponse(parseErrorMessage) {
  const message = parseErrorMessage
    ? `${ERROR_MESSAGES.INVALID_REQUEST_BODY}: ${parseErrorMessage}`
    : ERROR_MESSAGES.INVALID_REQUEST_BODY;
  return errorResponse(message, HTTP_STATUS.BAD_REQUEST);
}

function formatValidationError(error) {
  if (error instanceof z.ZodError) {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    return details || 'Validation failed';
  }
  return error instanceof Error ? error.message : String(error);
}

function buildModelsUrl(baseURL) {
  const normalizedBaseURL = (baseURL || '').replace(/\/+$/, '');
  const versionSuffixPattern = /\/v\d+(?:[a-z]+\d*)?$/i;
  if (versionSuffixPattern.test(normalizedBaseURL)) {
    return `${normalizedBaseURL}${ROUTES.API_CHANNEL_MODELS_SUFFIX}`;
  }
  return `${normalizedBaseURL}${ROUTES.V1_MODELS}`;
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

function buildPaginatedResponse(data, total, pagination) {
  const totalPages = Math.ceil(total / pagination.limit) || 1;
  return {
    data,
    total,
    page: pagination.page,
    limit: pagination.limit,
    total_pages: totalPages,
  };
}

function normalizeProvider(provider) {
  if (provider === PROVIDERS.GEMINI) return PROVIDERS.GOOGLE;
  if (provider === PROVIDERS.CLAUDE) return PROVIDERS.ANTHROPIC;
  if (provider === PROVIDERS.OPENAI_COMPATIBLE) return PROVIDERS.OPENAI;
  return provider;
}

function nowIso(nowFn) {
  return nowFn().toISOString();
}

function toEpochSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function getProviderOptions(payload) {
  const value = payload?.extra_body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function pruneUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function calculateModelScore(modelRow) {
  return (
    modelRow.weight * SCORE_WEIGHTS.WEIGHT_FACTOR +
    modelRow.success_rate * SCORE_WEIGHTS.SUCCESS_RATE_FACTOR -
    modelRow.avg_latency_ms * SCORE_WEIGHTS.LATENCY_PENALTY -
    modelRow.consecutive_failures * SCORE_WEIGHTS.FAILURE_PENALTY
  );
}

function getCooldownDuration(failures) {
  for (const tier of CONSTANTS.COOLDOWN_TIERS) {
    if (failures >= tier.minFailures && failures < tier.maxFailures) {
      return tier.durationMs;
    }
  }
  return 0;
}

async function initializeDatabase(env) {
  if (!env?.DB) {
    throw new Error('Database is not configured');
  }
  if (env.__dbInitialized) {
    return;
  }

  const ddl = SQL.DDL;
  const statements = [
    ddl.CREATE_CHANNELS_TABLE,
    ddl.CREATE_CHANNEL_MODELS_TABLE,
    ddl.CREATE_REQUEST_LOGS_TABLE,
    ddl.CREATE_INDEX_CHANNEL_MODELS_CHANNEL_ID,
    ddl.CREATE_INDEX_CHANNEL_MODELS_CODE,
    ddl.CREATE_INDEX_CHANNEL_MODELS_STATUS,
    ddl.CREATE_INDEX_CHANNEL_MODELS_CALL_TYPE,
    ddl.CREATE_INDEX_REQUEST_LOGS_CREATED_AT,
    ddl.CREATE_INDEX_REQUEST_LOGS_CHANNEL_ID,
    ddl.CREATE_INDEX_REQUEST_LOGS_MODEL_ID,
    ddl.CREATE_INDEX_REQUEST_LOGS_STATUS,
  ];

  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }

  env.__dbInitialized = true;
}

// 自定义封装 fetch, 支持请求日志打印
const depsFetch = async function (input, init) {
  const url = typeof input === 'string' ? input : input.url;
  const method = init?.method || 'GET';

  // 打印请求的基本信息
  console.log(`Request: ${method} ${url}`);
  if (init?.headers) {
    console.log('Request Headers:', init.headers);
  }
  if (init?.body) {
    console.log('Request Body:', await getRequestBody(init.body));
  }

  // 执行实际的 fetch 请求
  const response = await fetch(input, init);

  // 打印响应的基本信息
  console.log(`Response: ${response.status} ${response.statusText}`);
  const responseBody = await response.clone().text(); // 克隆响应体以便读取
  console.log('Response Body:', responseBody);

  // 直接返回响应
  return response;
};

// 处理请求体为非字符串的情况
async function getRequestBody(body) {
  if (body instanceof FormData) {
    return '[FormData]'; // 你可以根据需要进一步处理 FormData
  }
  if (body instanceof Blob) {
    return '[Blob]'; // 处理 Blob
  }
  if (typeof body === 'string') {
    return body;
  }
  if (body) {
    return JSON.stringify(body);
  }
  return '';
}

async function normalizeTranscriptionAudioInput(input) {
  if (typeof input === 'string' || input instanceof Uint8Array || input instanceof ArrayBuffer) {
    return input;
  }

  if (input instanceof Blob) {
    const arrayBuffer = await input.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  if (input && typeof input === 'object') {
    if (input.data) return normalizeTranscriptionAudioInput(input.data);
    if (input.uint8ArrayData) return normalizeTranscriptionAudioInput(input.uint8ArrayData);
    if (input.base64) return normalizeTranscriptionAudioInput(input.base64);
    if (typeof input.arrayBuffer === 'function') {
      const arrayBuffer = await input.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    }
  }

  throw new Error('Invalid transcription file');
}

function createApp(deps = {}) {
  const providers = {
    createOpenAI: deps.providers?.createOpenAI || createOpenAI,
    createGoogleGenerativeAI: deps.providers?.createGoogleGenerativeAI || createGoogleGenerativeAI,
    createAnthropic: deps.providers?.createAnthropic || createAnthropic,
    createOpenRouter: deps.providers?.createOpenRouter || createOpenRouter,
    createPollinations: deps.providers?.createPollinations || createPollinations,
    createExacg: deps.providers?.createExacg || createExacg,
  };

  const ai = {
    generateText: deps.ai?.generateText || generateText,
    streamText: deps.ai?.streamText || streamText,
    generateImage: deps.ai?.generateImage || generateImage,
    experimental_generateVideo: deps.ai?.experimental_generateVideo || experimental_generateVideo,
    experimental_generateSpeech: deps.ai?.experimental_generateSpeech || experimental_generateSpeech,
    experimental_transcribe: deps.ai?.experimental_transcribe || experimental_transcribe,
    embed: deps.ai?.embed || embed,
  };

  const createFallbackModel = deps.createFallback || createFallback;
  const nowFn = deps.now || (() => new Date());
  const uuidFn = deps.uuid || generateUUID;
  const getFetchFn = (env) => (env?.ENV === 'dev' && deps.fetch ? deps.fetch : fetch);

  function authenticate(request, env) {
    const token = extractBearerToken(request);
    return Boolean(token && env.ADMIN_KEY && token === env.ADMIN_KEY);
  }

  function isAdmin(request, env) {
    return authenticate(request, env);
  }

  function getWaitUntil(env) {
    return env?.ctx?.waitUntil ? env.ctx.waitUntil.bind(env.ctx) : (promise) => promise;
  }

  function instantiateLanguageModel(channelName, baseURL, apiKey, headers, provider, callType, modelCode, env) {
    const normalizedProvider = normalizeProvider(provider);
    const unsupportedCallType = () => {
      throw new Error(`Provider ${normalizedProvider} does not support callType ${callType} for model ${modelCode}`);
    };

    switch (normalizedProvider) {
      case PROVIDERS.GOOGLE: {
        const providerInstance = providers.createGoogleGenerativeAI({ apiKey, baseURL, headers, name: channelName, fetch: getFetchFn(env) });
        switch (callType) {
          case CALL_TYPES.IMAGE_GEN:
            return providerInstance.image(modelCode);
          case CALL_TYPES.VIDEO_GEN:
            return providerInstance.video(modelCode);
          case CALL_TYPES.AUDIO_GEN:
          case CALL_TYPES.CHAT:
            return providerInstance.chat(modelCode);
          case CALL_TYPES.EMBEDDING:
            return providerInstance.embedding(modelCode);
          default:
            return unsupportedCallType();
        }
      }
      case PROVIDERS.ANTHROPIC: {
        const providerInstance = providers.createAnthropic({ apiKey, baseURL, headers, name: channelName, fetch: getFetchFn(env) });
        switch (callType) {
          case CALL_TYPES.CHAT:
            return providerInstance.chat(modelCode);
          case CALL_TYPES.EMBEDDING:
            return providerInstance.embeddingModel(modelCode);
          default:
            return unsupportedCallType();
        }
      }
      case PROVIDERS.OPENROUTER: {
        const providerInstance = providers.createOpenRouter({ apiKey, baseURL, headers, name: channelName, fetch: getFetchFn(env) });
        switch (callType) {
          case CALL_TYPES.IMAGE_GEN:
            return providerInstance.imageModel(modelCode);
          case CALL_TYPES.CHAT:
            return providerInstance.chat(modelCode);
          case CALL_TYPES.EMBEDDING:
            return providerInstance.textEmbeddingModel(modelCode);
          default:
            return unsupportedCallType();
        }
      }
      case PROVIDERS.POLLINATIONS: {
        const providerInstance = providers.createPollinations({ apiKey, baseURL, headers, name: channelName, fetch: getFetchFn(env) });
        switch (callType) {
          case CALL_TYPES.IMAGE_GEN:
            return providerInstance.image(modelCode);
          case CALL_TYPES.VIDEO_GEN:
            return providerInstance.video(modelCode);
          default:
            return unsupportedCallType();
        }
      }
      case PROVIDERS.EXACG: {
        const providerInstance = providers.createExacg({ apiKey, baseURL, headers, name: channelName, fetch: getFetchFn(env) });
        switch (callType) {
          case CALL_TYPES.IMAGE_GEN:
            return providerInstance.image(modelCode);
          default:
            return unsupportedCallType();
        }
      }
      case PROVIDERS.OPENAI:
      default: {
        const providerInstance = providers.createOpenAI({ apiKey, baseURL, headers, name: channelName, fetch: getFetchFn(env) });
        switch (callType) {
          case CALL_TYPES.IMAGE_GEN:
            return providerInstance.image(modelCode);
          case CALL_TYPES.AUDIO_GEN:
            return providerInstance.speech(modelCode);
          case CALL_TYPES.CHAT:
            return providerInstance.chat(modelCode);
          case CALL_TYPES.EMBEDDING:
            return providerInstance.embedding(modelCode);
          case CALL_TYPES.TRANSCRIBE:
            return providerInstance.transcription(modelCode);
          default:
            return unsupportedCallType();
        }
      }
    }
  }

  async function executeAIRequest(aiModel, callType, body) {
    const providerOptions = firstValue(body.extra_body, body.providerOptions);
    if (callType === CALL_TYPES.CHAT) {
      return ai.generateText(
        pruneUndefined({
          model: aiModel,
          messages: body.messages,
          prompt: body.prompt,
          maxTokens: firstValue(body.maxTokens, body.max_tokens),
          temperature: body.temperature,
          topP: firstValue(body.topP, body.top_p),
          frequencyPenalty: firstValue(body.frequencyPenalty, body.frequency_penalty),
          presencePenalty: firstValue(body.presencePenalty, body.presence_penalty),
          stopSequences: firstValue(body.stopSequences, body.stop),
          seed: body.seed,
          tools: body.tools,
          toolChoice: firstValue(body.toolChoice, body.tool_choice),
          responseFormat: firstValue(body.responseFormat, body.response_format),
          maxRetries: body.max_retries,
          headers: body.request_headers,
          providerOptions,
        }),
      );
    }
    if (callType === CALL_TYPES.IMAGE_GEN) {
      return ai.generateImage(
        pruneUndefined({
          model: aiModel,
          prompt: body.prompt,
          n: body.n,
          size: body.size,
          aspectRatio: firstValue(body.aspectRatio, body.aspect_ratio),
          seed: body.seed,
          responseFormat: firstValue(body.responseFormat, body.response_format),
          providerMetadata: firstValue(body.providerMetadata, body.provider_metadata),
          providerOptions,
        }),
      );
    }
    if (callType === CALL_TYPES.VIDEO_GEN) {
      return ai.experimental_generateVideo(
        pruneUndefined({
          model: aiModel,
          prompt: body.prompt,
          providerOptions,
        }),
      );
    }
    if (callType === CALL_TYPES.AUDIO_GEN) {
      return ai.experimental_generateSpeech(
        pruneUndefined({
          model: aiModel,
          text: body.input,
          voice: body.voice,
          outputFormat: firstValue(body.outputFormat, body.response_format, body.format),
          speed: body.speed,
          instructions: body.instructions,
          providerOptions,
        }),
      );
    }
    if (callType === CALL_TYPES.TRANSCRIBE) {
      const audio = await normalizeTranscriptionAudioInput(body.file);
      return ai.experimental_transcribe(
        pruneUndefined({
          model: aiModel,
          audio,
          language: body.language,
          prompt: body.prompt,
          temperature: body.temperature,
          responseFormat: firstValue(body.responseFormat, body.response_format),
          timestampGranularities: firstValue(body.timestampGranularities, body.timestamp_granularities),
          providerOptions,
        }),
      );
    }
    if (callType === CALL_TYPES.EMBEDDING) {
      return ai.embed(
        pruneUndefined({
          model: aiModel,
          value: firstValue(body.value, body.input),
          dimensions: body.dimensions,
          encodingFormat: firstValue(body.encodingFormat, body.encoding_format),
          user: body.user,
          providerOptions,
        }),
      );
    }
    throw new Error(`Unsupported call type ${callType}`);
  }

  function formatAIResponse(result, callType, modelCode) {
    const created = toEpochSeconds(nowFn());
    if (callType === CALL_TYPES.CHAT) {
      return jsonResponse({
        id: `${CONSTANTS.UUID_PREFIX}${uuidFn()}`,
        object: OPENAI_OBJECTS.CHAT_COMPLETION,
        created,
        model: modelCode,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.text || '' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: result.usage?.promptTokens || 0,
          completion_tokens: result.usage?.completionTokens || 0,
          total_tokens: result.usage?.totalTokens || 0,
        },
      });
    }

    if (callType === CALL_TYPES.IMAGE_GEN) {
      const data = (result.images || []).map((image) => ({ b64_json: image.base64 }));
      return jsonResponse({ created, data });
    }

    if (callType === CALL_TYPES.VIDEO_GEN) {
      const data = (result.videos || []).map((video) => {
        if (video?.url) {
          return { url: video.url };
        }
        if (video?.base64) {
          return { url: `data:${video.mediaType};base64,${video.base64}` };
        }
        if (video?.type === 'base64' && video?.data) {
          return { url: `data:${video.mediaType};base64,${video.data}` };
        }
        return { url: '' };
      }).filter((item) => item.url);
      return jsonResponse({ created, data });
    }

    if (callType === CALL_TYPES.AUDIO_GEN) {
      const mediaType = result.audio?.mediaType || 'audio/mpeg';
      const headers = new Headers({ [HEADERS.CONTENT_TYPE]: mediaType });
      Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));
      return new Response(result.audio?.uint8ArrayData || new Uint8Array(), { status: HTTP_STATUS.OK, headers });
    }

    if (callType === CALL_TYPES.TRANSCRIBE) {
      return jsonResponse({ text: result.text || '' });
    }

    if (callType === CALL_TYPES.EMBEDDING) {
      return jsonResponse({
        object: OPENAI_OBJECTS.LIST,
        data: [{ object: OPENAI_OBJECTS.EMBEDDING, embedding: result.embedding || [], index: 0 }],
        model: modelCode,
        usage: { prompt_tokens: result.usage?.promptTokens || 0, total_tokens: result.usage?.totalTokens || 0 },
      });
    }

    return errorResponse(ERROR_MESSAGES.INTERNAL_ERROR, HTTP_STATUS.INTERNAL_ERROR);
  }

  function toSseChunk(payload) {
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  function sseDoneChunk() {
    return `data: ${STREAM_DONE}\n\n`;
  }

  function createSseResponse(textStream, modelCode) {
    const created = toEpochSeconds(nowFn());
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for await (const chunk of textStream) {
          const payload = {
            id: `${CONSTANTS.UUID_PREFIX}${uuidFn()}`,
            object: OPENAI_OBJECTS.CHAT_COMPLETION_CHUNK,
            created,
            model: modelCode,
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
          };
          controller.enqueue(encoder.encode(toSseChunk(payload)));
        }
        controller.enqueue(encoder.encode(sseDoneChunk()));
        controller.close();
      },
    });
    const headers = new Headers({ [HEADERS.CONTENT_TYPE]: SSE_CONTENT_TYPE });
    Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));
    return new Response(stream, { status: HTTP_STATUS.OK, headers });
  }

  async function writeLog(entry, env) {
    const logId = uuidFn();
    const createdAt = nowIso(nowFn);
    await env.DB
      .prepare(SQL.INSERT_LOG)
      .bind(
        logId,
        entry.channel_id,
        entry.channel_name,
        entry.model_id,
        entry.model_code,
        entry.call_type,
        entry.request_model,
        entry.status,
        entry.error_message,
        entry.latency_ms,
        entry.input_tokens,
        entry.output_tokens,
        createdAt,
      )
      .run();
  }

  async function recordSuccess(modelId, latencyMs, env) {
    const model = await env.DB.prepare(SQL.SELECT_MODEL_FOR_STATS).bind(modelId).first();
    if (!model) return;

    const newAvg = model.avg_latency_ms * (1 - EMA_ALPHA) + latencyMs * EMA_ALPHA;
    const newSuccess = model.success_rate * (1 - EMA_ALPHA) + 1 * EMA_ALPHA;
    const newError = 1 - newSuccess;
    const updatedAt = nowIso(nowFn);

    const setClause = `avg_latency_ms = ?1, success_rate = ?2, error_rate = ?3, consecutive_failures = ?4, cooldown_until = ?5, status = ?6, last_updated = ?7`;
    const sql = `${SQL.UPDATE_MODEL_STATS_BASE}${setClause} WHERE id = ?8`;

    await env.DB
      .prepare(sql)
      .bind(newAvg, newSuccess, newError, 0, null, MODEL_STATUS.ACTIVE, updatedAt, modelId)
      .run();
  }

  async function recordFailure(modelId, env) {
    const model = await env.DB.prepare(SQL.SELECT_MODEL_FOR_STATS).bind(modelId).first();
    if (!model) return;

    const newFailures = model.consecutive_failures + 1;
    const newSuccess = model.success_rate * (1 - EMA_ALPHA) + 0 * EMA_ALPHA;
    const newError = 1 - newSuccess;
    const cooldownMs = getCooldownDuration(newFailures);
    const cooldownUntil = cooldownMs > 0 ? new Date(nowFn().getTime() + cooldownMs).toISOString() : null;
    const newStatus = cooldownMs > 0 ? MODEL_STATUS.OPEN : model.status;
    const updatedAt = nowIso(nowFn);

    const setClause = `consecutive_failures = ?1, success_rate = ?2, error_rate = ?3, cooldown_until = ?4, status = ?5, last_updated = ?6`;
    const sql = `${SQL.UPDATE_MODEL_STATS_BASE}${setClause} WHERE id = ?7`;

    await env.DB
      .prepare(sql)
      .bind(newFailures, newSuccess, newError, cooldownUntil, newStatus, updatedAt, modelId)
      .run();
  }

  async function selectModels(modelIdentifier, userCallType, env, channelId) {
    const nowValue = nowIso(nowFn);
    const baseQuery = SQL.SELECT_MODELS_BY_IDENTIFIER_BASE;
    const hasChannel = Boolean(channelId);
    const query = hasChannel ? `${baseQuery} AND cm.channel_id = ?5` : baseQuery;
    const params = [modelIdentifier, `\"${modelIdentifier}\"`, MODEL_STATUS.DISABLE, nowValue];
    if (hasChannel) params.push(channelId);
    const { results } = await env.DB.prepare(query).bind(...params).all();
    if (!results || results.length === 0) return [];

    const matched = results.filter((row) => row.call_type === userCallType);
    if (matched.length === 0) return [];

    return matched
      .map((row) => ({
        channel: {
          id: row.ch_id,
          name: row.ch_name,
          key: row.ch_key,
          provider: row.provider,
          api_key: row.api_key,
          base_url: row.base_url,
        },
        model: row,
        score: calculateModelScore(row),
      }))
      .sort((a, b) => b.score - a.score);
  }

  async function handleV1Proxy(request, env, userCallType) {
    const parsedRequestBody = await parseRequestBody(request);
    if (!parsedRequestBody.success) {
      return invalidRequestBodyResponse(parsedRequestBody.error);
    }
    const { body } = parsedRequestBody;
    if (!body || !body.model) {
      return invalidRequestBodyResponse();
    }

    const channelId = request.headers.get(HEADERS.CHANNEL_ID) || undefined;
    const isStream = userCallType === CALL_TYPES.CHAT && body.stream === true;
    const candidates = await selectModels(body.model, userCallType, env, channelId);
    if (candidates.length === 0) {
      return errorResponse(ERROR_MESSAGES.NO_MODEL_AVAILABLE, HTTP_STATUS.SERVICE_UNAVAILABLE);
    }

    const waitUntil = getWaitUntil(env);

    if (isStream) {
      const models = candidates.map((candidate) =>
        instantiateLanguageModel(
          candidate.channel.name,
          candidate.channel.base_url,
          candidate.channel.api_key,
          safeJsonParse(candidate.model.headers, {}),
          candidate.channel.provider,
          candidate.model.call_type,
          candidate.model.code,
          env,
        ),
      );

      const modelMap = new Map(candidates.map((candidate) => [candidate.model.code, candidate]));

      const fallbackModel = createFallbackModel({
        models,
        onError: async (error, modelId) => {
          const selection = modelMap.get(modelId);
          if (!selection) return;
          const latencyMs = 0;
          waitUntil(recordFailure(selection.model.id, env));
          waitUntil(
            writeLog(
              {
                channel_id: selection.channel.id,
                channel_name: selection.channel.name,
                model_id: selection.model.id,
                model_code: selection.model.code,
                call_type: userCallType,
                request_model: body.model,
                status: LOG_STATUS.ERROR,
                error_message: error?.message || ERROR_MESSAGES.PROVIDER_ERROR,
                latency_ms: latencyMs,
                input_tokens: 0,
                output_tokens: 0,
              },
              env,
            ),
          );
        },
      });

      const startTime = nowFn().getTime();
      const result = await ai.streamText({
        ...pruneUndefined({
          model: fallbackModel,
          messages: body.messages,
          prompt: body.prompt,
          maxTokens: firstValue(body.maxTokens, body.max_tokens),
          temperature: body.temperature,
          topP: firstValue(body.topP, body.top_p),
          frequencyPenalty: firstValue(body.frequencyPenalty, body.frequency_penalty),
          presencePenalty: firstValue(body.presencePenalty, body.presence_penalty),
          stopSequences: firstValue(body.stopSequences, body.stop),
          seed: body.seed,
          tools: body.tools,
          toolChoice: firstValue(body.toolChoice, body.tool_choice),
          responseFormat: firstValue(body.responseFormat, body.response_format),
          providerOptions: firstValue(body.extra_body, body.providerOptions),
        }),
        onFinish: async (event) => {
          const latencyMs = nowFn().getTime() - startTime;
          const selection = modelMap.get(fallbackModel.modelId) || candidates[0];
          waitUntil(recordSuccess(selection.model.id, latencyMs, env));
          waitUntil(
            writeLog(
              {
                channel_id: selection.channel.id,
                channel_name: selection.channel.name,
                model_id: selection.model.id,
                model_code: selection.model.code,
                call_type: userCallType,
                request_model: body.model,
                status: LOG_STATUS.SUCCESS,
                error_message: '',
                latency_ms: latencyMs,
                input_tokens: event.usage?.promptTokens || 0,
                output_tokens: event.usage?.completionTokens || 0,
              },
              env,
            ),
          );
        },
      });

      return createSseResponse(result.textStream, candidates[0].model.code);
    }

    let lastError = null;
    for (const selection of candidates) {
      const startTime = nowFn().getTime();
      try {
        const aiModel = instantiateLanguageModel(
          selection.channel.name,
          selection.channel.base_url,
          selection.channel.api_key,
          safeJsonParse(selection.model.headers, {}),
          selection.channel.provider,
          selection.model.call_type,
          selection.model.code,
          env,
        );

        const result = await executeAIRequest(aiModel, selection.model.call_type, body);
        const latencyMs = nowFn().getTime() - startTime;

        waitUntil(recordSuccess(selection.model.id, latencyMs, env));
        waitUntil(
          writeLog(
            {
              channel_id: selection.channel.id,
              channel_name: selection.channel.name,
              model_id: selection.model.id,
              model_code: selection.model.code,
              call_type: userCallType,
              request_model: body.model,
              status: LOG_STATUS.SUCCESS,
              error_message: '',
              latency_ms: latencyMs,
              input_tokens: result.usage?.promptTokens || 0,
              output_tokens: result.usage?.completionTokens || 0,
            },
            env,
          ),
        );

        return formatAIResponse(result, selection.model.call_type, selection.model.code);
      } catch (error) {
        console.error(error);
        const latencyMs = nowFn().getTime() - startTime;
        lastError = error;
        waitUntil(recordFailure(selection.model.id, env));
        waitUntil(
          writeLog(
            {
              channel_id: selection.channel.id,
              channel_name: selection.channel.name,
              model_id: selection.model.id,
              model_code: selection.model.code,
              call_type: userCallType,
              request_model: body.model,
              status: LOG_STATUS.ERROR,
              error_message: error?.message || ERROR_MESSAGES.PROVIDER_ERROR,
              latency_ms: latencyMs,
              input_tokens: 0,
              output_tokens: 0,
            },
            env,
          ),
        );
      }
    }

    return errorResponse(lastError?.message || ERROR_MESSAGES.PROVIDER_ERROR, HTTP_STATUS.INTERNAL_ERROR);
  }

  async function handleModelsList(request, env) {
    const { results } = await env.DB.prepare(SQL.SELECT_STATUS_BASE).all();
    const seen = new Set();
    const data = results
      .filter((row) => row.status !== MODEL_STATUS.DISABLE)
      .filter((row) => {
        if (seen.has(row.code)) return false;
        seen.add(row.code);
        return true;
      })
      .map((row) => ({
        id: row.code,
        object: OPENAI_OBJECTS.MODEL,
        created: toEpochSeconds(nowFn()),
        owned_by: row.channel_name || 'unknown',
      }));

    return jsonResponse({ object: OPENAI_OBJECTS.LIST, data });
  }

  async function handleCreateChannel(request, env) {
    const parsedRequestBody = await parseRequestBody(request);
    if (!parsedRequestBody.success) {
      return invalidRequestBodyResponse(parsedRequestBody.error);
    }
    const { body } = parsedRequestBody;
    if (!body) return invalidRequestBodyResponse();

    let parsed;
    try {
      parsed = CreateChannelSchema.parse(body);
    } catch (error) {
      return invalidRequestBodyResponse(formatValidationError(error));
    }

    const existing = await env.DB.prepare(SQL.SELECT_CHANNEL_BY_KEY).bind(parsed.key).first();
    if (existing) {
      return errorResponse(ERROR_MESSAGES.FORBIDDEN, HTTP_STATUS.FORBIDDEN);
    }

    const channelId = uuidFn();
    const timestamp = nowIso(nowFn);

    await env.DB
      .prepare(SQL.INSERT_CHANNEL)
      .bind(channelId, parsed.name, parsed.key, parsed.provider, parsed.apiKey, parsed.baseURL, timestamp, timestamp)
      .run();

    for (const model of parsed.models) {
      const modelId = uuidFn();
      await env.DB
        .prepare(SQL.INSERT_MODEL)
        .bind(
          modelId,
          channelId,
          model.code,
          model.name,
          model.desc,
          JSON.stringify(model.aliases || []),
          model.callType,
          JSON.stringify(model.capabilities || []),
          model.cost,
          MODEL_STATUS.ACTIVE,
          model.weight,
          0,
          1,
          0,
          0,
          null,
          timestamp,
          JSON.stringify(model.headers || {}),
        )
        .run();
    }

    return handleGetChannel(channelId, env, HTTP_STATUS.CREATED);
  }

  async function handleGetChannel(channelId, env, status = HTTP_STATUS.OK) {
    const channel = await env.DB.prepare(SQL.SELECT_CHANNEL_BY_ID).bind(channelId).first();
    if (!channel) return errorResponse(ERROR_MESSAGES.CHANNEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    const { results: models } = await env.DB.prepare(SQL.SELECT_MODELS_BY_CHANNEL_ID).bind(channelId).all();
    return jsonResponse({ success: true, data: { ...channel, models } }, status);
  }

  async function handleUpdateChannel(channelId, request, env) {
    const channel = await env.DB.prepare(SQL.SELECT_CHANNEL_BY_ID).bind(channelId).first();
    if (!channel) return errorResponse(ERROR_MESSAGES.CHANNEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const parsedRequestBody = await parseRequestBody(request);
    if (!parsedRequestBody.success) {
      return invalidRequestBodyResponse(parsedRequestBody.error);
    }
    const { body } = parsedRequestBody;
    if (!body) return invalidRequestBodyResponse();

    let parsed;
    try {
      parsed = UpdateChannelSchema.parse(body);
    } catch (error) {
      return invalidRequestBodyResponse(formatValidationError(error));
    }

    const updates = [];
    const values = [];
    const pushUpdate = (field, value) => {
      updates.push(`${field} = ?${updates.length + 1}`);
      values.push(value);
    };

    if (parsed.name) pushUpdate('name', parsed.name);
    if (parsed.key) pushUpdate('key', parsed.key);
    if (parsed.provider) pushUpdate('provider', parsed.provider);
    if (parsed.apiKey) pushUpdate('api_key', parsed.apiKey);
    if (parsed.baseURL !== undefined) pushUpdate('base_url', parsed.baseURL);

    pushUpdate('updated_at', nowIso(nowFn));

    if (updates.length > 0) {
      const sql = `${SQL.UPDATE_CHANNEL_BASE}${updates.join(', ')} WHERE id = ?${updates.length + 1}`;
      await env.DB.prepare(sql).bind(...values, channelId).run();
    }

    if (parsed.models) {
      await env.DB.prepare(SQL.DELETE_MODELS_BY_CHANNEL_ID).bind(channelId).run();
      const timestamp = nowIso(nowFn);
      for (const model of parsed.models) {
        const modelId = uuidFn();
        await env.DB
          .prepare(SQL.INSERT_MODEL)
          .bind(
            modelId,
            channelId,
            model.code,
            model.name,
            model.desc || '',
            JSON.stringify(model.aliases || []),
            model.callType || CALL_TYPES.CHAT,
            JSON.stringify(model.capabilities || []),
            model.cost || '',
            MODEL_STATUS.ACTIVE,
            model.weight ?? 1,
            0,
            1,
            0,
            0,
            null,
            timestamp,
            JSON.stringify(model.headers || {}),
          )
          .run();
      }
    }

    return handleGetChannel(channelId, env, HTTP_STATUS.OK);
  }

  async function handleDeleteChannel(channelId, env) {
    const channel = await env.DB.prepare(SQL.SELECT_CHANNEL_BY_ID).bind(channelId).first();
    if (!channel) return errorResponse(ERROR_MESSAGES.CHANNEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    await env.DB.prepare(SQL.DELETE_MODELS_BY_CHANNEL_ID).bind(channelId).run();
    await env.DB.prepare(SQL.DELETE_CHANNEL).bind(channelId).run();

    return jsonResponse({ success: true }, HTTP_STATUS.OK);
  }

  async function handleListChannels(request, env) {
    const url = new URL(request.url);
    let pagination;
    try {
      pagination = parsePagination(url);
    } catch (error) {
      return invalidRequestBodyResponse(formatValidationError(error));
    }
    const { results } = await env.DB.prepare(SQL.COUNT_CHANNELS).all();
    const total = results?.[0]?.total || 0;
    const { results: channels } = await env.DB
      .prepare(SQL.SELECT_CHANNELS_PAGED)
      .bind(pagination.limit, (pagination.page - 1) * pagination.limit)
      .all();

    const data = [];
    for (const channel of channels) {
      const { results: models } = await env.DB.prepare(SQL.SELECT_MODELS_BY_CHANNEL_ID).bind(channel.id).all();
      data.push({ ...channel, models });
    }

    return jsonResponse(buildPaginatedResponse(data, total, pagination), HTTP_STATUS.OK);
  }

  async function handleGetModel(modelId, env) {
    const model = await env.DB.prepare(SQL.SELECT_MODEL_BY_ID).bind(modelId).first();
    if (!model) return errorResponse(ERROR_MESSAGES.MODEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    return jsonResponse({ success: true, data: model }, HTTP_STATUS.OK);
  }

  async function handleUpdateModel(modelId, request, env) {
    const model = await env.DB.prepare(SQL.SELECT_MODEL_BY_ID).bind(modelId).first();
    if (!model) return errorResponse(ERROR_MESSAGES.MODEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

    const parsedRequestBody = await parseRequestBody(request);
    if (!parsedRequestBody.success) {
      return invalidRequestBodyResponse(parsedRequestBody.error);
    }
    const { body } = parsedRequestBody;
    if (!body) return invalidRequestBodyResponse();

    let parsed;
    try {
      parsed = UpdateModelSchema.parse(body);
    } catch (error) {
      return invalidRequestBodyResponse(formatValidationError(error));
    }

    const updates = [];
    const values = [];
    const pushUpdate = (field, value) => {
      updates.push(`${field} = ?${updates.length + 1}`);
      values.push(value);
    };

    if (parsed.code) pushUpdate('code', parsed.code);
    if (parsed.name) pushUpdate('name', parsed.name);
    if (parsed.desc !== undefined) pushUpdate('desc', parsed.desc);
    if (parsed.aliases) pushUpdate('aliases', JSON.stringify(parsed.aliases));
    if (parsed.callType) pushUpdate('call_type', parsed.callType);
    if (parsed.capabilities) pushUpdate('capabilities', JSON.stringify(parsed.capabilities));
    if (parsed.cost !== undefined) pushUpdate('cost', parsed.cost);
    if (parsed.status) pushUpdate('status', parsed.status);
    if (parsed.weight !== undefined) pushUpdate('weight', parsed.weight);
    if (parsed.headers) pushUpdate('headers', JSON.stringify(parsed.headers));
    pushUpdate('last_updated', nowIso(nowFn));

    const sql = `${SQL.UPDATE_MODEL_BASE}${updates.join(', ')} WHERE id = ?${updates.length + 1}`;
    await env.DB.prepare(sql).bind(...values, modelId).run();

    return handleGetModel(modelId, env);
  }

  async function handleDeleteModel(modelId, env) {
    const model = await env.DB.prepare(SQL.SELECT_MODEL_BY_ID).bind(modelId).first();
    if (!model) return errorResponse(ERROR_MESSAGES.MODEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    await env.DB.prepare(SQL.DELETE_MODEL).bind(modelId).run();
    return jsonResponse({ success: true }, HTTP_STATUS.OK);
  }

  async function handleGetLogs(request, env) {
    const url = new URL(request.url);
    let parsed;
    try {
      parsed = LogQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
    } catch (error) {
      return invalidRequestBodyResponse(formatValidationError(error));
    }

    const { page, limit, channel_id, model_id, status, start_date, end_date } = parsed;
    const filters = [];
    const values = [];
    const pushFilter = (expression, value) => {
      filters.push(expression);
      values.push(value);
    };

    if (channel_id) pushFilter('channel_id = ?' + (values.length + 1), channel_id);
    if (model_id) pushFilter('model_id = ?' + (values.length + 1), model_id);
    if (status) pushFilter('status = ?' + (values.length + 1), status);
    if (start_date) pushFilter('created_at >= ?' + (values.length + 1), start_date);
    if (end_date) pushFilter('created_at <= ?' + (values.length + 1), end_date);

    const whereClause = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
    const listSql = `${SQL.SELECT_LOGS_BASE}${whereClause} ORDER BY created_at DESC LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`;
    const countSql = `${SQL.COUNT_LOGS_BASE}${whereClause}`;

    const { results: totalRows } = await env.DB.prepare(countSql).bind(...values).all();
    const total = totalRows?.[0]?.total || 0;

    const { results } = await env.DB
      .prepare(listSql)
      .bind(...values, limit, (page - 1) * limit)
      .all();

    return jsonResponse(buildPaginatedResponse(results, total, { page, limit }), HTTP_STATUS.OK);
  }

  async function handleStatus(env) {
    const { results } = await env.DB.prepare(SQL.SELECT_STATUS_BASE).all();
    const models = results.map((row) => ({
      code: row.code,
      name: row.name,
      status: row.status,
      channel_name: row.channel_name,
      success_rate: row.success_rate,
      avg_latency_ms: row.avg_latency_ms,
      consecutive_failures: row.consecutive_failures,
    }));
    return jsonResponse({ models }, HTTP_STATUS.OK);
  }

  /**
   * 获取指定渠道上游的模型列表
   * 通过调用上游 provider 的 /v1/models API 获取可用模型列表
   * 
   * @param channelId - 渠道 ID
   * @param env - 环境变量
   * @returns { success: true, data: UpstreamModel[] } 或错误响应
   */
  async function handleGetChannelModels(channelId, env) {
    const channel = await env.DB.prepare(SQL.SELECT_CHANNEL_BY_ID).bind(channelId).first();
    if (!channel) {
      return errorResponse(ERROR_MESSAGES.CHANNEL_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }

    return getChannelModels(channel, env);
  }

  async function handleGetChannelModelsByConnection(request, env) {
    const parsedRequestBody = await parseRequestBody(request);
    if (!parsedRequestBody.success) {
      return invalidRequestBodyResponse(parsedRequestBody.error);
    }
    const { body } = parsedRequestBody;
    if (!body) return invalidRequestBodyResponse();

    let parsed;
    try {
      parsed = UpstreamModelListSchema.parse(body);
    } catch (error) {
      return invalidRequestBodyResponse(formatValidationError(error));
    }

    const channel = {
      provider: parsed.provider,
      api_key: parsed.apiKey,
      base_url: parsed.baseURL,
    };

    return getChannelModels(channel, env);
  }

  async function getChannelModels(channel, env) {
    try {
      const models = await fetchUpstreamModels(channel, env);
      return jsonResponse({ success: true, data: models }, HTTP_STATUS.OK);
    } catch (error) {
      return jsonResponse({
        success: true,
        data: [],
        error: error.message || 'Failed to fetch upstream models',
      }, HTTP_STATUS.OK);
    }
  }

  /**
   * 从上游 provider 获取模型列表
   * 
   * 各 provider 的模型列表 API：
   * - openai/openai-compatible: GET {baseURL}/v1/models
   * - google/gemini: 需要通过 REST API 获取
   * - anthropic/claude: 无公开的模型列表 API，返回空数组
   * - openrouter: GET https://openrouter.ai/api/v1/models
   * - pollinations: GET https://gen.pollinations.ai/v1/models
   * - exacg: 无公开的模型列表 API，返回空数组
   *
   * @param channel - 渠道数据库行
   * @returns UpstreamModel[] 上游模型列表
   */
  async function fetchUpstreamModels(channel, env) {
    const normalizedProvider = normalizeProvider(channel.provider);

    // Anthropic / Exacg 没有公开的模型列表 API
    if (
      normalizedProvider === PROVIDERS.ANTHROPIC ||
      normalizedProvider === PROVIDERS.EXACG
    ) {
      return [];
    }

    const baseURL = channel.base_url || getDefaultBaseURL(normalizedProvider);
    const modelsURL = buildModelsUrl(baseURL);

    const headers = {
      [HEADERS.CONTENT_TYPE]: JSON_CONTENT_TYPE,
    };

    // 设置认证头
    if (normalizedProvider === PROVIDERS.GOOGLE) {
      // Google 使用 query parameter 认证
      const url = new URL(modelsURL);
      url.searchParams.set('key', channel.api_key);
      return fetchModelsFromUpstream(url.toString(), headers, env);
    } else {
      headers[HEADERS.AUTHORIZATION] = BEARER_PREFIX + channel.api_key;
    }

    return fetchModelsFromUpstream(modelsURL, headers, env);
  }

  /**
   * 从上游 URL 获取模型列表
   * 
   * @param url - 上游 API URL
   * @param headers - 请求头
   * @returns UpstreamModel[] 模型列表
   */
  async function fetchModelsFromUpstream(url, headers, env) {
    const response = await getFetchFn(env)(url, {
      method: METHODS.GET,
      headers,
    });

    if (!response.ok) {
      throw new Error(`Upstream returned ${response.status}`);
    }

    const data = await response.json();

    // OpenAI 兼容格式: { object: 'list', data: [{ id, object, created, owned_by }] }
    if (data.object === OPENAI_OBJECTS.LIST && Array.isArray(data.data)) {
      return data.data.map((model) => ({
        id: model.id,
        object: model.object || OPENAI_OBJECTS.MODEL,
        created: model.created || 0,
        owned_by: model.owned_by || 'unknown',
      }));
    }

    // 其他格式，尝试直接返回数组
    if (Array.isArray(data)) {
      return data.map((model) => ({
        id: model.id || model.name || model,
        object: OPENAI_OBJECTS.MODEL,
        created: 0,
        owned_by: 'unknown',
      }));
    }

    return [];
  }

  /**
   * 获取 provider 的默认 baseURL
   * 
   * @param provider - provider 标识
   * @returns 默认 baseURL
   */
  function getDefaultBaseURL(provider) {
    switch (provider) {
      case PROVIDERS.OPENAI:
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

  /**
   * 检测指定渠道下的指定上游模型可用性（无需模型已入库）
   * 
   * 检测两个维度：
   * 1. API 是否可访问（api_accessible）
   * 2. 响应是否有可用数据（data_available）
   *    - chat: 非空文本
   *    - image_gen: 非空图片数组
   *    - audio_gen: 非空音频数据
   *    - embedding: 非空向量数组
   *    - transcribe: 非空文本
   *    - video_gen: 非空视频数组
   * 
   * @param env - 环境变量
   * @returns { success: true, data: ModelCheckResult } 或错误响应
   */
  async function handleModelCheck(request, env) {
    // 1. 解析检测输入参数（直接使用前端传入的模型配置）
    const parsedRequestBody = await parseRequestBody(request);
    if (!parsedRequestBody.success) {
      return invalidRequestBodyResponse(parsedRequestBody.error);
    }
    const { body } = parsedRequestBody;
    if (!body) return invalidRequestBodyResponse();

    let parsed;
    try {
      parsed = ModelCheckSchema.parse(body);
    } catch (error) {
      return invalidRequestBodyResponse(formatValidationError(error));
    }

    const transientChannel = {
      name: 'transient-channel',
      provider: parsed.provider,
      api_key: parsed.apiKey,
      base_url: parsed.baseURL,
    };

    // 3. 实例化模型
    let aiModel;
    try {
      aiModel = instantiateLanguageModel(
        transientChannel.name,
        transientChannel.base_url,
        transientChannel.api_key,
        parsed.headers,
        transientChannel.provider,
        parsed.callType,
        parsed.model,
        env,
      );
    } catch (error) {
      return jsonResponse({
        success: true,
        data: {
          model_code: parsed.model,
          call_type: parsed.callType,
          api_accessible: false,
          data_available: false,
          latency_ms: 0,
          error_message: error.message || 'Failed to instantiate model',
        },
      }, HTTP_STATUS.SERVICE_UNAVAILABLE);
    }

    // 4. 执行检测请求
    const startTime = nowFn().getTime();
    let apiAccessible = false;
    let dataAvailable = false;
    let errorMessage = '';

    try {
      const result = await executeModelCheck(aiModel, parsed.callType, parsed.timeoutMs, request, env, getProviderOptions(body));
      apiAccessible = true;
      dataAvailable = result.dataAvailable;
    } catch (error) {
      errorMessage = error.message || 'Unknown error';
    }

    const latencyMs = nowFn().getTime() - startTime;

    // 5. 返回检测结果
    return jsonResponse({
      success: true,
      data: {
        model_code: parsed.model,
        call_type: parsed.callType,
        api_accessible: apiAccessible,
        data_available: dataAvailable,
        latency_ms: latencyMs,
        error_message: errorMessage,
      },
    }, HTTP_STATUS.OK);
  }

  async function loadModelCheckTranscribeAudio(request, env) {
    const audioUrl = new URL(CONSTANTS.MODEL_CHECK.TEST_TRANSCRIBE_AUDIO_PATH, request.url).toString();
    const response = env?.ASSETS?.fetch
      ? await env.ASSETS.fetch(audioUrl)
      : await getFetchFn(env)(audioUrl);
    if (!response.ok) {
      throw new Error(`Failed to load transcribe check audio: ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * 执行模型可用性检测
   * 
   * @param aiModel - AI SDK 模型实例
   * @param callType - 调用类型
   * @returns { dataAvailable: boolean }
   */
  async function executeModelCheck(aiModel, callType, timeoutMs = CONSTANTS.MODEL_CHECK.DEFAULT_TIMEOUT_MS, request, env, providerOptions) {
    const checkPromise = (async () => {
      if (callType === CALL_TYPES.CHAT) {
        const result = await ai.generateText({
          model: aiModel,
          prompt: CONSTANTS.MODEL_CHECK.TEST_PROMPT,
          maxTokens: 64,
          providerOptions,
        });
        return { dataAvailable: Boolean(result.text && result.text.trim().length > 0) };
      }

      if (callType === CALL_TYPES.IMAGE_GEN) {
        const result = await ai.generateImage({
          model: aiModel,
          prompt: CONSTANTS.MODEL_CHECK.TEST_IMAGE_PROMPT,
          n: 1,
          providerOptions,
        });
        return { dataAvailable: Boolean(result.images && result.images.length > 0) };
      }

      if (callType === CALL_TYPES.AUDIO_GEN) {
        const result = await ai.experimental_generateSpeech({
          model: aiModel,
          text: CONSTANTS.MODEL_CHECK.TEST_SPEECH_TEXT,
          providerOptions,
        });
        return { dataAvailable: Boolean(result.audio && result.audio.data && result.audio.data.length > 0) };
      }

      if (callType === CALL_TYPES.EMBEDDING) {
        const result = await ai.embed({
          model: aiModel,
          value: CONSTANTS.MODEL_CHECK.TEST_EMBEDDING_INPUT,
          providerOptions,
        });
        return { dataAvailable: Boolean(result.embedding && result.embedding.length > 0) };
      }

      if (callType === CALL_TYPES.TRANSCRIBE) {
        const audio = await loadModelCheckTranscribeAudio(request, env);
        const result = await ai.experimental_transcribe({ model: aiModel, audio, providerOptions });
        return { dataAvailable: Boolean(result.text && result.text.trim().length > 0) };
      }

      if (callType === CALL_TYPES.VIDEO_GEN) {
        const result = await ai.experimental_generateVideo({
          model: aiModel,
          prompt: CONSTANTS.MODEL_CHECK.TEST_IMAGE_PROMPT,
          providerOptions,
        });
        return { dataAvailable: Boolean(result.videos && result.videos.length > 0) };
      }

      throw new Error(`Unsupported call type: ${callType}`);
    })();

    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`${CONSTANTS.MODEL_CHECK.TIMEOUT_ERROR_PREFIX}${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      return await Promise.race([checkPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async function routeAdminApi(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (!isAdmin(request, env)) {
      return errorResponse(ERROR_MESSAGES.UNAUTHORIZED, HTTP_STATUS.UNAUTHORIZED);
    }

    if (pathname === ROUTES.API_CHANNELS && request.method === METHODS.GET) {
      return handleListChannels(request, env);
    }

    if (pathname === ROUTES.API_LOG && request.method === METHODS.GET) {
      return handleGetLogs(request, env);
    }

    if (pathname === ROUTES.API_CHANNEL && request.method === METHODS.POST) {
      return handleCreateChannel(request, env);
    }

    if (pathname === ROUTES.API_CHANNEL_MODELS && request.method === METHODS.POST) {
      return handleGetChannelModelsByConnection(request, env);
    }

    // 兼容路由: GET /api/channel/:id/models - 获取已保存渠道的上游模型列表
    const channelModelsMatch = pathname.match(
      new RegExp(`^${ROUTES.API_CHANNEL_PREFIX}([^/]+)${ROUTES.API_CHANNEL_MODELS_SUFFIX}$`)
    );
    if (channelModelsMatch && request.method === METHODS.GET) {
      return handleGetChannelModels(channelModelsMatch[1], env);
    }

    // 新路由: POST /api/model/check - 检测模型可用性（无需模型入库）
    if (pathname === `${ROUTES.API_MODEL}${ROUTES.API_MODEL_CHECK_SUFFIX}` && request.method === METHODS.POST) {
      return handleModelCheck(request, env);
    }

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
      if (request.method === METHODS.DELETE) return handleDeleteModel(modelId, env);
    }

    return errorResponse(ERROR_MESSAGES.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }

  async function routeRequest(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === ROUTES.STATUS && request.method === METHODS.GET) {
      return handleStatus(env);
    }

    if (pathname === ROUTES.V1_MODELS && request.method === METHODS.GET) {
      if (!authenticate(request, env)) return errorResponse(ERROR_MESSAGES.UNAUTHORIZED, HTTP_STATUS.UNAUTHORIZED);
      return handleModelsList(request, env);
    }

    if (PATH_TO_CALL_TYPE[pathname] && request.method === METHODS.POST) {
      if (!authenticate(request, env)) return errorResponse(ERROR_MESSAGES.UNAUTHORIZED, HTTP_STATUS.UNAUTHORIZED);
      return handleV1Proxy(request, env, PATH_TO_CALL_TYPE[pathname]);
    }

    if (pathname.startsWith(ROUTES.API_PREFIX)) {
      return routeAdminApi(request, env);
    }

    return errorResponse(ERROR_MESSAGES.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }

  async function handleRequest(request, env) {
    try {
      if (request.method === METHODS.OPTIONS) {
        return handleCorsPreflightRequest();
      }
      await initializeDatabase(env);
      const response = await routeRequest(request, env);
      return applyCors(response);
    } catch (error) {
      console.error(error)
      return errorResponse(ERROR_MESSAGES.INTERNAL_ERROR, HTTP_STATUS.INTERNAL_ERROR);
    }
  }

  return {
    fetch: handleRequest,
    handleRequest,
    routeRequest,
    authenticate,
    isAdmin,
    initializeDatabase,
    instantiateLanguageModel,
    executeAIRequest,
    formatAIResponse,
    handleV1Proxy,
    handleModelsList,
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
    fetchUpstreamModels,
    fetchModelsFromUpstream,
    getDefaultBaseURL,
    handleModelCheck,
    executeModelCheck,
    selectModels,
    recordSuccess,
    recordFailure,
    writeLog,
  };
}

const worker = createApp({fetch: depsFetch});

export default worker;
export { CONSTANTS, SCHEMAS, CALL_TYPE_TO_PATH, PATH_TO_CALL_TYPE, createApp, initializeDatabase };
