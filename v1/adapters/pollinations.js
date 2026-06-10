import { CALL_TYPES } from '../../model-selection.js';
import { ProviderResponseError } from './openai-compatible.js';

const POLLINATIONS_ADAPTER_ID = 'pollinations';
const POLLINATIONS_DEFAULT_BASE_URL = 'https://gen.pollinations.ai';
const POLLINATIONS_ENDPOINTS = {
  VIDEO: '/video/',
};
const POLLINATIONS_MODEL_ID = 'pollinations-video';
const POLLINATIONS_PROVIDER_OPTIONS_KEYS = ['providerOptions', 'provider_options'];
const POLLINATIONS_PROVIDER_OPTIONS_NAMESPACE = POLLINATIONS_ADAPTER_ID;
const POLLINATIONS_OPTION_FIELDS = ['width', 'height', 'seed', 'enhance', 'safe', 'image', 'duration', 'aspectRatio', 'audio'];
const POLLINATIONS_REQUEST_DEFAULTS = {
  CHECK_PROMPT: 'a white circle on black background',
  TIMEOUT_PREFIX: 'Model check timed out after ',
};
const HTTP_METHODS = {
  GET: 'GET',
};
const HEADERS = {
  AUTHORIZATION: 'authorization',
  CONTENT_TYPE: 'content-type',
};
const BEARER_PREFIX = 'Bearer ';
const JSON_CONTENT_TYPE = 'application/json';
const OPENAI_VIDEO_RESPONSE_KEYS = {
  CREATED: 'created',
  DATA: 'data',
  B64_JSON: 'b64_json',
};

function supportsPollinations(provider) {
  return String(provider || '').trim() === POLLINATIONS_ADAPTER_ID;
}

function trimTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getPollinationsBaseURL(connection) {
  return trimTrailingSlashes(connection.baseURL || connection.base_url || POLLINATIONS_DEFAULT_BASE_URL) || POLLINATIONS_DEFAULT_BASE_URL;
}

