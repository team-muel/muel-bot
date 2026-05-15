import { fetchWithTimeout } from './utils/network.js';

export type ScrapedCommunityPost = {
  id: string;
  title: string;
  content: string;
  link: string;
  published: string;
  author: string;
  images: string[];
};

const decodeHtml = (input: string): string => {
  return String(input || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
};

const truncate = (input: string, maxLength: number): string => {
  const text = String(input || '').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 1))}...`;
};

const isYouTubeHost = (hostname: string): boolean => {
  const normalized = String(hostname || '').replace(/^www\./, '').toLowerCase();
  return normalized === 'youtube.com' || normalized.endsWith('.youtube.com');
};

const deriveCommunityPostTitle = (content: string, fallback: string): string => {
  const normalized = String(content || '').replace(/\r/g, '').trim();
  if (!normalized) {
    return truncate(fallback || '새 커뮤니티 게시글', 180);
  }

  const bracketMatch = normalized.match(/【[^】]{4,180}】/);
  if (bracketMatch?.[0]) {
    return truncate(bracketMatch[0], 180);
  }

  const firstLine = normalized
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  if (firstLine) {
    return truncate(firstLine, 180);
  }

  return truncate(normalized, 180);
};

const extractJsonObjectByBraceMatch = (text: string, startIndex: number): string | null => {
  const firstBrace = text.indexOf('{', startIndex);
  if (firstBrace < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(firstBrace, i + 1);
      }
    }
  }

  return null;
};

const extractYtInitialData = (html: string): Record<string, unknown> | null => {
  const markers = [
    'var ytInitialData =',
    'window["ytInitialData"] =',
    "window['ytInitialData'] =",
    'ytInitialData =',
  ];

  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) {
      continue;
    }

    const jsonText = extractJsonObjectByBraceMatch(html, markerIndex + marker.length);
    if (!jsonText) {
      continue;
    }

    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try next marker.
    }
  }

  return null;
};

const getNested = (source: unknown, path: string[]): unknown => {
  return path.reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') {
      return undefined;
    }
    return (acc as Record<string, unknown>)[key];
  }, source);
};

const getRunsText = (value: unknown): string => {
  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as { runs?: Array<{ text?: string }>; simpleText?: string };
  if (typeof record.simpleText === 'string' && record.simpleText.trim()) {
    return record.simpleText.trim();
  }

  const runs = record.runs;
  if (!Array.isArray(runs)) {
    return '';
  }

  return runs.map((item) => String(item?.text || '')).join('').trim();
};

const findFirstPostRenderer = (root: unknown): Record<string, unknown> | null => {
  let found: Record<string, unknown> | null = null;

  const visit = (node: unknown) => {
    if (found || !node || typeof node !== 'object') {
      return;
    }

    const record = node as Record<string, unknown>;
    const backstage = record.backstagePostRenderer;
    if (backstage && typeof backstage === 'object') {
      found = backstage as Record<string, unknown>;
      return;
    }

    const shared = record.sharedPostRenderer;
    if (shared && typeof shared === 'object') {
      found = shared as Record<string, unknown>;
      return;
    }

    for (const value of Object.values(record)) {
      visit(value);
      if (found) {
        return;
      }
    }
  };

  visit(root);
  return found;
};

const extractPostId = (renderer: Record<string, unknown>, html: string): string | null => {
  const direct = getNested(renderer, ['postId']);
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }

  const urlFromRenderer = getNested(renderer, ['navigationEndpoint', 'commandMetadata', 'webCommandMetadata', 'url']);
  if (typeof urlFromRenderer === 'string') {
    const postMatch = urlFromRenderer.match(/\/post\/(Ug[0-9A-Za-z_-]+)/);
    if (postMatch?.[1]) {
      return postMatch[1];
    }
  }

  const htmlMatch = html.match(/"postId"\s*:\s*"(Ug[0-9A-Za-z_-]+)"/);
  if (htmlMatch?.[1]) {
    return htmlMatch[1];
  }

  const canonicalPostMatch = html.match(/https:\/\/www\.youtube\.com\/post\/(Ug[0-9A-Za-z_-]+)/);
  if (canonicalPostMatch?.[1]) {
    return canonicalPostMatch[1];
  }

  return null;
};

const extractImagesFromRenderer = (renderer: Record<string, unknown>): string[] => {
  const images: string[] = [];
  const attachment = renderer.backstageAttachment as Record<string, unknown>;
  if (!attachment) return images;

  if (attachment.backstageImageRenderer) {
    const thumbs = getNested(attachment, ['backstageImageRenderer', 'image', 'thumbnails']);
    if (Array.isArray(thumbs) && thumbs.length > 0) {
      const best = thumbs[thumbs.length - 1];
      if (best?.url) images.push(best.url);
    }
  }

  if (attachment.postMultiImageRenderer) {
    const renderers = getNested(attachment, ['postMultiImageRenderer', 'images']);
    if (Array.isArray(renderers)) {
      for (const item of renderers) {
        const thumbs = getNested(item, ['backstageImageRenderer', 'image', 'thumbnails']);
        if (Array.isArray(thumbs) && thumbs.length > 0) {
          const best = thumbs[thumbs.length - 1];
          if (best?.url) images.push(best.url);
        }
      }
    }
  }

  return images;
};

export const scrapeLatestCommunityPostByChannelId = async (
  channelId: string,
  timeoutMs: number,
): Promise<ScrapedCommunityPost | null> => {
  const communityUrl = `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/community`;
  return scrapeLatestCommunityPostByUrl(communityUrl, timeoutMs);
};

export const scrapeLatestCommunityPostByUrl = async (
  pageUrl: string,
  timeoutMs: number,
): Promise<ScrapedCommunityPost | null> => {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return null;
  }

  if (!isYouTubeHost(parsed.hostname)) {
    return null;
  }

  const response = await fetchWithTimeout(
    parsed.toString(),
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    },
    timeoutMs,
  );

  if (!response.ok) {
    return null;
  }

  const html = await response.text();
  const initialData = extractYtInitialData(html);
  if (!initialData) {
    return null;
  }

  const renderer = findFirstPostRenderer(initialData);
  if (!renderer) {
    return null;
  }

  const postId = extractPostId(renderer, html);
  if (!postId) {
    return null;
  }

  const rawContent = getRunsText(getNested(renderer, ['contentText']));
  const content = decodeHtml(rawContent || '');
  const title = deriveCommunityPostTitle(content, '새 커뮤니티 게시글');
  const author = decodeHtml(getRunsText(getNested(renderer, ['authorText'])) || 'YouTube Channel');
  const published = decodeHtml(getRunsText(getNested(renderer, ['publishedTimeText'])));

  return {
    id: postId,
    title: title || '새 커뮤니티 게시글',
    content,
    link: `https://www.youtube.com/post/${postId}`,
    published,
    author: author || 'YouTube Channel',
    images: extractImagesFromRenderer(renderer),
  };
};

