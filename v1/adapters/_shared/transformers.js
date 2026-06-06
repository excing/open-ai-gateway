import { CALL_TYPES } from '../../../model-selection.js';

const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const CHAT_COMPLETIONS_METHOD = 'POST';
const JSON_CONTENT_TYPE = 'application/json';
const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*\]\((https?:\/\/[^\s)]+|data:[^)]+)\)/g;
const DATA_URL_REGEX = /^data:[^;,]+;base64,(.+)$/i;
const DEFAULT_IMAGE_MIME = 'image/png';

const IMAGE_USER_CALL_TYPES = new Set([CALL_TYPES.IMAGE_GEN, CALL_TYPES.IMAGE_EDIT]);

function buildPromptByChatRequestBody(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const prompt = String(source.prompt || '').trim();
  const negative_prompt = source.negative_prompt ? `, no [${source.negative_prompt}]` : '';
  const count = source.n && 1 < source.n ? `, ${source.n} images` : '';
  const size = source.size ? `, ${source.size}` : '';
  const quality = source.quality ? `, ${source.quality} quality` : '';
  const style = source.style ? `, ${source.style} style` : '';
  const background = source.background ? `, ${source.background}` : '';
  return `${prompt}${negative_prompt}${count}${size}${quality}${style}${background}`;
}

function imageGenToChatRequestBody(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return {
    model: source.model,
    messages: [{ role: 'user', content: buildPromptByChatRequestBody(body) }],
    stream: false,
  };
}

async function imageEditToChatRequestBody(body, fetchFn) {
  const parsed = isFormDataInstance(body) ? readFromFormData(body) : readFromJson(body);
  const attachments = [...parsed.images];
  if (parsed.mask != null) attachments.push(parsed.mask);
  const content = [{ type: 'text', text: buildPromptByChatRequestBody(parsed) }];
  for (const item of attachments) {
    const url = await normalizeToDataUrl(item, fetchFn);
    if (url) content.push({ type: 'image_url', image_url: { url } });
  }
  return {
    model: parsed.model,
    messages: [{ role: 'user', content }],
    stream: false,
  };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const mime = blob.type || DEFAULT_IMAGE_MIME;
  return `data:${mime};base64,${arrayBufferToBase64(buffer)}`;
}

async function fetchUrlAsDataUrl(fetchFn, url) {
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`Failed to fetch image ${url}: ${response.status}`);
  const mime = response.headers.get('content-type') || DEFAULT_IMAGE_MIME;
  const buffer = await response.arrayBuffer();
  return `data:${mime};base64,${arrayBufferToBase64(buffer)}`;
}

