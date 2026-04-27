import { assertResponseIsOK } from "./provider-errors";

const CUSTOM_PUBAPI_PROVIDER_NAME = 'custom-pubapi';
const CUSTOM_PUBAPI_DEFAULT_BASE_URL = '';
const CUSTOM_PUBAPI_SPEC_VERSION = 'v3';
const CUSTOM_PUBAPI_DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; OpenAIGateway/1.0; +https://github.com)';
const CUSTOM_PUBAPI_AUTH_SCHEME = 'Bearer';
const CUSTOM_PUBAPI_ENDPOINTS = {
  MODELS: '/v1/models',
  CHAT: '/v1/chat/completions',
  SPEECH: '/v1/audio/speech',
};
const CUSTOM_PUBAPI_DEFAULT_SOURCE_LANG = 'auto';
const CUSTOM_PUBAPI_DEFAULT_TARGET_LANG = 'en';
const CUSTOM_PUBAPI_DEFAULT_NUMS = 5;
const CUSTOM_PUBAPI_DEFAULT_VOICE = 'default';
const CUSTOM_PUBAPI_DEFAULT_SPEED = '1.0';
const CUSTOM_PUBAPI_DEFAULT_TYPE = 'default';
const CUSTOM_PUBAPI_AUDIO_MEDIA_TYPE = 'audio/mpeg';
const EMPTY_USAGE = {
  inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
  totalTokens: 0,
  reasoningTokens: undefined,
  cachedInputTokens: undefined,
};

function trimTrailingSlashes(value) {
  return (value || '').replace(/\/+$/, '');
}

function resolveBaseURL(baseURL) {
  return trimTrailingSlashes(baseURL) || CUSTOM_PUBAPI_DEFAULT_BASE_URL;
}

function toHeadersRecord(headers) {
  if (!headers) return undefined;
  const entries = Object.entries(headers).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
}

// fix: Illegal invocation: function called with incorrect `this` reference
// 返回一个新函数，调用时不直接 candidate(...args)，而是显式指定 this = globalThis。
function toSafeFetch(fetchFn) {
  const candidate = fetchFn || fetch;
  return (...args) => candidate.call(globalThis, ...args);
}

function mergeHeaders(apiKey, baseHeaders, callHeaders) {
  return {
    'user-agent': CUSTOM_PUBAPI_DEFAULT_USER_AGENT,
    authorization: `${CUSTOM_PUBAPI_AUTH_SCHEME} ${apiKey}`,
    ...(baseHeaders || {}),
    ...(callHeaders || {}),
  };
}

function parseProviderOptions(options) {
  return options?.providerOptions?.[CUSTOM_PUBAPI_PROVIDER_NAME] || {};
}

function buildTextFromOptions(options) {
  if (typeof options?.text === 'string' && options.text.length > 0) return options.text;
  const prompt = options?.prompt;
  if (Array.isArray(prompt)) {
    const text = prompt
      .flatMap((message) => message?.content || [])
      .filter((part) => part?.type === 'text')
      .map((part) => part.text || '')
      .join('\n')
      .trim();
    if (text) return text;
  }
  if (typeof prompt === 'string' && prompt.length > 0) return prompt;
  if (typeof options?.input === 'string' && options.input.length > 0) return options.input;
  return '';
}

class CustomPubApiLanguageModelV3 {
  specificationVersion = CUSTOM_PUBAPI_SPEC_VERSION;

