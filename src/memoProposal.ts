/**
 * ADR-003 P4a — propose_memo write-tool 패턴.
 *
 * 흐름:
 * 1. Muel 답 직후 mentionHandler 가 fire-and-forget 으로 classifyProposeMemo 호출.
 * 2. should_propose=true + content 가 있으면 buildMemoProposalCard 로 ephemeral/reply 카드 발행.
 *    카드 = embed(title='가르쳐둘까?', description='"<content>"') + [가르치기][아니] 버튼.
 * 3. 사용자 [가르치기] 클릭 → handleMemoProposalButton 이 muel_user_memos insert
 *    + insertWeaveNode (ADR-002 user_memo node).
 * 4. [아니] 클릭 → 카드 닫음.
 *
 * 사용자 명시적 /메모 add 와 자동 memoryWorker 사이의 *중간 영역*. 사용자 confirm 후만 저장.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ButtonInteraction } from 'discord.js';
import { MUEL_INFO_COLOR } from './uiColors.js';
import { generateObject } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPrimaryTextModel } from './modelRegistry.js';
import { logMuelBackgroundAiEvent } from './muelAiEvents.js';
import { getSupabaseClient } from './supabase.js';
import { insertWeaveNode } from './weaveNodes.js';

// 메모 후보 추출 schema. should_propose=false 면 content 없어도 됨.
// schema 완화 (PR #98 정신): kind 도 z.string + 후처리 정규화.
const ProposeMemoSchema = z.object({
  should_propose: z.boolean(),
  content: z.string().max(300).optional(),
  kind: z.string().optional(),
  reason: z.string().max(160).optional(),
});

export type ProposeMemoResult = z.infer<typeof ProposeMemoSchema>;

const PROPOSE_PROMPT = [
  '사용자가 방금 Muel 에게 한 발언이 *기억으로 박을 가치* 가 있는지 판단.',
  '',
  'should_propose=true 케이스:',
  '- 자기 응답 톤·스타일 지시 (예: "반말 말고 존댓말 써", "회의록은 한국어로")',
  '- 자기 상태·사실 (예: "나 다음 주 토요일 휴가", "나는 코딩할 땐 음악 듣는 거 좋아")',
  '- 작업·운영 메타 (예: "이 프로젝트는 매니페스트 분리 우선")',
  '- 명시적 지시 (예: "이거 기억해줘")',
  '',
  'should_propose=false 케이스:',
  '- 단순 인사 / 잡담 / 짧은 반응',
  '- 일회성 질문',
  '- 정보 요청 (예: "최근 뉴스 알려줘")',
  '- 토론·의견 교환 (사용자가 자기 지침으로 박을 의도 X)',
  '',
  '한국어 한 줄 content (280자 이내). kind 는 preference / fact / project / decision / context 중 가장 가까운 것.',
].join('\n');

/**
 * 메모 후보 분류. fire-and-forget 으로 호출하기 적합한 짧은 LLM call.
 * schema 실패 시 fallback (null 반환), error 적재. throw X.
 */
