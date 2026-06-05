import { CALL_TYPES } from '../../model-selection.js';
import { ProviderResponseError } from './openai-compatible.js';

const EXACG_ADAPTER_ID = 'exacg';
const EXACG_DEFAULT_BASE_URL = 'https://sd.exacg.cc/api/v1';
const EXACG_ENDPOINTS = {
  GENERATE_IMAGE: '/generate_image',
};
const EXACG_PROVIDER_OPTIONS_KEYS = ['providerOptions', 'provider_options'];
const EXACG_PROVIDER_OPTIONS_NAMESPACE = EXACG_ADAPTER_ID;
const EXACG_OPTION_FIELDS = ['negative_prompt', 'steps', 'cfg', 'image_source'];
const EXACG_DEFAULT_NEGATIVE_PROMPT = 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]';
const EXACG_RESPONSE_KEYS = {
  DATA: 'data',
  ERROR: 'error',
  IMAGE_URL: 'image_url',
  MESSAGE: 'message',
  SUCCESS: 'success',
};
const EXACG_REQUEST_DEFAULTS = {
  SEED: 0,
  STEPS: 30,
  CHECK_PROMPT: 'a white circle on black background',
  TIMEOUT_PREFIX: 'Model check timed out after ',
};
const HTTP_METHODS = {
  POST: 'POST',
};
const HEADERS = {
  AUTHORIZATION: 'authorization',
  CONTENT_TYPE: 'content-type',
};
const JSON_CONTENT_TYPE = 'application/json';
const BEARER_PREFIX = 'Bearer ';
const OPENAI_IMAGE_RESPONSE_KEYS = {
  CREATED: 'created',
  DATA: 'data',
  URL: 'url',
};

function supportsExacg(provider) {
  return String(provider || '').trim() === EXACG_ADAPTER_ID;
}

function trimTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getExacgBaseURL(connection) {
  return trimTrailingSlashes(connection.baseURL || connection.base_url || EXACG_DEFAULT_BASE_URL) || EXACG_DEFAULT_BASE_URL;
}

function buildExacgURL(baseURL, endpointPath) {
  const normalizedBaseURL = trimTrailingSlashes(baseURL) || EXACG_DEFAULT_BASE_URL;
  const normalizedPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  return `${normalizedBaseURL}${normalizedPath}`;
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

function buildExacgHeaders(connection) {
  const headers = new Headers(connection.headers || {});
  headers.set(HEADERS.CONTENT_TYPE, JSON_CONTENT_TYPE);
  const apiKey = String(connection.apiKey ?? connection.api_key ?? '').trim();
  if (apiKey) headers.set(HEADERS.AUTHORIZATION, `${BEARER_PREFIX}${apiKey}`);
  return headers;
}

function parseExacgSize(size) {
  if (typeof size !== 'string') return {};
  const match = size.trim().match(/^(\d+)x(\d+)$/i);
  if (!match) return {};
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return {};
  return { width, height };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getExacgProviderOptions(requestBody) {
  for (const key of EXACG_PROVIDER_OPTIONS_KEYS) {
    const providerOptions = requestBody?.[key];
    if (!isPlainObject(providerOptions)) continue;
    const exacgOptions = providerOptions[EXACG_PROVIDER_OPTIONS_NAMESPACE];
    if (isPlainObject(exacgOptions)) return exacgOptions;
  }
  return {};
}

function parseExacgModelIndex(modelCode) {
  const normalizedModelCode = String(modelCode ?? '').trim();
  const parsed = Number(normalizedModelCode);
  if (!normalizedModelCode || !Number.isFinite(parsed)) {
    throw new Error(`Exacg model_index must be numeric, got: ${modelCode}`);
  }
  return parsed;
}

function assignDefinedExacgOptions(body, providerOptions) {
  for (const field of EXACG_OPTION_FIELDS) {
    if (providerOptions[field] !== undefined) body[field] = providerOptions[field];
  }
}

function buildExacgGenerateBody(modelCode, requestBody = {}) {
  const providerOptions = getExacgProviderOptions(requestBody);
  const size = parseExacgSize(requestBody.size);
  const body = {
    prompt: String(requestBody.prompt ?? ''),
    seed: requestBody.seed ?? EXACG_REQUEST_DEFAULTS.SEED,
    steps: EXACG_REQUEST_DEFAULTS.STEPS,
    model_index: parseExacgModelIndex(modelCode),
    negative_prompt: EXACG_DEFAULT_NEGATIVE_PROMPT,
  };

  if (size.width !== undefined) body.width = size.width;
  if (size.height !== undefined) body.height = size.height;
  assignDefinedExacgOptions(body, providerOptions);
  return body;
}

async function readExacgJson(response) {
  const text = await response.clone().text();
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    throw new Error('Exacg response is not JSON');
  }
}

function extractExacgErrorMessage(responseBody) {
  const error = responseBody?.[EXACG_RESPONSE_KEYS.ERROR];
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error?.message) return String(error.message);
  const message = responseBody?.[EXACG_RESPONSE_KEYS.MESSAGE];
  if (responseBody?.[EXACG_RESPONSE_KEYS.SUCCESS] === false && typeof message === 'string' && message.trim()) {
    return message.trim();
  }
  return '';
}

