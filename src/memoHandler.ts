import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getSupabaseClient } from './supabase.js';
import { renderDiscordMessage } from './rendering/discordRenderer.js';
import { insertWeaveNode } from './weaveNodes.js';

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

const MEMO_PAGE_SIZE = 10;
const MEMO_MAX_LIST = 100; // 한 사용자 메모 표시 상한 (목록 페이지네이션 기준)

const EPHEMERAL = MessageFlags.Ephemeral;

export const buildMemoSlashCommand = () => {
  const cmd = new SlashCommandBuilder()
    .setName(MEMO_COMMAND_NAME)
    .setDescription('Muel 에게 기억시킬 개인화 메모 (자기 응답 스타일·지침·사실).')
    .addSubcommand((sub) =>
      sub
        .setName(MEMO_SUB_ADD)
        .setDescription('새 메모를 추가합니다. 다음 대화부터 Muel 이 이걸 기억합니다.')
        .addStringOption((opt) =>
          opt
            .setName('내용')
            .setDescription('기억시킬 내용 (예: 나한테 답할 땐 존댓말 써)')
            .setRequired(true)
            .setMaxLength(2000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName(MEMO_SUB_LIST)
        .setDescription('내 메모 목록을 봅니다. 직접 추가한 것 + Muel 이 자동 추출한 것 모두.')
        .addIntegerOption((opt) =>
          opt
            .setName('페이지')
            .setDescription('페이지 번호 (1부터)')
            .setRequired(false)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName(MEMO_SUB_DELETE)
        .setDescription('번호로 메모를 삭제합니다. (자동 추출 메모는 status 만 archived.)')
        .addIntegerOption((opt) =>
          opt
            .setName('번호')
            .setDescription('목록에서 본 카드 우측 하단 #번호')
            .setRequired(true)
            .setMinValue(1),
        ),
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
    title: '메모 추가됨',
    body: content,
    fields: [{ name: '​', value: '✏️ 직접 · 다음 대화부터 반영' }],
  }]) as any;

const buildListMessage = (memos: MemoRow[], page: number) => {
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
  const footer = {
    type: 'info-card' as const,
    tone: 'muel' as const,
    title: `페이지 ${safePage} / ${totalPages}`,
    body: `총 ${memos.length}건 · 다음 페이지: \`/메모 목록 페이지:${safePage + 1}\` · 삭제: \`/메모 삭제 번호:<#>\``,
  };

  return renderDiscordMessage([...cards, footer]) as any;
};

const handleMemoAdd = async (interaction: ChatInputCommandInteraction) => {
  const content = interaction.options.getString('내용', true).trim();
  if (!content) {
    await interaction.reply({ content: '내용이 비어 있어.', flags: EPHEMERAL });
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
    await interaction.reply({ content: `저장 실패: ${error.message}`, flags: EPHEMERAL });
    return;
  }
  // ADR-002: 직접 메모도 weave 지식 노드로 남긴다 (private, owner=본인). fire-and-forget.
  void insertWeaveNode({
    sourceKind: 'user_memo',
    ownerUserId: interaction.user.id,
    body: content,
    sourceRef: { muel_user_memos_id: inserted?.id ?? null },
  });
  await interaction.reply({ ...buildAddSuccess(content), flags: EPHEMERAL });
};

const handleMemoList = async (interaction: ChatInputCommandInteraction) => {
  const page = interaction.options.getInteger('페이지') ?? 1;
  const memos = await fetchAllMemos(interaction.user.id);
  await interaction.reply({ ...buildListMessage(memos, page), flags: EPHEMERAL });
};

const handleMemoDelete = async (interaction: ChatInputCommandInteraction) => {
  const number = interaction.options.getInteger('번호', true);
  if (number < 1) {
    await interaction.reply({ content: '번호는 1 이상이어야 해.', flags: EPHEMERAL });
    return;
  }
  const memos = await fetchAllMemos(interaction.user.id);
  if (number > memos.length) {
    await interaction.reply({
      content: `#${number} 은 없는 번호야. 총 ${memos.length}건.`,
      flags: EPHEMERAL,
    });
    return;
  }
  const target = memos[number - 1];
  const supabase = getSupabaseClient();
  if (target.source === 'user_direct') {
    const { error } = await supabase.from('muel_user_memos').delete().eq('id', target.id);
    if (error) {
      await interaction.reply({ content: `삭제 실패: ${error.message}`, flags: EPHEMERAL });
      return;
    }
  } else {
    // auto_extracted: 자동 추출 메모는 hard delete 대신 status='archived' 로 비활성.
    // retrieveRelevantMemories 가 status='active' 만 본다.
    const { error } = await supabase
      .from('muel_memory_entries')
      .update({ status: 'archived' })
      .eq('id', target.id);
    if (error) {
      await interaction.reply({ content: `비활성 실패: ${error.message}`, flags: EPHEMERAL });
      return;
    }
  }
  await interaction.reply({
    content: `메모 #${number} 삭제됨 (${target.source === 'user_direct' ? '직접' : '자동 → 비활성'}).`,
    flags: EPHEMERAL,
  });
};

export const handleMemoCommand = async (interaction: ChatInputCommandInteraction): Promise<void> => {
  const sub = interaction.options.getSubcommand();
  try {
    if (sub === MEMO_SUB_ADD) await handleMemoAdd(interaction);
    else if (sub === MEMO_SUB_LIST) await handleMemoList(interaction);
    else if (sub === MEMO_SUB_DELETE) await handleMemoDelete(interaction);
    else {
      await interaction.reply({ content: '알 수 없는 서브커맨드.', flags: EPHEMERAL });
    }
  } catch (err) {
    console.error('[memo] handler failed', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '메모 처리 중 오류.', flags: EPHEMERAL }).catch(() => {});
    }
  }
};
