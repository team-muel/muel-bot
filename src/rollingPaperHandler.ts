import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { getSupabaseClient } from './supabase.js';

// /롤링페이퍼 — 멤버끼리 서로에게 남기는 한 줄(공개 레이어). /메모(나만 보는 Muel 기억)와 별개.
export const ROLLING_COMMAND_NAME = '롤링페이퍼';
const EPHEMERAL = MessageFlags.Ephemeral;
const ACTION = '동작';
const ACTION_WRITE = '작성';
const ACTION_SENT = '보낸';
const OPT_TARGET = '대상';
const OPT_CONTENT = '내용';
const MAX_LEN = 500;
const MAX_OPTIONS = 25;
const COLOR = 0x9b87f5;

const SEL_DELRECV = 'rp:sel:delrecv';
const SEL_UNBLOCK = 'rp:sel:unblock';
const SEL_DELSENT = 'rp:sel:delsent';
const BTN_BLOCK = 'rp:btn:block:';
const BTN_NOBLOCK = 'rp:btn:noblock';

export const isRollingButton = (customId: string): boolean => customId.startsWith('rp:btn:');
export const isRollingSelect = (customId: string): boolean => customId.startsWith('rp:sel:');

export const buildRollingSlashCommand = () =>
  new SlashCommandBuilder()
    .setName(ROLLING_COMMAND_NAME)
    .setDescription('서로한테 한 줄 남기는 롤링페이퍼. 그냥 실행하면 받은 걸 보여줄게.')
    .addStringOption((o) =>
      o.setName(ACTION).setDescription('작성 / 보낸 (비우면 받은 목록)').addChoices(
        { name: '작성', value: ACTION_WRITE },
        { name: '보낸', value: ACTION_SENT },
      ),
    )
    .addUserOption((o) => o.setName(OPT_TARGET).setDescription('동작=작성 일 때 받을 사람'))
    .addStringOption((o) => o.setName(OPT_CONTENT).setDescription('동작=작성 일 때 남길 한 줄'));

type AnyInteraction =
  | ChatInputCommandInteraction
  | StringSelectMenuInteraction
  | ButtonInteraction;

async function nameOf(interaction: AnyInteraction, id: string): Promise<string> {
  try {
    const u = await interaction.client.users.fetch(id);
    return u.globalName ?? u.username;
  } catch {
    return '유저';
  }
}

export const handleRollingCommand = async (
  interaction: ChatInputCommandInteraction,
): Promise<void> => {
  await interaction.deferReply({ flags: EPHEMERAL });
  const me = interaction.user.id;
  const supabase = getSupabaseClient();
  const action = interaction.options.getString(ACTION, false);

  if (action === ACTION_WRITE) {
    const target = interaction.options.getUser(OPT_TARGET, false);
    const content = (interaction.options.getString(OPT_CONTENT, false) ?? '').trim();
    if (!target) { await interaction.editReply({ content: '`동작:작성` 엔 `대상` 도 골라줘.' }); return; }
    if (!content) { await interaction.editReply({ content: '`동작:작성` 엔 `내용` 도 적어줘.' }); return; }
    if (content.length > MAX_LEN) { await interaction.editReply({ content: `${MAX_LEN}자 이하로 적어줘.` }); return; }
    if (target.id === me) { await interaction.editReply({ content: '자기 자신한텐 못 남겨.' }); return; }
    if (target.bot) { await interaction.editReply({ content: '봇한텐 못 남겨.' }); return; }

    const { data: blk } = await supabase
      .from('muel_rolling_blocks').select('author_id')
      .eq('target_id', target.id).eq('author_id', me).maybeSingle();
    if (blk) { await interaction.editReply({ content: '그 사람이 너한텐 롤링페이퍼를 막아놨어.' }); return; }

    const { error } = await supabase.from('muel_rolling_papers').upsert(
      { author_id: me, target_id: target.id, content, created_at: new Date().toISOString() },
      { onConflict: 'author_id,target_id' },
    );
    if (error) { await interaction.editReply({ content: `못 남겼어: ${error.message}.` }); return; }
    await interaction.editReply({ content: `<@${target.id}> 한테 남겼어. 바꾸려면 다시 작성(덮어쓰기), 지우려면 /롤링페이퍼 동작:보낸.` });
    return;
  }

  if (action === ACTION_SENT) {
    const { data: notes } = await supabase
      .from('muel_rolling_papers').select('id, target_id, content, created_at')
      .eq('author_id', me).order('created_at', { ascending: false });
    const rows = ((notes ?? []) as Array<{ id: string; target_id: string; content: string }>).slice(0, MAX_OPTIONS);
    if (rows.length === 0) { await interaction.editReply({ content: '아직 아무한테도 안 남겼어.' }); return; }
    const named = await Promise.all(rows.map(async (n) => ({ ...n, name: await nameOf(interaction, n.target_id) })));
    const embed = new EmbedBuilder().setTitle('내가 보낸 롤링페이퍼').setColor(COLOR)
      .setDescription(named.map((n, i) => `**${i + 1}.** → ${n.name} — ${n.content}`).join('\n').slice(0, 4000));
    const select = new StringSelectMenuBuilder().setCustomId(SEL_DELSENT).setPlaceholder('지울 카드 고르기')
      .addOptions(named.map((n, i) => ({ label: `${i + 1}. → ${n.name}`.slice(0, 100), description: n.content.slice(0, 90), value: n.id })));
    await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] });
    return;
  }

  // 받은 (default)
  const [{ data: notes }, { data: blocks }] = await Promise.all([
    supabase.from('muel_rolling_papers').select('id, author_id, content, created_at').eq('target_id', me).order('created_at', { ascending: false }),
    supabase.from('muel_rolling_blocks').select('author_id, created_at').eq('target_id', me).order('created_at', { ascending: false }),
  ]);
  const noteRows = ((notes ?? []) as Array<{ id: string; author_id: string; content: string }>).slice(0, MAX_OPTIONS);
  const blockRows = ((blocks ?? []) as Array<{ author_id: string }>).slice(0, MAX_OPTIONS);
  const named = await Promise.all(noteRows.map(async (n) => ({ ...n, name: await nameOf(interaction, n.author_id) })));
  const namedBlocks = await Promise.all(blockRows.map(async (b) => ({ ...b, name: await nameOf(interaction, b.author_id) })));

  const lines: string[] = [];
  if (named.length) lines.push(...named.map((n, i) => `**${i + 1}.** ${n.name} — ${n.content}`));
  else lines.push('아직 받은 롤링페이퍼가 없어.');
  if (namedBlocks.length) lines.push('', `🚫 차단: ${namedBlocks.map((b) => b.name).join(', ')}`);

  const embed = new EmbedBuilder().setTitle('나에게 온 롤링페이퍼').setColor(COLOR).setDescription(lines.join('\n').slice(0, 4000));
  const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  if (named.length) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(SEL_DELRECV).setPlaceholder('지울 카드 고르기 (지우면 차단할지 물어볼게)')
        .addOptions(named.map((n, i) => ({ label: `${i + 1}. ${n.name}`.slice(0, 100), description: n.content.slice(0, 90), value: n.id }))),
    ));
  }
  if (namedBlocks.length) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(SEL_UNBLOCK).setPlaceholder('차단 풀 사람 고르기')
        .addOptions(namedBlocks.map((b) => ({ label: b.name.slice(0, 100), value: b.author_id }))),
    ));
  }
  await interaction.editReply({ embeds: [embed], components });
};