function extractExacgImageURL(responseBody) {
  return String(
    responseBody?.[EXACG_RESPONSE_KEYS.DATA]?.[EXACG_RESPONSE_KEYS.IMAGE_URL] ||
    responseBody?.[EXACG_RESPONSE_KEYS.IMAGE_URL] ||
    '',
  ).trim();
}

async function readExacgProviderErrorMessage(response, responseBody) {
  const detail = extractExacgErrorMessage(responseBody);
  if (detail) return `Exacg upstream returned ${response.status}: ${detail}`;
  try {
    const text = await response.clone().text();
    if (text.trim()) return `Exacg upstream returned ${response.status}: ${text.trim()}`;
  } catch {
    // Fall through to the status-only message.
  }
  return `Exacg upstream returned ${response.status}`;
}

function getEpochSeconds(now) {
  return Math.floor(now.getTime() / 1000);
}

function buildOpenAIImageGenerationBody(input, imageURL, now) {
  return {
    [OPENAI_IMAGE_RESPONSE_KEYS.CREATED]: getEpochSeconds(now),
    [OPENAI_IMAGE_RESPONSE_KEYS.DATA]: [
      { [OPENAI_IMAGE_RESPONSE_KEYS.URL]: imageURL },
    ],
  };
}

function getSelectionConnection(selection) {
  return {
    provider: selection.channel.provider,
    apiKey: selection.channel.api_key,
    baseURL: selection.channel.base_url,
    headers: parseJsonObject(selection.model.headers, {}),
  };
}

function assertExacgImageEndpoint(endpoint) {
  if (endpoint.callType !== CALL_TYPES.IMAGE_GEN) {
    throw new Error(`Unsupported Exacg endpoint: ${endpoint.path}`);
  }
}

function assertJsonRequestBody(requestBody) {
  if (typeof FormData !== 'undefined' && requestBody instanceof FormData) {
    throw new Error('Exacg image generation expects a JSON request body');
  }
}

async function invokeExacg(fetchFn, nowFn, input) {
  assertExacgImageEndpoint(input.endpoint);
  assertJsonRequestBody(input.requestBody);

  const connection = getSelectionConnection(input.selection);
  const response = await fetchFn(buildExacgURL(getExacgBaseURL(connection), EXACG_ENDPOINTS.GENERATE_IMAGE), {
    method: HTTP_METHODS.POST,
    headers: buildExacgHeaders(connection),
    body: JSON.stringify(buildExacgGenerateBody(input.selection.model.code, input.requestBody)),
  });
  const responseBody = await readExacgJson(response);
  const errorMessage = extractExacgErrorMessage(responseBody);
  if (!response.ok) {
    throw new ProviderResponseError(response, await readExacgProviderErrorMessage(response, responseBody));
  }
  if (errorMessage) {
    throw new Error(`Exacg upstream error: ${errorMessage}`);
  }

  const imageURL = extractExacgImageURL(responseBody);
  if (!imageURL) {
    throw new Error('Exacg upstream error: Exacg success response missing data.image_url');
  }

  const imageGenerationBody = buildOpenAIImageGenerationBody(input, imageURL, nowFn());
  return {
    response: new Response(JSON.stringify(imageGenerationBody), {
      status: response.status,
      headers: { [HEADERS.CONTENT_TYPE]: JSON_CONTENT_TYPE },
    }),
    responseBody: {
      usage: {},
      images: imageGenerationBody.data,
    },
  };
}

