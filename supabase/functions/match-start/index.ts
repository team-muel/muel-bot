import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, badRequest, withErrorHandling, forbidden } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString, getMatch } from "../_shared/game.ts";
import { ANGEL_ROLES, DEMON_KILLER_ROLES, HELPER_ROLES, isDemonKillerRole } from "../_shared/engine/roles.ts";

type RoleCard = { role: string; faction: "angel" | "demon" | "neutral" };

// W6 중립(파스아) 등장 최소 인원. 중립은 천사 머릿수를 1 줄이므로 큰 게임에서만.
const PASUA_MIN_PLAYERS = 8;

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function generateRoles(playerCount: number, includeNeutral = false): RoleCard[] {
  // 기본 로스터(canon "기본" 시트) — "시민(무직)" 폐지, 전원이 명명 직업을 받는다.
  // DB faction 은 'angel' | 'demon' | 'neutral' — 가인 등 위장 직업은 role + engine_state.
  // 팀 구성(canon §1·§21):
  //   악마팀 = 악마 풀에서 1(대악마/팬텀/말렌/베스토) + 조력자 풀에서 1(가인/루나/로건/엘런) = 항상 2.
  //   천사팀 = 나머지 슬롯을 천사 풀에서 distinct 랜덤 추첨(대천사 off, 미포함).
  //   중립팀 = 파스아(1) — includeNeutral 게임 설정 + 8인 이상에서만, 천사 슬롯 1 대체(W6).
  if (playerCount < 5 || playerCount > 12) {
    throw badRequest("invalid_player_count", "인원은 5명에서 12명 사이여야 합니다.");
  }

  const spawnPasua = includeNeutral && playerCount >= PASUA_MIN_PLAYERS;

  const roles: RoleCard[] = [];
  // 악마팀: 악마 1 + 조력자 1 (각 풀에서 랜덤 1)
  roles.push({ role: shuffle(DEMON_KILLER_ROLES)[0], faction: "demon" });
  roles.push({ role: shuffle(HELPER_ROLES)[0], faction: "demon" });
  // 중립(파스아)
  if (spawnPasua) roles.push({ role: "pasua", faction: "neutral" });
  // 천사: 남은 슬롯을 천사 풀에서 distinct 추첨. ANGEL_ROLES(10) 은 12인(악마+조력자 제외 10)까지 커버.
  const angelSlots = playerCount - roles.length;
  for (const role of shuffle(ANGEL_ROLES).slice(0, angelSlots)) {
    roles.push({ role, faction: "angel" });
  }

  return shuffle(roles); // 좌석 순서 무작위화(누가 무엇인지 위치로 새지 않게)
}

function engineStateForAssignment(role: string, hasGain: boolean): Record<string, unknown> | null {
  const counters: Record<string, number> = {};

  if (role === "rainer") {
    // 라이너 백호: 천사팀 카운트 +1, 생존 무관(deadCountBonus). v1 은 +1.
    counters.countBonus = 1;
    counters.deadCountBonus = 1;
  }

  if (role === "uno") {
    // 우노 명예: 생존 시 천사팀 카운트 +1 (canon 은 +10, v1 은 +1).
    counters.countBonus = 1;
  }

  if (role === "arthur") {
    // 아서 여명의 기사: 자기 보호막 1 (밤 살해·처형 1회 무효). canon 탈락 면역의 v1 축약.
    counters.shield = 1;
  }

  if (hasGain && isDemonKillerRole(role)) {
    // 가인(조력자)이 있으면 뽑힌 악마에게 보호막 1.
    counters.shield = 1;
  }

  return Object.keys(counters).length > 0 ? { counters } : null;
}

