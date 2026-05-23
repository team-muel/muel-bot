import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Hub channel allowlist with in-memory cache.
 *
 * Hub channels are channels where Muel can respond without explicit @-mention.
 * Activation/deactivation is per channel, gated by ManageChannels permission
 * via the /허브 slash command. Storage is in muel_hub_channels.
 *
 * Per-channel tuning: muel_hub_channels.responsive_confidence_min adjusts the
 * router-confidence threshold needed for that channel to auto-respond. The
 * cache stores the threshold so the chat path doesn't hit DB on every message.
 *
 * Default threshold is 0.6 (matches the previous global constant). Admins can
 * tune per channel via SQL:
 *   update muel_hub_channels
 *     set responsive_confidence_min = 0.75
 *     where guild_id = ... and channel_id = ...;
 */

type HubKey = string; // `${guildId}:${channelId}`

const DEFAULT_RESPONSIVE_CONFIDENCE_MIN = 0.6;

export type HubChannelConfig = {
  responsiveConfidenceMin: number;
};

const CACHE_TTL_MS = 5 * 60_000;
let cache = new Map<HubKey, HubChannelConfig>();
let lastFullLoadAt = 0;
let loadingPromise: Promise<void> | null = null;

const makeKey = (guildId: string, channelId: string): HubKey => `${guildId}:${channelId}`;

const refreshCache = async (supabase: SupabaseClient): Promise<void> => {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const { data, error } = await supabase
      .from('muel_hub_channels')
      .select('guild_id, channel_id, responsive_confidence_min');
    if (error) {
      console.warn('[hub] cache refresh failed', error);
      return;
    }
    const next = new Map<HubKey, HubChannelConfig>();
    for (const row of data ?? []) {
      const min = typeof row.responsive_confidence_min === 'number' && Number.isFinite(row.responsive_confidence_min)
        ? row.responsive_confidence_min
        : DEFAULT_RESPONSIVE_CONFIDENCE_MIN;
      next.set(makeKey(row.guild_id, row.channel_id), { responsiveConfidenceMin: min });
    }
    cache = next;
    lastFullLoadAt = Date.now();
  })().finally(() => {
    loadingPromise = null;
  });
  return loadingPromise;
};

const refreshCacheIfStale = async (supabase: SupabaseClient): Promise<void> => {
  if (Date.now() - lastFullLoadAt < CACHE_TTL_MS) return;
  await refreshCache(supabase);
};

export const isHubChannelActive = async (
  supabase: SupabaseClient,
  args: { guildId: string; channelId: string },
): Promise<boolean> => {
  try {
    await refreshCacheIfStale(supabase);
  } catch (error) {
    console.warn('[hub] cache stale-check failed', error);
  }
  return cache.has(makeKey(args.guildId, args.channelId));
};

export const getHubChannelConfig = async (
  supabase: SupabaseClient,
  args: { guildId: string; channelId: string },
): Promise<HubChannelConfig | null> => {
  try {
    await refreshCacheIfStale(supabase);
  } catch (error) {
    console.warn('[hub] cache stale-check failed', error);
  }
  return cache.get(makeKey(args.guildId, args.channelId)) ?? null;
};

export const listHubChannels = async (
  supabase: SupabaseClient,
  args: { guildId: string },
): Promise<Array<{ channelId: string; activatedAt: string; activatedByUsername: string | null; responsiveConfidenceMin: number }>> => {
  const { data, error } = await supabase
    .from('muel_hub_channels')
    .select('channel_id, activated_at, activated_by_discord_username, responsive_confidence_min')
    .eq('guild_id', args.guildId)
    .order('activated_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    channelId: row.channel_id,
    activatedAt: row.activated_at,
    activatedByUsername: row.activated_by_discord_username ?? null,
    responsiveConfidenceMin: typeof row.responsive_confidence_min === 'number' && Number.isFinite(row.responsive_confidence_min)
      ? row.responsive_confidence_min
      : DEFAULT_RESPONSIVE_CONFIDENCE_MIN,
  }));
};

export const activateHubChannel = async (
  supabase: SupabaseClient,
  args: {
    guildId: string;
    channelId: string;
    activatedByUserId: string;
    activatedByUsername: string;
  },
): Promise<void> => {
  const { error } = await supabase
    .from('muel_hub_channels')
    .upsert(
      {
        guild_id: args.guildId,
        channel_id: args.channelId,
        activated_at: new Date().toISOString(),
        activated_by_discord_user_id: args.activatedByUserId,
        activated_by_discord_username: args.activatedByUsername,
      },
      { onConflict: 'guild_id,channel_id' },
    );
  if (error) throw error;
  const existing = cache.get(makeKey(args.guildId, args.channelId));
  cache.set(makeKey(args.guildId, args.channelId), {
    responsiveConfidenceMin: existing?.responsiveConfidenceMin ?? DEFAULT_RESPONSIVE_CONFIDENCE_MIN,
  });
};

export const deactivateHubChannel = async (
  supabase: SupabaseClient,
  args: { guildId: string; channelId: string },
): Promise<void> => {
  const { error } = await supabase
    .from('muel_hub_channels')
    .delete()
    .eq('guild_id', args.guildId)
    .eq('channel_id', args.channelId);
  if (error) throw error;
  cache.delete(makeKey(args.guildId, args.channelId));
};

export const getHubChannelStatus = (): {
  cachedChannelCount: number;
  lastFullLoadAt: string | null;
} => ({
  cachedChannelCount: cache.size,
  lastFullLoadAt: lastFullLoadAt > 0 ? new Date(lastFullLoadAt).toISOString() : null,
});
