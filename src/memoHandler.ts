import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder, type StringSelectMenuInteraction } from 'discord.js';
import { getSupabaseClient } from './supabase.js';
import { renderDiscordMessage } from './rendering/discordRenderer.js';
import { deleteWeaveNodesBySourceRef, insertWeaveNode } from './weaveNodes.js';
import { config } from './config.js';

/**
 * /메모 명령 — 사용자가 Muel 에게 *기억해줘* 라고 직접 지시하는 메모 CRUD.
 *
 * 목적: 개인화 / 고객화. 사용자가 자기 응답 톤·스타일·지침을 Muel 에게 명시적으로
 * 박아 두면 다음 대화부터 반영. 자동 추출 메모 (`muel_memory_entries`, LLM 이
 * 대화에서 뽑은 것) 와 동일 카드 그리드에 함께 노출.
 *
 * 데이터 소스 (목록):
 * - `muel_user_memos` — 사용자 직접 입력 (✏️ 직접)
 * - `muel_memory_entries` JOIN muel_chats — LLM 자동 추출 (🤖 자동), source_user_id 필터
 *
 * 페이지: 10건/페이지. 카드 우측 하단 ``#N`` 은 *전체 정렬 기준* 의 전역 번호 —
 * 페이지 넘겨도 1, 2, 3 부터 다시 시작 X (사용자가 ``삭제 #N`` 호출하면 의미 명확).
 */

export const MEMO_COMMAND_NAME = '메모';

const MEMO_SUB_ADD = 'add';
const MEMO_SUB_LIST = '목록';
const MEMO_SUB_DELETE = '삭제';
const MEMO_ACTION_FORGET_SELECT_PREFIX = 'memo:forget-select:';

const MEMO_PAGE_SIZE = 10;
const MEMO_MAX_LIST = 100; // 한 사용자 메모 표시 상한 (목록 페이지네이션 기준)

const EPHEMERAL = MessageFlags.Ephemeral;

export const buildMemoSlashCommand = () => {
  const cmd = new SlashCommandBuilder()
    .setName(MEMO_COMMAND_NAME)
    .setDescription('뮤엘 가르치기')
    .addStringOption((opt) =>
      opt
        .setName('동작')
        .setDescription('작성 / 목록 / 지우기')
        .setRequired(true)
        .addChoices(
          { name: '작성', value: MEMO_SUB_ADD },
          { name: '목록', value: MEMO_SUB_LIST },
          { name: '지우기', value: MEMO_SUB_DELETE },
        ),
    )
    .addStringOption((opt) =>
      opt
        .setName('내용')
        .setDescription('동작=작성 일 때 기억시킬 내용')
        .setRequired(false)
        .setMaxLength(2000),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('번호')
        .setDescription('동작=지우기 일 때 카드 #번호')
        .setRequired(false)
        .setMinValue(1),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('페이지')
        .setDescription('동작=목록 일 때 페이지 (1부터)')
        .setRequired(false)
        .setMinValue(1),
    );
  return cmd;
};

type MemoRow = {
  source: 'user_direct' | 'auto_extracted';
  id: string;
  content: string;
  kind: string | null;
  importance: number | null;
  created_at: string;
};

const memoSelectValue = (memo: MemoRow): string =>
  `${memo.source === 'user_direct' ? 'u' : 'a'}:${memo.id}`;

const sourceLabelFor = (memo: MemoRow): string =>
  memo.source === 'user_direct' ? '직접' : '자동';

const preview = (text: string, max = 92): string => {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1).trimEnd()}…`;
};

/** 사용자 + 자동 메모 통합 fetch (created_at desc 정렬, 상한 MEMO_MAX_LIST). */
const fetchAllMemos = async (discordUserId: string): Promise<MemoRow[]> => {
  const supabase = getSupabaseClient();

  const [{ data: direct, error: e1 }, { data: auto, error: e2 }] = await Promise.all([
    supabase
      .from('muel_user_memos')
      .select('id, content, created_at')
      .eq('discord_user_id', discordUserId)
      .order('created_at', { ascending: false })
      .limit(MEMO_MAX_LIST),
    supabase
      .from('muel_memory_entries')
      .select('id, content, kind, importance, created_at, muel_chats!inner(source_user_id)')
      .eq('muel_chats.source_user_id', discordUserId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(MEMO_MAX_LIST),
  ]);

  if (e1) console.warn('[memo] muel_user_memos fetch failed', e1);
  if (e2) console.warn('[memo] muel_memory_entries fetch failed', e2);

  const merged: MemoRow[] = [];
  for (const row of direct ?? []) {
    merged.push({
      source: 'user_direct',
      id: String(row.id),
      content: String(row.content),
      kind: null,
      importance: null,
      created_at: String(row.created_at),
    });
  }
  for (const row of auto ?? []) {
    merged.push({
      source: 'auto_extracted',
      id: String(row.id),
      content: String(row.content),
      kind: typeof row.kind === 'string' ? row.kind : null,
      importance: typeof row.importance === 'number' ? row.importance : null,
      created_at: String(row.created_at),
    });
  }

  merged.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return merged.slice(0, MEMO_MAX_LIST);
};

const formatMemoCard = (memo: MemoRow, indexNumber: number) => {
  const sourceLabel = memo.source === 'user_direct' ? '✏️ 직접' : '🤖 자동';
  const meta = [
    sourceLabel,
    memo.kind ? `kind=${memo.kind}` : null,
    memo.importance ? `★${memo.importance}` : null,
    new Date(memo.created_at).toISOString().slice(0, 10),
  ].filter(Boolean).join(' · ');

  return {
    type: 'info-card' as const,
    tone: 'muel' as const,
    title: `메모 #${indexNumber}`,
    body: memo.content,
    fields: [{ name: '​', value: meta }],
  };
};

