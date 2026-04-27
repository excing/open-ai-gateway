import { assertResponseIsOK } from "./provider-errors.js";

const MICROSOFT_TTS_PROVIDER_NAME = 'microsoft-tts';
const MICROSOFT_TTS_DEFAULT_MODEL = 'microsoft-tts';
const MICROSOFT_TTS_PATH = '/tts';
const MICROSOFT_TTS_DEFAULT_VOICE = 'zh-CN-XiaoxiaoMultilingualNeural';
const MICROSOFT_TTS_DEFAULT_RATE = 0;
const MICROSOFT_TTS_DEFAULT_PITCH = 0;
const MICROSOFT_TTS_DEFAULT_STYLE = 'general';
const MICROSOFT_TTS_DEFAULT_OUTPUT = 'audio-24khz-48kbitrate-mono-mp3';
const MICROSOFT_TTS_SPEC_VERSION = 'v3';

function trimTrailingSlashes(value) {
  return (value || '').replace(/\/+$/, '');
}

function resolveBaseURL(baseURL) {
  return trimTrailingSlashes(baseURL);
}

function parseProviderOptions(options) {
  return options?.providerOptions?.[MICROSOFT_TTS_PROVIDER_NAME] || {};
}

function toHeadersRecord(headers) {
  if (!headers) return undefined;
  const entries = Object.entries(headers).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
}

class MicrosoftTTSSpeechModelV3 {
  specificationVersion = MICROSOFT_TTS_SPEC_VERSION;

  constructor(modelId, config) {
    this.provider = `${config.providerName}.speech`;
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(options) {
    if (this.modelId !== MICROSOFT_TTS_DEFAULT_MODEL) {
      throw new Error(`Microsoft TTS only supports model "${MICROSOFT_TTS_DEFAULT_MODEL}"`);
    }
    if (!this.config.baseURL) {
      throw new Error('Microsoft TTS baseURL is required');
    }

    const providerOptions = parseProviderOptions(options);
    const rate = Number(providerOptions.rate ?? MICROSOFT_TTS_DEFAULT_RATE);
    const pitch = Number(providerOptions.pitch ?? MICROSOFT_TTS_DEFAULT_PITCH);
    const style = providerOptions.style ?? MICROSOFT_TTS_DEFAULT_STYLE;

    const url = new URL(`${this.config.baseURL}${MICROSOFT_TTS_PATH}`);
    url.searchParams.set('api_key', this.config.apiKey || '');
    url.searchParams.set('t', options.text || '');
    url.searchParams.set('v', options.voice || MICROSOFT_TTS_DEFAULT_VOICE);
    url.searchParams.set('r', String(rate));
    url.searchParams.set('p', String(pitch));
    url.searchParams.set('s', String(style));
    url.searchParams.set('o', options.outputFormat || MICROSOFT_TTS_DEFAULT_OUTPUT);

    const requestHeaders = {
      ...(this.config.headers || {}),
      ...(options?.headers || {}),
    };

    const response = await this.config.fetch(url.toString(), {
      method: 'GET',
      headers: requestHeaders,
      signal: options?.abortSignal,
    });

    await assertResponseIsOK(response, 'Microsoft TTS upstream returned');

    const bytes = new Uint8Array(await response.arrayBuffer());
    const headers = toHeadersRecord(Object.fromEntries(response.headers.entries()));

    return {
      audio: bytes,
      warnings: [],
      response: {
        timestamp: new Date(),
        modelId: this.modelId,
        headers,
      },
      providerMetadata: {
        [this.config.providerName]: {
          endpoint: url.toString(),
        },
      },
    };
  }
}

export function createMicrosoftTTS(options = {}) {
  const config = {
    providerName: options.name || MICROSOFT_TTS_PROVIDER_NAME,
    baseURL: resolveBaseURL(options.baseURL),
    apiKey: options.apiKey || '',
    headers: options.headers || {},
    fetch: options.fetch || fetch,
  };

  const createSpeechModel = (modelId) => new MicrosoftTTSSpeechModelV3(modelId, config);

  return {
    specificationVersion: MICROSOFT_TTS_SPEC_VERSION,
    speech: createSpeechModel,
    speechModel: createSpeechModel,
  };
}
