import { createDownload, DefaultGeneratedFile } from 'ai';

const CONSTANTS = {
  DOWNLOAD_TIMEOUT_MS: 60_000,
};

const downloadWithAiSdk = createDownload();

function toMediaBuckets(resources) {
  const buckets = { all: [], images: [], videos: [], audios: [] };
  for (const resource of resources) {
    if (!resource?.uint8Array || typeof resource?.mediaType !== 'string') continue;
    if (resource.mediaType.startsWith('image/')) buckets.images.push(resource);
    if (resource.mediaType.startsWith('video/')) buckets.videos.push(resource);
    if (resource.mediaType.startsWith('audio/')) buckets.audios.push(resource);
    buckets.all.push(resource);
  }
  return buckets;
}

async function extractMediaResources({ text = '', files = [] }) {
  if (files && files.length > 0) {
    return toMediaBuckets(files);
  }

  const resources = [];

  // 1. Inline base64 data URI
  const base64Regex = /data:(image|video|audio)\/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)/g;
  let match;
  while ((match = base64Regex.exec(text)) !== null) {
    const [_, mediaType, format, b64] = match;
    const mimeType = `${mediaType}/${format}`;
    resources.push(new DefaultGeneratedFile({ data: b64, mediaType: mimeType }));
  }

  // 不使用数组, 是 set 天然拥有数据去重的功能
  // 这里的作用就是对下载链接去重
  const pendingDownloads = new Set();

  // 2. Markdown 图片语法
  const markdownImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  while ((match = markdownImageRegex.exec(text)) !== null) {
    const [, , url] = match;
    if (url && !url.startsWith('data:')) {
      pendingDownloads.add(url);
    }
  }

  // 3. HTML 媒体标签
  const htmlMediaRegex = /<(img|video|audio|source)[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((match = htmlMediaRegex.exec(text)) !== null) {
    const [, , url] = match;
    if (url && !url.startsWith('data:')) {
      pendingDownloads.add(url);
    }
  }

  // 4. 纯文本中的媒体 URL
  const urlRegex =
    /https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(jpg|jpeg|png|gif|webp|mp4|webm|mp3|wav|pdf|doc|docx)/gi;
  const urls = text.match(urlRegex);
  if (urls && urls.length > 0) {
    for (const url of urls) {
      pendingDownloads.add(url);
    }
  }

  // 5. 下载链接
  if (pendingDownloads.size > 0) {
    const downloadResults = await Promise.all(
      [...pendingDownloads].map(async (url) => {
        return await downloadFile(url, CONSTANTS.DOWNLOAD_TIMEOUT_MS);
      }),
    );

    resources.push(...downloadResults.filter(Boolean).map(({ data, mediaType }) => new DefaultGeneratedFile({ data, mediaType })));
  }

  return toMediaBuckets(resources);
}

async function downloadFile(url, timeout = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await downloadWithAiSdk({
      url: new URL(url),
      abortSignal: controller.signal,
    });
  } catch (error) {
    console.warn(`资源${url}下载失败: `, error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export { extractMediaResources, downloadFile };