export const classifyProposeMemo = async (
  supabase: SupabaseClient,
  args: { userText: string; chatId?: string | null; discordUserId?: string | null },
): Promise<ProposeMemoResult | null> => {
  const trimmed = args.userText.trim();
  // 너무 짧으면 propose 의미 X — LLM call 절약.
  if (trimmed.length < 10) return null;

  const model = getPrimaryTextModel('extract');
  if (!model) return null;

  const startedAt = Date.now();
  try {
    const { object, usage, providerMetadata } = await generateObject({
      model: model.model,
      schema: ProposeMemoSchema,
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 256 } } },
      temperature: 0.1,
      prompt: `${PROPOSE_PROMPT}\n\nUser text:\n"""\n${trimmed}\n"""`,
    });
    void logMuelBackgroundAiEvent(supabase, {
      source: 'discord',
      status: 'success',
      taskType: 'propose_memo',
      resolvedModel: { provider: model.provider, modelId: model.modelId, task: model.task },
      startedAt,
      usage,
      providerMetadata,
      chatId: args.chatId ?? null,
      metadata: {
        should_propose: object.should_propose,
        content_preview: (object.content ?? '').slice(0, 80),
        kind: object.kind ?? null,
        discordUserId: args.discordUserId ?? null,
      },
    });
    return object;
  } catch (err) {
    const errClass = err instanceof Error ? err.name : typeof err;
    const errMsg = err instanceof Error ? err.message : String(err);
    const isSchemaFailure = errClass === 'AI_NoObjectGeneratedError' || errMsg.includes('did not match schema');
    void logMuelBackgroundAiEvent(supabase, {
      source: 'discord',
      status: isSchemaFailure ? 'fallback' : 'error',
      taskType: 'propose_memo',
      resolvedModel: { provider: model.provider, modelId: model.modelId, task: model.task },
      startedAt,
      errorClass: errClass,
      errorMessage: errMsg.slice(0, 240),
      fallbackReason: isSchemaFailure ? 'propose_memo_schema_match_failed' : null,
      chatId: args.chatId ?? null,
    });
    return null;
  }
};

// 버튼 customId. customId 길이 제한 (100자) 때문에 content 자체는 박지 않고 embed description 에서 추출.
const BTN_TEACH = 'memo:propose:teach';
const BTN_DENY = 'memo:propose:deny';

export const isMemoProposalButton = (customId: string): boolean =>
  customId === BTN_TEACH || customId === BTN_DENY;

const PROPOSAL_TITLE = '가르쳐둘까?';

/**
 * 카드 builder. embed description 에 `*"<content>"*` 형태로 박아 button 핸들러가 추출.
 */
export const buildMemoProposalCard = (proposalContent: string) => {
  const safe = proposalContent.replace(/[\r\n]+/g, ' ').slice(0, 280);
  const embed = new EmbedBuilder()
    .setColor(MUEL_INFO_COLOR)
    .setTitle(PROPOSAL_TITLE)
    .setDescription(`*"${safe}"*`)
    .setFooter({ text: '대화에서 뽑아본 메모 후보야. 박아두면 다음 대화부터 반영.' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(BTN_TEACH).setLabel('가르치기').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(BTN_DENY).setLabel('아니').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
};

/**
 * button handler. teach 시 muel_user_memos insert + weaveNode insert. deny 시 카드 닫음.
 * content 는 interaction.message.embeds[0].description 의 `*"..."*` 패턴에서 추출.
 */
export const handleMemoProposalButton = async (interaction: ButtonInteraction): Promise<void> => {
  const me = interaction.user.id;
  const cid = interaction.customId;

  if (cid === BTN_DENY) {
    await interaction.update({ content: '응, 잊을게.', embeds: [], components: [] });
    return;
  }
  if (cid !== BTN_TEACH) return;

  const desc = interaction.message?.embeds?.[0]?.description ?? '';
  const match = desc.match(/^\*"([\s\S]+)"\*$/);
  const content = match?.[1]?.trim() ?? null;
  if (!content) {
    await interaction.update({ content: '내용을 못 찾았어. 다시 해줘.', embeds: [], components: [] });
    return;
  }

  const supabase = getSupabaseClient();
  const { data: inserted, error } = await supabase
    .from('muel_user_memos')
    .insert({ discord_user_id: me, content })
    .select('id')
    .single();
  if (error) {
    console.warn('[propose-memo] insert failed', error);
    await interaction.update({
      content: `못 기억했어: ${error.message}. 잠깐 뒤 다시 해줘.`,
      embeds: [],
      components: [],
    });
    return;
  }
  // ADR-002: 직접 메모 weave 노드 (PR #75 의 enrichMemoMetadata 는 /메모 add 경로에만 — 후속 PR 에서 공통화).
  void insertWeaveNode({
    sourceKind: 'user_memo',
    ownerUserId: me,
    body: content,
    sourceRef: { muel_user_memos_id: inserted?.id ?? null, source: 'propose_memo' },
  });
  await interaction.update({
    content: `기억해뒀어: *"${content}"*`,
    embeds: [],
    components: [],
  });
};
