/**
 * In-memory ring buffer that captures recent messages per channel.
 * Used to give Muel awareness of ongoing conversation when mentioned.
 */

export type BufferedMessage = {
  authorId: string;
  authorName: string;
  content: string;
  timestamp: number;
};

const MAX_PER_CHANNEL = 20;
const MAX_CHANNELS = 50;
const buffers = new Map<string, BufferedMessage[]>();

export const pushMessage = (
  channelId: string,
  msg: BufferedMessage,
): void => {
  let buf = buffers.get(channelId);
  if (!buf) {
    // Evict oldest channel if we hit the cap
    if (buffers.size >= MAX_CHANNELS) {
      const oldest = buffers.keys().next().value;
      if (oldest) buffers.delete(oldest);
    }
    buf = [];
    buffers.set(channelId, buf);
  }

  buf.push(msg);
  if (buf.length > MAX_PER_CHANNEL) {
    buf.shift();
  }
};

export const getRecentMessages = (
  channelId: string,
  limit = 15,
): BufferedMessage[] => {
  const buf = buffers.get(channelId);
  if (!buf || buf.length === 0) return [];
  return buf.slice(-limit);
};

export const formatForContext = (
  channelId: string,
  botId: string,
  limit = 15,
): string => {
  const messages = getRecentMessages(channelId, limit);
  if (messages.length === 0) return '';

  const lines = messages
    .filter((m) => m.authorId !== botId)
    .map((m) => `${m.authorName}: ${m.content.slice(0, 200)}`)
    .slice(-10);

  if (lines.length === 0) return '';

  return [
    '--- Recent Channel Activity ---',
    ...lines,
    '--- End Activity ---',
  ].join('\n');
};