export const handleRollingSelect = async (interaction: StringSelectMenuInteraction): Promise<void> => {
  const me = interaction.user.id;
  const supabase = getSupabaseClient();
  const value = interaction.values[0];

  if (interaction.customId === SEL_DELRECV) {
    const { data: note } = await supabase.from('muel_rolling_papers').select('author_id').eq('id', value).eq('target_id', me).maybeSingle();
    if (!note) { await interaction.update({ content: '이미 없는 카드야.', embeds: [], components: [] }); return; }
    await supabase.from('muel_rolling_papers').delete().eq('id', value).eq('target_id', me);
    const authorId = (note as { author_id: string }).author_id;
    const name = await nameOf(interaction, authorId);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${BTN_BLOCK}${authorId}`).setLabel('차단').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(BTN_NOBLOCK).setLabel('놔둬').setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({ content: `지웠어. ${name} 를 롤링페이퍼에서 차단할까?`, embeds: [], components: [row] });
    return;
  }
  if (interaction.customId === SEL_UNBLOCK) {
    await supabase.from('muel_rolling_blocks').delete().eq('target_id', me).eq('author_id', value);
    const name = await nameOf(interaction, value);
    await interaction.update({ content: `${name} 차단 풀었어.`, embeds: [], components: [] });
    return;
  }
  if (interaction.customId === SEL_DELSENT) {
    await supabase.from('muel_rolling_papers').delete().eq('id', value).eq('author_id', me);
    await interaction.update({ content: '지웠어.', embeds: [], components: [] });
    return;
  }
};

export const handleRollingButton = async (interaction: ButtonInteraction): Promise<void> => {
  const me = interaction.user.id;
  const supabase = getSupabaseClient();
  const cid = interaction.customId;
  if (cid === BTN_NOBLOCK) { await interaction.update({ content: '응, 안 차단할게.', embeds: [], components: [] }); return; }
  if (cid.startsWith(BTN_BLOCK)) {
    const authorId = cid.slice(BTN_BLOCK.length);
    await supabase.from('muel_rolling_blocks').upsert(
      { target_id: me, author_id: authorId, created_at: new Date().toISOString() },
      { onConflict: 'target_id,author_id' },
    );
    const name = await nameOf(interaction, authorId);
    await interaction.update({ content: `${name} 차단했어. /롤링페이퍼에서 풀 수 있어.`, embeds: [], components: [] });
    return;
  }
};