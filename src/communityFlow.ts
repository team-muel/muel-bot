import { generateObject } from 'ai';
import { z } from 'zod';
import type { Message } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueueJob } from './muelJobs.js';
import { maybeSpeakOnSpike } from './proactiveSpeaker.js';
import { getRecentMessages } from './channelBuffer.js';
import { getPrimaryTextModel } from './modelRegistry.js';
import { logMuelBackgroundAiEvent } from './muelAiEvents.js';

const BUCKET_MS = 10 * 60_000;
const MIN_MESSAGES_PER_BUCKET = 12;
const MAX_SAMPLE_MESSAGES = 20;
const recentCounts = new Map<string, { bucketStart: number; count: number; fired: boolean }>();

type CommunityFlowPayload = {
  signalId: string;
};

// 스키마 완화 (2026-06-09): 모델이 max-길이 초과 응답해 AI_NoObjectGeneratedError 빈발 (30+건/h).
// max → optional/큰 한도 + 후처리에서 trim. enum 제약은 없으므로 z.string 그대로 둠.
const digestSchema = z.object({
  title: z.string().max(200).optional().default('대화 요약'),
  summary: z.string().max(2000).optional().default(''),
  highlights: z.array(z.string().max(300)).max(10).optional().default([]),
});

const bucketStartFor = (timestamp: number): number => Math.floor(timestamp / BUCKET_MS) * BUCKET_MS;

const getBucketKey = (guildId: string, channelId: string, bucketStart: number): string =>
  `${guildId}:${channelId}:${bucketStart}`;

const sampleChannelMessages = (channelId: string) =>
  getRecentMessages(channelId, MAX_SAMPLE_MESSAGES).map((msg) => ({
    authorId: msg.authorId,
    authorName: msg.authorName,
    content: msg.content.slice(0, 500),
    timestamp: new Date(msg.timestamp).toISOString(),
  }));

export const observeCommunityMessage = (
  supabase: SupabaseClient,
  message: Message,
): void => {
  if (!message.guildId || message.author.bot || !message.content.trim()) return;

  const bucketStart = bucketStartFor(message.createdTimestamp);
  const bucketEnd = bucketStart + BUCKET_MS;
  const key = getBucketKey(message.guildId, message.channelId, bucketStart);
  const current = recentCounts.get(key) ?? { bucketStart, count: 0, fired: false };
  current.count += 1;
  recentCounts.set(key, current);

  if (current.fired || current.count < MIN_MESSAGES_PER_BUCKET) return;
  current.fired = true;

  void (async () => {
    const sampleMessages = sampleChannelMessages(message.channelId);
    const { data, error } = await supabase
      .from('muel_community_signals')
      .upsert({
        guild_id: message.guildId,
        channel_id: message.channelId,
        signal_type: 'volume_spike',
        bucket_start: new Date(bucketStart).toISOString(),
        bucket_end: new Date(bucketEnd).toISOString(),
        message_count: current.count,
        sample_messages: sampleMessages,
        status: 'pending',
        metadata: {
          threshold: MIN_MESSAGES_PER_BUCKET,
          detector: 'volume_bucket_v1',
        },
      }, {
        onConflict: 'guild_id,channel_id,signal_type,bucket_start',
      })
      .select('id')
      .single();

    if (error) {
      console.warn('[community-flow] signal insert failed', error);
      return;
    }

    await enqueueJob(
      supabase,
      'summarize_community_flow',
      { signalId: data.id } satisfies CommunityFlowPayload,
      `summarize_community_flow:${data.id}`,
      new Date(Date.now() + 2 * 60_000).toISOString(),
    );

    await maybeSpeakOnSpike(supabase, message);
  })().catch((error) => {
    console.warn('[community-flow] observe failed', error);
  });
};

