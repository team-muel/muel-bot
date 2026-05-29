import type { ButtonInteraction, Client, Message } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { getSupabaseClient } from './supabase.js';
import { config } from './config.js';
import { enqueueJob } from './muelJobs.js';
import { buildResearchTopicFromItem, getYouTubeItemByOrigin } from './youtubeItemStore.js';
import { flushPendingResearchDms } from './researchDeliver.js';

/**
 * Stage AI-Q: "이 소식 더 알아보기" button handler.
 *
 * Button customId convention:
 *   research:enrich:<origin_table>:<origin_id>
 *
 * Flow on click:
 *   1. Parse customId
 *   2. Resolve a research topic from the original message (title + footer)
 *   3. Pre-checks: AIQ_SERVER_URL configured + AIQ_ENABLED
 *   4. INSERT muel_research_jobs (DB unique constraint enforces 1회/(origin,user))
 *   5. Reply ephemeral ack
 *   6. Enqueue 'research_user_dm' background job for the worker
 *
 * The actual AI-Q submission + polling + DM delivery happens in jobWorker.
 * This handler stays light so the Discord interaction acknowledges within 3s.
 */

const CUSTOM_ID_PREFIX = 'research:enrich:';

const parseCustomId = (
  raw: string,
): { originTable: string; originId: string } | null => {
  if (!raw.startsWith(CUSTOM_ID_PREFIX)) return null;
  const rest = raw.slice(CUSTOM_ID_PREFIX.length);
  // Split on first colon only — origin_id may contain colons in theory; here we
  // expect YouTube IDs (no colons) but stay defensive.
  const firstColon = rest.indexOf(':');
  if (firstColon === -1) return null;
  const originTable = rest.slice(0, firstColon);
  const originId = rest.slice(firstColon + 1);
  if (!originTable || !originId) return null;
  return { originTable, originId };
};

const safeTrim = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
};

const extractTopicFromMessage = (message: Message, originTable: string): string | null => {
  const embed = message.embeds?.[0];
  if (!embed) return null;
  const titleText = embed.title ?? '';
  const footerText = embed.footer?.text ?? '';
  const descFirst = (embed.description ?? '').split('\n').find(Boolean) ?? '';
  const cleaned = (s: string) => s.replace(/\*\*/g, '').trim();

  // Pull author name from footer when possible. Footer format is " · authorName · timeago" or similar.
  const footerParts = footerText.split('·').map((p) => cleaned(p)).filter(Boolean);
  const sourceLabel = footerParts[0] ?? '';        // 'YouTube 커뮤니티' or 'YouTube'
  const authorName = footerParts[1] ?? '';

  const titleClean = cleaned(titleText);
  const descClean = cleaned(descFirst);

  const parts: string[] = [];
  if (titleClean) parts.push(titleClean);
  else if (descClean) parts.push(descClean);
  if (authorName) parts.push(`(${sourceLabel || 'YouTube'} 채널: ${authorName})`);

  const topic = parts.join(' ').trim();
  if (!topic) return null;
  // Prefix to make it research-shaped for AI-Q (deep_researcher classifier).
  const tag = originTable === 'youtube_video' ? '영상 주제' : '게시글 주제';
  const finalTopic = `${tag} "${topic}"에 대한 맥락과 최근 동향을 한국어로 조사해줘. 관련된 사건, 출시 일정, 사용자 반응, 공식 발표가 있다면 함께 정리하고 출처를 인용해줘.`;
  return safeTrim(finalTopic, config.aiqTopicMaxChars);
};

const resolveResearchTopic = async (
  message: Message,
  originTable: string,
  originId: string,
): Promise<{ topic: string | null; topicSource: 'cache' | 'embed' | 'none' }> => {
  const cached = await getYouTubeItemByOrigin(getSupabaseClient(), originTable, originId);
  if (cached) {
    return {
      topic: safeTrim(buildResearchTopicFromItem(originTable, cached), config.aiqTopicMaxChars),
      topicSource: 'cache',
    };
  }

  const topic = extractTopicFromMessage(message, originTable);
  return { topic, topicSource: topic ? 'embed' : 'none' };
};

export const isResearchEnrichButton = (customId: string): boolean =>
  customId.startsWith(CUSTOM_ID_PREFIX);

