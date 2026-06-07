import {
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildMember,
} from 'discord.js';
import { getSupabaseClient } from './supabase.js';

export const WELCOME_COMMAND_NAME = '환영';
const EPHEMERAL = MessageFlags.Ephemeral;
const ACTION = '동작';
const ACTION_SET = '설정';
const ACTION_CANCEL = '취소';

export const buildWelcomeSlashCommand = () =>
  new SlashCommandBuilder()
    .setName(WELCOME_COMMAND_NAME)
    .setDescription('새 멤버 들어오면 내가 이 채널에서 맞이할게.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt
        .setName(ACTION)
        .setDescription('설정=이 채널에 켜기 / 취소=끄기')
        .addChoices(
          { name: '설정', value: ACTION_SET },
          { name: '취소', value: ACTION_CANCEL },
        ),
    );

export const handleWelcomeCommand = async (
  interaction: ChatInputCommandInteraction,
): Promise<void> => {
  await interaction.deferReply({ flags: EPHEMERAL });
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply({ content: '이건 서버 안에서만 돼.' });
    return;
  }
  const hasPerm = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  if (!hasPerm) {
    await interaction.editReply({ content: '이건 서버 관리 권한 있는 사람만 정할 수 있어.' });
    return;
  }

  const action = interaction.options.getString(ACTION, false) ?? ACTION_SET;
  const supabase = getSupabaseClient();

  if (action === ACTION_CANCEL) {
    const { error } = await supabase
      .from('muel_welcome_configs')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq('guild_id', guildId);
    if (error) {
      await interaction.editReply({ content: `못 껐어: ${error.message}. 잠깐 뒤 다시.` });
      return;
    }
    await interaction.editReply({ content: '알겠어, 이제 새 멤버 와도 채널에선 조용히 있을게.' });
    return;
  }

  const { error } = await supabase.from('muel_welcome_configs').upsert(
    {
      guild_id: guildId,
      channel_id: interaction.channelId,
      enabled: true,
      set_by_user_id: interaction.user.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'guild_id' },
  );
  if (error) {
    await interaction.editReply({ content: `못 켰어: ${error.message}. 잠깐 뒤 다시.` });
    return;
  }
  await interaction.editReply({
    content: '좋아, 이제 새 멤버 오면 여기서 내가 맞이할게. 끄려면 `/환영 동작:취소`.',
  });
};

// GuildMemberAdd 에서 호출. 서버에 환영 채널이 켜져 있으면 그 채널에 환영 메시지.
export const postWelcomeIfConfigured = async (member: GuildMember): Promise<void> => {
  if (member.user.bot) return;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('muel_welcome_configs')
      .select('channel_id, enabled')
      .eq('guild_id', member.guild.id)
      .maybeSingle();
    if (error || !data || !data.enabled || !data.channel_id) return;

    const channel = await member.guild.channels.fetch(data.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    await channel.send({
      content: `${member} 어서 와. 나 뮤엘이야 — 여기 상주하면서 같이 떠들어. 뭐 할 수 있는지는 /도움말, 내가 너희를 어떻게 보는지는 Weave에서 볼 수 있어.`,
      allowedMentions: { users: [member.id] },
    });
  } catch (err) {
    console.warn('[muel-welcome] channel post failed', {
      guildId: member.guild.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
};