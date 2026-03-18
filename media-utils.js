async function extractMediaResources({ text, files = [] }) {
  if (files && files.length > 0) {
    return files.map((file) => ({ base64: file.base64, mediaType: file.mediaType }));
  }
  const resources = [];

  // 3. Inline base64 data URI
  const base64Regex =
    /data:(image|video|audio)\/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)/g;
  let match;
  while ((match = base64Regex.exec(text)) !== null) {
    const [fullMatch, mediaType, format, b64] = match;
    const mimeType = `${mediaType}/${format}`;
    resources.push({ mediaType: mimeType, base64: b64 });
  }

  const pendingDownloads = [];

  // 4. Markdown 图片语法
  const markdownImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  while ((match = markdownImageRegex.exec(text)) !== null) {
    const [, alt, url] = match;
    if (url && !url.startsWith('data:')) {
      pendingDownloads.push({ url, filename: alt || undefined });
    }
  }

  // 5. HTML 媒体标签
  const htmlMediaRegex = /<(img|video|audio|source)[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((match = htmlMediaRegex.exec(text)) !== null) {
    const [fullMatch, , url] = match;
    if (url && !url.startsWith('data:')) {
      const altMatch = fullMatch.match(/(?:alt|title)=["']([^"']+)["']/i);
      pendingDownloads.push({ url, filename: altMatch?.[1] });
    }
  }

  // 6. 纯文本中的媒体 URL
  const urlRegex =
    /https?:\/\/[^\s<>"{}|\\^`\[\]]+\.(jpg|jpeg|png|gif|webp|mp4|webm|mp3|wav|pdf|doc|docx)/gi;
  const urls = text.match(urlRegex);
  if (urls) {
    for (const url of urls) {
      pendingDownloads.push({ url });
    }
  }

  // 去重下载
  if (pendingDownloads.length > 0) {
    const urlMap = new Map();
    for (const d of pendingDownloads) {
      if (!urlMap.has(d.url)) {
        urlMap.set(d.url, d.filename);
      }
    }

    const downloadResults = await Promise.all(
      [...urlMap.entries()].map(async ([url, filename]) => {
        const result = await downloadFile(url, 60 * 1000);
        return {
          mediaType: result.mimeType, base64: result.data
        };
      }),
    );

    resources.push(...downloadResults);
  }

  return resources;
}

async function downloadFile(url, timeout = 10000) {
  try {
    // const controller = new AbortController();
    // const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      // signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MediaExtractor/1.0)',
      },
    });

    // clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`下载资源失败: ${url}`, { status: response.status });
      return { data: url, mimeType: 'application/octet-stream' };
    }

    const mimeType = response.headers.get('content-type') || 'application/octet-stream';

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const publicUrl = `data:${mimeType};base64,${base64}`;
    return { data: publicUrl, mimeType };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error(`下载资源超时: ${url}`);
    } else {
      console.error(`下载资源异常: ${url}`, error instanceof Error ? error : undefined);
    }
    return { data: url, mimeType: 'application/octet-stream' };
  }
}

export { extractMediaResources, downloadFile };
