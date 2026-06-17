import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, badRequest, withErrorHandling, forbidden } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import {
  NEUTRAL_SPAWN_CHANCE,
  type NeutralMode,
  getMatch,
  readJsonObject,
  readRequiredString,
  resolveNeutralMode,
} from "../_shared/game.ts";
import { ANGEL_ROLES, DEMON_KILLER_ROLES, HELPER_ROLES } from "../_shared/engine/roles.ts";
import { GOMDORI_RULES } from "../_shared/gomdori-rules.ts";

// pending: 악마/조력자 슬롯은 role_assign 단계에서 *플레이어가 변종을 선택*한다(canon §5
// 배정 순서 = 악마 → 조력자 → 천사, 각자 자기 직업 선택). 선택 전까지 placeholder role
// (악마='demon', 조력자='gain') + engine_state.pendingSelection 으로 표시. match-select-role
// 가 확정하고, 미선택은 phase-advance(role_assign 만료)가 풀에서 랜덤 폴백한다.
type RoleCard = { role: string; faction: "angel" | "demon" | "neutral"; pending?: "demon" | "helper" };

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

function generateRoles(playerCount: number, neutralMode: NeutralMode = "auto"): RoleCard[] {
  // 기본 로스터(canon "기본" 시트) — "시민(무직)" 폐지, 전원이 명명 직업을 받는다.
  // DB faction 은 'angel' | 'demon' | 'neutral' — 가인 등 위장 직업은 role + engine_state.
  // 팀 구성(canon §1·§21):
  //   악마팀 = 악마 풀에서 1(대악마/팬텀/말렌/베스토) + 조력자 풀에서 1(가인/루나/로건/엘런) = 항상 2.
  //   천사팀 = 나머지 슬롯을 천사 풀에서 distinct 랜덤 추첨(대천사 off, 미포함).
  //   중립팀 = 파스아(1) — 8인 이상에서 천사 슬롯 1 대체(W6). 등장 여부는 확률형(M3-1,
  //   결정 잠금 #2): auto = NEUTRAL_SPAWN_CHANCE 확률(참여자는 존재를 알 수 없다),
  //   on = 강제 등장, off = 제외 — 호스트가 로비 게임 설정으로 오버라이드.
  // 인원 범위는 원본 기준 8~12 (gomdori-rules.playerCount 단일 출처, 2026-06-11 확정).
  if (playerCount < GOMDORI_RULES.playerCount.min || playerCount > GOMDORI_RULES.playerCount.max) {
    throw badRequest(
      "invalid_player_count",
      `인원은 ${GOMDORI_RULES.playerCount.min}명에서 ${GOMDORI_RULES.playerCount.max}명 사이여야 합니다.`,
    );
  }

  const neutralEligible = playerCount >= PASUA_MIN_PLAYERS;
  const spawnPasua = neutralEligible &&
    (neutralMode === "on" ||
      (neutralMode === "auto" && Math.random() < NEUTRAL_SPAWN_CHANCE));

  const roles: RoleCard[] = [];
  // 악마팀: 악마 1 + 조력자 1 — 변종은 role_assign 단계에서 본인이 선택(pending).
  // placeholder role 은 각 풀의 기본(대악마/가인). 미선택 시 phase-advance 가 풀에서 폴백.
  roles.push({ role: "demon", faction: "demon", pending: "demon" });
  roles.push({ role: "gain", faction: "demon", pending: "helper" });
  // 중립(파스아)
  if (spawnPasua) roles.push({ role: "pasua", faction: "neutral" });
  // 천사: 남은 슬롯을 천사 풀에서 distinct 추첨. ANGEL_ROLES(10) 은 12인(악마+조력자 제외 10)까지 커버.
  const angelSlots = playerCount - roles.length;
  for (const role of shuffle(ANGEL_ROLES).slice(0, angelSlots)) {
    roles.push({ role, faction: "angel" });
  }

  return shuffle(roles); // 좌석 순서 무작위화(누가 무엇인지 위치로 새지 않게)
}