export const summarizeCommunityFlowJob = async (
  supabase: SupabaseClient,
  payload: CommunityFlowPayload,
): Promise<void> => {
  const { data: signal, error } = await supabase
    .from('muel_community_signals')
    .select('*')
    .eq('id', payload.signalId)
    .single();

  if (error) throw error;
  if (!signal || signal.status === 'summarized') return;

  const samples = Array.isArray(signal.sample_messages) ? signal.sample_messages : [];
  if (samples.length === 0) {
    await supabase.from('muel_community_signals').update({ status: 'ignored' }).eq('id', signal.id);
    return;
  }

  const summaryModel = getPrimaryTextModel('summary');
  if (!summaryModel) {
    await supabase.from('muel_community_signals').update({
      status: 'error',
      metadata: {
        ...(signal.metadata ?? {}),
        error: 'summary model not configured',
      },
    }).eq('id', signal.id);
    return;
  }

  const transcript = samples
    .map((msg: any) => `${msg.authorName ?? msg.authorId}: ${String(msg.content ?? '').slice(0, 300)}`)
    .join('\n');

  const startedAt = Date.now();
  let result;
  try {
    result = await generateObject({
      model: summaryModel.model,
      schema: digestSchema,
      temperature: 0.2,
      prompt: [
        '너는 Discord 서버 흐름을 관찰하는 Muel의 큐레이터 모듈이다.',
        '아래 샘플은 짧은 시간에 대화량이 증가한 채널의 메시지다.',
        '원문에 없는 사실, 날짜, 숫자, 고유명사를 추가하지 말고, 서버 운영자가 흐름을 파악할 수 있게 한국어로 요약해라.',
        '장난/잡담이면 과장하지 말고 잡담이라고 말해라.',
        '',
        transcript,
      ].join('\n'),
    });
  } catch (aiError) {
    const errClass = aiError instanceof Error ? aiError.name : typeof aiError;
    const errMsg = aiError instanceof Error ? aiError.message : String(aiError);
    // 2026-06-09: schema 매칭 실패는 *요약 품질 실패* — 시스템 에러 아님. signal 은
    // 'ignored' 로 마감해서 cron retry 안 돌게 하고, 이벤트는 status='fallback' 으로 적재.
    // triage alert 임계에서 빠짐. 진짜 인프라/결제 에러만 status='error'.
    const isSchemaFailure = errClass === 'AI_NoObjectGeneratedError' || errMsg.includes('did not match schema');
    void logMuelBackgroundAiEvent(supabase, {
      source: 'community_flow',
      status: isSchemaFailure ? 'fallback' : 'error',
      taskType: 'summary',
      resolvedModel: { provider: summaryModel.provider, modelId: summaryModel.modelId, task: summaryModel.task },
      startedAt,
      errorClass: errClass,
      errorMessage: errMsg.slice(0, 240),
      fallbackReason: isSchemaFailure ? 'summary_schema_match_failed' : null,
      metadata: {
        signalId: signal.id,
        guildId: signal.guild_id,
        channelId: signal.channel_id,
      },
    });
    if (isSchemaFailure) {
      await supabase.from('muel_community_signals').update({
        status: 'ignored',
        metadata: { ...(signal.metadata ?? {}), schema_match_failed: true },
      }).eq('id', signal.id);
      return;
    }
    throw aiError;
  }

  void logMuelBackgroundAiEvent(supabase, {
    source: 'community_flow',
    status: 'success',
    taskType: 'summary',
    resolvedModel: { provider: summaryModel.provider, modelId: summaryModel.modelId, task: summaryModel.task },
    startedAt,
    usage: result.usage,
    providerMetadata: result.providerMetadata,
    metadata: {
      signalId: signal.id,
      guildId: signal.guild_id,
      channelId: signal.channel_id,
      messageCount: signal.message_count,
    },
  });

  const { title, summary, highlights } = result.object;
  await supabase.from('muel_community_digests').insert({
    signal_id: signal.id,
    guild_id: signal.guild_id,
    channel_id: signal.channel_id,
    window_start: signal.bucket_start,
    window_end: signal.bucket_end,
    title,
    summary,
    highlights,
    metadata: {
      model: summaryModel.modelId,
      provider: summaryModel.provider,
      taskType: 'summary',
      modelLane: summaryModel.task,
      source: 'volume_spike',
      messageCount: signal.message_count,
    },
  });

  await supabase.from('muel_community_signals').update({ status: 'summarized' }).eq('id', signal.id);
};