export const handleResearchEnrichButton = async (
  client: Client<true>,
  interaction: ButtonInteraction,
): Promise<void> => {
  // Opportunistic, token-free redelivery of any earlier DM-blocked results.
  void flushPendingResearchDms(client, interaction.user.id);

  const parsed = parseCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({
      content: '버튼 데이터가 손상됐어요. 게시물 다시 받으면 다시 시도해주세요.',
      flags: [MessageFlags.Ephemeral],
    }).catch(() => {});
    return;
  }

  if (!config.aiqEnabled) {
    await interaction.reply({
      content: '리서치 기능이 비활성 상태예요.',
      flags: [MessageFlags.Ephemeral],
    }).catch(() => {});
    return;
  }

  if (!config.aiqServerUrl) {
    await interaction.reply({
      content: '리서치 백엔드가 아직 준비되지 않았어요. 운영자가 곧 켜드릴 거예요.',
      flags: [MessageFlags.Ephemeral],
    }).catch(() => {});
    return;
  }

  const { topic, topicSource } = await resolveResearchTopic(interaction.message as Message, parsed.originTable, parsed.originId);
  if (!topic) {
    await interaction.reply({
      content: '이 게시물에서 조사 주제를 뽑지 못했어요.',
      flags: [MessageFlags.Ephemeral],
    }).catch(() => {});
    return;
  }

  const supabase = getSupabaseClient();
  const originMessageJumpUrl = (interaction.message as Message).url;

  // Step 4: INSERT muel_research_jobs — unique index enforces 1회/(origin,user) at DB layer.
  const { data: insertData, error: insertError } = await supabase
    .from('muel_research_jobs')
    .insert({
      trigger_source: 'user_button_dm',
      trigger_detail: '이 소식 더 알아보기',
      status: 'submitted',
      origin_table: parsed.originTable,
      origin_id: parsed.originId,
      discord_guild_id: interaction.guildId,
      discord_channel_id: interaction.channelId,
      requester_user_id: interaction.user.id,
      target_message_id: interaction.message.id,
      topic,
      agent_type: config.aiqDefaultAgentType,
      metadata: {
        username: interaction.user.username,
        originMessageJumpUrl,
        topicSource,
      },
    })
    .select('id')
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      // Unique violation = already requested for this (origin, user). Look up the prior row to advise.
      const { data: existing } = await supabase
        .from('muel_research_jobs')
        .select('status, delivery_channel, delivered_at, created_at')
        .eq('trigger_source', 'user_button_dm')
        .eq('origin_table', parsed.originTable)
        .eq('origin_id', parsed.originId)
        .eq('requester_user_id', interaction.user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let msg = '이 항목은 이미 조사하셨어요.';
      if (existing) {
        if (existing.status === 'submitted' || existing.status === 'running') {
          msg = '이미 조사 중이에요. 완료되면 DM 보내드릴게요.';
        } else if (existing.status === 'success' && existing.delivered_at) {
          msg = `이 항목은 이미 조사 결과를 DM으로 보내드렸어요 (${new Date(existing.delivered_at).toISOString().slice(0, 10)}).`;
        } else if (existing.status === 'success') {
          msg = '조사 결과가 준비됐는데 DM 전달이 막혔어요. DM 차단을 풀어주시면 다음 알림 때 같이 받아볼 수 있어요.';
        }
      }
      await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] }).catch(() => {});
      return;
    }
    console.error('[research-enrich] INSERT failed', insertError);
    await interaction.reply({
      content: '리서치 요청 등록에 실패했어요. 잠시 뒤 다시 시도해주세요.',
      flags: [MessageFlags.Ephemeral],
    }).catch(() => {});
    return;
  }

  const researchJobRowId = insertData?.id as string | undefined;
  if (!researchJobRowId) {
    await interaction.reply({
      content: '리서치 요청 등록에 실패했어요. (no row id)',
      flags: [MessageFlags.Ephemeral],
    }).catch(() => {});
    return;
  }

  // Step 5: ephemeral ack (must happen within 3s of click).
  // 시간 안내 톤: deep_researcher가 보통 10~20분 걸리므로 "1~3분"은 사실과
  // 다름. 사용자에게는 막연한 안내로 두고 catch에서 분류 안내 분기.
  await interaction.reply({
    content: '조사 시작했어요. 완료되면 DM으로 결과 보내드릴게요. (시간이 좀 걸릴 수 있어요)',
    flags: [MessageFlags.Ephemeral],
  }).catch(() => {});

  // Step 6: enqueue background job. dedupe_key = research_user_dm:<rowId> prevents
  // accidental double-enqueue of the same row.
  try {
    await enqueueJob(
      supabase,
      'research_user_dm',
      {
        researchJobRowId,
        topic,
        agentType: config.aiqDefaultAgentType,
        requesterUserId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        targetMessageId: interaction.message.id,
        originTable: parsed.originTable,
        originId: parsed.originId,
        originMessageJumpUrl,
        interactionToken: interaction.token,
        interactionApplicationId: interaction.applicationId,
      },
      `research_user_dm:${researchJobRowId}`,
    );
  } catch (err) {
    console.error('[research-enrich] enqueue failed', err);
    await supabase
      .from('muel_research_jobs')
      .update({
        status: 'failure',
        error_class: 'EnqueueError',
        error_message: (err instanceof Error ? err.message : String(err)).slice(0, 240),
        completed_at: new Date().toISOString(),
      })
      .eq('id', researchJobRowId);
    await interaction.followUp({
      content: '리서치 작업 큐 등록에 실패했어요. 운영자에게 알려주세요.',
      flags: [MessageFlags.Ephemeral],
    }).catch(() => {});
  }
};
