import type { Message } from 'discord.js';

/**
 * Visual lifecycle markers Muel leaves on a Discord message it processed.
 * Reactions are an ambient signal — they show what Muel did with a message
 * without requiring a chat reply for the bookkeeping.
 *
 * Legend (canonical):
 *   👀  REACTION_SEEN     — Muel started processing this message.
 *   ❓  REACTION_QUESTION — Router classified this as a question-like intent.
 *   ✅  REACTION_DONE     — Muel produced a response successfully.
 *   📌  REACTION_PINNED   — Muel marked this as noteworthy (reserved; no
 *                           automatic trigger yet — kept for manual or
 *                           policy-driven flagging in a later step).
 *
 * Reaction failures (missing permission, Discord rate limit) are swallowed so
 * the chat path stays robust. Enabling/disabling is env-gated; default true.
 */
const ENABLED = (process.env.MUEL_REACTION_TAGGING_ENABLED ?? 'true').trim().toLowerCase() !== 'false';

export const REACTION_SEEN = '👀';
export const REACTION_QUESTION = '❓';
export const REACTION_DONE = '✅';
export const REACTION_PINNED = '📌';

export const tagMessage = async (message: Message, emoji: string): Promise<void> => {
  if (!ENABLED) return;
  try {
    await message.react(emoji);
  } catch (error) {
    console.warn('[reactions] react failed', {
      emoji,
      channelId: message.channelId,
      messageId: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const isReactionTaggingEnabled = (): boolean => ENABLED;
