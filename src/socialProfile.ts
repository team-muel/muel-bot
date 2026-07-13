/**
 * P5 소셜 프로필 메모리 — 유저별 대화 레지스터 요약.
 *
 * Why: 기존 장기 기억은 "심오한 사실"(worldview/preference) 위주라 잡담 표면에
 * 필요한 기억 — 이 유저는 반말인지, 봇을 놀리는 편인지, 어떤 밈을 굴리는지 —
 * 이 없다. memory_worker 가 대화를 읽는 김에 레지스터 프로필 1~2문장을
 * 저비용으로 갱신(24h TTL)하고, 컨텍스트 윈도우가 잡담 턴에도 주입한다.
 *
 * 프라이버시: 민감정보(신원·건강·정치 등) 금지를 프롬프트에 명시. 내용은
 * 서비스롤 전용 테이블(muel_user_social_profiles)에만 저장.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { repairJsonText } from './aiRepair.js';

const PROFILE_TTL_MS = 24 * 3600_000;
const MIN_SAMPLE_LINES = 3;

const profileSchema = z.object({
  register_summary: z.string().max(240).describe(
    '이 유저와 대화할 때 유용한 레지스터 요약 1~2문장: 말투(반말/존대), 장난·드립 성향, 이모지·밈 습관, 봇을 대하는 태도. 민감정보 금지.',
  ),
});

/** memory_worker 에서 호출 — 실패해도 잡을 죽이지 않도록 전부 삼킨다. */
export const maybeUpdateSocialProfile = async (
  supabase: SupabaseClient,
  extractModel: { model: any },
  ownerUserId: string | null,
  userLines: string[],
): Promise<void> => {
  try {
    if (!ownerUserId || userLines.length < MIN_SAMPLE_LINES) return;

    const { data: existing } = await supabase
      .from('muel_user_social_profiles')
      .select('updated_at')
      .eq('discord_user_id', ownerUserId)
      .maybeSingle();
    if (existing?.updated_at && Date.now() - new Date(existing.updated_at).getTime() < PROFILE_TTL_MS) {
      return; // 24h 내 갱신됨 — 스킵(비용 가드).
    }

    const { object } = await generateObject({
      model: extractModel.model,
      schema: profileSchema,
      experimental_repairText: repairJsonText,
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
      prompt: [
        '아래는 한 Discord 유저의 최근 발화 샘플이다. 이 유저와 잡담할 때 유용한',
        '"대화 레지스터 프로필"을 1~2문장으로 써라: 말투(반말/존대), 장난·드립 성향,',
        '이모지·밈 습관, 봇(Muel)을 대하는 태도.',
        '절대 포함 금지: 실명·신원, 건강, 정치·종교, 위치, 직장 내부 정보 등 민감정보.',
        '',
        ...userLines.slice(-30).map((l) => `- ${l.slice(0, 200)}`),
      ].join('\n'),
    });

    await supabase.from('muel_user_social_profiles').upsert({
      discord_user_id: ownerUserId,
      register_summary: object.register_summary,
      sample_count: userLines.length,
      updated_at: new Date().toISOString(),
    });
    console.log('[social-profile] updated', { ownerUserId, sampleCount: userLines.length });
  } catch (err) {
    console.warn('[social-profile] update failed (non-fatal)', err instanceof Error ? err.message : String(err));
  }
};

/** 컨텍스트 윈도우 주입용 — 프로필이 없으면 빈 문자열. 실패는 조용히. */
export const fetchSocialProfileText = async (
  supabase: SupabaseClient,
  userId: string,
  authorName: string,
): Promise<string> => {
  try {
    const { data } = await supabase
      .from('muel_user_social_profiles')
      .select('register_summary')
      .eq('discord_user_id', userId)
      .maybeSingle();
    const summary = data?.register_summary?.trim();
    if (!summary) return '';
    return [
      '--- User Register (이 유저의 대화 결) ---',
      `${authorName}: ${summary}`,
      '--- End Register ---',
    ].join('\n');
  } catch {
    return '';
  }
};
