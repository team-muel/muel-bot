/**
 * In-memory ring buffer that captures recent messages per channel.
 * Used to give Muel awareness of ongoing conversation when mentioned.
 */

export type BufferedMessage = {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: number;
  /** Message id this one replies to, if any — used to show who's addressing whom. */
  replyToId?: string;
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

const relativeTime = (ts: number, now: number): string => {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
};

/**
 * Render the recent channel buffer as ambient context for the model.
 *
 * Each line carries a relative timestamp and, when the message is a reply, the
 * person it answers ("말한사람 → 답장상대: 내용"). The leading name is always the
 * *speaker*, not the subject — this addressing structure lets the model tell who
 * is talking to whom instead of binding a topic to whoever typed the line
 * (the speaker↔subject confusion behind the 2026-06-27 misfire). Same token
 * budget, higher signal.
 */
export const formatForContext = (
  channelId: string,
  botId: string,
  limit = 15,
): string => {
  const messages = getRecentMessages(channelId, limit);
  if (messages.length === 0) return '';

  const now = Date.now();
  // id -> speaker, so a reply can name who it answers (when still in buffer).
  const nameById = new Map(messages.map((m) => [m.id, m.authorName]));

  const lines = messages
    .filter((m) => m.authorId !== botId)
    .map((m) => {
      const target = m.replyToId ? nameById.get(m.replyToId) : undefined;
      const who = target ? `${m.authorName} → ${target}` : m.authorName;
      return `[${relativeTime(m.timestamp, now)}] ${who}: ${m.content.slice(0, 200)}`;
    })
    .slice(-10);

  if (lines.length === 0) return '';

  return [
    '--- Recent Channel Activity (앞 이름=화자, → 뒤=답장 상대. 화자는 화제의 대상이 아닐 수 있음) ---',
    ...lines,
    '--- End Activity ---',
  ].join('\n');
};
