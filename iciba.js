import { assertResponseIsOK } from "./provider-errors";

const ICIBA_PROVIDER_NAME = 'iciba';
const ICIBA_DEFAULT_BASE_URL = 'https://www.iciba.com';
const ICIBA_SPEC_VERSION = 'v3';
const ICIBA_DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; OpenAIGateway/1.0; +https://github.com)';
const ICIBA_MODELS = {
  DICT: 'iciba-dict',
  SUGGEST: 'iciba-suggest',
  VOICE: 'iciba-dictvoice',
};
const ICIBA_CHAT_MODEL_SET = new Set([ICIBA_MODELS.DICT, ICIBA_MODELS.SUGGEST]);
const ICIBA_ENDPOINTS = {
  WORD_DATA: '/_next/data/SIgDISbkU9OFnSzS3LWHc/word.json',
  SUGGEST: 'https://dict.iciba.com/dictionary/word/suggestion',
};
const ICIBA_DEFAULT_SUGGEST_NUMS = 5;
const ICIBA_DEFAULT_TYPE = 1;
const ICIBA_TTS_MEDIA_TYPE = 'audio/mpeg';
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
  return trimTrailingSlashes(baseURL) || ICIBA_DEFAULT_BASE_URL;
}

function toHeadersRecord(headers) {
  if (!headers) return undefined;
  const entries = Object.entries(headers).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
}

function mergeHeaders(baseHeaders, callHeaders) {
  return {
    'user-agent': ICIBA_DEFAULT_USER_AGENT,
    ...(baseHeaders || {}),
    ...(callHeaders || {}),
  };
}

function parseProviderOptions(options) {
  return options?.providerOptions?.[ICIBA_PROVIDER_NAME] || {};
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
  if (!ICIBA_CHAT_MODEL_SET.has(modelId)) {
    throw new Error(`Iciba chat only supports models "${ICIBA_MODELS.DICT}" and "${ICIBA_MODELS.SUGGEST}"`);
  }
}

function assertSpeechModelSupported(modelId) {
  if (modelId !== ICIBA_MODELS.VOICE) {
    throw new Error(`Iciba speech only supports model "${ICIBA_MODELS.VOICE}"`);
  }
}

function extractIcibaSymbols(payload) {
  return payload?.pageProps?.initialReduxState?.word?.wordInfo?.baesInfo?.symbols?.[0] || {};
}

function pickIcibaVoiceUrl(symbols, type) {
  if (type === 1 && symbols.ph_en_mp3_bk) return symbols.ph_en_mp3_bk;
  if (type === 2 && symbols.ph_am_mp3_bk) return symbols.ph_am_mp3_bk;
  return symbols.ph_tts_mp3_bk || '';
}

class IcibaLanguageModelV3 {
  specificationVersion = ICIBA_SPEC_VERSION;

  constructor(modelId, config) {
    this.provider = `${config.providerName}.chat`;
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(options) {
    assertChatModelSupported(this.modelId);

    const text = buildTextFromOptions(options);
    const providerOptions = parseProviderOptions(options);
    const requestHeaders = mergeHeaders(this.config.headers, options?.headers);
    let url;
    let response;
    let payload;
    let textOutput;

    if (this.modelId === ICIBA_MODELS.SUGGEST) {
      const nums = Number(providerOptions.nums ?? ICIBA_DEFAULT_SUGGEST_NUMS);
      url = new URL(ICIBA_ENDPOINTS.SUGGEST);
      url.searchParams.set('word', text);
      url.searchParams.set('nums', String(nums));
      response = await this.config.fetch(url.toString(), {
        method: 'GET',
        headers: requestHeaders,
        signal: options?.abortSignal,
      });
      assertResponseIsOK(response, 'Iciba upstream returned');
      payload = await response.json().catch(() => ({}));
      if (payload?.status !== 1) {
        throw new Error('Iciba suggest upstream error');
      }
      textOutput = JSON.stringify(payload?.message || [], null, 2);
    } else {
      url = new URL(`${this.config.baseURL}${ICIBA_ENDPOINTS.WORD_DATA}`);
      url.searchParams.set('w', text);
      response = await this.config.fetch(url.toString(), {
        method: 'GET',
        headers: requestHeaders,
        signal: options?.abortSignal,
      });
      assertResponseIsOK(response, 'Iciba upstream returned');
      payload = await response.json().catch(() => ({}));
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
    throw new Error('Iciba does not support streaming');
  }
}

class IcibaSpeechModelV3 {
  specificationVersion = ICIBA_SPEC_VERSION;

  constructor(modelId, config) {
    this.provider = `${config.providerName}.speech`;
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(options) {
    assertSpeechModelSupported(this.modelId);

    const text = buildTextFromOptions(options);
    const providerOptions = parseProviderOptions(options);
    const type = Number(providerOptions.type ?? options?.type ?? ICIBA_DEFAULT_TYPE);

    const url = new URL(`${this.config.baseURL}${ICIBA_ENDPOINTS.WORD_DATA}`);
    url.searchParams.set('w', text);

    const response = await this.config.fetch(url.toString(), {
      method: 'GET',
      headers: mergeHeaders(this.config.headers, options?.headers),
      signal: options?.abortSignal,
    });

    assertResponseIsOK(response, 'Iciba upstream returned');

    const payload = await response.json().catch(() => ({}));
    const symbols = extractIcibaSymbols(payload);
    const voiceUrl = pickIcibaVoiceUrl(symbols, type);
    if (!voiceUrl) {
      throw new Error('Iciba upstream error: no voice url available');
    }

    const resource = await this.config.fetch(voiceUrl);

    assertResponseIsOK(resource, 'Iciba upstream returned');

    const audio = new Uint8Array(await resource.arrayBuffer());
    const headers = toHeadersRecord(Object.fromEntries(resource.headers.entries()));

    return {
      audio,
      warnings: [],
      providerMetadata: {
        [this.config.providerName]: {
          endpoint: url.toString(),
          voice_url: voiceUrl,
        },
      },
      response: {
        timestamp: new Date(),
        modelId: this.modelId,
        headers,
        body: payload,
      },
      mediaType: resource.mediaType || ICIBA_TTS_MEDIA_TYPE,
    };
  }
}

export function createIciba(options = {}) {
  const config = {
    providerName: options.name || ICIBA_PROVIDER_NAME,
    baseURL: resolveBaseURL(options.baseURL),
    headers: options.headers || {},
    fetch: options.fetch || fetch,
  };

  const createChatModel = (modelId) => new IcibaLanguageModelV3(modelId, config);
  const createSpeechModel = (modelId) => new IcibaSpeechModelV3(modelId, config);

  return {
    specificationVersion: ICIBA_SPEC_VERSION,
    chat: createChatModel,
    languageModel: createChatModel,
    speech: createSpeechModel,
    speechModel: createSpeechModel,
  };
}
