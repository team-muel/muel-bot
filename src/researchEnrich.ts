import type { ButtonInteraction, Client, Message } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { generateText, stepCountIs } from 'ai';
import { getSupabaseClient } from './supabase.js';
import { config } from './config.js';
import { enqueueJob } from './muelJobs.js';
import { buildResearchTopicFromItem, getYouTubeItemByOrigin } from './youtubeItemStore.js';
import { flushPendingResearchDms } from './researchDeliver.js';
import { getGeminiTextModel, getGoogleSearchTool } from './modelRegistry.js';
import { sanitizeModelOutput } from './responseSanitizer.js';
import { renderDiscordMessage } from './rendering/discordRenderer.js';

/**
 * "이 소식 더 알아보기" → two-step, grounding-first flow.
 *
 *   research:enrich:<origin_table>:<origin_id>
 *     - Generate an immediate Gemini web-grounded brief (seconds, reliable).
 *     - Persist topic + brief as a muel_research_jobs row with status='briefed'
 *       (NOT submitted to AI-Q yet).
 *     - Offer an opt-in "더 깊게 조사" button.
 *
 *   research:deep:<research_job_row_id>
 *     - Only on explicit opt-in: submit the (brief-seeded) topic to AI-Q and
 *       enqueue 'research_user_dm' for the durable poll/DM pipeline.
 *
 * Rationale: grounding answers the common case instantly and survives restarts;
 * the heavy AI-Q deep_researcher is reserved for when the user actually wants
 * multi-source depth.
 */

const ENRICH_PREFIX = 'research:enrich:';
const DEEP_PREFIX = 'research:deep:';

export const isResearchEnrichButton = (customId: string): boolean => customId.startsWith(ENRICH_PREFIX);
export const isResearchDeepButton = (customId: string): boolean => customId.startsWith(DEEP_PREFIX);

