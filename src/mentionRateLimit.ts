/**
 * Stage 3.2 — In-memory rate limit + concurrency guard for Discord mentions.
 *
 * Constraints (defaults — adjust via env if needed):
 * - Per user:    6 calls / minute, 200 calls / day
 * - Per channel: 30 calls / minute
 * - Global:      ≤ 8 in-flight generateMuelReply invocations
 *
 * On limit: returns a MentionLimitDecision describing the reason. Caller is
 * responsible for replying to Discord and logging the muel_ai_events row.
 *
 * In-memory only. A multi-instance deployment would need Redis-backed buckets;
 * single Render instance is the current shape.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

const USER_PER_MINUTE = Number(process.env.MUEL_MENTION_USER_PER_MIN ?? 6);
const USER_PER_DAY = Number(process.env.MUEL_MENTION_USER_PER_DAY ?? 200);
const CHANNEL_PER_MINUTE = Number(process.env.MUEL_MENTION_CHANNEL_PER_MIN ?? 30);
const GLOBAL_CONCURRENCY = Number(process.env.MUEL_MENTION_GLOBAL_CONCURRENCY ?? 8);

type UserBucket = {
  minuteWindowStart: number;
  minuteCount: number;
  dayWindowStart: number;
  dayCount: number;
};

type ChannelBucket = {
  minuteWindowStart: number;
  minuteCount: number;
};

const userBuckets = new Map<string, UserBucket>();
const channelBuckets = new Map<string, ChannelBucket>();
let inFlight = 0;

const SWEEP_INTERVAL_MS = 5 * MINUTE_MS;
let lastSweepAt = 0;

const sweep = (now: number): void => {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;

  for (const [key, bucket] of userBuckets.entries()) {
    if (now - bucket.dayWindowStart > DAY_MS + MINUTE_MS) {
      userBuckets.delete(key);
    }
  }
  for (const [key, bucket] of channelBuckets.entries()) {
    if (now - bucket.minuteWindowStart > MINUTE_MS * 5) {
      channelBuckets.delete(key);
    }
  }
};

export type MentionLimitReason =
  | 'rate_limit_user_minute'
  | 'rate_limit_user_day'
  | 'rate_limit_channel_minute'
  | 'global_concurrency';

export type MentionLimitDecision =
  | { allowed: true; release: () => void }
  | { allowed: false; reason: MentionLimitReason; retryHintSeconds: number };

const refreshUserBucket = (userId: string, now: number): UserBucket => {
  let bucket = userBuckets.get(userId);
  if (!bucket) {
    bucket = {
      minuteWindowStart: now,
      minuteCount: 0,
      dayWindowStart: now,
      dayCount: 0,
    };
    userBuckets.set(userId, bucket);
    return bucket;
  }
  if (now - bucket.minuteWindowStart >= MINUTE_MS) {
    bucket.minuteWindowStart = now;
    bucket.minuteCount = 0;
  }
  if (now - bucket.dayWindowStart >= DAY_MS) {
    bucket.dayWindowStart = now;
    bucket.dayCount = 0;
  }
  return bucket;
};

const refreshChannelBucket = (channelId: string, now: number): ChannelBucket => {
  let bucket = channelBuckets.get(channelId);
  if (!bucket) {
    bucket = { minuteWindowStart: now, minuteCount: 0 };
    channelBuckets.set(channelId, bucket);
    return bucket;
  }
  if (now - bucket.minuteWindowStart >= MINUTE_MS) {
    bucket.minuteWindowStart = now;
    bucket.minuteCount = 0;
  }
  return bucket;
};

export const acquireMentionSlot = (args: {
  userId: string;
  channelId: string;
}): MentionLimitDecision => {
  const now = Date.now();
  sweep(now);

  const userBucket = refreshUserBucket(args.userId, now);
  if (userBucket.minuteCount >= USER_PER_MINUTE) {
    const retry = Math.max(1, Math.ceil((MINUTE_MS - (now - userBucket.minuteWindowStart)) / 1000));
    return { allowed: false, reason: 'rate_limit_user_minute', retryHintSeconds: retry };
  }
  if (userBucket.dayCount >= USER_PER_DAY) {
    const retry = Math.max(60, Math.ceil((DAY_MS - (now - userBucket.dayWindowStart)) / 1000));
    return { allowed: false, reason: 'rate_limit_user_day', retryHintSeconds: retry };
  }

  const channelBucket = refreshChannelBucket(args.channelId, now);
  if (channelBucket.minuteCount >= CHANNEL_PER_MINUTE) {
    const retry = Math.max(1, Math.ceil((MINUTE_MS - (now - channelBucket.minuteWindowStart)) / 1000));
    return { allowed: false, reason: 'rate_limit_channel_minute', retryHintSeconds: retry };
  }

  if (inFlight >= GLOBAL_CONCURRENCY) {
    return { allowed: false, reason: 'global_concurrency', retryHintSeconds: 5 };
  }

  userBucket.minuteCount += 1;
  userBucket.dayCount += 1;
  channelBucket.minuteCount += 1;
  inFlight += 1;

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    inFlight = Math.max(0, inFlight - 1);
  };
  return { allowed: true, release };
};

export const formatLimitReplyMessage = (decision: { reason: MentionLimitReason; retryHintSeconds: number }): string => {
  switch (decision.reason) {
    case 'rate_limit_user_minute':
      return `잠깐. 너무 빠르게 부르고 있어. ${decision.retryHintSeconds}초쯤 뒤에 다시 불러줘.`;
    case 'rate_limit_user_day':
      return '오늘 너랑은 이미 충분히 얘기했어. 내일 다시 와줘.';
    case 'rate_limit_channel_minute':
      return '이 채널이 지금 너무 시끄러워. 잠깐 뒤에 다시 불러줘.';
    case 'global_concurrency':
      return '지금 동시에 처리 중인 답이 많아. 잠깐만 기다려줘.';
  }
};

export const getMentionLimitStatus = (): {
  inFlight: number;
  trackedUsers: number;
  trackedChannels: number;
  config: {
    userPerMinute: number;
    userPerDay: number;
    channelPerMinute: number;
    globalConcurrency: number;
  };
} => ({
  inFlight,
  trackedUsers: userBuckets.size,
  trackedChannels: channelBuckets.size,
  config: {
    userPerMinute: USER_PER_MINUTE,
    userPerDay: USER_PER_DAY,
    channelPerMinute: CHANNEL_PER_MINUTE,
    globalConcurrency: GLOBAL_CONCURRENCY,
  },
});