async function normalizeToDataUrl(value, fetchFn) {
  if (value == null) return null;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return blobToDataUrl(value);
  const str = String(value).trim();
  if (!str) return null;
  if (str.startsWith('data:')) return str;
  if (/^https?:\/\//i.test(str)) return fetchUrlAsDataUrl(fetchFn, str);
  return `data:${DEFAULT_IMAGE_MIME};base64,${str}`;
}

function collectFormDataImages(form) {
  const images = [];
  for (const key of ['image', 'image[]']) {
    for (const value of form.getAll(key)) images.push(value);
  }
  return images;
}

function collectJsonImages(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter((item) => item != null);
  return [value];
}

function readFromFormData(body) {
  const images = collectFormDataImages(body);
  const mask = body.get('mask');
  return {
    model: String(body.get('model') || ''),
    prompt: String(body.get('prompt') || '').trim(),
    negative_prompt: String(body.get('negative_prompt') || '').trim(),
    n: body.get('n'),
    size: String(body.get('size') || '').trim(),
    quality: String(body.get('quality') || '').trim(),
    style: String(body.get('style') || '').trim(),
    background: String(body.get('background') || '').trim(),
    images,
    mask: mask || null,
  };
}

function readFromJson(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return {
    model: source.model,
    prompt: String(source.prompt || '').trim(),
    negative_prompt: source.negative_prompt,
    n: source.n,
    size: source.size,
    quality: source.quality,
    style: source.style,
    background: source.background,
    images: collectJsonImages(source.image),
    mask: source.mask ?? null,
  };
}

function isFormDataInstance(value) {
  return typeof FormData !== 'undefined' && value instanceof FormData;
}

export const buildFrontendRequest = async (input, deps = {}) => {
  const userCallType = input?.endpoint?.callType;
  const modelCallType = input?.selection?.model?.call_type;
  if (!userCallType || !modelCallType || userCallType === modelCallType) return input;
  if (modelCallType !== CALL_TYPES.CHAT) return input;
  if (!IMAGE_USER_CALL_TYPES.has(userCallType)) return input;
  const fetchFn = deps.fetch || fetch;
  const requestBody = userCallType === CALL_TYPES.IMAGE_EDIT
    ? await imageEditToChatRequestBody(input.requestBody, fetchFn)
    : imageGenToChatRequestBody(input.requestBody);
  return {
    ...input,
    endpoint: {
      ...input.endpoint,
      path: CHAT_COMPLETIONS_PATH,
      method: CHAT_COMPLETIONS_METHOD,
      callType: CALL_TYPES.CHAT,
    },
    requestBody,
  };
};

function toImageDataEntry(value) {
  if (!value) return null;
  const url = String(value).trim();
  if (!url) return null;
  const match = url.match(DATA_URL_REGEX);
  if (match) return { b64_json: match[1] };
  return { url };
}

function pushFromContentPart(images, part) {
  if (!part || typeof part !== 'object') return;
  if (part.type === 'image_url') {
    const entry = toImageDataEntry(part.image_url?.url ?? part.image_url);
    if (entry) images.push(entry);
    return;
  }
  if (part.type === 'output_image' || part.type === 'image') {
    const entry = toImageDataEntry(part.url ?? part.image_url?.url ?? part.image_url);
    if (entry) images.push(entry);
    else if (part.source?.data) images.push({ b64_json: part.source.data });
    return;
  }
  if (part.type === 'image_base64' && part.data) {
    images.push({ b64_json: part.data });
  }
}

function pushFromMarkdown(images, text) {
  if (typeof text !== 'string') return;
  const before = images.length;
  MARKDOWN_IMAGE_REGEX.lastIndex = 0;
  let match;
  while ((match = MARKDOWN_IMAGE_REGEX.exec(text)) !== null) {
    const entry = toImageDataEntry(match[1]);
    if (entry) images.push(entry);
  }
  if (images.length > before) return;
  const trimmed = text.trim();
  if (/^(https?:\/\/|data:)/i.test(trimmed)) {
    const entry = toImageDataEntry(trimmed);
    if (entry) images.push(entry);
  }
}

function extractImagesFromChoice(choice) {
  const images = [];
  const message = choice?.message || {};
  if (Array.isArray(message.images)) {
    for (const img of message.images) {
      if (typeof img === 'string') {
        const entry = toImageDataEntry(img);
        if (entry) images.push(entry);
      } else if (img && typeof img === 'object') {
        pushFromContentPart(images, img.type ? img : { type: 'image_url', image_url: img });
      }
    }
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) pushFromContentPart(images, part);
  } else {
    pushFromMarkdown(images, message.content);
  }
  return images;
}

function chatToImageGenBody(responseBody) {
  const images = [];
  for (const choice of responseBody?.choices || []) {
    images.push(...extractImagesFromChoice(choice));
  }
  const body = {
    created: responseBody?.created || Math.floor(Date.now() / 1000),
    data: images,
  };
  if (responseBody?.usage) body.usage = responseBody.usage;
  return body;
}

function buildJsonResponse(body, sourceResponse) {
  const headers = new Headers(sourceResponse.headers);
  headers.set('content-type', JSON_CONTENT_TYPE);
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  headers.delete('content-encoding');
  return new Response(JSON.stringify(body), { status: sourceResponse.status, headers });
}

function isChatCompletionShape(body) {
  return Array.isArray(body?.choices);
}

export const buildFrontendResponse = (userCallType, response, responseBody) => {
  if (IMAGE_USER_CALL_TYPES.has(userCallType) && isChatCompletionShape(responseBody)) {
    const newBody = chatToImageGenBody(responseBody);
    if (!newBody.data.length) {
      throw new Error('No image data extracted from chat completion response');
    }
    return { response: buildJsonResponse(newBody, response), responseBody: newBody };
  }
  return { response, responseBody };
};