  constructor(modelId, config) {
    this.provider = `${config.providerName}.chat`;
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(options) {
    if (!this.config.baseURL) {
      throw new Error('Custom PubAPI baseURL is required');
    }

    const text = buildTextFromOptions(options);
    const providerOptions = parseProviderOptions(options);
    const url = new URL(`${this.config.baseURL}${CUSTOM_PUBAPI_ENDPOINTS.CHAT}`);
    const headers = mergeHeaders(this.config.apiKey, this.config.headers, options?.headers);
    const requestBody = {
      model: this.modelId,
      messages: [{ content: text }],
      source_lang: String(providerOptions.source_lang || CUSTOM_PUBAPI_DEFAULT_SOURCE_LANG),
      target_lang: String(providerOptions.target_lang || CUSTOM_PUBAPI_DEFAULT_TARGET_LANG),
      nums: Number(providerOptions.nums ?? CUSTOM_PUBAPI_DEFAULT_NUMS),
    };

    const response = await this.config.fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(requestBody),
      signal: options?.abortSignal,
    });

    await assertResponseIsOK(response, 'Custom PubAPI upstream returned');

    const payload = await response.json().catch(() => ({}));
    const textOutput = JSON.stringify(payload);
    const responseHeaders = toHeadersRecord(Object.fromEntries(response.headers.entries()));

    return {
      content: [{ type: 'text', text: textOutput }],
      warnings: [],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: EMPTY_USAGE,
      providerMetadata: {
        [this.config.providerName]: {
          endpoint: url.toString(),
          payload,
        },
      },
      response: {
        timestamp: new Date(),
        modelId: this.modelId,
        headers: responseHeaders,
        body: payload,
      },
    };
  }

  async doStream() {
    throw new Error('Custom PubAPI does not support streaming');
  }
}

class CustomPubApiSpeechModelV3 {
  specificationVersion = CUSTOM_PUBAPI_SPEC_VERSION;

  constructor(modelId, config) {
    this.provider = `${config.providerName}.speech`;
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(options) {
    if (!this.config.baseURL) {
      throw new Error('Custom PubAPI baseURL is required');
    }

    const providerOptions = parseProviderOptions(options);
    const text = buildTextFromOptions(options);
    const url = new URL(`${this.config.baseURL}${CUSTOM_PUBAPI_ENDPOINTS.SPEECH}`);
    const headers = mergeHeaders(this.config.apiKey, this.config.headers, options?.headers);
    const requestBody = {
      model: this.modelId,
      input: text,
      voice: String(options?.voice || providerOptions.voice || CUSTOM_PUBAPI_DEFAULT_VOICE),
      speed: String(options?.speed ?? providerOptions.speed ?? CUSTOM_PUBAPI_DEFAULT_SPEED),
      type: String(providerOptions.type || CUSTOM_PUBAPI_DEFAULT_TYPE),
    };

    const response = await this.config.fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(requestBody),
      signal: options?.abortSignal,
    });

    await assertResponseIsOK(response, 'Custom PubAPI speech upstream returned');

    const audio = new Uint8Array(await response.arrayBuffer());
    const responseHeaders = toHeadersRecord(Object.fromEntries(response.headers.entries()));

    return {
      audio,
      warnings: [],
      providerMetadata: {
        [this.config.providerName]: {
          endpoint: url.toString(),
        },
      },
      response: {
        timestamp: new Date(),
        modelId: this.modelId,
        headers: responseHeaders,
      },
      mediaType: response.headers.get('content-type') || CUSTOM_PUBAPI_AUDIO_MEDIA_TYPE,
    };
  }
}

export function createCustomPubApi(options = {}) {
  const config = {
    providerName: options.name || CUSTOM_PUBAPI_PROVIDER_NAME,
    baseURL: resolveBaseURL(options.baseURL),
    apiKey: options.apiKey || '',
    headers: options.headers || {},
    fetch: toSafeFetch(options.fetch),
  };

  const createChatModel = (modelId) => new CustomPubApiLanguageModelV3(modelId, config);
  const createSpeechModel = (modelId) => new CustomPubApiSpeechModelV3(modelId, config);

  return {
    specificationVersion: CUSTOM_PUBAPI_SPEC_VERSION,
    chat: createChatModel,
    languageModel: createChatModel,
    speech: createSpeechModel,
    speechModel: createSpeechModel,
  };
}
