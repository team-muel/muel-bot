import type { Client, GuildTextBasedChannel, Message } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logMuelAgentAction } from './agentActions.js';

// Muel 프로액티브(먼저 말 걸기). 침묵이 기본 — 옵트인 채널에서만, 강한 가드레일.
const TICK_MS = 15 * 60_000;
const MORNING_HOUR = 8;            // KST 08:00~08:59 아침 인사
const QUIET_START_HOUR = 23;       // 23:00~07:59 KST 무발화
const QUIET_END_HOUR = 8;
const SPIKE_MIN_INTERVAL_MS = 4 * 60 * 60_000; // 채널당 스파이크 최소 간격

const MORNING_LINES = [
  '좋은 아침. 오늘도 여기 있어.',
  '아침이야. 다들 잘 잤어?',
  '굿모닝. 재밌는 거 있으면 풀어봐.',
  '아침. 천천히 시작하자.',
];
const SPIKE_LINES = [
  '갑자기 북적이네, 무슨 일이야?',
  '오 다들 모였네. 뭔 얘기 중이야?',
  '분위기 올라왔다. 나도 껴도 돼?',
];
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

function kstNow(): { hour: number; date: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return { hour, date: `${parts.year}-${parts.month}-${parts.day}` };
}
const isQuietHour = (h: number): boolean => h >= QUIET_START_HOUR || h < QUIET_END_HOUR;

async function postLine(channel: GuildTextBasedChannel, text: string): Promise<boolean> {
  try {
    await channel.send({ content: text, allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    console.warn('[proactive] post failed', err instanceof Error ? err.message : String(err));
    return false;
  }
}

// communityFlow 볼륨 스파이크에서 호출. 옵트인 + 쿨다운 + 콰이엇아워 통과 시 가벼운 한 줄.
export const maybeSpeakOnSpike = async (
  supabase: SupabaseClient,
  message: Message,
): Promise<void> => {
  if (!message.guildId) return;
  if (isQuietHour(kstNow().hour)) return;

  const { data } = await supabase
    .from('muel_proactive_configs')
    .select('enabled, spike, last_spoke_at')
    .eq('guild_id', message.guildId)
    .eq('channel_id', message.channelId)
    .maybeSingle();
  const cfg = data as { enabled: boolean; spike: boolean; last_spoke_at: string | null } | null;
  if (!cfg || !cfg.enabled || !cfg.spike) return;
  if (cfg.last_spoke_at && Date.now() - new Date(cfg.last_spoke_at).getTime() < SPIKE_MIN_INTERVAL_MS) return;

  const channel = message.channel;
  if (!channel.isTextBased() || !('send' in channel)) return;

  const ok = await postLine(channel as GuildTextBasedChannel, pick(SPIKE_LINES));
  if (!ok) return;
  await supabase
    .from('muel_proactive_configs')
    .update({ last_spoke_at: new Date().toISOString() })
    .eq('guild_id', message.guildId)
    .eq('channel_id', message.channelId);
  await logMuelAgentAction(supabase, {
    triggerSource: 'proactive',
    triggerDetail: 'spike',
    status: 'responded',
    discordGuildId: message.guildId,
    discordChannelId: message.channelId,
    metadata: {},
  });
};

// 아침 인사 틱: KST 아침 시간대, 길드당 1회, 가장 최근 활성 옵트인 채널에만.
const runMorningTick = async (client: Client, supabase: SupabaseClient): Promise<void> => {
  const { hour, date } = kstNow();
  if (hour !== MORNING_HOUR) return;

  const { data } = await supabase
    .from('muel_proactive_configs')
    .select('guild_id, channel_id')
    .eq('enabled', true)
    .eq('morning', true);
  const configs = (data ?? []) as Array<{ guild_id: string; channel_id: string }>;
  if (configs.length === 0) return;

  const byGuild = new Map<string, string[]>();
  for (const c of configs) {
    const arr = byGuild.get(c.guild_id) ?? [];
    arr.push(c.channel_id);
    byGuild.set(c.guild_id, arr);
  }

  for (const [guildId, channelIds] of byGuild) {
    const { data: st } = await supabase
      .from('muel_proactive_guild_state')
      .select('last_morning_date')
      .eq('guild_id', guildId)
      .maybeSingle();
    if ((st as { last_morning_date?: string } | null)?.last_morning_date === date) continue;

    let best: GuildTextBasedChannel | null = null;
    let bestTs = -1;
    for (const cid of channelIds) {
      const ch = await client.channels.fetch(cid).catch(() => null);
      if (!ch || !ch.isTextBased() || !('send' in ch)) continue;
      const tc = ch as GuildTextBasedChannel;
      const lastTs = tc.lastMessage?.createdTimestamp
        ?? (tc.lastMessageId ? Number((BigInt(tc.lastMessageId) >> 22n)) + 1420070400000 : 0);
      if (lastTs > bestTs) { bestTs = lastTs; best = tc; }
    }
    if (!best) continue;

    const ok = await postLine(best, pick(MORNING_LINES));
    if (!ok) continue;
    await supabase
      .from('muel_proactive_guild_state')
      .upsert({ guild_id: guildId, last_morning_date: date, updated_at: new Date().toISOString() }, { onConflict: 'guild_id' });
    await supabase
      .from('muel_proactive_configs')
      .update({ last_spoke_at: new Date().toISOString() })
      .eq('guild_id', guildId)
      .eq('channel_id', best.id);
    await logMuelAgentAction(supabase, {
      triggerSource: 'proactive',
      triggerDetail: 'morning',
      status: 'responded',
      discordGuildId: guildId,
      discordChannelId: best.id,
      metadata: {},
    });
  }
};

export const startProactiveScheduler = (client: Client, supabase: SupabaseClient): void => {
  const tick = () => {
    void runMorningTick(client, supabase).catch((e) => console.warn('[proactive] tick failed', e));
  };
  setInterval(tick, TICK_MS);
  setTimeout(tick, 30_000);
};