const parseOrigin = (raw: string): { originTable: string; originId: string } | null => {
  const rest = raw.slice(ENRICH_PREFIX.length);
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

  const footerParts = footerText.split('·').map((p) => cleaned(p)).filter(Boolean);
  const sourceLabel = footerParts[0] ?? '';
  const authorName = footerParts[1] ?? '';

  const titleClean = cleaned(titleText);
  const descClean = cleaned(descFirst);

  const parts: string[] = [];
  if (titleClean) parts.push(titleClean);
  else if (descClean) parts.push(descClean);
  if (authorName) parts.push(`(${sourceLabel || 'YouTube'} 채널: ${authorName})`);

  const topic = parts.join(' ').trim();
  if (!topic) return null;
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

/**
 * Lightweight Gemini web-grounded brief. Public web facts only — never seeded
 * with private/user context (AI-Q payload discipline + privacy). Returns null on
 * failure; callers degrade gracefully.
 */
const generateGroundedBrief = async (topic: string): Promise<string | null> => {
  const gemini = getGeminiTextModel('heavy');
  if (!gemini) return null;
  const tools: Record<string, any> = {};
  const googleSearch = getGoogleSearchTool();
  if (googleSearch) tools.googleSearch = googleSearch;
  try {
    const { text, finishReason } = await generateText({
      model: gemini.model,
      tools,
      stopWhen: stepCountIs(3),
      temperature: 0.4,
      maxOutputTokens: 1024,
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
      system: [
        '너는 Muel이야. 주어진 주제의 현재 맥락을 한국어로 간결히 정리해.',
        '핵심 사실 3~5개를 짧은 불릿으로. 가능하면 끝에 출처 링크를 붙여.',
        '검색 결과에 있는 사실·날짜·숫자만 써. 모르면 모른다고 해. 지어내지 마.',
        '서두 인사나 사족 없이 바로 요점만.',
      ].join('\n'),
      prompt: `주제: ${topic}\n\n위 주제를 웹에서 찾아 지금 시점의 맥락을 정리해줘.`,
    });
    const cleaned = sanitizeModelOutput(text);
    if (!cleaned) {
      console.warn('[research-enrich] grounded brief empty', { finishReason, textLen: text?.length ?? 0 });
      return null;
    }
    return cleaned;
  } catch (err) {
    console.warn('[research-enrich] grounded brief failed', err);
    return null;
  }
};

const buildDeepButtonRow = (researchJobRowId: string) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${DEEP_PREFIX}${researchJobRowId}`)
      .setLabel('더 깊게 조사 (딥리서치 · DM)')
      .setStyle(ButtonStyle.Secondary),
  );

// ---- enrich: immediate grounded brief + opt-in deep button ----

export const handleResearchEnrichButton = async (
  client: Client<true>,
  interaction: ButtonInteraction,
): Promise<void> => {
  // Opportunistic, token-free redelivery of any earlier DM-blocked deep results.
  void flushPendingResearchDms(client, interaction.user.id);

  const parsed = parseOrigin(interaction.customId);
  if (!parsed) {
    await interaction.reply({ content: '버튼 데이터가 손상됐어요. 게시물을 다시 받아 시도해주세요.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
    return;
  }

  // Grounding takes >3s, so defer first (ephemeral).
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

  const originMessageJumpUrl = (interaction.message as Message).url;
  const { topic, topicSource } = await resolveResearchTopic(interaction.message as Message, parsed.originTable, parsed.originId);
  if (!topic) {
    await interaction.editReply({ content: '이 게시물에서 조사 주제를 뽑지 못했어요.' }).catch(() => {});
    return;
  }

  const brief = await generateGroundedBrief(topic);
  const supabase = getSupabaseClient();
  const deepAvailable = Boolean(config.aiqEnabled && config.aiqServerUrl);

  // Persist topic + brief (status='briefed', not submitted to AI-Q yet) so the
  // opt-in deep button can recover them — the ephemeral message has no source embed.
  let researchJobRowId: string | null = null;
  if (deepAvailable) {
    const { data: insertData, error: insertError } = await supabase
      .from('muel_research_jobs')
      .insert({
        trigger_source: 'user_button_dm',
        trigger_detail: '이 소식 더 알아보기 (grounded brief)',
        status: 'briefed',
        origin_table: parsed.originTable,
        origin_id: parsed.originId,
        discord_guild_id: interaction.guildId,
        discord_channel_id: interaction.channelId,
        requester_user_id: interaction.user.id,
        target_message_id: interaction.message.id,
        topic,
        agent_type: config.aiqDefaultAgentType,
        metadata: { username: interaction.user.username, originMessageJumpUrl, topicSource, groundedBrief: brief ?? null },
      })
      .select('id')
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        const { data: existing } = await supabase
          .from('muel_research_jobs')
          .select('id')
          .eq('trigger_source', 'user_button_dm')
          .eq('origin_table', parsed.originTable)
          .eq('origin_id', parsed.originId)
          .eq('requester_user_id', interaction.user.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        researchJobRowId = existing?.id ?? null;
      } else {
        console.error('[research-enrich] briefed row insert failed', insertError);
      }
    } else {
      researchJobRowId = insertData?.id ?? null;
    }
  }

  const components = deepAvailable && researchJobRowId ? [buildDeepButtonRow(researchJobRowId)] : [];

  if (brief) {
    // 빠른 요약도 딥 리서치 결과(rich embed)와 같은 톤의 카드로 — 평문 대신 info-card.
    // 딥 버튼은 카드 아래 components 로 유지. brief 는 embed description(≤3900) 에 들어간다.
    const footerNote = deepAvailable
      ? 'Muel 리서치 · 더 깊게 조사하려면 아래 버튼'
      : 'Muel 리서치';
    const rendered = renderDiscordMessage([
      {
        type: 'info-card',
        tone: 'muel',
        title: '리서치 요약',
        body: brief,
        footer: footerNote,
      },
    ]);
    await interaction
      .editReply({ embeds: rendered.embeds, components, allowedMentions: { parse: [] } })
      .catch(() => {});
  } else {
    const content = deepAvailable
      ? '지금 빠른 요약을 만들지 못했어. 더 깊게 조사해볼까?'
      : '지금 빠른 요약을 만들지 못했어. 잠시 뒤 다시 시도해줘.';
    await interaction.editReply({ content, components }).catch(() => {});
  }
};

// ---- deep: opt-in AI-Q submission for a previously-briefed topic ----

export const handleResearchDeepButton = async (
  client: Client<true>,
  interaction: ButtonInteraction,
): Promise<void> => {
  void flushPendingResearchDms(client, interaction.user.id);

  const rowId = interaction.customId.slice(DEEP_PREFIX.length).trim();
  if (!rowId) {
    await interaction.reply({ content: '버튼 데이터가 손상됐어요.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

  if (!config.aiqEnabled || !config.aiqServerUrl) {
    await interaction.editReply({ content: '딥리서치 백엔드가 지금은 꺼져 있어. 위 요약으로 갈음해줘.' }).catch(() => {});
    return;
  }

  const supabase = getSupabaseClient();
  const { data: row, error: rowErr } = await supabase
    .from('muel_research_jobs')
    .select('id, status, topic, origin_table, origin_id, discord_guild_id, discord_channel_id, target_message_id, agent_type, metadata')
    .eq('id', rowId)
    .maybeSingle();

  if (rowErr || !row) {
    await interaction.editReply({ content: '이 조사 항목을 찾지 못했어. 게시물에서 다시 시도해줘.' }).catch(() => {});
    return;
  }

  if (row.status === 'submitted' || row.status === 'running') {
    await interaction.editReply({ content: '이미 딥리서치가 진행 중이야. 완료되면 DM으로, 실패하면 안내로 알려줄게.' }).catch(() => {});
    return;
  }
  if (row.status === 'success') {
    await interaction.editReply({ content: '이 항목은 이미 딥리서치를 마쳤어. DM을 확인해줘 (차단돼 있었다면 다음에 자동 재전송돼).' }).catch(() => {});
    return;
  }

  const metadata = (row.metadata ?? {}) as { groundedBrief?: string | null; originMessageJumpUrl?: string | null; username?: string | null };
  const seededTopic = metadata.groundedBrief
    ? safeTrim(`${row.topic}\n\n[참고: 현재 맥락 요약]\n${metadata.groundedBrief}`, config.aiqTopicMaxChars)
    : row.topic;

  const { error: updErr } = await supabase
    .from('muel_research_jobs')
    .update({
      status: 'submitted',
      topic: seededTopic,
      trigger_detail: '더 깊게 조사 (opt-in deep research)',
      submitted_at: new Date().toISOString(),
      error_class: null,
      error_message: null,
    })
    .eq('id', rowId);
  if (updErr) {
    console.error('[research-deep] status update failed', updErr);
    await interaction.editReply({ content: '딥리서치 시작에 실패했어. 잠시 뒤 다시 시도해줘.' }).catch(() => {});
    return;
  }

  try {
    await enqueueJob(
      supabase,
      'research_user_dm',
      {
        researchJobRowId: rowId,
        topic: seededTopic,
        agentType: row.agent_type ?? config.aiqDefaultAgentType,
        requesterUserId: interaction.user.id,
        guildId: row.discord_guild_id,
        channelId: row.discord_channel_id,
        targetMessageId: row.target_message_id,
        originTable: row.origin_table,
        originId: row.origin_id,
        originMessageJumpUrl: metadata.originMessageJumpUrl ?? null,
        interactionToken: interaction.token,
        interactionApplicationId: interaction.applicationId,
      },
      `research_user_dm:${rowId}`,
    );
  } catch (err) {
    console.error('[research-deep] enqueue failed', err);
    await supabase
      .from('muel_research_jobs')
      .update({ status: 'failure', error_class: 'EnqueueError', error_message: (err instanceof Error ? err.message : String(err)).slice(0, 240), completed_at: new Date().toISOString() })
      .eq('id', rowId);
    await interaction.editReply({ content: '딥리서치 작업 큐 등록에 실패했어. 운영자에게 알려줘.' }).catch(() => {});
    return;
  }

  await interaction.editReply({ content: '딥리서치 시작했어. 다출처 조사라 시간이 걸리고, 검색 쿼터나 백엔드 상태에 따라 실패할 수 있어. 완료되면 DM으로, 실패하면 안내로 알려줄게.' }).catch(() => {});
};