// ─── InnerTube API (yt-dlp compatible) ────────────────────────────────────────

const INNERTUBE_BROWSE_URL = 'https://www.youtube.com/youtubei/v1/browse';

const buildInnerTubeContext = () => ({
  client: {
    clientName: 'WEB',
    clientVersion: '2.20260401.00.00',
    hl: 'ko',
    gl: 'KR',
  },
});

const INNERTUBE_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'X-YouTube-Client-Name': '1',
  'X-YouTube-Client-Version': '2.20260401.00.00',
};

/**
 * Step 1: Browse channel to discover community/posts tab params dynamically.
 * YouTube renamed "Community" to "Posts" in the UI and changed internal params.
 * Hardcoding params is fragile — extract them live from the tab endpoint.
 */
const resolveCommunityTabParams = async (
  channelId: string,
  timeoutMs: number,
): Promise<string | null> => {
  const response = await fetchWithTimeout(
    `${INNERTUBE_BROWSE_URL}?prettyPrint=false`,
    {
      method: 'POST',
      headers: INNERTUBE_HEADERS,
      body: JSON.stringify({
        context: buildInnerTubeContext(),
        browseId: channelId,
      }),
    },
    timeoutMs,
  );

  if (!response.ok) return null;

  const data = await response.json() as Record<string, unknown>;
  const tabs = getNested(data, ['contents', 'twoColumnBrowseResultsRenderer', 'tabs']);
  if (!Array.isArray(tabs)) return null;

  for (const tab of tabs) {
    const tabRenderer = getNested(tab, ['tabRenderer']) as Record<string, unknown> | undefined;
    if (!tabRenderer) continue;
    const url = getNested(tabRenderer, ['endpoint', 'commandMetadata', 'webCommandMetadata', 'url']);
    if (typeof url === 'string' && (url.includes('/posts') || url.includes('/community'))) {
      const params = getNested(tabRenderer, ['endpoint', 'browseEndpoint', 'params']);
      return typeof params === 'string' ? params : null;
    }
  }

  return null; // channel has no community/posts tab
};