Deno.serve((req: Request) => {
  return withErrorHandling(req, async () => {
    const origin = req.headers.get("Origin");
    const pre = preflight(req);
    if (pre) return pre;

    if (req.method !== "POST") {
      return jsonResponse(
        { error: { code: "method_not_allowed", message: "POST only." } },
        { status: 405, origin },
      );
    }

    const claims = await requireGameAuth(req);
    const body = readJsonObject(await req.json().catch(() => null));
    const matchId = readRequiredString(body, "matchId");

    const match = await getMatch(matchId);

    if (match.status !== "lobby") {
      throw conflict("invalid_status", "게임이 이미 시작되었거나 로비 상태가 아닙니다.");
    }
    if (match.hostUserId !== claims.sub) {
      throw forbidden("not_host", "방장만 게임을 시작할 수 있습니다.");
    }

    const supabase = getSupabaseAdmin();

    // Check all players are ready
    const { data: players, error: playersError } = await supabase
      .from("match_players")
      .select("user_id, ready, is_host")
      .eq("match_id", matchId);
    
    if (playersError) throw playersError;
    if (!players || players.length < 5 || players.length > 12) {
      throw conflict("invalid_player_count", "인원은 5명 이상 12명 이하여야 합니다.");
    }

    const unreadyPlayers = players.filter((p) => !p.ready && !p.is_host);
    if (unreadyPlayers.length > 0) {
      throw conflict("players_not_ready", "모든 참가자가 준비를 완료해야 합니다.");
    }

    // 1. Assign roles. 중립(파스아) 포함 여부는 로비 게임 설정(matches.settings.includeNeutral).
    const includeNeutral = match.settings?.includeNeutral === true;
    const roles = generateRoles(players.length, includeNeutral);
    const hasGain = roles.some((role) => role.role === "gain");
    const assignments = players.map((p, index) => ({
      user_id: p.user_id,
      role: roles[index].role,
      faction: roles[index].faction,
      engine_state: engineStateForAssignment(roles[index].role, hasGain),
    }));

    // Update match_players roles in a loop (since no bulk update in pure Supabase JS easily without RPC, but we can do it via promise all or rpc. 
    // Actually, we can use `upsert` or individual updates). Let's use individual updates for now or delete/reinsert? No, update is safer.
    await Promise.all(
      assignments.map((a) =>
        supabase
          .from("match_players")
          .update({ role: a.role, faction: a.faction, engine_state: a.engine_state })
          .eq("match_id", matchId)
          .eq("user_id", a.user_id)
      )
    ).then((results) => {
      const failed = results.find((result) => result.error);
      if (failed?.error) throw failed.error;
    });

    // 2. Create phase
    const expectedEndedAt = new Date(Date.now() + 8000).toISOString(); // 8s role_assign (GOMDORI_RULES.phases.roleAssign.durationSec)
    const { data: phase, error: phaseError } = await supabase
      .from("match_phases")
      .insert({
        match_id: matchId,
        phase_number: 1,
        phase_type: "role_assign",
        expected_ended_at: expectedEndedAt,
      })
      .select()
      .single();
    
    if (phaseError) throw phaseError;

    // 3. Update match status
    const { error: matchError } = await supabase
      .from("matches")
      .update({ status: "role_assign", started_at: new Date().toISOString() })
      .eq("id", matchId);
    
    if (matchError) throw matchError;

    // 4. Create events
    const events = [];
    events.push({
      match_id: matchId,
      phase_id: phase.id,
      event_type: "match_started",
      visibility: "public",
      payload: { phase_number: 1, expected_ended_at: expectedEndedAt },
    });

    const demonCircle = assignments.filter((a) => a.faction === "demon");

    for (const assignment of assignments) {
      events.push({
        match_id: matchId,
        phase_id: phase.id,
        event_type: "role_assigned",
        visibility: "private",
        recipient_user_id: assignment.user_id,
        payload: {
          role: assignment.role,
          faction: assignment.faction,
          // demons and helpers get to know their allies
          allies: assignment.faction === "demon" 
            ? demonCircle.filter(d => d.user_id !== assignment.user_id).map(d => ({ user_id: d.user_id, role: d.role }))
            : [],
        },
      });
    }

    const { error: eventsError } = await supabase
      .from("match_events")
      .insert(events);
    
    if (eventsError) throw eventsError;

    return jsonResponse({ success: true, phase }, { origin });
  });
});
