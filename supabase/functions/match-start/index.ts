import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, badRequest, withErrorHandling, forbidden } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString, getMatch } from "../_shared/game.ts";

type RoleCard = { role: string; faction: "angel" | "demon" };

function pushRole(cards: RoleCard[], count: number, role: string, faction: RoleCard["faction"]) {
  for (let i = 0; i < count; i++) cards.push({ role, faction });
}

function generateRoles(playerCount: number): RoleCard[] {
  // W4 v1: 가인/로마즈/라이너는 5인부터 항상 배정(전원이 직업을 받고 시작하는 원안).
  // DB faction 은 'angel' | 'demon' — 가인 등 위장 직업은 role + engine_state 로 표현.
  // 팀 구성:
  //   악마팀 = 악마(1) + 가인(조력자, 1) — 이변이 없으면 항상 2명.
  //   천사팀 = 로마즈(1) + 라이너(1) + 의사(1, 5인+) + 경찰(1, 6인+) + 나머지 시민
  //   중립팀 = 대규모 인원에서 도입 예정(W6, 미구현).
  if (playerCount < 5 || playerCount > 12) {
    throw badRequest("invalid_player_count", "인원은 5명에서 12명 사이여야 합니다.");
  }

  const roles: RoleCard[] = [];
  // 악마팀
  pushRole(roles, 1, "demon", "demon");
  pushRole(roles, 1, "gain", "demon");
  // 천사팀
  pushRole(roles, 1, "romaz", "angel");
  pushRole(roles, 1, "rainer", "angel");
  pushRole(roles, 1, "doctor", "angel");
  pushRole(roles, playerCount >= 6 ? 1 : 0, "police", "angel");
  // 나머지 슬롯은 시민으로 채움
  const remaining = playerCount - roles.length;
  pushRole(roles, remaining, "citizen", "angel");

  // Shuffle roles
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  return roles;
}

function engineStateForAssignment(role: string, hasGain: boolean): Record<string, unknown> | null {
  const counters: Record<string, number> = {};

  if (role === "rainer") {
    // 라이너 백호: 천사팀 카운트 +1, 생존 무관. canon 은 +3 이나, 5인부터 라이너를 항상
    // 배정하므로 전멸 시에도 deadCountBonus 가 악마팀 카운트 이상이면 악마가 영영 못 이긴다.
    // 그래서 v1 은 +1 (악마팀 최소 2 > 1). 표준 인원이 커지면 재상향 검토.
    counters.countBonus = 1;
    counters.deadCountBonus = 1;
  }

  if (hasGain && role === "demon") {
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

    // 1. Assign roles
    const roles = generateRoles(players.length);
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