async function listExacgModels() {
  return [];
}

function buildExacgCheckRequest(input) {
  if (input.callType !== CALL_TYPES.IMAGE_GEN) {
    throw new Error(`Unsupported Exacg call type: ${input.callType}`);
  }
  return {
    url: buildExacgURL(getExacgBaseURL(input), EXACG_ENDPOINTS.GENERATE_IMAGE),
    method: HTTP_METHODS.POST,
    headers: buildExacgHeaders(input),
    body: JSON.stringify(buildExacgGenerateBody(input.model, { prompt: EXACG_REQUEST_DEFAULTS.CHECK_PROMPT })),
  };
}

function buildUnavailableCheckResult(input, errorMessage, latencyMs) {
  return {
    model_code: input.model,
    call_type: input.callType,
    api_accessible: false,
    data_available: false,
    latency_ms: latencyMs,
    error_message: errorMessage,
  };
}

async function checkExacgAvailability(fetchFn, nowFn, input) {
  if (input.callType !== CALL_TYPES.IMAGE_GEN) {
    return buildUnavailableCheckResult(input, `Unsupported Exacg call type: ${input.callType}`, 0);
  }

  const start = nowFn().getTime();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const checkRequest = buildExacgCheckRequest(input);
    const response = await fetchFn(checkRequest.url, {
      method: checkRequest.method,
      headers: checkRequest.headers,
      body: checkRequest.body,
      signal: controller.signal,
    });
    const responseBody = await readExacgJson(response);
    const errorMessage = extractExacgErrorMessage(responseBody);
    const imageURL = extractExacgImageURL(responseBody);
    const latencyMs = Math.max(0, nowFn().getTime() - start);
    return {
      model_code: input.model,
      call_type: input.callType,
      api_accessible: response.ok && !errorMessage,
      data_available: response.ok && !errorMessage && Boolean(imageURL),
      latency_ms: latencyMs,
      error_message: response.ok && !errorMessage ? '' : await readExacgProviderErrorMessage(response, responseBody),
    };
  } catch (error) {
    const isAbort = error?.name === 'AbortError';
    return buildUnavailableCheckResult(
      input,
      isAbort ? `${EXACG_REQUEST_DEFAULTS.TIMEOUT_PREFIX}${input.timeoutMs}ms` : error?.message || String(error),
      Math.max(0, nowFn().getTime() - start),
    );
  } finally {
    clearTimeout(timeout);
  }
}

function createExacgAdapter(deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const nowFn = deps.now || (() => new Date());
  return {
    id: EXACG_ADAPTER_ID,
    supports: supportsExacg,
    defaultBaseURL: () => EXACG_DEFAULT_BASE_URL,
    invoke: (input) => invokeExacg(fetchFn, nowFn, input),
    listModels: listExacgModels,
    checkAvailability: (input) => checkExacgAvailability(fetchFn, nowFn, input),
  };
}

export {
  EXACG_ADAPTER_ID,
  EXACG_DEFAULT_NEGATIVE_PROMPT,
  EXACG_DEFAULT_BASE_URL,
  EXACG_ENDPOINTS,
  EXACG_OPTION_FIELDS,
  EXACG_PROVIDER_OPTIONS_KEYS,
  EXACG_PROVIDER_OPTIONS_NAMESPACE,
  EXACG_RESPONSE_KEYS,
  EXACG_REQUEST_DEFAULTS,
  buildExacgCheckRequest,
  buildExacgGenerateBody,
  buildExacgHeaders,
  buildExacgURL,
  buildOpenAIImageGenerationBody,
  checkExacgAvailability,
  createExacgAdapter,
  extractExacgErrorMessage,
  extractExacgImageURL,
  getExacgBaseURL,
  getExacgProviderOptions,
  invokeExacg,
  listExacgModels,
  parseExacgModelIndex,
  parseExacgSize,
  readExacgJson,
  supportsExacg,
};
