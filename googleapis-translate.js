import { assertResponseIsOK } from "./provider-errors.js";

const GOOGLE_TRANSLATE_PROVIDER_NAME = 'google-translate';
const GOOGLE_TRANSLATE_DEFAULT_BASE_URL = 'https://translate.googleapis.com';
const GOOGLE_TRANSLATE_SPEC_VERSION = 'v3';
const GOOGLE_TRANSLATE_ENDPOINTS = {
  TTS: '/translate_tts',
  CHAT: '/translate_a/single',
};
const GOOGLE_TRANSLATE_MODELS = {
  TTS: 'google-tts',
  TRANSLATE: 'google-translate',
  DICT: 'google-dict',
};
const GOOGLE_TRANSLATE_CHAT_MODEL_SET = new Set([
  GOOGLE_TRANSLATE_MODELS.TRANSLATE,
  GOOGLE_TRANSLATE_MODELS.DICT,
]);
const GOOGLE_TRANSLATE_DEFAULT_SOURCE_LANG = 'auto';
const GOOGLE_TRANSLATE_DEFAULT_TARGET_LANG = 'en';
const GOOGLE_TRANSLATE_DEFAULT_TTS_SPEED = 1;
const GOOGLE_TRANSLATE_DEFAULT_TOKEN = '100000.999999';
const GOOGLE_TRANSLATE_TTS_MEDIA_TYPE = 'audio/mpeg';
const GOOGLE_TRANSLATE_DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0';
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
  return trimTrailingSlashes(baseURL) || GOOGLE_TRANSLATE_DEFAULT_BASE_URL;
}

function toHeadersRecord(headers) {
  if (!headers) return undefined;
  const entries = Object.entries(headers).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
}

function parseProviderOptions(options) {
  return options?.providerOptions?.[GOOGLE_TRANSLATE_PROVIDER_NAME] || {};
}

// fix: Illegal invocation: function called with incorrect `this` reference
// 返回一个新函数，调用时不直接 candidate(...args)，而是显式指定 this = globalThis。
function toSafeFetch(fetchFn) {
  const candidate = fetchFn || fetch;
  return (...args) => candidate.call(globalThis, ...args);
}

function mergeHeaders(baseHeaders, callHeaders) {
  return {
    ...(baseHeaders || {}),
    ...(callHeaders || {}),
    'user-agent': GOOGLE_TRANSLATE_DEFAULT_USER_AGENT,
  };
}

function buildTranslateText(options) {
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
  if (typeof options?.prompt === 'string' && options.prompt.length > 0) return options.prompt;
  if (typeof options?.input === 'string' && options.input.length > 0) return options.input;
  return '';
}

function buildSpeechText(options) {
  if (typeof options?.text === 'string' && options.text.length > 0) return options.text;
  if (typeof options?.input === 'string' && options.input.length > 0) return options.input;
  return '';
}

function extractTranslatedText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (Array.isArray(payload.sentences)) {
    const text = payload.sentences.map((item) => item?.trans || '').join('').trim();
    if (text) return text;
  }
  if (Array.isArray(payload.alternatives)) {
    const text = payload.alternatives
      .map((item) => item?.word_postproc || item?.word || item?.trans || '')
      .filter(Boolean)
      .join(', ')
      .trim();
    if (text) return text;
  }
  if (typeof payload.trans === 'string') return payload.trans;
  return '';
}

function assertChatModelSupported(modelId) {
  if (!GOOGLE_TRANSLATE_CHAT_MODEL_SET.has(modelId)) {
    throw new Error(
      `Google Translate chat only supports models "${GOOGLE_TRANSLATE_MODELS.TRANSLATE}" and "${GOOGLE_TRANSLATE_MODELS.DICT}"`,
    );
  }
}

function assertSpeechModelSupported(modelId) {
  if (modelId !== GOOGLE_TRANSLATE_MODELS.TTS) {
    throw new Error(`Google Translate speech only supports model "${GOOGLE_TRANSLATE_MODELS.TTS}"`);
  }
}

