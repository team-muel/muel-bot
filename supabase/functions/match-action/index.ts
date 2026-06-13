import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, badRequest, withErrorHandling, forbidden } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject, readRequiredString, getMatch } from "../_shared/game.ts";
import { HELPER_ROLES, isDemonKillerRole } from "../_shared/engine/roles.ts";
import { getRoleDefinition } from "../_shared/engine/engine.ts";

// 유효 직업 (2026-06-12): 게임 내 변환(낙인 재배정·타락·전향)은 DB role 컬럼이
// 아니라 engine_state.currentRole 에 영속화된다. 행동 검증을 DB role 로 하면
// 재배정된 새 직업의 능력은 거부되고 옛 능력이 통과한다 — 모든 role 판정은
// 이 함수를 거친다 (엔진 playerStateFromRows 와 동일 규칙).
function effectiveRole(row: { role: string; engine_state?: Record<string, unknown> | null }): string {
  const cur = (row.engine_state as { currentRole?: unknown } | null)?.currentRole;
  return typeof cur === "string" ? cur : row.role;
}

// 부활 계열(SINGLE_DEAD) — 일반 밤 행동과 달리 *탈락자* 를 대상으로 한다.
const REVIVE_ACTIONS = ["mizlet_revive", "helen_revive"];
// 자기 대상(SELF) 행동 — 대상 없이 자기에게 발동. targetUserId 없어도 OK.
const SELF_ACTIONS = ["phantom_eclipse", "besto_shift", "rainer_summon"];

const NIGHT_ACTIONS_BY_ROLE: Record<string, string[]> = {
  // 악마 풀
  demon: ["demon_kill", "daeakma_brand"], // 처치 + 메피스토 낙인(재배정, v2)
  phantom: ["phantom_nightmare", "phantom_seal", "phantom_eclipse"], // 악몽 + 봉인 + 일식(self, v2)
  malen: ["malen_release", "malen_possess"], // 혼령 방출(처치) + 빙의(봉인+카운트, v2)
  besto: ["besto_hidden", "besto_shift"], // 히든 포지션(처치) + 변신(self 조사 회피, v2)
  // 천사 능동
  dordan: ["police_investigate"], // 도르단 = 탐정 조사
  habreterus: ["doctor_heal"],
  mizlet: ["mizlet_revive"], // 디저트 선물 = 탈락자 부활(v2)
  helen: ["helen_revive", "helen_sleep"], // 황금빛 수면 — 탈락자 부활 + 생존자 수면(v2)
  romaz: ["romaz_suspect"],
  rainer: ["rainer_summon"], // 백호 소환(self, 1회) — 천사팀 카운트 획득(v2)
  seika: ["seika_supernova"], // 초신성 = 봉인(v2)
  arthur: ["arthur_emberblade"], // 잔불 대검 = 대상 하루 무적
  luru: ["luru_charm"], // 매료 = 처형 투표 양도
  // 조력자 고유(v2)
  luna: ["luna_corrupt"], // 천사 → 악마팀 변환
  logen: ["logen_nullify"], // 그 밤 대상 능력 무력화(봉인)
  ellen: ["ellen_persecute"], // 박해 — 받는-투표가치 누진
  uno: ["uno_struggle"], // 투쟁 — 대상 소속 카운트 +1
  // 중립
  pasua: ["pasua_convert", "pasua_faith"], // 포교(전향) + 신앙(처치, 악마 면역, v2)
  // 레거시(현 로스터 미배정이나 정의는 유지)
  doctor: ["doctor_heal"],
  police: ["police_investigate"],
};

