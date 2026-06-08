import type { SupabaseClient } from '@supabase/supabase-js';

// 부정 피드백 신호 적재 (muel_feedback_signals). Muel(봇)이 reaction/abuse/부정 리플라이를
// 감지해 INSERT → 스케줄된 트리아지가 클러스터링/처리. 이 모듈은 어떤 경우에도 throw 하지
// 않는다(유저 응답 흐름을 절대 막지 않음).

// 명백한 부정 리액션 이모지.
const NEGATIVE_EMOJI = new Set([
  '👎', '😡', '🤬', '💩', '🙄', '😒', '🤮', '👿', '💢', '😠',
]);

// 욕설/강한 부정 (abuse) — severity 높게.
const ABUSE_RE = /(씨발|시발|ㅅㅂ|병신|ㅂㅅ|지랄|닥쳐|꺼져|개소리|좆|fuck|shit|stfu)/iu;
// 일반 부정 반응.
const NEGATIVE_RE =
  /(멍청|바보|짜증|쓸모\s*없|쓸데없|별로|최악|틀렸|잘못했|구려|구린|노답|이상해|왜\s*이래|stupid|useless|trash|dumb|wtf)/iu;

export const isNegativeEmoji = (name: string | null | undefined): boolean =>
  !!name && NEGATIVE_EMOJI.has(name);

export const classifyNegativeText = (
  text: string | null | undefined,
): { negative: boolean; abuse: boolean } => {
  const t = (text ?? '').trim();
  if (!t) return { negative: false, abuse: false };
  const abuse = ABUSE_RE.test(t);
  return { negative: abuse || NEGATIVE_RE.test(t), abuse };
};

export type FeedbackSignalInput = {
  signalType: 'reaction_negative' | 'reply_negative' | 'abuse';
  sentiment?: 'negative' | 'abuse';
  guildId?: string | null;
  channelId?: string | null;
  channelType?: string | null;
  messageId?: string | null;
  muelMessageId?: string | null;
  userId?: string | null;
  severity?: number;
  evidence?: string | null;
  metadata?: Record<string, unknown>;
};

export const recordFeedbackSignal = async (
  supabase: SupabaseClient,
  input: FeedbackSignalInput,
): Promise<void> => {
  try {
    const { error } = await supabase.from('muel_feedback_signals').insert({
      signal_type: input.signalType,
      sentiment: input.sentiment ?? 'negative',
      guild_id: input.guildId ?? null,
      channel_id: input.channelId ?? null,
      channel_type: input.channelType ?? null,
      message_id: input.messageId ?? null,
      muel_message_id: input.muelMessageId ?? null,
      user_id: input.userId ?? null,
      severity: input.severity ?? 2,
      evidence: input.evidence ?? null,
      metadata: input.metadata ?? {},
    });
    if (error) console.warn('[feedback-signal] insert error', error.message);
  } catch (err) {
    console.warn('[feedback-signal] insert failed', err);
  }
};
