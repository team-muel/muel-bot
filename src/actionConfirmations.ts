import type { ButtonInteraction, MessageReplyOptions } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { activateHubChannel, deactivateHubChannel } from './hubChannels.js';
import { logMuelAgentAction } from './agentActions.js';
import { flavorError } from './errorFlavor.js';

const PREFIX = 'muel:action';
const HUB_ON = 'hub_on';
const HUB_OFF = 'hub_off';
const CANCEL = 'cancel';

type HubAction = typeof HUB_ON | typeof HUB_OFF;

const labelFor = (action: HubAction): string =>
  action === HUB_ON ? '허브 활성화' : '허브 비활성화';

const parseCustomId = (customId: string): { kind: HubAction | typeof CANCEL; userId: string; channelId: string } | null => {
  const parts = customId.split(':');
  if (parts.length !== 5) return null;
  const [prefixA, prefixB, kind, userId, channelId] = parts;
  if (`${prefixA}:${prefixB}` !== PREFIX) return null;
  if (kind !== HUB_ON && kind !== HUB_OFF && kind !== CANCEL) return null;
  if (!/^\d{17,20}$/.test(userId) || !/^\d{17,20}$/.test(channelId)) return null;
  return { kind, userId, channelId };
};

const buildCustomId = (kind: HubAction | typeof CANCEL, userId: string, channelId: string): string =>
  `${PREFIX}:${kind}:${userId}:${channelId}`;

export const isMuelActionButton = (customId: string): boolean => customId.startsWith(`${PREFIX}:`);

export const buildHubActionConfirmation = (args: {
  action: 'hub_activate' | 'hub_deactivate';
  userId: string;
  channelId: string;
}): MessageReplyOptions => {
  const kind: HubAction = args.action === 'hub_activate' ? HUB_ON : HUB_OFF;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId(kind, args.userId, args.channelId))
      .setLabel(labelFor(kind))
      .setStyle(kind === HUB_ON ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(buildCustomId(CANCEL, args.userId, args.channelId))
      .setLabel('취소')
      .setStyle(ButtonStyle.Secondary),
  );

  const actionText = kind === HUB_ON ? '이 채널에서 Muel Hub를 켜기' : '이 채널에서 Muel Hub를 끄기';
  return {
    content: `${actionText} 전에 확인이 필요해. 채널 관리 권한이 있는 요청자만 실행할 수 있어.`,
    components: [row],
    allowedMentions: { parse: [], repliedUser: false },
  };
};

export const handleMuelActionButton = async (
  supabase: SupabaseClient,
  interaction: ButtonInteraction,
): Promise<void> => {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({ content: '확인 버튼 데이터가 손상됐어.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
    return;
  }

  if (interaction.user.id !== parsed.userId) {
    await interaction.reply({ content: '이 확인 버튼은 요청한 사람만 누를 수 있어.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
    return;
  }

  if (parsed.kind === CANCEL) {
    await interaction.update({ content: '작업을 취소했어.', components: [] }).catch(() => {});
    return;
  }

  if (!interaction.guildId) {
    await interaction.reply({ content: '서버 안에서만 실행할 수 있어.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
    return;
  }

  if (interaction.channelId !== parsed.channelId) {
    await interaction.reply({ content: '요청했던 채널에서만 실행할 수 있어.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
    return;
  }

  const hasPermission = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ?? false;
  if (!hasPermission) {
    await interaction.reply({ content: '채널 관리 권한이 있어야 실행할 수 있어.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
    void logMuelAgentAction(supabase, {
      triggerSource: 'mention',
      triggerDetail: parsed.kind,
      status: 'denied',
      discordGuildId: interaction.guildId,
      discordChannelId: interaction.channelId,
      discordUserId: interaction.user.id,
      metadata: { triggerKind: 'action_confirmation', reason: 'missing_manage_channels' },
    });
    return;
  }

  try {
    if (parsed.kind === HUB_ON) {
      await activateHubChannel(supabase, {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        activatedByUserId: interaction.user.id,
        activatedByUsername: interaction.user.username,
      });
    } else {
      await deactivateHubChannel(supabase, {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });
    }

    await interaction.update({
      content: parsed.kind === HUB_ON
        ? '확인 완료. 이 채널에서 Muel Hub를 활성화했어.'
        : '확인 완료. 이 채널의 Muel Hub를 비활성화했어.',
      components: [],
    }).catch(() => {});

    void logMuelAgentAction(supabase, {
      triggerSource: 'mention',
      triggerDetail: parsed.kind,
      status: 'responded',
      discordGuildId: interaction.guildId,
      discordChannelId: interaction.channelId,
      discordUserId: interaction.user.id,
      metadata: { triggerKind: 'action_confirmation' },
    });
  } catch (error) {
    await interaction.reply({ content: flavorError(error), flags: [MessageFlags.Ephemeral] }).catch(() => {});
    void logMuelAgentAction(supabase, {
      triggerSource: 'mention',
      triggerDetail: parsed.kind,
      status: 'error',
      discordGuildId: interaction.guildId,
      discordChannelId: interaction.channelId,
      discordUserId: interaction.user.id,
      metadata: {
        triggerKind: 'action_confirmation',
        errorMessage: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
      },
    });
  }
};