class GoogleTranslateLanguageModelV3 {
  specificationVersion = GOOGLE_TRANSLATE_SPEC_VERSION;

  constructor(modelId, config) {
    this.provider = `${config.providerName}.chat`;
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(options) {
    assertChatModelSupported(this.modelId);

    const providerOptions = parseProviderOptions(options);
    const sourceLang = providerOptions.source_lang || GOOGLE_TRANSLATE_DEFAULT_SOURCE_LANG;
    const targetLang = providerOptions.target_lang || GOOGLE_TRANSLATE_DEFAULT_TARGET_LANG;
    const text = buildTranslateText(options);

    const url = new URL(`${this.config.baseURL}${GOOGLE_TRANSLATE_ENDPOINTS.CHAT}`);
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('dj', '1');
    ['t', 'at', 'bd', 'ex', 'md', 'rw', 'ss', 'rm'].forEach((value) => url.searchParams.append('dt', value));
    url.searchParams.set('q', text);
    url.searchParams.set('sl', String(sourceLang));
    url.searchParams.set('source', 'icon');
    url.searchParams.set('tk', GOOGLE_TRANSLATE_DEFAULT_TOKEN);
    url.searchParams.set('tl', String(targetLang));

    const requestHeaders = mergeHeaders(this.config.headers, options?.headers);
    const response = await this.config.fetch(url.toString(), {
      method: 'GET',
      headers: requestHeaders,
      signal: options?.abortSignal,
    });

    await assertResponseIsOK(response, 'Google Translate upstream returned');

    const payload = await response.json().catch(() => ({}));
    const textOutput = extractTranslatedText(payload);
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
    throw new Error('Google Translate does not support streaming');
  }
}

class GoogleTranslateSpeechModelV3 {
  specificationVersion = GOOGLE_TRANSLATE_SPEC_VERSION;

  constructor(modelId, config) {
    this.provider = `${config.providerName}.speech`;
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(options) {
    assertSpeechModelSupported(this.modelId);

    const providerOptions = parseProviderOptions(options);
    const targetLang = providerOptions.lang || providerOptions.target_lang || GOOGLE_TRANSLATE_DEFAULT_TARGET_LANG;
    const speed = Number(providerOptions.speed ?? options?.speed ?? GOOGLE_TRANSLATE_DEFAULT_TTS_SPEED);
    const text = buildSpeechText(options);

    const url = new URL(`${this.config.baseURL}${GOOGLE_TRANSLATE_ENDPOINTS.TTS}`);
    url.searchParams.set('ie', 'UTF-8');
    url.searchParams.set('tl', String(targetLang));
    url.searchParams.set('client', 'tw-ob');
    url.searchParams.set('q', text);
    url.searchParams.set('ttsspeed', String(speed));

    const requestHeaders = mergeHeaders(this.config.headers, options?.headers);
    const response = await this.config.fetch(url.toString(), {
      method: 'GET',
      headers: requestHeaders,
      signal: options?.abortSignal,
    });

    await assertResponseIsOK(response, 'Google Translate TTS upstream returned');

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
      mediaType: response.headers.get('content-type') || GOOGLE_TRANSLATE_TTS_MEDIA_TYPE,
    };
  }
}

export function createGoogleApisTranslate(options = {}) {
  const config = {
    providerName: options.name || GOOGLE_TRANSLATE_PROVIDER_NAME,
    baseURL: resolveBaseURL(options.baseURL),
    headers: options.headers || {},
    fetch: toSafeFetch(options.fetch),
  };

  const createChatModel = (modelId) => new GoogleTranslateLanguageModelV3(modelId, config);
  const createSpeechModel = (modelId) => new GoogleTranslateSpeechModelV3(modelId, config);

  return {
    specificationVersion: GOOGLE_TRANSLATE_SPEC_VERSION,
    chat: createChatModel,
    languageModel: createChatModel,
    speech: createSpeechModel,
    speechModel: createSpeechModel,
  };
}
