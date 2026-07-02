/**
 * 소셜 골든셋 회귀 하네스 (P1).
 *
 * Why: 잡담 표면의 사회적 오발(답장 오바인딩, 날짜 수긍 등)은 스크린샷으로만
 * 남고, 모델·프롬프트·오버레이를 바꿀 때 회귀 여부를 판단할 수단이 없었다.
 * 인시던트를 muel_social_eval_cases(DB — 시나리오 원문은 공개 레포 밖) 에
 * 케이스로 적재해 두고, 이 러너가 *실제 배포 조건*(베이스+오버레이 프롬프트,
 * 실제 chat 레인 모델, 실제 컨텍스트 조립기)으로 재생해 휴리스틱 채점한다.
 *
 * 실행: ENABLE_SOCIAL_EVAL=true 로 부팅하면 ClientReady 후 1회 실행.
 * (모델 스왑·오버레이 변경 직후 한 부팅만 켜서 확인하고 끄는 용도.)
 * 결과: muel_ai_events(source='social_eval') — fallback_reason='eval_fail' 이
 * 실패 케이스. metadata 에 케이스 키·채점 상세·응답 원문(800자) 저장.
 *
 * 템플릿 토큰: {{TODAY_WEEKDAY}} = 실제 오늘 요일, {{WRONG_WEEKDAY}} = 내일
 * 요일(= 항상 틀린 주장). 케이스 본문·채점 규칙 양쪽에서 치환된다.
 */

import { generateText } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { buildMuelContextWindow } from './muelContextWindow.js';
import { getComposedBaseSystemPrompt } from './muelAgent.js';
import { getLaneModel } from './modelRegistry.js';
import { logMuelBackgroundAiEvent } from './muelAiEvents.js';
import type { UIMessage } from './muelConversationStore.js';

type ChannelScriptLine = {
  minutesAgo?: number;
  author: string;
  content: string;
  isBot?: boolean;
  replyToBot?: boolean;
};

type HistoryLine = { role: 'user' | 'assistant'; text: string };

type EvalCase = {
  key: string;
  description: string | null;
  channel_script: ChannelScriptLine[];
  history_script: HistoryLine[];
  user_message: string;
  author_name: string;
  judge: { forbidden?: string[]; required?: string[]; note?: string };
};

const WEEKDAYS_KO = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

const buildTemplateTokens = (): Record<string, string> => {
  const kstNow = new Date(Date.now() + 9 * 3600_000);
  const today = kstNow.getUTCDay();
  return {
    '{{TODAY_WEEKDAY}}': WEEKDAYS_KO[today]!,
    '{{WRONG_WEEKDAY}}': WEEKDAYS_KO[(today + 1) % 7]!,
  };
};

const applyTokens = (text: string, tokens: Record<string, string>): string => {
  let out = text;
  for (const [k, v] of Object.entries(tokens)) out = out.split(k).join(v);
  return out;
};

/** 채널 스크립트를 channelBuffer.formatForContext 와 동일한 서식으로 렌더. */
const renderChannelActivity = (script: ChannelScriptLine[], tokens: Record<string, string>): string => {
  if (!script || script.length === 0) return '';
  const lines = script.map((line) => {
    const rel = !line.minutesAgo || line.minutesAgo < 1 ? '방금' : `${line.minutesAgo}분 전`;
    const who = line.replyToBot ? `${line.author} → Muel` : line.author;
    return `[${rel}] ${who}: ${applyTokens(line.content, tokens)}`;
  });
  return [
    '--- Recent Channel Activity (앞 이름=화자, → 뒤=답장 상대. 화자는 화제의 대상이 아닐 수 있음) ---',
    ...lines,
    '--- End Activity ---',
  ].join('\n');
};

const toHistory = (script: HistoryLine[], authorName: string, tokens: Record<string, string>): UIMessage[] =>
  (script ?? []).map((line) => ({
    id: crypto.randomUUID(),
    role: line.role,
    parts: [{ type: 'text', text: applyTokens(line.text, tokens) }],
    metadata: line.role === 'user' ? { discordUsername: authorName } : undefined,
  } as UIMessage));

