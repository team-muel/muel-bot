import { EmbedBuilder, ThreadAutoArchiveDuration } from 'discord.js';
import { splitForDiscord } from './discordText.js';
import { DISCORD_LIMITS, DISCORD_SAFE } from './discordLimits.js';
import { MUEL_BRAND_COLOR } from '../uiColors.js';

/** A Discord message we can open a thread off of (structural — testable). */
type ThreadableMessage = {
  startThread?: (options: {
    name: string;
    autoArchiveDuration: ThreadAutoArchiveDuration;
    reason?: string;
  }) => Promise<{ send: (payload: { embeds: EmbedBuilder[] }) => Promise<unknown> }>;
};

/** Minimal shape of a channel we can post plain follow-up messages to. */
type ChannelSend = {
  send?: (payload: { content: string; allowedMentions?: { parse: never[] } }) => Promise<unknown>;
};

/**
 * Move overflow text into a thread off `message`, rendered as EMBEDS (not raw
 * text) so long continuations stay readable and branded. The body is split
 * URL-safely; nothing is dropped. Returns true if a thread was created.
 */
export const postOverflowToThread = async (
  message: ThreadableMessage,
  name: string,
  body: string,
  opts: { color?: number; reason?: string; footer?: string } = {},
): Promise<boolean> => {
  if (typeof message.startThread !== 'function') return false;
  const chunks = splitForDiscord(body, DISCORD_SAFE.infoDescription);
  if (chunks.length === 0) return false;

  try {
    const thread = await message.startThread({
      name: (name || '이어서').slice(0, 90),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: opts.reason ?? 'Muel overflow thread',
    });
    for (let i = 0; i < chunks.length; i += 1) {
      const embed = new EmbedBuilder()
        .setColor(opts.color ?? MUEL_BRAND_COLOR)
        .setDescription(chunks[i]!);
      if (opts.footer && i === chunks.length - 1) {
        embed.setFooter({ text: opts.footer.slice(0, DISCORD_LIMITS.embedFooter) });
      }
      await thread.send({ embeds: [embed] });
    }
    return true;
  } catch (error) {
    console.warn('[discord] overflow thread failed', error);
    return false;
  }
};

/**
 * Deliver reply overflow without dropping content. `anchor` is the already-sent
 * first reply. Up to `maxInline` extra chunks are posted as normal follow-up
 * messages; anything beyond that moves into a thread (as embeds) so the channel
 * isn't flooded.
 */
export const deliverOverflowChunks = async (
  message: { channel?: unknown },
  anchor: ThreadableMessage,
  rest: string[],
  opts: { maxInline?: number; threadName?: string; color?: number } = {},
): Promise<void> => {
  if (rest.length === 0) return;
  const maxInline = opts.maxInline ?? 2;
  const channel = message.channel as ChannelSend | undefined;

  if (rest.length <= maxInline && typeof channel?.send === 'function') {
    for (const chunk of rest) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
    return;
  }

  await postOverflowToThread(anchor, opts.threadName ?? '이어서', rest.join('\n\n'), {
    color: opts.color,
  });
};
