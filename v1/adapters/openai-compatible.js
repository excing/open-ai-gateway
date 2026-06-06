import { CALL_TYPES } from '../../model-selection.js';
import { buildFrontendRequest, buildFrontendResponse } from './_shared/transformers.js';

const OPENAI_COMPATIBLE_ADAPTER_ID = 'openai-compatible';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_COMPATIBLE_PROVIDERS = ['openai', OPENAI_COMPATIBLE_ADAPTER_ID];
const V1_PREFIX = '/v1';
const JSON_CONTENT_TYPE = 'application/json';
const BEARER_PREFIX = 'Bearer ';

const OPENAI_OBJECTS = {
  LIST: 'list',
  MODEL: 'model',
  CHAT_COMPLETION: 'chat.completion',
};

const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream';
const SSE_DATA_PREFIX = 'data:';
const SSE_DONE_MARKER = '[DONE]';

const OPENAI_CHECK = {
  PROMPT: 'Say "OK" if you can read this message.',
  IMAGE_PROMPT: 'a white circle on black background',
  EMBEDDING_INPUT: 'test',
  SPEECH_INPUT: 'test',
  SPEECH_VOICE: 'alloy',
  MAX_TOKENS: 16,
  IMAGE_SIZE: '256x256',
  TIMEOUT_PREFIX: 'Model check timed out after ',
};

class ProviderResponseError extends Error {
  constructor(response, message) {
    super(message);
    this.name = 'ProviderResponseError';
    this.response = response;
    this.status = response.status;
  }
}

function supportsOpenAICompatible(provider) {
  return OPENAI_COMPATIBLE_PROVIDERS.includes(String(provider || '').trim());
}

function getOpenAICompatibleBaseURL(connection) {
  return String(connection.baseURL || connection.base_url || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function buildOpenAICompatibleURL(baseURL, endpointPath) {
  const normalizedBaseURL = String(baseURL || '').replace(/\/+$/, '');
  const normalizedPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  if (/\/v\d+(?:[a-z]+\d*)?$/i.test(normalizedBaseURL) && normalizedPath.startsWith(`${V1_PREFIX}/`)) {
    return `${normalizedBaseURL}${normalizedPath.slice(V1_PREFIX.length)}`;
  }
  return `${normalizedBaseURL}${normalizedPath}`;
}

function safeJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function buildOpenAIHeaders(connection, contentType = JSON_CONTENT_TYPE) {
  const headers = new Headers(connection.headers || {});
  headers.set('authorization', `${BEARER_PREFIX}${connection.apiKey || connection.api_key}`);
  if (contentType) headers.set('content-type', contentType);
  return headers;
}

function isFormDataBody(body) {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

function cloneBodyWithModel(body, modelCode) {
  if (isFormDataBody(body)) {
    const cloned = new FormData();
    let hasModel = false;
    for (const [key, value] of body.entries()) {
      if (key === 'model') {
        cloned.append(key, modelCode);
        hasModel = true;
      } else {
        cloned.append(key, value);
      }
    }
    if (!hasModel) cloned.append('model', modelCode);
    return cloned;
  }
  return JSON.stringify({ ...(body || {}), model: modelCode });
}

async function readJsonIfPossible(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes(JSON_CONTENT_TYPE)) return undefined;
  try {
    return await response.clone().json();
  } catch {
    return undefined;
  }
}

async function readProviderErrorMessage(response, responseBody) {
  const body = responseBody || await readJsonIfPossible(response);
  const error = body?.error;
  let detail = '';
  if (typeof error === 'string' && error.trim()) detail = error.trim();
  if (!detail && error?.message) detail = String(error.message);
  try {
    const text = await response.clone().text();
    if (!detail && text.trim()) detail = text.trim();
  } catch {
    // Ignore body read failures and fall back to status text.
  }
  return detail ? `Upstream returned ${response.status}: ${detail}` : `Upstream returned ${response.status}`;
}

function normalizeOpenAIUsage(responseBody) {
  const usage = responseBody?.usage || {};
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0;
  const totalTokens = usage.totalTokens ?? usage.total_tokens ?? Number(inputTokens || 0) + Number(outputTokens || 0);
  return { inputTokens, outputTokens, promptTokens: inputTokens, completionTokens: outputTokens, totalTokens };
}

function normalizeBillingBody(endpoint, responseBody) {
  if (!responseBody) return undefined;
  const usage = normalizeOpenAIUsage(responseBody);
  if (endpoint.callType === CALL_TYPES.IMAGE_GEN) {
    return { usage, images: Array.isArray(responseBody.data) ? responseBody.data : responseBody.images || [] };
  }
  if (endpoint.callType === CALL_TYPES.VIDEO_GEN) {
    return { usage, videos: responseBody.videos || responseBody.data || [] };
  }
  return { ...responseBody, usage };
}

function getSelectionConnection(selection) {
  return {
    provider: selection.channel.provider,
    apiKey: selection.channel.api_key,
    baseURL: selection.channel.base_url,
    headers: safeJsonObject(selection.model.headers, {}),
  };
}

function isStreamRequested(body) {
  if (isFormDataBody(body)) {
    const value = body.get('stream');
    return value === 'true' || value === true;
  }
  return body?.stream === true;
}

function isEventStreamResponse(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes(EVENT_STREAM_CONTENT_TYPE);
}

function isChatLikeEndpoint(endpoint) {
  return endpoint.callType === CALL_TYPES.CHAT;
}

async function readSSEChunks(response) {
  const text = await response.clone().text();
  const chunks = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(SSE_DATA_PREFIX)) continue;
    const payload = line.slice(SSE_DATA_PREFIX.length).trim();
    if (!payload || payload === SSE_DONE_MARKER) continue;
    try {
      chunks.push(JSON.parse(payload));
    } catch {
      // Skip malformed SSE payloads.
    }
  }
  return chunks;
}

