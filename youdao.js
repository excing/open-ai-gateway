import { assertResponseIsOK } from "./provider-errors.js";

const YOUDAO_PROVIDER_NAME = 'youdao';
const YOUDAO_DEFAULT_BASE_URL = 'https://dict.youdao.com';
const YOUDAO_SPEC_VERSION = 'v3';
const YOUDAO_DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; OpenAIGateway/1.0; +https://github.com)';
const YOUDAO_MODELS = {
  CHAT: 'youdao-dict',
  SUGGEST: 'youdao-suggest',
  TTS: 'youdao-dictvoice',
};
const YOUDAO_CHAT_MODEL_SET = new Set([YOUDAO_MODELS.CHAT, YOUDAO_MODELS.SUGGEST]);
const YOUDAO_ENDPOINTS = {
  CHAT: '/jsonapi_s',
  SUGGEST: '/suggest',
  TTS: '/dictvoice',
};
const YOUDAO_CHAT_QUERY = {
  doctype: 'json',
  jsonversion: '4',
};
const YOUDAO_CHAT_FORM_DEFAULTS = {
  le: 'en',
  t: '1',
  client: 'web',
  sign: '9583bb95a4a21a3870950688db121755',
  keyfrom: 'webdict',
};
const YOUDAO_DEFAULT_TTS_TYPE = 1;
const YOUDAO_TTS_MEDIA_TYPE = 'audio/mpeg';
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
  return trimTrailingSlashes(baseURL) || YOUDAO_DEFAULT_BASE_URL;
}

function toHeadersRecord(headers) {
  if (!headers) return undefined;
  const entries = Object.entries(headers).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
}

function mergeHeaders(baseHeaders, callHeaders, contentType) {
  return {
    'user-agent': YOUDAO_DEFAULT_USER_AGENT,
    ...(contentType ? { 'content-type': contentType } : {}),
    ...(baseHeaders || {}),
    ...(callHeaders || {}),
  };
}

function parseProviderOptions(options) {
  return options?.providerOptions?.[YOUDAO_PROVIDER_NAME] || {};
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

function assertChatModelSupported(modelId) {
  if (!YOUDAO_CHAT_MODEL_SET.has(modelId)) {
    throw new Error(`Youdao chat only supports models "${YOUDAO_MODELS.CHAT}" and "${YOUDAO_MODELS.SUGGEST}"`);
  }
}

function assertSpeechModelSupported(modelId) {
  if (modelId !== YOUDAO_MODELS.TTS) {
    throw new Error(`Youdao speech only supports model "${YOUDAO_MODELS.TTS}"`);
  }
}

class YoudaoLanguageModelV3 {
  specificationVersion = YOUDAO_SPEC_VERSION;

  constructor(modelId, config) {
    this.provider = `${config.providerName}.chat`;
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(options) {
    assertChatModelSupported(this.modelId);

    const text = buildTextFromOptions(options);
    const providerOptions = parseProviderOptions(options);
    let response;
    let url;

    if (this.modelId === YOUDAO_MODELS.SUGGEST) {
      url = new URL(`${this.config.baseURL}${YOUDAO_ENDPOINTS.SUGGEST}`);
      url.searchParams.set('num', providerOptions.num || '5');
      url.searchParams.set('ver', '3.0');
      url.searchParams.set('doctype', 'json');
      url.searchParams.set('q', text);

      response = await this.config.fetch(url.toString(), {
        method: 'GET',
        headers: mergeHeaders(this.config.headers, options?.headers),
        signal: options?.abortSignal,
      });
    } else {
      url = new URL(`${this.config.baseURL}${YOUDAO_ENDPOINTS.CHAT}`);
      Object.entries(YOUDAO_CHAT_QUERY).forEach(([key, value]) => url.searchParams.set(key, value));

      const form = new URLSearchParams();
      form.set('q', text);
      form.set('le', String(providerOptions.le || YOUDAO_CHAT_FORM_DEFAULTS.le));
      form.set('client', String(providerOptions.client || YOUDAO_CHAT_FORM_DEFAULTS.client));
      form.set('keyfrom', String(providerOptions.keyfrom || YOUDAO_CHAT_FORM_DEFAULTS.keyfrom));

      response = await this.config.fetch(url.toString(), {
        method: 'POST',
        headers: mergeHeaders(this.config.headers, options?.headers, 'application/x-www-form-urlencoded'),
        body: form.toString(),
        signal: options?.abortSignal,
      });
    }

    await assertResponseIsOK(response, 'Youdao upstream returned');

    const payload = await response.json().catch(() => ({}));
    let textOutput = '';
    if (this.modelId === YOUDAO_MODELS.SUGGEST) {
      if (payload?.result?.code !== 200) {
        throw new Error(`Youdao suggest upstream error: ${payload?.result?.msg || 'unknown error'}`);
      }
      textOutput = JSON.stringify(payload?.data || {}, null, 2);
    } else {
      payload.oxford = undefined;
      payload.oxfordAdvance = undefined;
      payload.oxfordAdvanceHtml = undefined;
      payload.oxfordAdvanceTen = undefined;
      payload.webster = undefined;
      payload.wordElaboration = undefined;
      payload.senior = undefined;
      textOutput = JSON.stringify(payload, null, 2);
    }
    const headers = toHeadersRecord(Object.fromEntries(response.headers.entries()));

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
        headers,
        body: payload,
      },
    };
  }

  async doStream() {
    throw new Error('Youdao does not support streaming');
  }
}

class YoudaoSpeechModelV3 {
  specificationVersion = YOUDAO_SPEC_VERSION;

  constructor(modelId, config) {
    this.provider = `${config.providerName}.speech`;
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(options) {
    assertSpeechModelSupported(this.modelId);

    const text = buildTextFromOptions(options);
    const providerOptions = parseProviderOptions(options);
    const pronunciationType = Number(providerOptions.type ?? YOUDAO_DEFAULT_TTS_TYPE);

    const url = new URL(`${this.config.baseURL}${YOUDAO_ENDPOINTS.TTS}`);
    url.searchParams.set('audio', text);
    url.searchParams.set('type', String(pronunciationType));

    const requestHeaders = mergeHeaders(this.config.headers, options?.headers);
    const response = await this.config.fetch(url.toString(), {
      method: 'GET',
      headers: requestHeaders,
      signal: options?.abortSignal,
    });

    await assertResponseIsOK(response, 'Youdao TTS upstream returned');

    const audio = new Uint8Array(await response.arrayBuffer());
    const headers = toHeadersRecord(Object.fromEntries(response.headers.entries()));

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
        headers,
      },
      mediaType: response.headers.get('content-type') || YOUDAO_TTS_MEDIA_TYPE,
    };
  }
}

export function createYoudao(options = {}) {
  const config = {
    providerName: options.name || YOUDAO_PROVIDER_NAME,
    baseURL: resolveBaseURL(options.baseURL),
    headers: options.headers || {},
    fetch: options.fetch || fetch,
  };

  const createChatModel = (modelId) => new YoudaoLanguageModelV3(modelId, config);
  const createSpeechModel = (modelId) => new YoudaoSpeechModelV3(modelId, config);

  return {
    specificationVersion: YOUDAO_SPEC_VERSION,
    chat: createChatModel,
    languageModel: createChatModel,
    speech: createSpeechModel,
    speechModel: createSpeechModel,
  };
}
