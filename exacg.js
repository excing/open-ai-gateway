const EXACG_PROVIDER_NAME = 'exacg';
const EXACG_DEFAULT_BASE_URL = 'https://sd.exacg.cc/api/v1';
const EXACG_ENDPOINTS = {
  GENERATE_IMAGE: '/generate_image',
};
const EXACG_SPEC_VERSION = 'v3';
const EXACG_MAX_IMAGES_PER_CALL = 1;
const EXACG_DEFAULT_SEED = -1;
const EXACG_PROVIDER_OPTIONS_KEY = 'exacg';

function trimTrailingSlashes(value) {
  return (value || '').replace(/\/+$/, '');
}

function resolveBaseURL(baseURL) {
  return trimTrailingSlashes(baseURL) || EXACG_DEFAULT_BASE_URL;
}

function parseSize(size) {
  if (!size || typeof size !== 'string') return {};
  const [width, height] = size.split('x');
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  if (!Number.isFinite(parsedWidth) || !Number.isFinite(parsedHeight)) return {};
  return { width: parsedWidth, height: parsedHeight };
}

function toBase64(uint8Array) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(uint8Array).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < uint8Array.length; i += 1) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binary);
}

function mergeHeaders(baseHeaders, callHeaders, apiKey) {
  const headers = {
    'content-type': 'application/json',
    ...(baseHeaders || {}),
    ...(callHeaders || {}),
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function getExacgProviderOptions(options) {
  return options?.providerOptions?.[EXACG_PROVIDER_OPTIONS_KEY] || {};
}

function parseModelIndex(modelId) {
  const parsed = Number(modelId);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Exacg model_index must be numeric, got: ${modelId}`);
  }
  return parsed;
}

function buildRequestBody(modelId, options) {
  const providerOptions = getExacgProviderOptions(options);
  const size = parseSize(options?.size);
  const body = {
    prompt: options?.prompt || '',
    seed: options?.seed ?? EXACG_DEFAULT_SEED,
    model_index: parseModelIndex(modelId),
  };

  if (size.width !== undefined) body.width = size.width;
  if (size.height !== undefined) body.height = size.height;

  if (providerOptions.negative_prompt !== undefined) body.negative_prompt = providerOptions.negative_prompt;
  if (providerOptions.steps !== undefined) body.steps = providerOptions.steps;
  if (providerOptions.cfg !== undefined) body.cfg = providerOptions.cfg;
  if (providerOptions.image_source !== undefined) body.image_source = providerOptions.image_source;

  return body;
}

async function responseJson(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Exacg response is not JSON');
  }
  return response.json();
}

function extractErrorMessage(json) {
  if (typeof json?.error === 'string' && json.error.length > 0) return json.error;
  return '';
}

async function tryFetchUrlAsBase64(imageUrl, fetchFn, headers, abortSignal) {
  const response = await fetchFn(imageUrl, { method: 'GET', headers, signal: abortSignal });
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return toBase64(bytes);
}

async function extractBase64ImageFromOfficialSuccess(json, fetchFn, headers, abortSignal) {
  if (json?.success !== true || !json?.data || typeof json.data !== 'object') {
    throw new Error('Exacg response is not in success format');
  }
  const imageUrl = json.data.image_url;
  if (typeof imageUrl !== 'string' || imageUrl.length === 0) {
    throw new Error('Exacg success response missing data.image_url');
  }
  const base64 = await tryFetchUrlAsBase64(imageUrl, fetchFn, headers, abortSignal);
  if (!base64) {
    throw new Error('Failed to download exacg image_url');
  }
  return base64;
}

class ExacgImageModelV3 {
  specificationVersion = EXACG_SPEC_VERSION;
  maxImagesPerCall = EXACG_MAX_IMAGES_PER_CALL;

  constructor(modelId, config) {
    this.provider = `${config.providerName}.image`;
    this.modelId = modelId;
    this.config = config;
  }

  async doGenerate(options) {
    const headers = mergeHeaders(this.config.headers, options?.headers, this.config.apiKey);
    const url = `${this.config.baseURL}${EXACG_ENDPOINTS.GENERATE_IMAGE}`;
    const body = buildRequestBody(this.modelId, options);

    const response = await this.config.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.abortSignal,
    });

    if (!response.ok) {
      throw new Error(`Exacg upstream returned ${response.status}`);
    }

    const json = await responseJson(response);
    const errorMessage = extractErrorMessage(json);
    if (errorMessage) {
      throw new Error(`Exacg upstream error: ${errorMessage}`);
    }
    const base64 = await extractBase64ImageFromOfficialSuccess(json, this.config.fetch, headers, options?.abortSignal);

    return {
      images: [base64],
      warnings: [],
      providerMetadata: {
        [this.config.providerName]: {
          images: [json],
        },
      },
      response: {
        timestamp: new Date(),
        modelId: this.modelId,
        headers: undefined,
      },
    };
  }
}

export function createExacg(options = {}) {
  const config = {
    providerName: options.name || EXACG_PROVIDER_NAME,
    baseURL: resolveBaseURL(options.baseURL),
    apiKey: options.apiKey || '',
    headers: options.headers || {},
    fetch: options.fetch || fetch,
  };

  const createImageModel = (modelId) => new ExacgImageModelV3(modelId, config);

  return {
    specificationVersion: EXACG_SPEC_VERSION,
    image: createImageModel,
    imageModel: createImageModel,
  };
}