function mergeToolCallDeltas(existing, deltas) {
  const result = Array.isArray(existing) ? existing.slice() : [];
  for (const delta of deltas) {
    const index = typeof delta.index === 'number' ? delta.index : result.length;
    const current = result[index] || { index, id: '', type: 'function', function: { name: '', arguments: '' } };
    if (delta.id) current.id = delta.id;
    if (delta.type) current.type = delta.type;
    if (delta.function) {
      if (delta.function.name) current.function.name = (current.function.name || '') + delta.function.name;
      if (delta.function.arguments) current.function.arguments = (current.function.arguments || '') + delta.function.arguments;
    }
    result[index] = current;
  }
  return result;
}

function aggregateChatCompletionFromSSE(chunks, fallbackModel) {
  const choices = new Map();
  let id = '';
  let created = 0;
  let model = fallbackModel;
  let systemFingerprint;
  let usage;

  for (const chunk of chunks) {
    if (chunk.id) id = chunk.id;
    if (chunk.created) created = chunk.created;
    if (chunk.model) model = chunk.model;
    if (chunk.system_fingerprint) systemFingerprint = chunk.system_fingerprint;
    if (chunk.usage) usage = chunk.usage;
    if (!Array.isArray(chunk.choices)) continue;
    for (const choice of chunk.choices) {
      const index = typeof choice.index === 'number' ? choice.index : 0;
      const acc = choices.get(index) || { index, message: { role: 'assistant', content: '' }, finish_reason: null };
      const delta = choice.delta || {};
      if (delta.role) acc.message.role = delta.role;
      if (typeof delta.content === 'string') acc.message.content += delta.content;
      if (Array.isArray(delta.tool_calls)) {
        acc.message.tool_calls = mergeToolCallDeltas(acc.message.tool_calls, delta.tool_calls);
      }
      if (choice.finish_reason) acc.finish_reason = choice.finish_reason;
      choices.set(index, acc);
    }
  }

  const aggregated = {
    id: id || `chatcmpl-${Date.now()}`,
    object: OPENAI_OBJECTS.CHAT_COMPLETION,
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: Array.from(choices.values()).sort((a, b) => a.index - b.index),
  };
  if (systemFingerprint) aggregated.system_fingerprint = systemFingerprint;
  if (usage) aggregated.usage = usage;
  return aggregated;
}

async function convertSSEToChatCompletion(response, fallbackModel) {
  const chunks = await readSSEChunks(response);
  const body = aggregateChatCompletionFromSSE(chunks, fallbackModel);
  const headers = new Headers(response.headers);
  headers.set('content-type', JSON_CONTENT_TYPE);
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  return { response: new Response(JSON.stringify(body), { status: response.status, headers }), responseBody: body };
}

