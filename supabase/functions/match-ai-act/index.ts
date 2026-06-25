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
import { decideChoice, generateChatLine } from "../_shared/ai-decide.ts";

// match-ai-act (ADR-005, Increment 2) — AI 용병의 행동을 채운다.
// 사람과 동일한 검증 코어(submitMatchAction)를 거치고, LLM(MindLogic) 결정은
// best-effort 다. LLM 이 없거나 실패하면 합법 휴리스틱으로 폴백하므로 게임은 항상
// 정상적으로 진행/완주된다. pg_cron(run_phase_advance_loop)이 5초마다 호출한다.
// day(토론): AI 가 채팅으로 한마디 한다(LLM 자유발언, 실패 시 캔드 라인). 토론당 1회.

const ACTIVE_AI_PHASES = ["night", "night_suspect", "vote", "verdict", "day"];

// LLM 실패 시 폴백 발언 — 그래도 "말은 한다". 정체 비노출·범용.
const CANNED_LINES = [
  "음… 아직은 누가 수상한지 확신이 안 서네요.",
  "조용히 있는 사람이 제일 신경 쓰이는데요.",
  "근거 없이 몰아가지는 맙시다. 천천히 봅시다.",
  "어젯밤 정황을 다시 맞춰볼 필요가 있어요.",
  "저는 떳떳합니다. 의심되면 이유를 말해주세요.",
  "표를 급하게 던지면 악마만 이득이에요.",
  "지금까지 행동이 가장 어색한 사람은 누구죠?",
];

// #6b 최후의 반론(처형 후보) 폴백 발언 — LLM 실패 시.
const DEFENSE_LINES = [
  "저는 결백합니다. 진짜 악마는 따로 있어요.",
  "여기서 저를 처형하면 악마만 웃습니다. 다시 생각해 주세요.",
  "근거가 약합니다. 제 행동 어디가 악마였는지 말해보세요.",
  "저를 살리면 다음 밤 진짜 악마가 드러납니다.",
];