function engineStateForAssignment(card: RoleCard): Record<string, unknown> | null {
  // 악마/조력자 슬롯: 변종 선택 대기. 풀을 함께 실어 프론트 선택 UI 와 폴백이 쓴다.
  if (card.pending === "demon") {
    return { pendingSelection: { kind: "demon", pool: DEMON_KILLER_ROLES } };
  }
  if (card.pending === "helper") {
    return { pendingSelection: { kind: "helper", pool: HELPER_ROLES } };
  }

  const counters: Record<string, number> = {};

  // 라이너 백호: v2 에서 자동 주입 폐지 — rainer_summon(1회 self 액션)으로 능동 획득한다.

  if (card.role === "uno") {
    // 우노 명예(canon): 생존 시 천사팀 카운트 +1(canon +10, v1 +1) + 행사 투표가치 +10.
    // voteValueMod +10 은 사탄의 마(전원 -1)를 뚫고 우노의 표를 살린다 — 악마 투표 독점에
    // 맞서는 천사 진영의 표 경로(tally 가 voteValueMod 합산). 명예 실추(밤행동 불가)는 후속.
    counters.countBonus = 1;
    counters.voteValueMod = 10;
  }

  if (card.role === "arthur") {
    // 아서 여명의 기사: 자기 보호막 1 (밤 살해·처형 1회 무효). canon 탈락 면역의 v1 축약.
    counters.shield = 1;
  }

  if (card.role === "phantom") {
    // 팬텀 악몽: 사용 횟수 5회 제한(canon). 발동 1회당 1 소비, 어둠이 내린 도시 0명 지목 밤마다 +2 충전.
    counters.nightmareUses = 5;
  }

  // 가인→악마 보호막은 변종 선택이 끝난 뒤(phase-advance role_assign 만료) 재계산한다.
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
    if (
      !players ||
      players.length < GOMDORI_RULES.playerCount.min ||
      players.length > GOMDORI_RULES.playerCount.max
    ) {
      throw conflict(
        "invalid_player_count",
        `인원은 ${GOMDORI_RULES.playerCount.min}명 이상 ${GOMDORI_RULES.playerCount.max}명 이하여야 합니다.`,
      );
    }

    const unreadyPlayers = players.filter((p) => !p.ready && !p.is_host);
    if (unreadyPlayers.length > 0) {
      throw conflict("players_not_ready", "모든 참가자가 준비를 완료해야 합니다.");
    }

    // 1. Assign roles. 중립(파스아) 등장 모드는 로비 게임 설정(matches.settings.neutral,
    //    레거시 includeNeutral 불리언도 resolveNeutralMode 가 흡수).
    const neutralMode = resolveNeutralMode(match.settings);
    const roles = generateRoles(players.length, neutralMode);
    const assignments = players.map((p, index) => ({
      user_id: p.user_id,
      role: roles[index].role,
      faction: roles[index].faction,
      // match_players.engine_state 는 NOT NULL — 능력 카운터가 없는 직업(uno/arthur 외 천사,
      // 라이너 자동주입 폐지 후 대부분)은 engineStateForAssignment 가 null 을 반환하므로 {} 로
      // 폴백한다. null 을 그대로 UPDATE 하면 NOT NULL 위반 → 게임 시작 500. (2026-06-15 핫픽스)
      engine_state: engineStateForAssignment(roles[index]) ?? {},
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

    // 2. Create phase. role_assign = 변종 선택 단계 — duration 은 rules manifest
    //    단일 출처(하드코딩 30000 제거, 2026-06-12). 미선택은 phase-advance 가 랜덤 폴백.
    const expectedEndedAt = new Date(
      Date.now() + GOMDORI_RULES.phases.roleAssign.durationSec * 1000,
    ).toISOString();
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
          // 접선 정본(2026-06-12): 배정 시점엔 아무도 서로를 모른다. 회로(채팅/통지)는
          // 변종 선택 확정 후 finalizeRoleSelection 이 조력자 패시브(가인·로건)와
          // 팬텀 오버라이드에 따라 연다 — 여기서의 조기 동료 공개는 canon 위반이었고,
          // 변종 확정 전 placeholder 직업을 노출하는 문제도 있었다.
          allies: [],
          // 악마/조력자 슬롯이면 변종 선택 풀을 실어 보낸다(프론트 role_assign 선택 UI).
          pendingSelection:
            (assignment.engine_state as { pendingSelection?: unknown } | null)?.pendingSelection ?? null,
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
