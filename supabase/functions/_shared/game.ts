import { badRequest, notFound } from "./errors.ts";
import { getSupabaseAdmin } from "./supabase-admin.ts";

export type MatchSummary = {
  id: string;
  status: string;
  hostUserId: string | null;
  contextType: string;
  contextId: string | null;
  maxPlayers: number;
  winner: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  // 로비 게임 설정(jsonb). 예: { includeNeutral: true } → 파스아(중립) 등장.
  // 토글 UI 는 후속(로비 설정 UI). 기본 미설정 = 비활성.
  settings: Record<string, unknown>;
  tableLabel: string;
  engineState: Record<string, unknown> | null;
};

export type PlayerSummary = {
  matchId: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  alive: boolean;
  ready: boolean;
  isHost: boolean;
  joinedAt: string;
  lastSeenAt: string | null;
  role: string | null;
  faction: string | null;
};

// --- 중립(파스아) 등장 모드 (M3-1, 결정 잠금 #2) ---
// 기본은 "auto" = 존재 여부를 알 수 없는 확률 스폰. 호스트는 로비 게임 설정에서
// "on"(강제 등장) / "off"(제외) 로 오버라이드할 수 있다(대규모 인원 UI).
export type NeutralMode = "auto" | "on" | "off";

export const NEUTRAL_MODES: readonly NeutralMode[] = ["auto", "on", "off"];

// auto 모드에서 적격 인원일 때 중립이 실제로 등장할 확률.
// 0.5 = "있는지 없는지 모른다"를 전략적으로 최대화. 수치 튜닝은 후속(결정 잠금 #5).
export const NEUTRAL_SPAWN_CHANCE = 0.5;

export function resolveNeutralMode(settings: Record<string, unknown>): NeutralMode {
  const raw = settings.neutral;
  if (typeof raw === "string" && (NEUTRAL_MODES as readonly string[]).includes(raw)) {
    return raw as NeutralMode;
  }
  // 레거시 호환: 구 includeNeutral 불리언이 명시돼 있으면 의도를 보존한다.
  if (settings.includeNeutral === true) return "on";
  if (settings.includeNeutral === false) return "off";
  return "auto";
}

export function readJsonObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("invalid_json", "Expected a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function readRequiredString(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest("missing_field", `${key} is required.`);
  }
  return value.trim();
}

export function toMatchSummary(row: Record<string, unknown>): MatchSummary {
  return {
    id: String(row.id),
    status: String(row.status),
    hostUserId: typeof row.host_user_id === "string" ? row.host_user_id : null,
    contextType: String(row.context_type),
    contextId: typeof row.context_id === "string" ? row.context_id : null,
    maxPlayers: Number(row.max_players),
    winner: typeof row.winner === "string" ? row.winner : null,
    createdAt: String(row.created_at),
    startedAt: typeof row.started_at === "string" ? row.started_at : null,
    endedAt: typeof row.ended_at === "string" ? row.ended_at : null,
    settings:
      row.settings && typeof row.settings === "object" && !Array.isArray(row.settings)
        ? (row.settings as Record<string, unknown>)
        : {},
    tableLabel: typeof row.table_label === "string" ? row.table_label : "",
    engineState:
      row.engine_state && typeof row.engine_state === "object" && !Array.isArray(row.engine_state)
        ? (row.engine_state as Record<string, unknown>)
        : null,
  };
}

export function toPlayerSummary(row: Record<string, unknown>): PlayerSummary {
  return {
    matchId: String(row.match_id),
    userId: String(row.user_id),
    displayName: String(row.display_name),
    avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null,
    alive: Boolean(row.alive),
    ready: Boolean(row.ready),
    isHost: Boolean(row.is_host),
    joinedAt: String(row.joined_at),
    lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : null,
    role: typeof row.role === "string" ? row.role : null,
    faction: typeof row.faction === "string" ? row.faction : null,
  };
}

export async function findOpenMatchByDiscordChannel(
  discordChannelId: string,
): Promise<MatchSummary | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("matches")
    .select("*")
    .eq("context_type", "discord_voice")
    .eq("context_id", discordChannelId)
    .in("status", ["lobby", "role_assign", "night", "night_resolve", "day", "vote", "verdict"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data ? toMatchSummary(data as Record<string, unknown>) : null;
}

export async function findOpenMatchByInstance(
  instanceId: string,
): Promise<MatchSummary | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("matches")
    .select("*")
    .eq("instance_id", instanceId)
    .in("status", ["lobby", "role_assign", "night", "night_resolve", "day", "vote", "verdict"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data ? toMatchSummary(data as Record<string, unknown>) : null;
}

export async function getMatch(matchId: string): Promise<MatchSummary> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("matches")
    .select("*")
    .eq("id", matchId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound("match_not_found", "Match not found.");
  return toMatchSummary(data as Record<string, unknown>);
}

export async function getGameUser(userId: string): Promise<{
  id: string;
  displayName: string;
  avatarUrl: string | null;
}> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("users")
    .select("id, display_name, avatar_url")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound("user_not_found", "Game user not found.");
  return {
    id: String(data.id),
    displayName: String(data.display_name),
    avatarUrl: typeof data.avatar_url === "string" ? data.avatar_url : null,
  };
}

export async function findMyActiveMatch(
  userId: string,
  discordChannelId: string,
  instanceId: string | null,
): Promise<MatchSummary | null> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("matches")
    .select("*, match_players!inner(*)")
    .eq("match_players.user_id", userId)
    .not("status", "in", '("ended","aborted")');

  if (instanceId) {
    query = query.eq("instance_id", instanceId);
  } else {
    query = query.eq("context_type", "discord_voice").eq("context_id", discordChannelId);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? toMatchSummary(data as Record<string, unknown>) : null;
}

export async function getNextTableNumber(
  contextType: string,
  contextId: string,
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("next_table_number", {
    p_context_type: contextType,
    p_context_id: contextId,
  });
  if (error) throw error;
  return Number(data ?? 1);
}
