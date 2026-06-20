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
  isAi: boolean;
  aiProvider: string | null;
};

// --- AI 용병 플레이어 (ADR-005) ---
// 봇 유저 슬롯 3개 — FK 충족용 고정 행(마이그레이션 20260615120000 가 시드). 모델 정체는
// 매치별 match_players(ai_provider/display_name)에 실린다.
export const AI_BOT_USER_IDS = [
  "aaaa0001-0000-4000-8000-000000000001",
  "aaaa0002-0000-4000-8000-000000000002",
  "aaaa0003-0000-4000-8000-000000000003",
] as const;

export type AiProvider = "chatgpt" | "gemini" | "claude";

export const AI_PROVIDERS: readonly AiProvider[] = ["chatgpt", "gemini", "claude"];

export const AI_PROVIDER_LABEL: Record<AiProvider, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  claude: "Claude",
};

// 한 매치당 최대 AI 수 = 서로 다른 모델 3개.
export const MAX_AI_PLAYERS = AI_PROVIDERS.length;

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
    isAi: Boolean(row.is_ai),
    aiProvider: typeof row.ai_provider === "string" ? row.ai_provider : null,
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

// --- 로비 presence GC (유령 플레이어 정리) ---
// 클라는 30s 마다 하트비트(match-heartbeat → last_seen_at)를 보낸다. Activity 를 닫거나
// 탭/네트워크가 죽으면 best-effort leaveMatch 가 누락돼 match_players row 가 잔류한다(유령).
// last_seen_at 이 TTL 보다 오래되면(=하트비트 끊김) **로비에서만** 솎아낸다. AI 용병은
// 하트비트가 없으므로 GC 대상에서 제외. 진행 중 매치는 절대 건드리지 않는다(게임 무결성 —
// 끊긴 플레이어는 alive/elimination 경로가 담당).
export const LOBBY_PRESENCE_TTL_MS = 90_000;

// 떠난 유저(들) 처리의 단일 경로 — match-leave 와 reconcileLobbyPresence 가 공유한다.
// 호스트가 떠났으면 가장 먼저 들어온 '사람' 참가자에게 위임(AI 에는 절대 위임 안 함).
// 사람이 없으면(AI 만 남음) 로비를 abort. 호스트는 남았지만 테이블이 비면 empty_table abort.
export async function reassignLobbyHostOrAbort(
  matchId: string,
  departedUserIds: string[],
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: matchRow, error: matchErr } = await supabase
    .from("matches")
    .select("host_user_id, status")
    .eq("id", matchId)
    .maybeSingle();
  if (matchErr) throw matchErr;
  if (!matchRow || matchRow.status !== "lobby") return;

  const hostDeparted =
    typeof matchRow.host_user_id === "string" &&
    departedUserIds.includes(matchRow.host_user_id);

  if (hostDeparted) {
    const { data: humans, error: humansErr } = await supabase
      .from("match_players")
      .select("user_id")
      .eq("match_id", matchId)
      .eq("is_ai", false)
      .order("joined_at", { ascending: true })
      .limit(1);
    if (humansErr) throw humansErr;

    const newHostId = humans?.[0]?.user_id as string | undefined;
    if (newHostId) {
      const { error: hostErr } = await supabase
        .from("matches")
        .update({ host_user_id: newHostId })
        .eq("id", matchId)
        .eq("status", "lobby");
      if (hostErr) throw hostErr;
      await supabase
        .from("match_players")
        .update({ is_host: false })
        .eq("match_id", matchId)
        .neq("user_id", newHostId);
      await supabase
        .from("match_players")
        .update({ is_host: true })
        .eq("match_id", matchId)
        .eq("user_id", newHostId);
      await supabase.from("match_events").insert({
        match_id: matchId,
        event_type: "host_changed",
        visibility: "public",
        payload: { hostUserId: newHostId, reason: "host_left" },
      });
      return;
    }

    await supabase
      .from("matches")
      .update({
        status: "aborted",
        abort_reason: "host_left_no_humans",
        ended_at: new Date().toISOString(),
      })
      .eq("id", matchId)
      .eq("status", "lobby");
    return;
  }

  // 빈 테이블 자동 소멸: 로비에서 마지막 플레이어가 빠지면 abort.
  const { count, error: countErr } = await supabase
    .from("match_players")
    .select("user_id", { count: "exact", head: true })
    .eq("match_id", matchId);
  if (countErr) throw countErr;
  if (count === 0) {
    await supabase
      .from("matches")
      .update({
        status: "aborted",
        abort_reason: "empty_table",
        ended_at: new Date().toISOString(),
      })
      .eq("id", matchId);
  }
}

// 로비의 유령 플레이어를 솎아내고(GC) 호스트 공백/빈 테이블을 정리한다. 진행 중 매치는 no-op.
// read/entry 경로(heartbeat·join·list)에서 호출 — 활성 클라가 30s 마다 하트비트를 보내므로
// 로비가 살아있는 한 GC 가 주기적으로 돈다.
export async function reconcileLobbyPresence(matchId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: matchRow, error: matchErr } = await supabase
    .from("matches")
    .select("status")
    .eq("id", matchId)
    .maybeSingle();
  if (matchErr) throw matchErr;
  if (!matchRow || matchRow.status !== "lobby") return;

  const cutoff = new Date(Date.now() - LOBBY_PRESENCE_TTL_MS).toISOString();
  const { data: removed, error: delErr } = await supabase
    .from("match_players")
    .delete()
    .eq("match_id", matchId)
    .eq("is_ai", false)
    .or(`last_seen_at.lt.${cutoff},and(last_seen_at.is.null,joined_at.lt.${cutoff})`)
    .select("user_id");
  if (delErr) throw delErr;
  if (!removed || removed.length === 0) return;

  const departed = removed.map((r) => String(r.user_id));
  for (const userId of departed) {
    await supabase.from("match_events").insert({
      match_id: matchId,
      event_type: "player_left",
      visibility: "public",
      payload: { userId, reason: "presence_timeout" },
    });
  }
  await reassignLobbyHostOrAbort(matchId, departed);
}
