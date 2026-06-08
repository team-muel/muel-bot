import type { Client } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyNegativeText, isNegativeEmoji, recordFeedbackSignal } from './feedbackSignals.js';

// 지연 관찰: Muel 이 답한 직후가 아니라 ~90초 뒤에 그 답변에 대한 반응(리액션·후속 발화)을
// 모아 부정 피드백을 판정/적재한다. 즉시-리스너(index.ts MessageReactionAdd)는 보조.
// 견고성: in-process setTimeout 대신 DB 큐(muel_pending_observations) + 폴러 → 재배포/재시작에도 안전.

const OBSERVE_DELAY_MS = 90_000;
const POLL_INTERVAL_MS = 60_000;
const BATCH = 20;
const FOLLOWUP_LIMIT = 10;

export const schedulePendingObservation = async (
  supabase: SupabaseClient,
  input: {
    guildId?: string | null;
    channelId: string;
    muelMessageId: string;
    userId?: string | null;
    replyExcerpt?: string | null;
  },
): Promise<void> => {
  try {
    await supabase.from('muel_pending_observations').insert({
      guild_id: input.guildId ?? null,
      channel_id: input.channelId,
      muel_message_id: input.muelMessageId,
      user_id: input.userId ?? null,
      reply_excerpt: input.replyExcerpt ?? null,
      observe_after: new Date(Date.now() + OBSERVE_DELAY_MS).toISOString(),
    });
  } catch (err) {
    console.warn('[feedback-observe] schedule failed', err);
  }
};

const observeOne = async (
  client: Client,
  supabase: SupabaseClient,
  row: {
    id: string;
    guild_id: string | null;
    channel_id: string;
    muel_message_id: string;
    user_id: string | null;
  },
): Promise<void> => {
  let negative = false;
  let abuse = false;
  const evidence: string[] = [];

  const channel: any = await client.channels.fetch(row.channel_id).catch(() => null);
  if (!channel || typeof channel.messages?.fetch !== 'function') return;

  // 1) Muel 답변 메시지에 달린 부정 리액션
  try {
    const msg = await channel.messages.fetch(row.muel_message_id);
    for (const reaction of msg.reactions.cache.values()) {
      if (isNegativeEmoji(reaction.emoji.name) && (reaction.count ?? 0) > 0) {
        negative = true;
        evidence.push(`reaction:${reaction.emoji.name}x${reaction.count}`);
      }
    }
  } catch {
    // 메시지 삭제됨 등 — 무시
  }

  // 2) 답변 이후의 후속 발화(리플라이/연속 메시지)에서 부정·욕설
  try {
    const after = await channel.messages.fetch({ after: row.muel_message_id, limit: FOLLOWUP_LIMIT });
    for (const m of after.values()) {
      if (m.author?.bot) continue;
      const text = String(m.content ?? '');
      const c = classifyNegativeText(text);
      if (c.negative) {
        negative = true;
        abuse = abuse || c.abuse;
        evidence.push(`reply:${text.slice(0, 80)}`);
      }
    }
  } catch {
    // 권한/페치 실패 — 무시
  }

  if (negative) {
    await recordFeedbackSignal(supabase, {
      signalType: abuse ? 'abuse' : 'reply_negative',
      sentiment: abuse ? 'abuse' : 'negative',
      guildId: row.guild_id,
      channelId: row.channel_id,
      channelType: row.guild_id ? 'guild' : 'dm',
      muelMessageId: row.muel_message_id,
      userId: row.user_id,
      severity: abuse ? 4 : 2,
      evidence: evidence.join(' | ').slice(0, 400),
      metadata: { source: 'deferred_observation' },
    });
  }
};

export const processPendingObservations = async (
  client: Client,
  supabase: SupabaseClient,
): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('muel_pending_observations')
      .select('id, guild_id, channel_id, muel_message_id, user_id')
      .eq('status', 'pending')
      .lte('observe_after', new Date().toISOString())
      .order('observe_after', { ascending: true })
      .limit(BATCH);
    if (error || !data || data.length === 0) return;

    for (const row of data) {
      try {
        await observeOne(client, supabase, row as any);
        await supabase.from('muel_pending_observations').update({ status: 'done' }).eq('id', row.id);
      } catch (err) {
        console.warn('[feedback-observe] observe failed', err);
        await supabase.from('muel_pending_observations').update({ status: 'error' }).eq('id', row.id);
      }
    }
  } catch (err) {
    console.warn('[feedback-observe] poll failed', err);
  }
};

export const startFeedbackObserver = (client: Client, supabase: SupabaseClient): NodeJS.Timeout => {
  console.log('[feedback-observe] poller started', { intervalMs: POLL_INTERVAL_MS, delayMs: OBSERVE_DELAY_MS });
  return setInterval(() => {
    void processPendingObservations(client, supabase);
  }, POLL_INTERVAL_MS);
};
