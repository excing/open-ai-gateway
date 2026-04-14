const POLLINATIONS_PROVIDER_NAME = 'pollinations';
const POLLINATIONS_DEFAULT_BASE_URL = 'https://gen.pollinations.ai';
const POLLINATIONS_ENDPOINTS = {
  IMAGE: '/image',
  VIDEO: '/video',
};
const POLLINATIONS_MEDIA_TYPES = {
  IMAGE: 'image/png',
  VIDEO: 'video/mp4',
};
const SPEC_VERSION = 'v3';
const DEFAULT_MAX_PER_CALL = 1;

function trimTrailingSlashes(value) {
  return (value || '').replace(/\/+$/, '');
}

function resolveBaseURL(baseURL) {
  return trimTrailingSlashes(baseURL) || POLLINATIONS_DEFAULT_BASE_URL;
}

function toRecordHeaders(headers) {
  if (!headers) return undefined;
  const entries = Object.entries(headers).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
}

function parseSize(size) {
  if (!size || typeof size !== 'string') return {};
  const [width, height] = size.split('x');
  if (!width || !height) return {};
  return { width, height };
}

function buildUrl(baseURL, endpoint, prompt, query) {
  const url = new URL(`${resolveBaseURL(baseURL)}${endpoint}/${encodeURIComponent(prompt || '')}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function buildHeaders(sharedHeaders, apiKey, callHeaders) {
  const headers = {
    ...(sharedHeaders || {}),
    ...(callHeaders || {}),
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

async function fetchAsBase64({ fetchFn, url, headers, fallbackMediaType, abortSignal }) {
  console.info(url);
  const response = await fetchFn(url, { method: 'GET', headers, signal: abortSignal });
  if (!response.ok) {
    throw new Error(`Pollinations upstream returned ${response.status}`);
  }
  const mediaType = response.headers.get('content-type') || fallbackMediaType;
  const headersRecord = toRecordHeaders(Object.fromEntries(response.headers.entries()));
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { mediaType, data: bytes, headers: headersRecord };
}

class PollinationsImageModelV3 {
  specificationVersion = SPEC_VERSION;
  maxImagesPerCall = DEFAULT_MAX_PER_CALL;

  constructor(modelId, config) {
    this.provider = `${config.providerName}.image`;
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(options) {
    const size = parseSize(options?.size);
    const prompt = options?.prompt || '';
    const requestHeaders = buildHeaders(this.config.headers, this.config.apiKey, options?.headers);
    const url = buildUrl(this.config.baseURL, POLLINATIONS_ENDPOINTS.IMAGE, prompt, {
      model: this.modelId,
      seed: options?.seed,
      width: size.width,
      height: size.height,
      nologo: true,
    });

    const media = await fetchAsBase64({
      fetchFn: this.config.fetch,
      url,
      headers: requestHeaders,
      fallbackMediaType: POLLINATIONS_MEDIA_TYPES.IMAGE,
      abortSignal: options?.abortSignal,
    });

    return {
      images: [media.data],
      warnings: [],
      providerMetadata: {
        [this.config.providerName]: {
          images: [{ url, mediaType: media.mediaType }],
        },
      },
      response: {
        timestamp: new Date(),
        modelId: this.modelId,
        headers: media.headers,
      },
    };
  }
}

class PollinationsVideoModelV3 {
  specificationVersion = SPEC_VERSION;
  maxVideosPerCall = DEFAULT_MAX_PER_CALL;

  constructor(modelId, config) {
    this.provider = `${config.providerName}.video`;
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(options) {
    const prompt = options?.prompt || '';
    const requestHeaders = buildHeaders(this.config.headers, this.config.apiKey, options?.headers);
    const url = buildUrl(this.config.baseURL, POLLINATIONS_ENDPOINTS.VIDEO, prompt, {
      model: this.modelId,
      seed: options?.seed,
      aspect_ratio: options?.aspectRatio,
    });

    const media = await fetchAsBase64({
      fetchFn: this.config.fetch,
      url,
      headers: requestHeaders,
      fallbackMediaType: POLLINATIONS_MEDIA_TYPES.VIDEO,
      abortSignal: options?.abortSignal,
    });

    return {
      videos: [{ type: 'binary', data: media.data, mediaType: media.mediaType }],
      warnings: [],
      providerMetadata: {
        [this.config.providerName]: {
          videos: [{ url, mediaType: media.mediaType }],
        },
      },
      response: {
        timestamp: new Date(),
        modelId: this.modelId,
        headers: media.headers,
      },
    };
  }
}

export function createPollinations(options = {}) {
  const config = {
    providerName: options.name || POLLINATIONS_PROVIDER_NAME,
    baseURL: resolveBaseURL(options.baseURL),
    apiKey: options.apiKey || '',
    headers: options.headers || {},
    fetch: options.fetch || fetch,
  };

  const createImageModel = (modelId) => new PollinationsImageModelV3(modelId, config);
  const createVideoModel = (modelId) => new PollinationsVideoModelV3(modelId, config);

  return {
    specificationVersion: SPEC_VERSION,
    image: createImageModel,
    imageModel: createImageModel,
    video: createVideoModel,
  };
}
