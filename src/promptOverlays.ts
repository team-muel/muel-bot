/**
 * DB 기반 시스템 프롬프트 오버레이.
 *
 * Why: 행동 규칙 수준의 프롬프트 지시를 코드에 하드코딩하면 공개 레포에
 * 그대로 노출되고, 수정마다 PR·배포가 필요하다. 오버레이는
 * muel_prompt_overlays 테이블(서비스롤 전용, RLS)에서 로드해
 * 베이스 프롬프트 뒤에 합성한다 — 내용은 깃허브에 남지 않고,
 * 배포 없이 SQL 로 추가·수정·비활성화할 수 있다.
 *
 * 동작:
 * - initPromptOverlays(supabase): 부팅 시 1회 로드 + REFRESH_MS 주기 리프레시.
 * - getOverlayPromptText(): 캐시된 합성 텍스트(우선순위 오름차순, 빈 문자열 가능).
 * - DB 실패 시 마지막 성공 캐시 유지(없으면 빈 문자열) — 오버레이는 *강화*
 *   레이어지 필수 의존성이 아니다. 봇 기동을 막지 않는다.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isSupabaseDataApiRestricted,
  isSupabaseDataApiProbeDue,
  isSupabaseQuotaRestriction,
  recordSupabaseDataApiSuccess,
  recordSupabaseQuotaRestriction,
} from './serviceRestriction.js';

const REFRESH_MS = 5 * 60_000;

type OverlayRow = { key: string; content: string; priority: number };

let cachedText = '';
let cachedKeys: string[] = [];
let cachedCount = 0;
let timer: ReturnType<typeof setInterval> | null = null;

const refresh = async (supabase: SupabaseClient): Promise<void> => {
  if (isSupabaseDataApiRestricted() && !isSupabaseDataApiProbeDue()) return;
  try {
    const { data, error } = await supabase
      .from('muel_prompt_overlays')
      .select('key, content, priority')
      .eq('enabled', true)
      .order('priority', { ascending: true });
    if (error) {
      if (isSupabaseQuotaRestriction(error)) recordSupabaseQuotaRestriction(error);
      console.warn('[prompt-overlays] fetch failed, keeping cache', error.message);
      return;
    }
    recordSupabaseDataApiSuccess();
    const rows = (data ?? []) as OverlayRow[];
    cachedText = rows.map((r) => r.content.trim()).filter(Boolean).join('\n\n');
    cachedKeys = rows.map((r) => r.key);
    if (rows.length !== cachedCount) {
      console.log('[prompt-overlays] loaded', { count: rows.length, keys: rows.map((r) => r.key) });
    }
    cachedCount = rows.length;
  } catch (err) {
    if (isSupabaseQuotaRestriction(err)) recordSupabaseQuotaRestriction(err);
    console.warn('[prompt-overlays] refresh crashed, keeping cache', err instanceof Error ? err.message : String(err));
  }
};

export const initPromptOverlays = async (supabase: SupabaseClient): Promise<void> => {
  await refresh(supabase);
  if (!timer) {
    timer = setInterval(() => void refresh(supabase), REFRESH_MS);
    // Render 프로세스 종료를 막지 않게.
    if (typeof timer.unref === 'function') timer.unref();
  }
};

/** 캐시된 오버레이 합성 텍스트. 로드 전/실패 시 빈 문자열. */
export const getOverlayPromptText = (): string => cachedText;

/**
 * 해당 프리픽스의 오버레이가 로드돼 있는지. 베이스 페르소나(base-*)가 DB로
 * 중앙화(2026-07-13)되면서, 캐시에 base-* 가 있으면 DB 가 시스템 프롬프트의
 * 단일 출처이고 없으면(부팅 직후 최초 로드 실패 등) 코드 폴백을 쓴다.
 */
export const hasOverlayKeyPrefix = (prefix: string): boolean =>
  cachedKeys.some((k) => k.startsWith(prefix));