async function invokeOpenAICompatible(fetchFn, input) {
  const finalInput = await buildFrontendRequest(input, { fetch: fetchFn });
  const connection = getSelectionConnection(finalInput.selection);
  const baseURL = getOpenAICompatibleBaseURL(connection);
  const isMultipart = isFormDataBody(finalInput.requestBody);
  const response = await fetchFn(buildOpenAICompatibleURL(baseURL, finalInput.endpoint.path), {
    method: finalInput.endpoint.method,
    headers: buildOpenAIHeaders(connection, isMultipart ? '' : JSON_CONTENT_TYPE),
    body: cloneBodyWithModel(finalInput.requestBody, finalInput.selection.model.code),
  });
  if (!response.ok) {
    const errorBody = await readJsonIfPossible(response);
    throw new ProviderResponseError(response, await readProviderErrorMessage(response, errorBody));
  }
  let upstreamResponse = response;
  let upstreamBody;
  if (!isStreamRequested(finalInput.requestBody) && isChatLikeEndpoint(finalInput.endpoint) && isEventStreamResponse(response)) {
    const converted = await convertSSEToChatCompletion(response, finalInput.selection.model.code);
    upstreamResponse = converted.response;
    upstreamBody = converted.responseBody;
  } else {
    upstreamBody = await readJsonIfPossible(response);
  }
  const transformed = buildFrontendResponse(input.endpoint.callType, upstreamResponse, upstreamBody);
  return {
    response: transformed.response,
    responseBody: normalizeBillingBody(input.endpoint, transformed.responseBody),
  };
}

function normalizeOpenAIModelList(data) {
  if (data?.object === OPENAI_OBJECTS.LIST && Array.isArray(data.data)) {
    return data.data.map((model) => ({
      id: String(model.id || '').trim(),
      object: model.object || OPENAI_OBJECTS.MODEL,
      created: Number(model.created || 0),
      owned_by: model.owned_by || 'unknown',
    })).filter((model) => model.id);
  }
  if (Array.isArray(data)) {
    return data.map((model) => ({
      id: String(model?.id || model?.name || model || '').trim(),
      object: OPENAI_OBJECTS.MODEL,
      created: 0,
      owned_by: 'unknown',
    })).filter((model) => model.id);
  }
  return [];
}

async function listOpenAICompatibleModels(fetchFn, connection) {
  const response = await fetchFn(buildOpenAICompatibleURL(getOpenAICompatibleBaseURL(connection), '/v1/models'), {
    method: 'GET',
    headers: buildOpenAIHeaders(connection),
  });
  const responseBody = await readJsonIfPossible(response);
  if (!response.ok) {
    throw new Error(await readProviderErrorMessage(response, responseBody));
  }
  return normalizeOpenAIModelList(responseBody);
}

function createSilentWav() {
  const sampleRate = 8000;
  const sampleCount = 800;
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}

function buildJsonCheck(path, body, connection) {
  return {
    path,
    method: 'POST',
    headers: buildOpenAIHeaders(connection),
    body: JSON.stringify(body),
  };
}

function buildCheckRequest(input) {
  const model = input.model;
  if (input.callType === CALL_TYPES.CHAT) {
    return buildJsonCheck('/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: OPENAI_CHECK.PROMPT }],
      max_tokens: OPENAI_CHECK.MAX_TOKENS,
      stream: false,
    }, input);
  }
  if (input.callType === CALL_TYPES.IMAGE_GEN) {
    return buildJsonCheck('/v1/images/generations', {
      model,
      prompt: OPENAI_CHECK.IMAGE_PROMPT,
      n: 1,
      size: OPENAI_CHECK.IMAGE_SIZE,
    }, input);
  }
  if (input.callType === CALL_TYPES.AUDIO_GEN) {
    return buildJsonCheck('/v1/audio/speech', {
      model,
      input: OPENAI_CHECK.SPEECH_INPUT,
      voice: OPENAI_CHECK.SPEECH_VOICE,
    }, input);
  }
  if (input.callType === CALL_TYPES.EMBEDDING) {
    return buildJsonCheck('/v1/embeddings', { model, input: OPENAI_CHECK.EMBEDDING_INPUT }, input);
  }
  if (input.callType === CALL_TYPES.VIDEO_GEN) {
    return buildJsonCheck('/v1/video/generations', { model, prompt: OPENAI_CHECK.IMAGE_PROMPT }, input);
  }
  if (input.callType === CALL_TYPES.TRANSCRIBE) {
    const form = new FormData();
    form.append('model', model);
    form.append('file', new Blob([createSilentWav()], { type: 'audio/wav' }), 'check.wav');
    return { path: '/v1/audio/transcriptions', method: 'POST', headers: buildOpenAIHeaders(input, ''), body: form };
  }
  throw new Error(`Unsupported call type: ${input.callType}`);
}

