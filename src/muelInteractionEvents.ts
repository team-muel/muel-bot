import { Client, Events, MessageFlags } from 'discord.js';
import { getSupabaseClient } from './supabase.js';
import { renderDiscordMessage } from './rendering/discordRenderer.js';
import {
  handleFlatSubscribeCommand,
  SUBSCRIBE_COMMAND_NAME,
} from './subscribe.js';
import {
  handleHubSlashInteraction,
  HUB_COMMAND_NAME,
} from './conciergeHandler.js';
import {
  handleResearchEnrichButton,
  handleResearchDeepButton,
  isResearchEnrichButton,
  isResearchDeepButton,
} from './researchEnrich.js';
import { handleMuelActionButton, isMuelActionButton } from './actionConfirmations.js';
import {
  handleMemoCommand,
  handleMemoSelectMenu,
  isMemoSelectMenu,
  MEMO_COMMAND_NAME,
} from './memoHandler.js';
import {
  ROLLING_COMMAND_NAME,
  handleRollingCommand,
  handleRollingButton,
  handleRollingSelect,
  isRollingButton,
  isRollingSelect,
} from './rollingPaperHandler.js';
import { handleMemoProposalButton, isMemoProposalButton } from './memoProposal.js';
import { WELCOME_COMMAND_NAME, handleWelcomeCommand } from './welcomeHandler.js';
import {
  ARCHIVE_POLICY_COMMAND_NAME,
  handleArchivePolicyCommand,
} from './archivist/policy.js';
import { onSafeDiscordEvent } from './discordEventSafety.js';
import { config } from './config.js';

const buildHelpMessage = () => renderDiscordMessage([{
  type: 'info-card',
  tone: 'muel',
  title: '명령어',
  body: [
    '/구독 - 유튜브 채널 구독 알림',
    '/메모 - 뮤엘에게 기억시키기',
    '/허브 - 이 채널에서 평소 대화에도 응답',
    '/롤링페이퍼 - 멤버끼리 한 줄 남기기',
    '/도움말 · /ping',
    '',
    `팀뮤엘: ${config.hubUrl}`,
    `기록: ${config.hubUrl}/weave`,
  ].join('\n'),
  footer: 'Muel은 AI이며 인물 등에 관한 정보 제공 시 실수를 할 수 있어요.',
}]);

export const registerMuelInteractionEvents = (client: Client): void => {
  if (config.enableHttpInteractions) return;

  onSafeDiscordEvent(client, Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
      if (isResearchEnrichButton(interaction.customId)) {
        await handleResearchEnrichButton(client as Client<true>, interaction);
      } else if (isResearchDeepButton(interaction.customId)) {
        await handleResearchDeepButton(client as Client<true>, interaction);
      } else if (isMuelActionButton(interaction.customId)) {
        await handleMuelActionButton(getSupabaseClient(), interaction);
      } else if (isRollingButton(interaction.customId)) {
        await handleRollingButton(interaction);
      } else if (isMemoProposalButton(interaction.customId)) {
        await handleMemoProposalButton(interaction);
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (isMemoSelectMenu(interaction.customId)) {
        await handleMemoSelectMenu(interaction);
      } else if (isRollingSelect(interaction.customId)) {
        await handleRollingSelect(interaction);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ping') {
      await interaction.reply({ content: '응, 여기 있어.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    if (interaction.commandName === '도움말') {
      await interaction.reply({ ...buildHelpMessage(), flags: [MessageFlags.Ephemeral] });
      return;
    }

    if (interaction.commandName === SUBSCRIBE_COMMAND_NAME) {
      try {
        await handleFlatSubscribeCommand(interaction);
      } catch (error) {
        console.error('[youtube-subscribe] interaction failed', {
          interactionId: interaction.id,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          error,
        });
        const fallback = { content: '구독 명령을 처리하지 못했어요. 잠시 뒤 다시 시도해주세요.' };
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply(fallback);
          } else {
            await interaction.reply(interaction.inGuild()
              ? { ...fallback, flags: [MessageFlags.Ephemeral] }
              : fallback);
          }
        } catch (replyError) {
          console.error('[youtube-subscribe] fallback response failed', {
            interactionId: interaction.id,
            replyError,
          });
        }
      }
      return;
    }

    if (interaction.commandName === HUB_COMMAND_NAME) {
      await handleHubSlashInteraction(interaction);
      return;
    }
    if (interaction.commandName === MEMO_COMMAND_NAME) {
      await handleMemoCommand(interaction);
      return;
    }
    if (interaction.commandName === ROLLING_COMMAND_NAME) {
      await handleRollingCommand(interaction);
      return;
    }
    if (interaction.commandName === WELCOME_COMMAND_NAME) {
      await handleWelcomeCommand(interaction);
      return;
    }
    if (interaction.commandName === ARCHIVE_POLICY_COMMAND_NAME) {
      await handleArchivePolicyCommand(interaction);
      return;
    }

    await interaction.reply({
      ...renderDiscordMessage([{
        type: 'info-card',
        tone: 'warning',
        title: '알 수 없는 명령어',
        body: '내가 아는 명령은 /도움말 /구독 /메모 /허브 /ping 이야.',
      }]),
      flags: [MessageFlags.Ephemeral],
    });
  });
};
