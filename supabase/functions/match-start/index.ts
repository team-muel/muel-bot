import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, badRequest, withErrorHandling, forbidden } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString, getMatch } from "../_shared/game.ts";

// 라이너 백호 카운트 가산. canon = +3; v1 은 저인원 안전을 위해 +1 (라이브 튜닝 대상).
const RAINER_COUNT_BONUS = 1;

function generateRoles(playerCount: number): Array<{ role: string; faction: string }> {
  // W4 v1 트랜치: 라이너(천사,카운트+)·로마즈(천사,용의자색출)·가인(조력자,악마보호).
  // 5인 = 라이브 쇼케이스(가인 포함, demon-team 2). 6+ = helper 1개→가인, citizen 2개→라이너/로마즈 치환.
  // 팀 머릿수는 기존 분포와 동일 — 가인↔helper, 라이너/로마즈↔citizen 1:1 치환.
  const roles: Array<{ role: string; faction: string }> = [];
  const add = (role: string, faction: string, n = 1) => {
    for (let i = 0; i < n; i++) roles.push({ role, faction });
  };

  if (playerCount === 5) {
    add('demon', 'demon');
    add('gain', 'demon');
    add('romaz', 'angel');
    add('rainer', 'angel');
    add('doctor', 'angel');
  } else {
    let helper = 0;
    let citizen = 0;
    if (playerCount === 6) { helper = 1; citizen = 2; }
    else if (playerCount === 7) { helper = 1; citizen = 3; }
    else if (playerCount === 8) { helper = 1; citizen = 4; }
    else if (playerCount === 9) { helper = 2; citizen = 4; }
    else if (playerCount === 10) { helper = 2; citizen = 5; }
    else if (playerCount === 11) { helper = 2; citizen = 6; }
    else if (playerCount === 12) { helper = 2; citizen = 7; }
    else { throw badRequest("invalid_player_count", "인원은 5명에서 12명 사이여야 합니다."); }

    add('demon', 'demon');
    add('gain', 'demon');                  // helper 1개 → 가인
    add('helper', 'demon', helper - 1);    // 나머지 helper
    add('doctor', 'angel');
    add('police', 'angel');
    add('rainer', 'angel');                // citizen 1개 → 라이너
    add('romaz', 'angel');                 // citizen 1개 → 로마즈
    add('citizen', 'angel', citizen - 2);  // 나머지 시민
  }

  // Shuffle roles
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  return roles;
}

// 직업별 초기 engine_state. 라이너=백호 카운트, 가인=악마 보호막(악마 본인에게 주입).
function initEngineState(role: string, gainPresent: boolean): Record<string, unknown> | null {
  if (role === 'rainer') {
    return { counters: { countBonus: RAINER_COUNT_BONUS, deadCountBonus: RAINER_COUNT_BONUS } };
  }
  if (role === 'demon' && gainPresent) {
    return { counters: { shield: 1 } };
  }
  return null;
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
    const assignments = players.map((p, index) => ({
      user_id: p.user_id,
      role: roles[index].role,
      faction: roles[index].faction,
    }));

    // 가인이 배정됐으면 악마 본인에게 보호막을 주입한다.
    const gainPresent = assignments.some((a) => a.role === "gain");

    // Update match_players roles + 초기 engine_state (라이너 카운트, 가인→악마 보호막).
    await Promise.all(
      assignments.map((a) =>
        supabase
          .from("match_players")
          .update({ role: a.role, faction: a.faction, engine_state: initEngineState(a.role, gainPresent) })
          .eq("match_id", matchId)
          .eq("user_id", a.user_id)
      )
    );

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
