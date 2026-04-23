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

function getMp3Duration(data) {
  let offset = skipID3(data)
  let duration = 0

  while (offset + 4 < data.length) {
    if (data[offset] === 0xff && (data[offset + 1] & 0xe0) === 0xe0) {

      const header = parseFrameHeader(data, offset)

      if (header.frameSize && header.samples) {
        offset += header.frameSize
        duration += header.samples / header.sampleRate
      } else {
        offset++
      }

    } else if (
      data[offset] === 0x54 &&
      data[offset + 1] === 0x41 &&
      data[offset + 2] === 0x47
    ) {
      offset += 128
    } else {
      offset++
    }

  }

  return Math.round(duration * 1000) / 1000
}

function skipID3(data) {

  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {

    const flags = data[5]
    const footer = (flags & 0x10) ? 10 : 0

    const z0 = data[6]
    const z1 = data[7]
    const z2 = data[8]
    const z3 = data[9]

    const size =
      ((z0 & 0x7f) << 21) |
      ((z1 & 0x7f) << 14) |
      ((z2 & 0x7f) << 7) |
      (z3 & 0x7f)

    return 10 + size + footer
  }

  return 0
}

function parseFrameHeader(data, offset) {

  const b1 = data[offset + 1]
  const b2 = data[offset + 2]

  const versionBits = (b1 & 0x18) >> 3
  const layerBits = (b1 & 0x06) >> 1

  const versions = ['2.5','x','2','1']
  const layers = ['x','3','2','1']

  const version = versions[versionBits]
  const simpleVersion = version === '2.5' ? 2 : version
  const layer = layers[layerBits]

  const bitRates = {
    V1L1:[0,32,64,96,128,160,192,224,256,288,320,352,384,416,448],
    V1L2:[0,32,48,56,64,80,96,112,128,160,192,224,256,320,384],
    V1L3:[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320],
    V2L1:[0,32,48,56,64,80,96,112,128,144,160,176,192,224,256],
    V2L2:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160],
    V2L3:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160]
  }

  const sampleRates = {
    '1':[44100,48000,32000],
    '2':[22050,24000,16000],
    '2.5':[11025,12000,8000]
  }

  const samples = {
    '1':{1:384,2:1152,3:1152},
    '2':{1:384,2:1152,3:576}
  }

  const key = 'V' + simpleVersion + 'L' + layer
  const bitrateIndex = (b2 & 0xf0) >> 4
  const sampleRateIndex = (b2 & 0x0c) >> 2
  const padding = (b2 & 0x02) >> 1

  const bitRate = bitRates[key]?.[bitrateIndex] || 0
  const sampleRate = sampleRates[version]?.[sampleRateIndex] || 0
  const sample = samples[simpleVersion]?.[layer] || 0

  if (!bitRate || !sampleRate || !sample) {
    return {}
  }

  let frameSize

  if (layer === '1') {
    frameSize = ((sample * bitRate * 125 / sampleRate) + padding * 4) | 0
  } else {
    frameSize = ((sample * bitRate * 125 / sampleRate) + padding) | 0
  }

  return {
    frameSize,
    samples: sample,
    sampleRate
  }
}

function getMp4Duration(uint8) {
  const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);

  const moov = findBox(uint8, 0, uint8.length, "moov");
  if (!moov) return null;

  // 优先解析 video track mdhd
  const traks = findBoxes(uint8, moov.start, moov.end, "trak");

  for (const trak of traks) {
    const mdia = findBox(uint8, trak.start, trak.end, "mdia");
    if (!mdia) continue;

    const mdhd = findBox(uint8, mdia.start, mdia.end, "mdhd");
    if (!mdhd) continue;

    const duration = parseMdhd(uint8, view, mdhd.start);
    if (duration) return duration;
  }

  // fallback mvhd
  const mvhd = findBox(uint8, moov.start, moov.end, "mvhd");
  if (mvhd) {
    return parseMvhd(uint8, view, mvhd.start);
  }

  return null;
}

function findBox(data, start, end, type) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  let offset = start;

  while (offset < end) {
    const size = view.getUint32(offset);
    const name = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7]
    );

    if (name === type) {
      return {
        start: offset + 8,
        end: offset + size
      };
    }

    if (size <= 0) break;

    offset += size;
  }

  return null;
}

function findBoxes(data, start, end, type) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const result = [];
  let offset = start;

  while (offset < end) {
    const size = view.getUint32(offset);

    const name = String.fromCharCode(
      data[offset + 4],
      data[offset + 5],
      data[offset + 6],
      data[offset + 7]
    );

    if (name === type) {
      result.push({
        start: offset + 8,
        end: offset + size
      });
    }

    if (size <= 0) break;

    offset += size;
  }

  return result;
}

function parseMdhd(data, view, offset) {
  const version = data[offset];

  if (version === 1) {
    const timescale = view.getUint32(offset + 20);
    const duration = Number(view.getBigUint64(offset + 24));
    return duration / timescale;
  } else {
    const timescale = view.getUint32(offset + 12);
    const duration = view.getUint32(offset + 16);
    return duration / timescale;
  }
}

function parseMvhd(data, view, offset) {
  const version = data[offset];

  if (version === 1) {
    const timescale = view.getUint32(offset + 20);
    const duration = Number(view.getBigUint64(offset + 24));
    return duration / timescale;
  } else {
    const timescale = view.getUint32(offset + 12);
    const duration = view.getUint32(offset + 16);
    return duration / timescale;
  }
}

export { extractMediaResources, downloadFile, getMp3Duration, getMp4Duration };