export function readOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw badRequest("invalid_field", `${key} must be a string.`);
  }
  return value.trim() || null;
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
    const actionType = readRequiredString(body, "actionType"); // night actions, vote, verdict_approve, verdict_reject
    const targetUserId = readOptionalString(body, "targetUserId"); // Can be null for skip vote

    const supabase = getSupabaseAdmin();

    // 1. Get current match and phase
    const match = await getMatch(matchId);
    
    const { data: currentPhase, error: phaseError } = await supabase
      .from("match_phases")
      .select("*")
      .eq("match_id", matchId)
      .is("ended_at", null)
      .order("phase_number", { ascending: false })
      .limit(1)
      .single();

    if (phaseError || !currentPhase) {
      throw conflict("no_active_phase", "현재 활성화된 페이즈가 없습니다.");
    }

    // 2. Validate action against current phase and role
    const { data: player, error: playerError } = await supabase
      .from("match_players")
      .select("role, alive, engine_state")
      .eq("match_id", matchId)
      .eq("user_id", claims.sub)
      .single();

    if (playerError || !player) throw forbidden("not_participant", "게임 참가자가 아닙니다.");
    if (!player.alive) throw forbidden("dead_player", "사망한 플레이어는 행동할 수 없습니다.");

    if (match.status === "night") {
      // H-1: first night skips all abilities (GOMDORI_RULES.firstNight.skipsAbilities);
      // phase-advance discards them anyway, so reject instead of silently accepting.
      if (currentPhase.phase_number === 1) {
        throw conflict("first_night", "첫 번째 밤에는 능력을 사용할 수 없습니다.");
      }
      const actorRole = effectiveRole(player);
      const allowedActions = NIGHT_ACTIONS_BY_ROLE[actorRole] ?? [];
      if (!allowedActions.includes(actionType)) {
        throw forbidden("invalid_role", "현재 직업으로는 이 밤 행동을 사용할 수 없습니다.");
      }
      // maxUses(1회성 능력) 소진 선제 거부 — 최종 강제는 엔진(resolveNightActions,
      // counters.used_*). 여기서 막는 건 "제출됐는데 발동 안 함" UX 혼란 방지용.
      const ability = getRoleDefinition(actorRole)?.actions.night?.find((a) => a.id === actionType);
      if (ability?.maxUses != null) {
        const counters = (player.engine_state as { counters?: Record<string, number> } | null)?.counters;
        if ((counters?.[`used_${actionType}`] ?? 0) >= ability.maxUses) {
          throw conflict("ability_exhausted", "이미 사용한 능력입니다.");
        }
      }
      // 연속 포교 제한(파스아): 직전 밤에 포교했으면 이번 밤 포교 불가(신앙은 가능).
      // convertCooldown 은 엔진이 포교 발동 밤에 1 로 세팅하고 매 밤 1 감소시킨다.
      if (actionType === "pasua_convert") {
        const counters = (player.engine_state as { counters?: Record<string, number> } | null)?.counters;
        if ((counters?.convertCooldown ?? 0) > 0) {
          throw conflict("convert_cooldown", "연속으로 포교할 수 없습니다. 다음 밤에 다시 시도하세요.");
        }
      }
      // 변신(베스토)·일식(팬텀) 등 SELF 행동은 대상 없이 자기에게 발동 — 대상 검증 생략.
      if (!SELF_ACTIONS.includes(actionType)) {
      if (!targetUserId) throw badRequest("missing_target", "대상을 선택해야 합니다.");
      // M-1: 악마 처치(처치/악몽/혼령 방출/히든 포지션)는 자기 자신 불가.
      if (["demon_kill", "phantom_nightmare", "malen_release", "besto_hidden", "pasua_faith"].includes(actionType) && targetUserId === claims.sub) {
        throw badRequest("invalid_target", "자기 자신을 대상으로 지정할 수 없습니다.");
      }
      // 포교·변환·무력화·박해·투쟁·잔불대검·매료·빙의·낙인: 자기 자신 불가.
      if (
        ["pasua_convert", "luna_corrupt", "logen_nullify", "ellen_persecute", "uno_struggle", "arthur_emberblade", "luru_charm", "malen_possess", "daeakma_brand"].includes(actionType) &&
        targetUserId === claims.sub
      ) {
        throw badRequest("invalid_target", "자기 자신을 대상으로 지정할 수 없습니다.");
      }
      const { data: targetState } = await supabase
        .from("match_players")
        .select("alive, role, engine_state")
        .eq("match_id", matchId)
        .eq("user_id", targetUserId)
        .single();
      if (!targetState) throw badRequest("invalid_target", "대상을 찾을 수 없습니다.");
      const targetRole = effectiveRole(targetState);
      if (REVIVE_ACTIONS.includes(actionType)) {
        // 부활(미즐렛/헬렌): 탈락한 대상에게만.
        if (targetState.alive) throw badRequest("invalid_target", "부활은 탈락한 대상에게만 사용할 수 있습니다.");
      } else if (!targetState.alive) {
        // H-4: 그 외 밤 행동은 생존자만 대상으로.
        throw badRequest("dead_target", "이미 사망한 대상은 선택할 수 없습니다.");
      }
      // 포교(파스아): 악마(처치자)·중립 포교 불가(canon §파스아). 가인 등 조력자·천사는 가능.
      // 처치자 집합으로 판정 — 가인/루나 등 조력자는 faction='demon' 이나 처치자가 아니라 허용.
      if (
        actionType === "pasua_convert" &&
        (isDemonKillerRole(targetRole) || targetRole === "pasua" || targetRole === "converted")
      ) {
        throw badRequest("invalid_target", "악마와 중립은 포교할 수 없습니다.");
      }
      // 변환(루나): 천사만. 악마(처치자)·조력자·중립·이미 타락은 불가.
      if (
        actionType === "luna_corrupt" &&
        (isDemonKillerRole(targetRole) ||
          HELPER_ROLES.includes(targetRole) ||
          ["pasua", "converted", "corrupted"].includes(targetRole))
      ) {
        throw badRequest("invalid_target", "천사만 타락시킬 수 있습니다.");
      }
      } // end !SELF_ACTIONS 대상 검증
    } else if (match.status === "vote") {
      if (actionType !== "vote") throw badRequest("invalid_phase", "현재는 투표 페이즈입니다.");
    } else if (match.status === "verdict") {
      if (actionType !== "verdict_approve" && actionType !== "verdict_reject") {
        throw badRequest("invalid_phase", "현재는 찬반 투표 페이즈입니다.");
      }
    } else if (match.status === "night_suspect") {
      // 의심 투표. 대상 null = 기권(무투, canon §3).
      if (actionType !== "suspect") throw badRequest("invalid_phase", "현재는 의심 투표 페이즈입니다.");
    } else {
      throw conflict("invalid_phase", "지금은 행동을 할 수 없는 페이즈입니다.");
    }

    // 3. Calculate instant result if police investigation
    let investigationResult = null;
    if (actionType === "police_investigate" && targetUserId) {
      const { data: target } = await supabase
        .from("match_players")
        .select("role, engine_state")
        .eq("match_id", matchId)
        .eq("user_id", targetUserId)
        .single();

      if (target) {
        // 처치자(악마 풀)만 '악마'로 보인다. 조력자(가인 등)·천사·중립은 '천사'(=악마 아님).
        // 베스토 변신(솔): counters.disguised>0 이면 처치자라도 '천사'로 회피.
        // 직업은 유효 직업(변환 반영) 기준 — 낙인 재배정으로 악마가 된/아니게 된 경우 포함.
        const disguised = ((target.engine_state as { counters?: { disguised?: number } } | null)?.counters?.disguised ?? 0) > 0;
        investigationResult = (isDemonKillerRole(effectiveRole(target)) && !disguised) ? "demon" : "angel";
      }
    }

    // Verdict choices use two action labels, so clear the opposite choice before
    // upsert to preserve one active verdict ballot per player.
    if (actionType === "verdict_approve" || actionType === "verdict_reject") {
      const { error: clearVerdictError } = await supabase
        .from("match_actions")
        .delete()
        .eq("phase_id", currentPhase.id)
        .eq("actor_user_id", claims.sub)
        .in("action_type", ["verdict_approve", "verdict_reject"]);

      if (clearVerdictError) throw clearVerdictError;
    }

    // 4. Insert or update action
    // Upsert so players can change their mind before the phase ends
    const { error: actionError } = await supabase
      .from("match_actions")
      .upsert({
        phase_id: currentPhase.id,
        match_id: matchId,
        actor_user_id: claims.sub,
        action_type: actionType,
        target_user_id: targetUserId,
        result: investigationResult ? { investigationResult } : null,
        submitted_at: new Date().toISOString()
      }, { onConflict: 'phase_id, actor_user_id, action_type' });

    if (actionError) throw actionError;

    return jsonResponse({ success: true, investigationResult }, { origin });
  });
});
