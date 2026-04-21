import { createDownload, DefaultGeneratedFile } from 'ai';

const CONSTANTS = {
  DOWNLOAD_TIMEOUT_MS: 60_000,
};

const downloadWithAiSdk = createDownload();

function toMediaBuckets(text, resources, usage) {
  const buckets = { text, files: [], images: [], video: null, videos: [], audios: [], audio: null, usage };
  for (const resource of resources) {
    if (!resource?.uint8Array || typeof resource?.mediaType !== 'string') continue;
    if (resource.mediaType.startsWith('image/')) buckets.images.push(resource);
    if (resource.mediaType.startsWith('video/')) buckets.videos.push(resource);
    if (resource.mediaType.startsWith('audio/')) buckets.audios.push(resource);
    buckets.files.push(resource);
  }
  if (0 < buckets.videos.length) buckets.video = buckets.videos[0];
  if (0 < buckets.audios.length) buckets.audio = buckets.audios[0];
  return buckets;
}

async function extractMediaResources({ text = '', files = [], usage }) {
  if (files && files.length > 0) {
    return toMediaBuckets(text, files, usage);
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
        return await downloadFile(url);
      }),
    );

    resources.push(...downloadResults.filter(Boolean).map(({ data, mediaType }) => new DefaultGeneratedFile({ data, mediaType })));
  }

  return toMediaBuckets(text, resources, usage);
}

async function downloadFile(url, timeout = CONSTANTS.DOWNLOAD_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await downloadWithAiSdk({
      url: new URL(url),
      abortSignal: controller.signal,
    });
  } catch (error) {
    console.warn(`资源(${url})下载失败: `, error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getMp3Duration(uint8) {
  const now = new Date();
  const data = uint8;
  const len = data.length;

  let i = 0;

  // 跳过 ID3
  if (
    data[0] === 0x49 && // I
    data[1] === 0x44 && // D
    data[2] === 0x33
  ) {
    const size =
      ((data[6] & 0x7f) << 21) |
      ((data[7] & 0x7f) << 14) |
      ((data[8] & 0x7f) << 7) |
      (data[9] & 0x7f);

    i = 10 + size;
  }

  for (; i < len - 4; i++) {
    if (data[i] === 0xff && (data[i + 1] & 0xe0) === 0xe0) {
      const bitrateIndex = (data[i + 2] >> 4) & 0x0f;

      const bitrateTable = [
        0, 32, 40, 48, 56, 64, 80, 96,
        112, 128, 160, 192, 224, 256, 320, 0
      ];

      const bitrate = bitrateTable[bitrateIndex];

      if (!bitrate) continue;

      const duration = (len * 8) / (bitrate * 1000);

      console.info('timeMs', new Date() - now);
      return duration;
    }
  }

  return null;
}

function getMp4Duration(uint8) {
  const data = uint8;
  const view = new DataView(data.buffer);

  let offset = 0;

  while (offset < data.length) {
    const size = view.getUint32(offset);
    const type =
      String.fromCharCode(
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7]
      );

    if (type === "moov") {
      return parseMoov(data.subarray(offset + 8, offset + size));
    }

    offset += size;
  }

  return null;
}

function parseMoov(data) {
  const view = new DataView(data.buffer);

  let offset = 0;

  while (offset < data.length) {
    const size = view.getUint32(offset);
    const type =
      String.fromCharCode(
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7]
      );

    if (type === "mvhd") {
      const version = data[offset + 8];

      if (version === 1) {
        const timescale = view.getUint32(offset + 28);
        const duration = Number(view.getBigUint64(offset + 32));
        return duration / timescale;
      } else {
        const timescale = view.getUint32(offset + 20);
        const duration = view.getUint32(offset + 24);
        return duration / timescale;
      }
    }

    offset += size;
  }

  return null;
}

export { extractMediaResources, downloadFile, getMp3Duration, getMp4Duration };