// #2 AI 채팅은 항상 인간보다 적게(도배 방지): 이번 페이즈(낮)의 town 메시지를 인간/AI 로 세서
// AI 누적이 인간 누적 이상이면 발화를 보류한다. 인간이 침묵하면 AI 도 침묵한다.
async function aiUnderHumanQuota(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  matchId: string,
  players: PlayerRow[],
  sinceIso: string | null,
): Promise<boolean> {
  let q = supabase.from("match_chats").select("sender_user_id").eq("match_id", matchId).eq("channel", "town");
  if (sinceIso) q = q.gte("created_at", sinceIso);
  const { data } = await q;
  const aiSet = new Set(players.filter((p) => p.is_ai).map((p) => p.user_id));
  let human = 0;
  let ai = 0;
  for (const r of (data ?? []) as { sender_user_id: string }[]) {
    if (aiSet.has(r.sender_user_id)) ai += 1;
    else human += 1;
  }
  return ai < human;
}

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
    .select("id, phase_number, started_at")
    .eq("match_id", matchId)
    .is("ended_at", null)
    .order("phase_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!phase) return 0;

  // #6b 최후의 반론 후보(AI면 발언시킴) — matches.engine_state.verdict.candidateUserId.
  let verdictCandidateId: string | null = null;
  if (status === "verdict") {
    const { data: m } = await supabase.from("matches").select("engine_state").eq("id", matchId).maybeSingle();
    const v = (m?.engine_state as { verdict?: { candidateUserId?: string | null } } | null)?.verdict;
    verdictCandidateId = typeof v?.candidateUserId === "string" ? v.candidateUserId : null;
  }

  // (2026-06-15) 첫 밤도 능력 사용 — 과거 night phase_number===1 스킵 제거(첫밤 활성화 동기).

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
    const ok = await actForAi(supabase, matchId, status, ai, allPlayers, did, phase.id, phase.started_at ?? null, verdictCandidateId);
    if (ok) count++;
    // 도배 방지(2026-06-17): 낮 토론은 tick 당 AI 1명만 발화시켜 분산한다. 나머지 AI 는 다음
    // tick 에서 한 명씩 발화 → 휴먼이 끼어들 틈이 생기고 AI 채팅이 한꺼번에 쏟아지지 않는다.
    // (밤 행동은 cap 없음 — 각 AI 가 그 페이즈에 능력/투표를 제출해야 게임이 진행된다.)
    if (status === "day" && ok) break;
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
  phaseId: string,
  phaseStartedAt: string | null,
  verdictCandidateId: string | null,
): Promise<boolean> {
  const aliveOthers = players.filter((p) => p.alive && p.user_id !== ai.user_id);
  const dead = players.filter((p) => !p.alive);
  const selfHint = `너는 '${ai.role}' 직업(${effectiveFaction(ai)} 진영)이다.`;

  // 낮 토론: AI 가 채팅으로 한마디 한다(LLM 자유발언, 실패 시 캔드). 토론(=이 day 페이즈)당 1회.
  if (status === "day") {
    if (did.has("ai_day_chat")) return false;
    // #2 AI 채팅은 항상 인간보다 적게 — 이번 낮 town 누적이 인간 이상이면 발화 보류(도배 방지).
    if (!(await aiUnderHumanQuota(supabase, matchId, players, phaseStartedAt))) return false;
    const aliveNames = aliveOthers.map((p) => p.display_name).join(", ") || "없음";
    const deadNames = dead.map((p) => p.display_name).join(", ") || "없음";
    const context = `생존자: ${aliveNames}. 탈락자: ${deadNames}. 지금은 낮 토론 — 마을은 악마를 찾아 처형하려 한다.`;
    const res = await generateChatLine({ provider: ai.ai_provider ?? "gemini", systemHint: selfHint, context });
    const text = (res.ok ? res.text : (pick(CANNED_LINES) ?? "…")).slice(0, 2000);
    try {
      await supabase.from("match_chats").insert({ match_id: matchId, channel: "town", sender_user_id: ai.user_id, message: text });
      // 토론당 1회 가드 마커(게임 액션 아님). action_type CHECK 에 ai_day_chat 추가됨.
      await supabase.from("match_actions").insert({ phase_id: phaseId, match_id: matchId, actor_user_id: ai.user_id, action_type: "ai_day_chat", target_user_id: null, submitted_at: new Date().toISOString() });
      return true;
    } catch {
      return false;
    }
  }

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
    // #6b 후보 AI 는 최후의 반론을 한 번 발언한다(채팅 마커는 ai_day_chat 재사용 — 페이즈별이라
    // 낮 발언과 겹치지 않는다). 발언 후 아래 찬반 표결을 그대로 진행한다.
    if (verdictCandidateId === ai.user_id && !did.has("ai_day_chat")) {
      const dres = await generateChatLine({
        provider: ai.ai_provider ?? "gemini",
        systemHint: selfHint,
        context: "너는 지금 처형 후보로 최후의 반론 차례다. 살아남기 위해 결백을 짧고 설득력 있게 호소하라.",
      });
      const dtext = (dres.ok ? dres.text : (pick(DEFENSE_LINES) ?? "저는 결백합니다.")).slice(0, 2000);
      try {
        await supabase.from("match_chats").insert({ match_id: matchId, channel: "town", sender_user_id: ai.user_id, message: dtext });
        await supabase.from("match_actions").insert({ phase_id: phaseId, match_id: matchId, actor_user_id: ai.user_id, action_type: "ai_day_chat", target_user_id: null, submitted_at: new Date().toISOString() });
        did.add("ai_day_chat");
      } catch { /* 발언 실패는 무시 — 표결은 계속 */ }
    }
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
    const killLike = ["demon_kill", "phantom_nightmare", "malen_release", "pasua_faith", "arthur_judge"].includes(actionType);
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