function buildPollinationsURL(baseURL, prompt, query = {}) {
  const normalizedBaseURL = trimTrailingSlashes(baseURL) || POLLINATIONS_DEFAULT_BASE_URL;
  const url = new URL(`${normalizedBaseURL}${POLLINATIONS_ENDPOINTS.VIDEO}${encodeURIComponent(prompt)}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
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

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getPollinationsProviderOptions(requestBody) {
  for (const key of POLLINATIONS_PROVIDER_OPTIONS_KEYS) {
    const providerOptions = requestBody?.[key];
    if (!isPlainObject(providerOptions)) continue;
    const pollinationsOptions = providerOptions[POLLINATIONS_PROVIDER_OPTIONS_NAMESPACE];
    if (isPlainObject(pollinationsOptions)) return pollinationsOptions;
  }
  return {};
}

function buildPollinationsHeaders(connection) {
  const headers = new Headers(connection.headers || {});
  const apiKey = String(connection.apiKey ?? connection.api_key ?? '').trim();
  if (apiKey) headers.set(HEADERS.AUTHORIZATION, `${BEARER_PREFIX}${apiKey}`);
  return headers;
}

function getSelectionConnection(selection) {
  return {
    provider: selection.channel.provider,
    apiKey: selection.channel.api_key,
    baseURL: selection.channel.base_url,
    headers: parseJsonObject(selection.model.headers, {}),
  };
}

function assertPollinationsVideoEndpoint(endpoint) {
  if (endpoint.callType !== CALL_TYPES.VIDEO_GEN) {
    throw new Error(`Unsupported Pollinations endpoint: ${endpoint.path}`);
  }
}

function assertJsonRequestBody(requestBody) {
  if (typeof FormData !== 'undefined' && requestBody instanceof FormData) {
    throw new Error('Pollinations video generation expects a JSON request body');
  }
}

function readPollinationsPrompt(requestBody) {
  const prompt = String(requestBody?.prompt ?? '').trim();
  if (!prompt) throw new Error('prompt: Required');
  return prompt;
}

function buildPollinationsVideoQuery(requestBody = {}, modelCode = '') {
  const providerOptions = getPollinationsProviderOptions(requestBody);
  const query = {};
  if (modelCode) query.model = modelCode;
  for (const field of POLLINATIONS_OPTION_FIELDS) {
    if (providerOptions[field] !== undefined) query[field] = providerOptions[field];
  }
  return query;
}

async function readPollinationsProviderErrorMessage(response) {
  try {
    const text = await response.clone().text();
    if (text.trim()) return `Pollinations upstream returned ${response.status}: ${text.trim()}`;
  } catch {
    // Fall through to the status-only message.
  }
  return `Pollinations upstream returned ${response.status}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function buildOpenAIVideoGenerationBody(response, now) {
  const buffer = await response.clone().arrayBuffer();
  return {
    [OPENAI_VIDEO_RESPONSE_KEYS.CREATED]: Math.floor(now.getTime() / 1000),
    [OPENAI_VIDEO_RESPONSE_KEYS.DATA]: [
      { [OPENAI_VIDEO_RESPONSE_KEYS.B64_JSON]: arrayBufferToBase64(buffer) },
    ],
  };
}

async function invokePollinations(fetchFn, nowFn, input) {
  assertPollinationsVideoEndpoint(input.endpoint);
  assertJsonRequestBody(input.requestBody);

  const connection = getSelectionConnection(input.selection);
  const response = await fetchFn(buildPollinationsURL(
    getPollinationsBaseURL(connection),
    readPollinationsPrompt(input.requestBody),
    buildPollinationsVideoQuery(input.requestBody, input.selection.model.code),
  ), {
    method: HTTP_METHODS.GET,
    headers: buildPollinationsHeaders(connection),
  });
  if (!response.ok) {
    throw new ProviderResponseError(response, await readPollinationsProviderErrorMessage(response));
  }

  const videoGenerationBody = await buildOpenAIVideoGenerationBody(response, nowFn());
  return {
    response: new Response(JSON.stringify(videoGenerationBody), {
      status: response.status,
      headers: { [HEADERS.CONTENT_TYPE]: JSON_CONTENT_TYPE },
    }),
    responseBody: {
      usage: {},
      videos: videoGenerationBody.data,
    },
  };
}

async function listPollinationsModels() {
  return [
    {
      id: POLLINATIONS_MODEL_ID,
      object: 'model',
      owned_by: POLLINATIONS_ADAPTER_ID,
    },
  ];
}

function buildPollinationsCheckRequest(input) {
  if (input.callType !== CALL_TYPES.VIDEO_GEN) {
    throw new Error(`Unsupported Pollinations call type: ${input.callType}`);
  }
  return {
    url: buildPollinationsURL(getPollinationsBaseURL(input), POLLINATIONS_REQUEST_DEFAULTS.CHECK_PROMPT, { model: input.model }),
    method: HTTP_METHODS.GET,
    headers: buildPollinationsHeaders(input),
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

async function checkPollinationsAvailability(fetchFn, nowFn, input) {
  if (input.callType !== CALL_TYPES.VIDEO_GEN) {
    return buildUnavailableCheckResult(input, `Unsupported Pollinations call type: ${input.callType}`, 0);
  }

  const start = nowFn().getTime();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const checkRequest = buildPollinationsCheckRequest(input);
    const response = await fetchFn(checkRequest.url, {
      method: checkRequest.method,
      headers: checkRequest.headers,
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, nowFn().getTime() - start);
    return {
      model_code: input.model,
      call_type: input.callType,
      api_accessible: response.ok,
      data_available: response.ok && (await response.clone().arrayBuffer()).byteLength > 0,
      latency_ms: latencyMs,
      error_message: response.ok ? '' : await readPollinationsProviderErrorMessage(response),
    };
  } catch (error) {
    const isAbort = error?.name === 'AbortError';
    return buildUnavailableCheckResult(
      input,
      isAbort ? `${POLLINATIONS_REQUEST_DEFAULTS.TIMEOUT_PREFIX}${input.timeoutMs}ms` : error?.message || String(error),
      Math.max(0, nowFn().getTime() - start),
    );
  } finally {
    clearTimeout(timeout);
  }
}

function createPollinationsAdapter(deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const nowFn = deps.now || (() => new Date());
  return {
    id: POLLINATIONS_ADAPTER_ID,
    supports: supportsPollinations,
    defaultBaseURL: () => POLLINATIONS_DEFAULT_BASE_URL,
    invoke: (input) => invokePollinations(fetchFn, nowFn, input),
    listModels: listPollinationsModels,
    checkAvailability: (input) => checkPollinationsAvailability(fetchFn, nowFn, input),
  };
}

export {
  POLLINATIONS_ADAPTER_ID,
  POLLINATIONS_DEFAULT_BASE_URL,
  POLLINATIONS_ENDPOINTS,
  POLLINATIONS_MODEL_ID,
  POLLINATIONS_OPTION_FIELDS,
  POLLINATIONS_PROVIDER_OPTIONS_KEYS,
  POLLINATIONS_PROVIDER_OPTIONS_NAMESPACE,
  POLLINATIONS_REQUEST_DEFAULTS,
  buildOpenAIVideoGenerationBody,
  buildPollinationsCheckRequest,
  buildPollinationsHeaders,
  buildPollinationsURL,
  buildPollinationsVideoQuery,
  checkPollinationsAvailability,
  createPollinationsAdapter,
  getPollinationsBaseURL,
  getPollinationsProviderOptions,
  invokePollinations,
  listPollinationsModels,
  supportsPollinations,
};
