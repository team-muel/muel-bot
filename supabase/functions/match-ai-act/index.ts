import { preflight, jsonResponse } from "../_shared/cors.ts";
import { withErrorHandling } from "../_shared/errors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject } from "../_shared/game.ts";
import {
  effectiveRole,
  NIGHT_ACTIONS_BY_ROLE,
  REVIVE_ACTIONS,
  SELF_ACTIONS,
  submitMatchAction,
} from "../_shared/match-action-core.ts";
import { decideChoice } from "../_shared/ai-decide.ts";

// match-ai-act (ADR-005, Increment 2) — AI 용병의 행동을 채운다.
// 사람과 동일한 검증 코어(submitMatchAction)를 거치고, LLM(MindLogic) 결정은
// best-effort 다. LLM 이 없거나 실패하면 합법 휴리스틱으로 폴백하므로 게임은 항상
// 정상적으로 진행/완주된다. pg_cron(run_phase_advance_loop)이 5초마다 호출한다.

const ACTIVE_AI_PHASES = ["night", "night_suspect", "vote", "verdict"];

type PlayerRow = {
  user_id: string;
  display_name: string;
  role: string;
  faction: string | null;
  alive: boolean;
  is_ai: boolean;
  ai_provider: string | null;
  engine_state: Record<string, unknown> | null;
};