const judgeReply = (
  reply: string,
  judge: EvalCase['judge'],
  tokens: Record<string, string>,
): { pass: boolean; forbiddenHits: string[]; requiredMisses: string[] } => {
  const forbiddenHits: string[] = [];
  const requiredMisses: string[] = [];
  for (const raw of judge.forbidden ?? []) {
    const pattern = applyTokens(raw, tokens);
    if (new RegExp(pattern, 'iu').test(reply)) forbiddenHits.push(pattern);
  }
  for (const raw of judge.required ?? []) {
    const pattern = applyTokens(raw, tokens);
    if (!new RegExp(pattern, 'iu').test(reply)) requiredMisses.push(pattern);
  }
  return { pass: forbiddenHits.length === 0 && requiredMisses.length === 0, forbiddenHits, requiredMisses };
};

export const runSocialEval = async (supabase: SupabaseClient): Promise<void> => {
  if (!config.enableSocialEval) return;
  const { data, error } = await supabase
    .from('muel_social_eval_cases')
    .select('key, description, channel_script, history_script, user_message, author_name, judge')
    .eq('enabled', true);
  if (error || !data || data.length === 0) {
    console.warn('[social-eval] no cases loaded', error?.message ?? 'empty');
    return;
  }

  const lane = getLaneModel('chat');
  if (!lane) {
    console.warn('[social-eval] chat lane model unavailable');
    return;
  }

  const tokens = buildTemplateTokens();
  let passCount = 0;
  console.log('[social-eval] running', { cases: data.length, model: lane.modelId });

  for (const row of data as EvalCase[]) {
    const startedAt = Date.now();
    try {
      const userText = applyTokens(row.user_message, tokens);
      const window = await buildMuelContextWindow({
        supabase,
        baseSystemPrompt: getComposedBaseSystemPrompt(),
        userText,
        authorName: row.author_name,
        history: toHistory(row.history_script, row.author_name, tokens),
        channelActivity: renderChannelActivity(row.channel_script, tokens),
        sourceUserId: `social-eval:${row.key}`,
      });
      const { text, usage } = await generateText({
        model: lane.model,
        system: window.system,
        messages: window.messages,
        temperature: 0.7,
        maxOutputTokens: 512,
        maxRetries: 1,
      });
      const verdict = judgeReply(text, row.judge ?? {}, tokens);
      if (verdict.pass) passCount += 1;
      console.log(`[social-eval] ${verdict.pass ? 'PASS' : 'FAIL'} ${row.key}`, verdict.pass ? '' : verdict);
      await logMuelBackgroundAiEvent(supabase, {
        source: 'social_eval',
        status: 'success',
        taskType: 'social_eval',
        resolvedModel: { provider: lane.provider, modelId: lane.modelId, task: 'social_eval' },
        startedAt,
        usage,
        fallbackReason: verdict.pass ? null : 'eval_fail',
        metadata: {
          caseKey: row.key,
          verdict: verdict.pass ? 'pass' : 'fail',
          forbiddenHits: verdict.forbiddenHits,
          requiredMisses: verdict.requiredMisses,
          reply: text.slice(0, 800),
        },
      });
    } catch (err) {
      console.warn('[social-eval] case crashed', row.key, err instanceof Error ? err.message : String(err));
      await logMuelBackgroundAiEvent(supabase, {
        source: 'social_eval',
        status: 'error',
        taskType: 'social_eval',
        resolvedModel: { provider: lane.provider, modelId: lane.modelId, task: 'social_eval' },
        startedAt,
        errorClass: err instanceof Error ? err.name : typeof err,
        errorMessage: err instanceof Error ? err.message : String(err),
        metadata: { caseKey: row.key },
      });
    }
  }
  console.log('[social-eval] done', { pass: passCount, total: data.length });
};