const buildAddSuccess = (content: string) =>
  renderDiscordMessage([{
    type: 'info-card',
    tone: 'muel',
    title: '기억해뒀어',
    body: content,
    fields: [{ name: '​', value: '✏️ 직접 · 다음 대화부터 반영' }],
  }]) as any;

const buildListMessage = (memos: MemoRow[], page: number, ownerUserId: string) => {
  if (memos.length === 0) {
    return renderDiscordMessage([{
      type: 'info-card',
      tone: 'muel',
      title: '메모 없음',
      body: '아직 저장된 메모가 없어. `/메모 add 내용:<...>` 으로 시작해.',
    }]) as any;
  }

  const totalPages = Math.max(1, Math.ceil(memos.length / MEMO_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * MEMO_PAGE_SIZE;
  const slice = memos.slice(start, start + MEMO_PAGE_SIZE);

  const cards = slice.map((m, i) => formatMemoCard(m, start + i + 1));
  const hasNext = safePage < totalPages;
  const footer = {
    type: 'info-card' as const,
    tone: 'muel' as const,
    title: `페이지 ${safePage} / ${totalPages}`,
    body: [
      `총 ${memos.length}건`,
      hasNext ? `다음 페이지: \`/메모 목록 페이지:${safePage + 1}\`` : null,
      '직접 메모는 삭제, 자동 메모는 비활성화됨',
    ].filter(Boolean).join(' · '),
    linkButton: { label: 'Weave 열기', url: `${config.hubUrl}/weave` },
    selectMenu: {
      customId: `${MEMO_ACTION_FORGET_SELECT_PREFIX}${ownerUserId}`,
      placeholder: '삭제/비활성화할 메모 선택',
      options: slice.map((memo, i) => ({
        label: `#${start + i + 1} ${sourceLabelFor(memo)}`,
        value: memoSelectValue(memo),
        description: preview(memo.content),
        emoji: memo.source === 'user_direct' ? '✏️' : '🤖',
      })),
    },
  };

  return renderDiscordMessage([...cards, footer]) as any;
};

const handleMemoAdd = async (interaction: ChatInputCommandInteraction) => {
  await interaction.deferReply({ flags: EPHEMERAL });
  const content = (interaction.options.getString('내용') ?? '').trim();
  if (!content) {
    await interaction.editReply({ content: '`동작:작성` 엔 `내용` 도 같이 적어줘.' });
    return;
  }
  const supabase = getSupabaseClient();
  const { data: inserted, error } = await supabase
    .from('muel_user_memos')
    .insert({
      discord_user_id: interaction.user.id,
      content,
    })
    .select('id')
    .single();
  if (error) {
    console.warn('[memo] add failed', error);
    await interaction.editReply({ content: `못 박아뒀어: ${error.message}. 잠깐 뒤 다시 해줘.` });
    return;
  }
  // ADR-002: 직접 메모도 weave 지식 노드로 남긴다 (private, owner=본인). fire-and-forget.
  void insertWeaveNode({
    sourceKind: 'user_memo',
    ownerUserId: interaction.user.id,
    body: content,
    sourceRef: { muel_user_memos_id: inserted?.id ?? null },
  });
  await interaction.editReply({ ...buildAddSuccess(content) });
};

const handleMemoList = async (interaction: ChatInputCommandInteraction) => {
  await interaction.deferReply({ flags: EPHEMERAL });
  const page = interaction.options.getInteger('페이지') ?? 1;
  const memos = await fetchAllMemos(interaction.user.id);
  await interaction.editReply({ ...buildListMessage(memos, page, interaction.user.id) });
};

const handleMemoDelete = async (interaction: ChatInputCommandInteraction) => {
  await interaction.deferReply({ flags: EPHEMERAL });
  const number = interaction.options.getInteger('번호') ?? 0;
  if (number < 1) {
    await interaction.editReply({ content: '`동작:지우기` 엔 `번호` 도 같이. (1 이상)' });
    return;
  }
  const memos = await fetchAllMemos(interaction.user.id);
  if (number > memos.length) {
    await interaction.editReply({
      content: `#${number} 은 없는 번호야. 총 ${memos.length}건.`,
    });
    return;
  }
  const target = memos[number - 1];
  const result = await deleteOrArchiveMemo({
    source: target.source,
    id: target.id,
    ownerUserId: interaction.user.id,
  });
  if (!result.ok) {
    await interaction.editReply({ content: result.message });
    return;
  }
  await interaction.editReply({
    content: `지웠어 #${number} (${target.source === 'user_direct' ? '직접' : '자동 비활성'}).`,
  });
};

const deleteOrArchiveMemo = async (
  args: {
    source: MemoRow['source'];
    id: string;
    ownerUserId: string;
  },
): Promise<{ ok: true; label: string } | { ok: false; message: string }> => {
  const supabase = getSupabaseClient();
  if (args.source === 'user_direct') {
    const { data, error } = await supabase
      .from('muel_user_memos')
      .delete()
      .eq('id', args.id)
      .eq('discord_user_id', args.ownerUserId)
      .select('id')
      .maybeSingle();
    if (error) return { ok: false, message: `삭제 실패: ${error.message}` };
    if (!data?.id) return { ok: false, message: '이 메모를 찾지 못했어. 목록을 새로 열어줘.' };

    await deleteWeaveNodesBySourceRef({
      sourceKind: 'user_memo',
      ownerUserId: args.ownerUserId,
      sourceRef: { muel_user_memos_id: args.id },
      client: supabase,
    });
    return { ok: true, label: '직접 메모 삭제됨' };
  }

  const { data: owned, error: ownErr } = await supabase
    .from('muel_memory_entries')
    .select('id, muel_chats!inner(source_user_id)')
    .eq('id', args.id)
    .eq('muel_chats.source_user_id', args.ownerUserId)
    .maybeSingle();
  if (ownErr) return { ok: false, message: `비활성 실패: ${ownErr.message}` };
  if (!owned?.id) return { ok: false, message: '이 자동 메모를 찾지 못했어. 목록을 새로 열어줘.' };

  const { error } = await supabase
    .from('muel_memory_entries')
    .update({ status: 'archived' })
    .eq('id', args.id);
  if (error) return { ok: false, message: `비활성 실패: ${error.message}` };

  await deleteWeaveNodesBySourceRef({
    sourceKind: 'auto_memo',
    ownerUserId: args.ownerUserId,
    sourceRef: { muel_memory_entries_id: args.id },
    client: supabase,
  });
  return { ok: true, label: '자동 메모 비활성화됨' };
};

const parseMemoSelectValue = (value: string): { source: MemoRow['source']; id: string } | null => {
  const separator = value.indexOf(':');
  if (separator === -1) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!id) return null;
  if (kind === 'u') return { source: 'user_direct', id };
  if (kind === 'a') return { source: 'auto_extracted', id };
  return null;
};

export const isMemoSelectMenu = (customId: string): boolean =>
  customId.startsWith(MEMO_ACTION_FORGET_SELECT_PREFIX);

export const handleMemoSelectMenu = async (interaction: StringSelectMenuInteraction): Promise<void> => {
  const ownerUserId = interaction.customId.slice(MEMO_ACTION_FORGET_SELECT_PREFIX.length);
  if (!ownerUserId || ownerUserId !== interaction.user.id) {
    await interaction.reply({ content: '이 메모 목록은 요청한 사람만 조작할 수 있어.', flags: EPHEMERAL }).catch(() => {});
    return;
  }

  const parsed = parseMemoSelectValue(interaction.values[0] ?? '');
  if (!parsed) {
    await interaction.reply({ content: '선택 데이터가 손상됐어. 목록을 다시 열어줘.', flags: EPHEMERAL }).catch(() => {});
    return;
  }

  await interaction.deferReply({ flags: EPHEMERAL }).catch(() => {});
  const result = await deleteOrArchiveMemo({
    source: parsed.source,
    id: parsed.id,
    ownerUserId,
  });

  const message = result.ok
    ? `${result.label}. 최신 상태는 \`/메모 목록\` 으로 다시 확인해줘.`
    : result.message;
  await interaction.editReply({ content: message }).catch(() => {});
};

export const handleMemoCommand = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const sub = interaction.options.getString('동작', true);
  try {
    if (sub === MEMO_SUB_ADD) await handleMemoAdd(interaction);
    else if (sub === MEMO_SUB_LIST) await handleMemoList(interaction);
    else if (sub === MEMO_SUB_DELETE) await handleMemoDelete(interaction);
    else {
      await interaction.reply({ content: '그건 모르는 동작이야.', flags: EPHEMERAL });
    }
  } catch (err) {
    console.error('[memo] handler failed', err);
    try {
      if (interaction.deferred) await interaction.editReply({ content: '메모 처리 중 오류.' });
      else if (!interaction.replied) await interaction.reply({ content: '메모 처리 중 오류.', flags: EPHEMERAL });
    } catch { /* ignore */ }
  }
};