function pick<T>(arr: T[]): T | null {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

function effectiveFaction(row: PlayerRow): string {
  const cur = (row.engine_state as { currentFaction?: unknown } | null)?.currentFaction;
  return typeof cur === "string" ? cur : row.faction ?? "angel";
}

Deno.serve((req: Request) => {
  return withErrorHandling(req, async () => {
    const origin = req.headers.get("Origin");
    const pre = preflight(req);
    if (pre) return pre;

    const supabase = getSupabaseAdmin();
    const body = req.method === "POST"
      ? readJsonObject(await req.json().catch(() => ({})))
      : {};
    const onlyMatchId = typeof body.matchId === "string" ? body.matchId : null;

    // AI 가 있는 활성 매치 추리기.
    let matchQuery = supabase
      .from("matches")
      .select("id, status")
      .in("status", ACTIVE_AI_PHASES);
    if (onlyMatchId) matchQuery = matchQuery.eq("id", onlyMatchId);
    const { data: matches, error: matchErr } = await matchQuery;
    if (matchErr) throw matchErr;

    let acted = 0;
    for (const match of matches ?? []) {
      acted += await processMatch(supabase, match.id, String(match.status));
    }

    return jsonResponse({ success: true, acted }, { origin });
  });
});

async function processMatch(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  matchId: string,
  status: string,
): Promise<number> {
  const { data: phase } = await supabase
    .from("match_phases")
    .select("id, phase_number")
    .eq("match_id", matchId)
    .is("ended_at", null)
    .order("phase_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!phase) return 0;

  // 첫 밤은 능력 없음.
  if (status === "night" && phase.phase_number === 1) return 0;

  const { data: players } = await supabase
    .from("match_players")
    .select("user_id, display_name, role, faction, alive, is_ai, ai_provider, engine_state")
    .eq("match_id", matchId);
  if (!players) return 0;

  const aiPlayers = (players as PlayerRow[]).filter((p) => p.is_ai && p.alive);
  if (aiPlayers.length === 0) return 0;

  const { data: actions } = await supabase
    .from("match_actions")
    .select("actor_user_id, action_type")
    .eq("phase_id", phase.id);
  const actedByActor = new Map<string, Set<string>>();
  for (const a of (actions ?? []) as { actor_user_id: string; action_type: string }[]) {
    if (!actedByActor.has(a.actor_user_id)) actedByActor.set(a.actor_user_id, new Set());
    actedByActor.get(a.actor_user_id)!.add(a.action_type);
  }

  const allPlayers = players as PlayerRow[];
  let count = 0;
  for (const ai of aiPlayers) {
    const did = actedByActor.get(ai.user_id) ?? new Set<string>();
    const ok = await actForAi(supabase, matchId, status, ai, allPlayers, did);
    if (ok) count++;
  }
  return count;
}

async function actForAi(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  matchId: string,
  status: string,
  ai: PlayerRow,
  players: PlayerRow[],
  did: Set<string>,
): Promise<boolean> {
  const aliveOthers = players.filter((p) => p.alive && p.user_id !== ai.user_id);
  const dead = players.filter((p) => !p.alive);
  const selfHint = `너는 '${ai.role}' 직업(${effectiveFaction(ai)} 진영)이다.`;

  const submit = async (actionType: string, targetUserId: string | null): Promise<boolean> => {
    try {
      await submitMatchAction(supabase, { matchId, actorUserId: ai.user_id, actionType, targetUserId });
      return true;
    } catch {
      return false; // 불법/소진 등은 조용히 스킵(게임 진행은 계속)
    }
  };

  // 후보 → LLM 선택(실패 시 휴리스틱). 반환 userId|null.
  const choose = async (
    candidates: PlayerRow[],
    question: string,
    allowSkip: boolean,
    heuristic: () => string | null,
  ): Promise<string | null> => {
    if (candidates.length === 0) return null;
    const res = await decideChoice({
      provider: ai.ai_provider ?? "gemini",
      systemHint: selfHint,
      question,
      candidates: candidates.map((c) => ({ id: c.user_id, label: c.display_name })),
      allowSkip,
    });
    if (res.ok) return res.choice;
    return heuristic();
  };

  if (status === "vote") {
    if (did.has("vote")) return false;
    const target = await choose(
      aliveOthers,
      "낮 투표: 누구를 처형 후보로 지목할까?",
      true,
      () => pick(aliveOthers)?.user_id ?? null, // 휴리스틱: 무작위 지목(게임 수렴)
    );
    return await submit("vote", target);
  }

  if (status === "night_suspect") {
    if (did.has("suspect")) return false;
    const target = await choose(
      aliveOthers,
      "밤 의심 투표: 능력을 봉인할 의심자를 고를까? (기권 가능)",
      true,
      () => null, // 휴리스틱: 기권
    );
    return await submit("suspect", target);
  }

  if (status === "verdict") {
    if (did.has("verdict_approve") || did.has("verdict_reject")) return false;
    const res = await decideChoice({
      provider: ai.ai_provider ?? "gemini",
      systemHint: selfHint,
      question: "처형 찬반 투표: 후보를 처형할까?",
      candidates: [
        { id: "verdict_approve", label: "찬성(처형한다)" },
        { id: "verdict_reject", label: "반대(살린다)" },
      ],
      allowSkip: false,
    });
    const choice = res.ok && res.choice ? res.choice : (Math.random() < 0.5 ? "verdict_approve" : "verdict_reject");
    return await submit(choice, null);
  }

  if (status === "night") {
    const role = effectiveRole(ai);
    const actionType = (NIGHT_ACTIONS_BY_ROLE[role] ?? [])[0];
    if (!actionType) return false; // 밤 능동 능력 없음(예: 시민형)
    if (did.size > 0) return false; // 이미 이번 밤 행동함

    if (SELF_ACTIONS.includes(actionType)) {
      return await submit(actionType, null);
    }
    if (REVIVE_ACTIONS.includes(actionType)) {
      const target = await choose(dead, "부활시킬 탈락자를 고를까?", true, () => pick(dead)?.user_id ?? null);
      return target ? await submit(actionType, target) : false;
    }
    // 처치류는 아군(악마 진영)을 피한다(전략·합법성).
    const killLike = ["demon_kill", "phantom_nightmare", "malen_release", "besto_hidden", "pasua_faith", "arthur_judge"].includes(actionType);
    let candidates = aliveOthers;
    if (killLike && effectiveFaction(ai) === "demon") {
      const nonAllies = aliveOthers.filter((p) => effectiveFaction(p) !== "demon");
      if (nonAllies.length > 0) candidates = nonAllies;
    }
    const target = await choose(
      candidates,
      `밤 능력('${actionType}') 대상을 고르자.`,
      false,
      () => pick(candidates)?.user_id ?? null,
    );
    return target ? await submit(actionType, target) : false;
  }

  return false;
}
