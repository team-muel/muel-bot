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
  // DB-facing faction stays 'angel' | 'demon'. Disguised roles such as gain are
  // represented by role + engine_state, not by a third DB faction.
  // faction: 'angel', 'demon'
  let demon = 1;
  let doctor = 1;
  let police = 1;
  let helper = 0;
  let citizen = 0;

  if (playerCount === 5) { helper = 0; citizen = 2; }
  else if (playerCount === 6) { helper = 1; citizen = 2; }
  else if (playerCount === 7) { helper = 1; citizen = 3; }
  else if (playerCount === 8) { helper = 1; citizen = 4; }
  else if (playerCount === 9) { helper = 2; citizen = 4; }
  else if (playerCount === 10) { helper = 2; citizen = 5; }
  else if (playerCount === 11) { helper = 2; citizen = 6; }
  else if (playerCount === 12) { helper = 2; citizen = 7; }
  else { throw badRequest("invalid_player_count", "인원은 5명에서 12명 사이여야 합니다."); }

  const roles: RoleCard[] = [];
  pushRole(roles, demon, "demon", "demon");

  if (helper > 0) {
    pushRole(roles, 1, "gain", "demon");
    pushRole(roles, helper - 1, "helper", "demon");
  }

  pushRole(roles, doctor, "doctor", "angel");
  pushRole(roles, playerCount >= 7 ? 1 : police, playerCount >= 7 ? "romaz" : "police", "angel");
  pushRole(roles, playerCount >= 8 ? 1 : 0, "rainer", "angel");
  pushRole(roles, playerCount >= 8 ? citizen - 1 : citizen, "citizen", "angel");

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
    // Rainer counts as 3 angel count whether alive or dead.
    counters.countBonus = 2;
    counters.deadCountBonus = 3;
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
    const expectedEndedAt = new Date(Date.now() + 3000).toISOString(); // 3 seconds for role_assign
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
