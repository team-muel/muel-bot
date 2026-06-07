import {
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getSupabaseClient } from './supabase.js';

// /먼저 — 채널별 프로액티브(먼저 말 걸기) 옵트인. 기본 OFF. 허브 응답과 별개.
export const PROACTIVE_COMMAND_NAME = '먼저';
const EPHEMERAL = MessageFlags.Ephemeral;
const ACTION = '동작';
const A_ON = '켜기';
const A_OFF = '끄기';
const A_STATUS = '상태';

export const buildProactiveSlashCommand = () =>
  new SlashCommandBuilder()
    .setName(PROACTIVE_COMMAND_NAME)
    .setDescription('이 채널에서 내가 가끔 먼저 말 걸지 정해 (아침 인사 · 갑자기 북적일 때).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) =>
      o
        .setName(ACTION)
        .setDescription('켜기 / 끄기 / 상태')
        .addChoices(
          { name: '켜기', value: A_ON },
          { name: '끄기', value: A_OFF },
          { name: '상태', value: A_STATUS },
        ),
    );

export const handleProactiveCommand = async (
  interaction: ChatInputCommandInteraction,
): Promise<void> => {
  await interaction.deferReply({ flags: EPHEMERAL });
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply({ content: '서버 채널에서만 돼.' });
    return;
  }
  if (!(interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ?? false)) {
    await interaction.editReply({ content: '채널 관리 권한 있는 사람만 정할 수 있어.' });
    return;
  }
  const action = interaction.options.getString(ACTION, false) ?? A_STATUS;
  const supabase = getSupabaseClient();
  const channelId = interaction.channelId;

  if (action === A_STATUS) {
    const { data } = await supabase
      .from('muel_proactive_configs')
      .select('enabled, morning, spike')
      .eq('guild_id', guildId)
      .eq('channel_id', channelId)
      .maybeSingle();
    const c = data as { enabled: boolean; morning: boolean; spike: boolean } | null;
    if (!c || !c.enabled) {
      await interaction.editReply({ content: '여긴 내가 먼저 말 안 걸어. 켜려면 `/먼저 동작:켜기`.' });
      return;
    }
    await interaction.editReply({
      content: `여긴 내가 가끔 먼저 말 걸어 (아침${c.morning ? ' ✓' : ' ✗'} · 북적일 때${c.spike ? ' ✓' : ' ✗'}). 끄려면 \`/먼저 동작:끄기\`.`,
    });
    return;
  }

  if (action === A_OFF) {
    const { error } = await supabase
      .from('muel_proactive_configs')
      .upsert({ guild_id: guildId, channel_id: channelId, enabled: false }, { onConflict: 'guild_id,channel_id' });
    if (error) {
      await interaction.editReply({ content: `못 껐어: ${error.message}.` });
      return;
    }
    await interaction.editReply({ content: '알겠어, 여기선 먼저 말 안 걸게.' });
    return;
  }

  const { error } = await supabase
    .from('muel_proactive_configs')
    .upsert(
      { guild_id: guildId, channel_id: channelId, enabled: true, morning: true, spike: true },
      { onConflict: 'guild_id,channel_id' },
    );
  if (error) {
    await interaction.editReply({ content: `못 켰어: ${error.message}.` });
    return;
  }
  await interaction.editReply({
    content: '좋아, 이제 가끔 먼저 말 걸게 — 아침 인사랑, 갑자기 북적일 때. 너무 시끄러우면 `/먼저 동작:끄기`.',
  });
};