import { config } from './config.js';
import { fetchWithTimeout } from './utils/network.js';

const NAVER_SEARCH_BASE_URL = 'https://naverapihub.apigw.ntruss.com/search/v1';
const MAX_QUERY_CHARS = 200;
const MAX_RESULTS = 8;
const MAX_TOOL_OUTPUT_CHARS = 4_800;

export const NAVER_SEARCH_TYPES = ['news', 'webkr', 'local', 'kin', 'encyc'] as const;
export type NaverSearchType = (typeof NAVER_SEARCH_TYPES)[number];
export type NaverSearchSort = 'sim' | 'date';

type NaverSearchItem = {
  title?: unknown;
  link?: unknown;
  originallink?: unknown;
  description?: unknown;
  pubDate?: unknown;
  category?: unknown;
  telephone?: unknown;
  address?: unknown;
  roadAddress?: unknown;
};

type NaverSearchResponse = {
  total?: unknown;
  items?: unknown;
  errorCode?: unknown;
  errorMessage?: unknown;
  message?: unknown;
};

export type NaverSearchResult = {
  title: string;
  url: string | null;
  description: string;
  publishedAt: string | null;
  metadata: string[];
};

export type NaverSearchResults = {
  query: string;
  type: NaverSearchType;
  searchedAt: string;
  total: number | null;
  results: NaverSearchResult[];
};

const decodeHtmlEntities = (text: string): string => {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return text.replace(
    /&(#(?:x[\da-f]+|\d+)|[a-z]+);/giu,
    (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const codePoint = Number.parseInt(entity.slice(2), 16);
        return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : match;
      }
      if (entity.startsWith('#')) {
        const codePoint = Number.parseInt(entity.slice(1), 10);
        return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : match;
      }
      return named[entity.toLowerCase()] ?? match;
    },
  );
};

export const cleanNaverText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const safeHttpUrl = (value: unknown): string | null => {
  const text = cleanNaverText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const toFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const truncate = (text: string, max: number): string => (
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
);

const formatHttpError = (status: number, body: string): Error => {
  const compactBody = cleanNaverText(body);
  return new Error(
    `NAVER API HUB search failed (${status})${compactBody ? `: ${truncate(compactBody, 180)}` : ''}`,
  );
};

export const isNaverSearchConfigured = (): boolean => (
  config.naverSearchEnabled
  && Boolean(config.naverHubKeyId)
  && Boolean(config.naverHubKey)
);

export const searchNaver = async (input: {
  query: string;
  type: NaverSearchType;
  display?: number;
  sort?: NaverSearchSort;
}): Promise<NaverSearchResults> => {
  if (!isNaverSearchConfigured()) {
    throw new Error('NAVER API HUB search is not configured');
  }

  const query = input.query.trim();
  if (!query) throw new Error('NAVER search query is empty');
  if (query.length > MAX_QUERY_CHARS) {
    throw new Error(`NAVER search query exceeds ${MAX_QUERY_CHARS} characters`);
  }

  const display = Math.min(MAX_RESULTS, Math.max(1, Math.trunc(input.display ?? 5)));
  const url = new URL(`${NAVER_SEARCH_BASE_URL}/${input.type}`);
  url.searchParams.set('query', query);
  url.searchParams.set('display', String(display));
  if (input.type === 'news' && input.sort) {
    url.searchParams.set('sort', input.sort);
  }

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        accept: 'application/json',
        'user-agent': 'muel-bot/1.0',
        'X-NCP-APIGW-API-KEY-ID': config.naverHubKeyId!,
        'X-NCP-APIGW-API-KEY': config.naverHubKey!,
      },
    },
    config.naverSearchTimeoutMs,
  );

  if (!response.ok) {
    throw formatHttpError(response.status, await response.text());
  }

  const payload = await response.json() as NaverSearchResponse;
  if (!Array.isArray(payload.items)) {
    const message = cleanNaverText(payload.errorMessage ?? payload.message);
    throw new Error(message ? `NAVER API HUB: ${truncate(message, 180)}` : 'NAVER API HUB returned an invalid response');
  }

  const results = (payload.items as NaverSearchItem[]).slice(0, display).map((item) => {
    const url = safeHttpUrl(item.originallink) ?? safeHttpUrl(item.link);
    const metadata = [
      cleanNaverText(item.category),
      cleanNaverText(item.telephone),
      cleanNaverText(item.roadAddress) || cleanNaverText(item.address),
    ].filter(Boolean);

    return {
      title: truncate(cleanNaverText(item.title) || '제목 없음', 180),
      url,
      description: truncate(cleanNaverText(item.description), 420),
      publishedAt: cleanNaverText(item.pubDate) || null,
      metadata,
    };
  });

  return {
    query,
    type: input.type,
    searchedAt: new Date().toISOString(),
    total: toFiniteNumber(payload.total),
    results,
  };
};

export const formatNaverSearchResults = (search: NaverSearchResults): string => {
  const header = [
    `[NAVER API HUB · ${search.type}]`,
    `검색어: ${search.query}`,
    `검색 시각: ${search.searchedAt}`,
    search.total === null ? '' : `전체 결과 수: ${search.total}`,
  ].filter(Boolean).join('\n');

  if (search.results.length === 0) {
    return `${header}\n검색 결과가 없어.`;
  }

  const body = search.results.map((result, index) => {
    const lines = [
      `${index + 1}. ${result.title}`,
      result.description ? `요약: ${result.description}` : '',
      result.publishedAt ? `게시: ${result.publishedAt}` : '',
      result.metadata.length > 0 ? `정보: ${result.metadata.join(' · ')}` : '',
      result.url ? `출처: ${result.url}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  }).join('\n\n');

  return truncate(`${header}\n\n${body}`, MAX_TOOL_OUTPUT_CHARS);
};
