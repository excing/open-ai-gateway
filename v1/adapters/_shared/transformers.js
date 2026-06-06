import { CALL_TYPES } from '../../../model-selection.js';

const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const CHAT_COMPLETIONS_METHOD = 'POST';
const JSON_CONTENT_TYPE = 'application/json';
const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*\]\((https?:\/\/[^\s)]+|data:[^)]+)\)/g;
const DATA_URL_REGEX = /^data:[^;,]+;base64,(.+)$/i;

function imageGenToChatRequestBody(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return {
    model: source.model,
    messages: [{ role: 'user', content: String(source.prompt || '').trim() }],
    // modalities: ['text', 'image'],
    stream: false,
  };
}

export const buildFrontendRequest = (input) => {
  const userCallType = input?.endpoint?.callType;
  const modelCallType = input?.selection?.model?.call_type;
  if (!userCallType || !modelCallType || userCallType === modelCallType) return input;
  if (modelCallType !== CALL_TYPES.CHAT) return input;
  if (userCallType === CALL_TYPES.IMAGE_GEN) {
    return {
      ...input,
      endpoint: {
        ...input.endpoint,
        path: CHAT_COMPLETIONS_PATH,
        method: CHAT_COMPLETIONS_METHOD,
        callType: CALL_TYPES.CHAT,
      },
      requestBody: imageGenToChatRequestBody(input.requestBody),
    };
  }
  return input;
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
  if (userCallType === CALL_TYPES.IMAGE_GEN && isChatCompletionShape(responseBody)) {
    const newBody = chatToImageGenBody(responseBody);
    if (!newBody.data.length) {
      throw new Error('No image data extracted from chat completion response');
    }
    return { response: buildJsonResponse(newBody, response), responseBody: newBody };
  }
  return { response, responseBody };
};