function hasTextChoice(responseBody) {
  if (typeof responseBody?.output_text === 'string' && responseBody.output_text.trim()) return true;
  if (typeof responseBody?.text === 'string' && responseBody.text.trim()) return true;
  if (!Array.isArray(responseBody?.choices)) return false;
  return responseBody.choices.some((choice) => {
    const content = choice?.message?.content ?? choice?.text;
    return typeof content === 'string' && content.trim().length > 0;
  });
}

async function hasAvailableCheckData(callType, response, responseBody) {
  if (callType === CALL_TYPES.CHAT) return hasTextChoice(responseBody);
  if (callType === CALL_TYPES.IMAGE_GEN) return Array.isArray(responseBody?.data) && responseBody.data.length > 0;
  if (callType === CALL_TYPES.VIDEO_GEN) return Array.isArray(responseBody?.data || responseBody?.videos) && (responseBody.data || responseBody.videos).length > 0;
  if (callType === CALL_TYPES.EMBEDDING) {
    const embedding = responseBody?.data?.[0]?.embedding || responseBody?.embedding;
    return Array.isArray(embedding) && embedding.length > 0;
  }
  if (callType === CALL_TYPES.TRANSCRIBE) return typeof responseBody?.text === 'string' && responseBody.text.trim().length > 0;
  if (callType === CALL_TYPES.AUDIO_GEN) return (await response.clone().arrayBuffer()).byteLength > 0;
  return false;
}

async function checkOpenAICompatibleAvailability(fetchFn, nowFn, input) {
  const start = nowFn().getTime();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const checkRequest = buildCheckRequest(input);
    const response = await fetchFn(buildOpenAICompatibleURL(getOpenAICompatibleBaseURL(input), checkRequest.path), {
      method: checkRequest.method,
      headers: checkRequest.headers,
      body: checkRequest.body,
      signal: controller.signal,
    });
    const responseBody = await readJsonIfPossible(response);
    const dataAvailable = response.ok ? await hasAvailableCheckData(input.callType, response, responseBody) : false;
    return {
      model_code: input.model,
      call_type: input.callType,
      api_accessible: response.ok,
      data_available: dataAvailable,
      latency_ms: Math.max(0, nowFn().getTime() - start),
      error_message: response.ok ? '' : await readProviderErrorMessage(response, responseBody),
    };
  } catch (error) {
    const isAbort = error?.name === 'AbortError';
    return {
      model_code: input.model,
      call_type: input.callType,
      api_accessible: false,
      data_available: false,
      latency_ms: Math.max(0, nowFn().getTime() - start),
      error_message: isAbort ? `${OPENAI_CHECK.TIMEOUT_PREFIX}${input.timeoutMs}ms` : error?.message || String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function createOpenAICompatibleAdapter(deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const nowFn = deps.now || (() => new Date());
  return {
    id: OPENAI_COMPATIBLE_ADAPTER_ID,
    supports: supportsOpenAICompatible,
    defaultBaseURL: () => OPENAI_DEFAULT_BASE_URL,
    invoke: (input) => invokeOpenAICompatible(fetchFn, input),
    listModels: (input) => listOpenAICompatibleModels(fetchFn, input),
    checkAvailability: (input) => checkOpenAICompatibleAvailability(fetchFn, nowFn, input),
  };
}

export {
  OPENAI_COMPATIBLE_ADAPTER_ID,
  OPENAI_COMPATIBLE_PROVIDERS,
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_OBJECTS,
  ProviderResponseError,
  buildOpenAICompatibleURL,
  buildOpenAIHeaders,
  cloneBodyWithModel,
  createOpenAICompatibleAdapter,
  getOpenAICompatibleBaseURL,
  normalizeBillingBody,
  normalizeOpenAIModelList,
  normalizeOpenAIUsage,
  supportsOpenAICompatible,
};
