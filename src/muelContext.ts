import { getSupabaseClient } from './supabase.js';
import { formatPostsForContext } from './youtubePostCache.js';
import { formatRecentYouTubeItemsForContext } from './youtubeItemStore.js';

export type ServerContext = {
  recentDreams: string;
  youtubeSourcesSummary: string;
  recentPosts: string;
  recentYouTubeItems: string;
};

const formatDreamSummary = (dreams: Array<{
  main_tag: string | null;
  emotions: string[] | null;
  keywords: string[] | null;
  created_at: string;
}>): string => {
  if (dreams.length === 0) return '최근 기록된 꿈이 없습니다.';

  const tags = new Map<string, number>();
  const emotions = new Map<string, number>();
  const keywords = new Map<string, number>();

  for (const dream of dreams) {
    if (dream.main_tag) tags.set(dream.main_tag, (tags.get(dream.main_tag) ?? 0) + 1);
    for (const e of dream.emotions ?? []) emotions.set(e, (emotions.get(e) ?? 0) + 1);
    for (const k of dream.keywords ?? []) keywords.set(k, (keywords.get(k) ?? 0) + 1);
  }

  const topTags = [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
  const topEmotions = [...emotions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e]) => e);
  const topKeywords = [...keywords.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);

  return [
    `최근 꿈 ${dreams.length}개 기록됨.`,
    topTags.length > 0 ? `주요 태그: ${topTags.join(', ')}` : '',
    topEmotions.length > 0 ? `주요 감정: ${topEmotions.join(', ')}` : '',
    topKeywords.length > 0 ? `주요 키워드: ${topKeywords.join(', ')}` : '',
  ].filter(Boolean).join(' ');
};

const formatSourcesSummary = (sources: Array<{
  name: string | null;
  last_check_status: string | null;
  last_check_at: string | null;
}>): string => {
  if (sources.length === 0) return '등록된 YouTube 구독이 없습니다.';

  const active = sources.filter((s) => s.last_check_status === 'success');
  const names = sources
    .map((s) => s.name?.replace(/^youtube-/, '') ?? '알 수 없음')
    .slice(0, 5);

  return `YouTube 구독 ${sources.length}개 (활성 ${active.length}개). 채널: ${names.join(', ')}`;
};

export const fetchServerContext = async (): Promise<ServerContext> => {
  const supabase = getSupabaseClient();

  const [dreamsResult, sourcesResult, youtubeItemsResult] = await Promise.allSettled([
    supabase
      .from('dreams')
      .select('main_tag, emotions, keywords, created_at')
      .order('created_at', { ascending: false })
      .limit(30),
    supabase
      .from('sources')
      .select('name, last_check_status, last_check_at')
      .eq('is_active', true),
    formatRecentYouTubeItemsForContext(supabase, 5),
  ]);

  const dreams = dreamsResult.status === 'fulfilled' && dreamsResult.value.data
    ? dreamsResult.value.data
    : [];

  const sources = sourcesResult.status === 'fulfilled' && sourcesResult.value.data
    ? sourcesResult.value.data
    : [];

  return {
    recentDreams: formatDreamSummary(dreams),
    youtubeSourcesSummary: formatSourcesSummary(sources),
    recentPosts: formatPostsForContext(3),
    recentYouTubeItems: youtubeItemsResult.status === 'fulfilled' ? youtubeItemsResult.value : '',
  };
};