const extractPostFromTabData = (data: Record<string, unknown>): ScrapedCommunityPost | null => {
  // The selected tab in this response is the community/posts tab.
  // Find the first backstage/shared post renderer anywhere in the tree.
  const tabs = getNested(data, ['contents', 'twoColumnBrowseResultsRenderer', 'tabs']);
  if (!Array.isArray(tabs)) return null;

  const candidateTabs = tabs
    .map((tab) => getNested(tab, ['tabRenderer']) as Record<string, unknown> | undefined)
    .filter((tabRenderer): tabRenderer is Record<string, unknown> => Boolean(tabRenderer?.content));

  const prioritizedTabs = candidateTabs.some((tabRenderer) => Boolean(tabRenderer.selected))
    ? candidateTabs.filter((tabRenderer) => Boolean(tabRenderer.selected))
    : candidateTabs;

  for (const tabRenderer of prioritizedTabs) {
    if (!tabRenderer.content) continue;

    const renderer = findFirstPostRenderer(tabRenderer.content);
    if (!renderer) continue;

    const postId = extractPostId(renderer, '');
    if (!postId) continue;

    const rawContent = getRunsText(getNested(renderer, ['contentText']));
    const content = decodeHtml(rawContent || '');
    const title = deriveCommunityPostTitle(content, '새 커뮤니티 게시글');
    const author = decodeHtml(getRunsText(getNested(renderer, ['authorText'])) || 'YouTube Channel');
    const published = decodeHtml(getRunsText(getNested(renderer, ['publishedTimeText'])));

    return {
      id: postId,
      title: title || '새 커뮤니티 게시글',
      content,
      link: `https://www.youtube.com/post/${postId}`,
      published,
      author: author || 'YouTube Channel',
      images: extractImagesFromRenderer(renderer),
    };
  }

  return null;
};

/**
 * Fetch latest community post via YouTube InnerTube API (2-step).
 *
 * Step 1: Browse channel page → discover community/posts tab params dynamically.
 *         YouTube changed internal params ("community" → "posts" protobuf key),
 *         so hardcoding them breaks silently. We extract live from the tab endpoint.
 * Step 2: Browse with the extracted params → fetch actual community tab content.
 *
 * Same API endpoints yt-dlp uses internally — no binary required.
 */
export const scrapeLatestCommunityPostByInnerTube = async (
  channelId: string,
  timeoutMs: number,
): Promise<ScrapedCommunityPost | null> => {
  if (!channelId || !channelId.startsWith('UC')) return null;

  // Step 1: discover community tab params
  const stepTimeoutMs = Math.floor(timeoutMs / 2);
  const communityParams = await resolveCommunityTabParams(channelId, stepTimeoutMs);
  if (!communityParams) return null; // no community tab on this channel

  // Step 2: fetch community tab content
  const response = await fetchWithTimeout(
    `${INNERTUBE_BROWSE_URL}?prettyPrint=false`,
    {
      method: 'POST',
      headers: INNERTUBE_HEADERS,
      body: JSON.stringify({
        context: buildInnerTubeContext(),
        browseId: channelId,
        params: decodeURIComponent(communityParams),
      }),
    },
    stepTimeoutMs,
  );

  if (!response.ok) return null;

  const data = await response.json() as Record<string, unknown>;
  return extractPostFromTabData(data);
};
