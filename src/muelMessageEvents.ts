import { Client, Events } from 'discord.js';
import { handleMuelMention, shouldMuelRespond } from './mentionHandler.js';
import { pushMessage } from './channelBuffer.js';
import { getSupabaseClient } from './supabase.js';
import { isNegativeEmoji, recordFeedbackSignal } from './feedbackSignals.js';
import { observeCommunityMessage } from './communityFlow.js';
import { handleHubChannelMessage } from './conciergeHandler.js';
import { isHubChannelActive } from './hubChannels.js';
import {
  archiveMemberAdd,
  archiveMemberRemove,
  archiveMessageCreate,
  archiveMessageDelete,
  archiveMessageUpdate,
} from './archivist/index.js';
import { postWelcomeIfConfigured } from './welcomeHandler.js';
import { onSafeDiscordEvent } from './discordEventSafety.js';

const MUEL_WELCOME_DM = [
  '안녕, 나는 Muel (뮤엘) 이야.',
  '이 서버 어디서든 `@Muel` 멘션해서 부르거나, 여기 DM 으로도 바로 얘기할 수 있어.',
  '뭐든 질문해도 돼. 모르면 모른다고 할게.',
].join('\n');

export const registerMuelMessageEvents = (client: Client): void => {
  onSafeDiscordEvent(client, Events.MessageCreate, async (message) => {
    if (!client.isReady()) return;

    void archiveMessageCreate(message).catch((error) => {
      console.warn('[archivist] messageCreate failed', { messageId: message.id, error });
    });
    if (message.author.bot) return;

    let mentionPathHandled = false;
    try {
      mentionPathHandled = await shouldMuelRespond(message, client);
    } catch (error) {
      console.warn('[muel] shouldMuelRespond check failed', error);
    }

    if (mentionPathHandled) {
      await handleMuelMention(client, message);
    } else if (message.guildId && message.content) {
      try {
        const active = await isHubChannelActive(getSupabaseClient(), {
          guildId: message.guildId,
          channelId: message.channelId,
        });
        if (active) await handleHubChannelMessage(client, message);
      } catch (error) {
        console.warn('[hub] channel auto-respond failed', error);
      }
    }

    if (message.content) {
      pushMessage(message.channelId, {
        id: message.id,
        authorId: message.author.id,
        authorName: message.author.displayName ?? message.author.username,
        content: message.content,
        timestamp: message.createdTimestamp,
        replyToId: message.reference?.messageId ?? undefined,
      });
      try {
        observeCommunityMessage(getSupabaseClient(), message);
      } catch (error) {
        console.warn('[community-flow] skipped observe', error);
      }
    }
  });

  onSafeDiscordEvent(client, Events.MessageUpdate, async (oldMessage, newMessage) => {
    try {
      await archiveMessageUpdate(oldMessage, newMessage);
    } catch (error) {
      console.warn('[archivist] messageUpdate failed', { messageId: newMessage.id, error });
    }
  });

  onSafeDiscordEvent(client, Events.MessageDelete, async (message) => {
    try {
      await archiveMessageDelete(message);
    } catch (error) {
      console.warn('[archivist] messageDelete failed', { messageId: message.id, error });
    }
  });

  onSafeDiscordEvent(client, Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (user.bot) return;
      if (reaction.partial) {
        try { await reaction.fetch(); } catch { return; }
      }
      const msg = reaction.message;
      if (msg.partial) {
        try { await msg.fetch(); } catch { return; }
      }
      if (!client.user || msg.author?.id !== client.user.id) return;
      if (!isNegativeEmoji(reaction.emoji.name)) return;
      await recordFeedbackSignal(getSupabaseClient(), {
        signalType: 'reaction_negative',
        sentiment: 'negative',
        guildId: msg.guildId ?? null,
        channelId: msg.channelId,
        channelType: msg.guildId ? 'guild' : 'dm',
        muelMessageId: msg.id,
        userId: user.id,
        severity: 2,
        evidence: `reaction:${reaction.emoji.name ?? '?'}`,
        metadata: { emoji: reaction.emoji.name },
      });
    } catch (error) {
      console.warn('[feedback-signal] reaction handler failed', error);
    }
  });

  onSafeDiscordEvent(client, Events.GuildMemberAdd, async (member) => {
    try {
      await archiveMemberAdd(member);
    } catch (error) {
      console.warn('[archivist] guildMemberAdd restore failed', { userId: member.id, error });
    }
    if (member.user.bot) return;
    try {
      await member.send(MUEL_WELCOME_DM);
      console.log('[muel-welcome] sent', { userId: member.id, guildId: member.guild.id });
    } catch (error) {
      console.warn('[muel-welcome] DM blocked', {
        userId: member.id,
        guildId: member.guild.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await postWelcomeIfConfigured(member);
  });

  onSafeDiscordEvent(client, Events.GuildMemberRemove, async (member) => {
    try {
      await archiveMemberRemove(member);
    } catch (error) {
      console.warn('[archivist] guildMemberRemove mask failed', { userId: member.id, error });
    }
  });
};
