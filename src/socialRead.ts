/**
 * Social-read 전처리 (P4).
 *
 * Why: Discord 잡담에서 "누구에게 온 말인가 / 어떤 레지스터인가" 를 chat 모델이
 * 생성 중에 암묵적으로 추론하게 두면 오발률이 높다 (답장 오바인딩 "아니" 건,
 * 날짜 수긍 건). 생성 *전에* 저가 라우터 레인 모델이 판독을 구조화해서 뽑고,
 * 그 판독문을 프롬프트에 명시 주입한다 — 모델이 눈치를 보는 게 아니라
 * 판독문을 읽는 구조로.
 *
 * 확신이 낮으면 low-commit 정책: 오답의 비용을 캡핑한다 (사실 단정 금지,
 * 짧게, 애매하면 되묻기). 판독 실패는 무해 — 섹션이 빠질 뿐 동작 불변.
 *
 * 비용: lightweight(잡담) 턴에만 실행, 라우터 레인(flash급) 1홉 추가 (~1s).
 * 킬스위치: MUEL_SOCIAL_READ=false.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import { config } from './config.js';
import { getLaneModel } from './modelRegistry.js';

export type SocialRead = {
  addressee: 'muel' | 'other' | 'unclear';
  register: 'banter' | 'serious' | 'test' | 'unclear';
  confidence: number;
};

export const LOW_COMMIT_CONFIDENCE = 0.55;

const socialReadSchema = z.object({
  addressee: z.enum(['muel', 'other', 'unclear'])
    .describe('이 메시지가 향한 대상. Muel(봇)에게 직접 온 말이면 muel, 다른 사람들끼리의 대화면 other.'),
  register: z.enum(['banter', 'serious', 'test', 'unclear'])
    .describe('메시지의 레지스터. 가벼운 농담/드립/밈이면 banter, 진지한 질문/부탁이면 serious, 봇을 떠보거나 놀리는 것이면 test.'),
  confidence: z.number().min(0).max(1).describe('판독 전체에 대한 확신도.'),
});

export const runSocialRead = async (input: {
  userText: string;
  authorName: string;
  channelActivity?: string;
}): Promise<SocialRead | null> => {
  if (!config.enableSocialRead) return null;
  const lane = getLaneModel('router');
  if (!lane) return null;
  const startedAt = Date.now();
  try {
    const { object } = await generateObject({
      model: lane.model,
      schema: socialReadSchema,
      maxRetries: 0,
      prompt: [
        '너는 Discord 대화 판독기다. 아래 채널 맥락과 방금 도착한 메시지를 보고,',
        '메시지의 수신자와 레지스터를 판독해라. 답장(→) 표시는 그 메시지가 화살표 뒤',
        '사람의 직전 발언에 대한 응답이라는 뜻이다.',
        '',
        input.channelActivity ?? '(채널 맥락 없음)',
        '',
        `방금 도착한 메시지 — ${input.authorName}: ${input.userText.slice(0, 500)}`,
      ].join('\n'),
    });
    console.log('[social-read]', { ...object, latencyMs: Date.now() - startedAt });
    return object as SocialRead;
  } catch (err) {
    console.warn('[social-read] failed, proceeding without', err instanceof Error ? err.message : String(err));
    return null;
  }
};

/** 판독 결과를 시스템 프롬프트 섹션으로 포맷. low-commit 정책 포함.
 *  lowCommitMin: 채널별 임계 오버라이드(P6) — null 이면 전역 기본. */
export const formatSocialReadSection = (read: SocialRead, lowCommitMin: number | null = null): string => {
  const threshold = lowCommitMin ?? LOW_COMMIT_CONFIDENCE;
  const lowCommit = read.confidence < threshold || read.register === 'test';
  const lines = [
    '--- SOCIAL READ (전처리 판독 — 이 판독을 전제로 응답해라) ---',
    `수신자=${read.addressee}, 레지스터=${read.register}, 확신도=${read.confidence.toFixed(2)}`,
  ];
  if (read.register === 'banter') {
    lines.push('가벼운 드립/농담이다. 같은 톤으로 짧게 받아라. 사실 검증 모드로 진지해지지 마라.');
  }
  if (read.register === 'test') {
    lines.push('너를 떠보거나 놀리는 메시지일 가능성이 높다. 유쾌하게 받되, 사실(날짜·기록·설정)은 양보하지 마라.');
  }
  if (lowCommit) {
    lines.push('확신이 낮다 → LOW-COMMIT: 사실 단정 금지, 1~2문장으로 짧게, 애매하면 가볍게 되묻어라. 다른 안건과 엮지 마라.');
  }
  lines.push('--- End Social Read ---');
  return lines.join('\n');
};
