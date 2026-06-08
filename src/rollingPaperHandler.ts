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
//
// UX (2026-06-08 사용자 결정):
// - 옵션은 *작성* + *대상* 두 개만. `동작=작성` 같은 별도 동작 옵션 제거.
// - 둘 다 채워서 호출 → 그 사람에게 한 줄 남김 (덮어쓰기).
// - 대상만 골라서 호출 → 그 대상에게 *남겨진* 카드 구경 (공개 레이어, 읽기 전용).
// - 둘 다 비워서 호출 → 내가 *받은* 카드 목록 + 차단 관리.
// - *내가 보낸 카드 목록* 은 별도 슬래시 명령으로 후속 분리 (이전의 `동작=보낸` 제거).
export const ROLLING_COMMAND_NAME = '롤링페이퍼';
const EPHEMERAL = MessageFlags.Ephemeral;
const OPT_TARGET = '대상';
const OPT_WRITE = '작성';
const MAX_LEN = 500;
const MAX_OPTIONS = 25;
const COLOR = 0x9b87f5;

const SEL_DELRECV = 'rp:sel:delrecv';
const SEL_UNBLOCK = 'rp:sel:unblock';
const SEL_DELSENT = 'rp:sel:delsent';
const BTN_BLOCK = 'rp:btn:block:';
const BTN_NOBLOCK = 'rp:btn:noblock';
// 작성 직후 ephemeral 응답에 *이 채널에 공개로 보여주기* 버튼 (2026-06-08).
// customId 에 target_id 를 박아서 DB 재조회 시 그 대상의 카드만 가져온다.
const BTN_SHOW = 'rp:btn:show:';

export const isRollingButton = (customId: string): boolean => customId.startsWith('rp:btn:');
export const isRollingSelect = (customId: string): boolean => customId.startsWith('rp:sel:');

export const buildRollingSlashCommand = () =>
  new SlashCommandBuilder()
    .setName(ROLLING_COMMAND_NAME)
    .setDescription('멤버끼리 한 줄 남기는 롤링페이퍼')
    .addStringOption((o) =>
      o
        .setName(OPT_WRITE)
        .setDescription('남길 한 줄')
        .setMaxLength(MAX_LEN),
    )
    .addUserOption((o) => o.setName(OPT_TARGET).setDescription('받을 사람'));

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
  const target = interaction.options.getUser(OPT_TARGET, false);
  const content = (interaction.options.getString(OPT_WRITE, false) ?? '').trim();

  // 옵션 분기 (2026-06-08 UX 변경): action 옵션 제거, 옵션 두 개의 조합으로 결정.
  // - 작성+대상 둘 다 → 작성
  // - 둘 다 빔 → 받은 목록 (기존 default 흐름)
  // - 하나만 → 안내
  if (target && !content) {
    // 대상만 골랐을 때 → 그 대상에게 *남겨진* 롤링페이퍼 구경(공개 레이어, 읽기 전용).
    if (target.bot) { await interaction.editReply({ content: '봇한텐 롤링페이퍼가 없어.' }); return; }
    const { data: forTarget } = await supabase
      .from('muel_rolling_papers')
      .select('author_id, content, created_at')
      .eq('target_id', target.id)
      .order('created_at', { ascending: false });
    const rows = ((forTarget ?? []) as Array<{ author_id: string; content: string }>).slice(0, MAX_OPTIONS);
    const named = await Promise.all(rows.map(async (n) => ({ ...n, name: await nameOf(interaction, n.author_id) })));
    const targetName = await nameOf(interaction, target.id);
    const lines = named.length
      ? named.map((n, i) => `**${i + 1}.** ${n.name} — ${n.content}`)
      : ['아직 남겨진 롤링페이퍼가 없어. `작성`도 같이 적으면 네가 첫 줄을 남길 수 있어.'];
    const embed = new EmbedBuilder()
      .setTitle(`${targetName} 에게 온 롤링페이퍼`)
      .setColor(COLOR)
      .setDescription(lines.join('\n').slice(0, 4000));
    await interaction.editReply({ embeds: [embed] });
    return;
  }
  if (!target && content) {
    await interaction.editReply({ content: '`대상` 도 같이 골라줘.' });
    return;
  }

  if (target && content) {
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
    // 작성 성공 — ephemeral 답에 *공개로 보여주기* 버튼 추가. 누르면 같은 채널에 카드 발행.
    const showRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${BTN_SHOW}${target.id}`)
        .setLabel('이 채널에 공개로 보여주기')
        .setStyle(ButtonStyle.Primary),
    );
    await interaction.editReply({
      content: `<@${target.id}> 한테 남겼어. 바꾸려면 다시 작성(덮어쓰기).`,
      components: [showRow],
    });
    return;
  }

  // 받은 (default — 둘 다 비웠을 때)
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
  if (cid.startsWith(BTN_SHOW)) {
    const targetId = cid.slice(BTN_SHOW.length);
    const { data: note } = await supabase
      .from('muel_rolling_papers')
      .select('content')
      .eq('author_id', me)
      .eq('target_id', targetId)
      .maybeSingle();
    if (!note) {
      await interaction.update({ content: '카드가 사라졌어. 다시 작성해줘.', embeds: [], components: [] });
      return;
    }
    const targetName = await nameOf(interaction, targetId);
    const myName = await nameOf(interaction, me);
    const content = (note as { content: string }).content;
    const embed = new EmbedBuilder()
      .setTitle('롤링페이퍼')
      .setColor(COLOR)
      .setDescription(`**${myName}** → **${targetName}**\n${content}`);
    // 채널에 공개 메시지로 카드 발행. 채널이 null (DM context 등) 이면 안내만.
    const channel = interaction.channel;
    if (channel && 'send' in channel && typeof channel.send === 'function') {
      try {
        await (channel as { send: (opts: { embeds: EmbedBuilder[] }) => Promise<unknown> }).send({ embeds: [embed] });
        await interaction.update({ content: '공개로 보여줬어.', components: [] });
      } catch (err) {
        await interaction.update({
          content: `이 채널엔 못 보냈어. (${err instanceof Error ? err.message : '권한 X'})`,
          components: [],
        });
      }
    } else {
      await interaction.update({ content: '이 컨텍스트에선 공개 채널이 없어.', components: [] });
    }
    return;
  }
};