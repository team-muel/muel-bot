import { preflight, jsonResponse } from "../_shared/cors.ts";
import { withErrorHandling } from "../_shared/errors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import {
  TAG_SUSPECTED,
  checkTimeoutWinner,
  checkWinCondition,
  resolveNightActions,
  resolveNightmares,
  tallyEliminationVotes,
  tallySuspicionVotes,
  tallyVerdictVotes,
} from "../_shared/engine/engine.ts";
import type { MatchState, PlayerState } from "../_shared/engine/types.ts";
import { CONTACT_BLOCKED_DEMONS, DEMON_KILLER_ROLES, HELPER_CONTACT, HELPER_ROLES } from "../_shared/engine/roles.ts";
import { GOMDORI_RULES, resolvePhaseDurations } from "../_shared/gomdori-rules.ts";
import {
  PHASE_NIGHT,
  PHASE_NIGHT_SUSPECT,
  firstNightTransition,
  nextNightSuspectTransition,
  nightAfterSuspicionTransition,
} from "../_shared/phase-flow.ts";

type EngineState = Record<string, unknown> & {
  modifiers?: Record<string, number>;
  // substrate: 직전 처형 투표·의심 투표의 voter→target 맵(레이스 없이 match 레벨 1회 기록).
  voteTargets?: Record<string, string>;
  suspectTargets?: Record<string, string>;
  verdict?: {
    candidateUserId: string | null;
    tallies: Record<string, number>;
    skipped: number;
    tie: boolean;
    maxVotes: number;
    phaseId: string;
  };
};

type DbPlayer = {
  user_id: string;
  display_name: string;
  role: string;
  faction: string;
  alive: boolean;
  engine_state: Record<string, unknown> | null;
};

type DbAction = {
  actor_user_id: string;
  target_user_id: string | null;
  action_type: string;
  // 멀티타깃(아서 잔불이 꺼지기 전에): match-action 이 result.targetUserIds 에 전체 대상을 담는다.
  result?: { targetUserIds?: string[] } | null;
};

function requireNoError<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data;
}

function playerStateFromRows(
  matchId: string,
  phase: MatchState["phase"],
  phaseNumber: number,
  rows: DbPlayer[],
  modifiers = {},
  marks: { voteTargets?: Record<string, string>; suspectTargets?: Record<string, string> } = {},
) {
  const state: MatchState = {
    matchId,
    dayCount: phaseNumber,
    phase,
    angelCount: 0,
    demonCount: 0,
    players: {},
    actionStack: [],
    modifiers,
  };

  for (const row of rows) {
    const engineState = row.engine_state || {};
    const currentRole = typeof engineState.currentRole === "string" ? engineState.currentRole : row.role;
    const treatedAsFaction = typeof engineState.treatedAsFaction === "string" ? engineState.treatedAsFaction : row.faction;
    // 포교(파스아)로 진영이 바뀌면 DB faction 컬럼이 아니라 engine_state.currentFaction
    // 에 영속화된다(전향자는 천사→중립). 없으면 DB faction 으로 폴백.
    const currentFaction = typeof engineState.currentFaction === "string" ? engineState.currentFaction : row.faction;

    state.players[row.user_id] = {
      userId: row.user_id,
      originalRole: row.role,
      currentRole,
      baseVoteValue: typeof engineState.baseVoteValue === "number" ? engineState.baseVoteValue : 1,
      bonusVoteValue: typeof engineState.bonusVoteValue === "number" ? engineState.bonusVoteValue : 0,
      suspicionValue: typeof engineState.suspicionValue === "number" ? engineState.suspicionValue : 0,
      actualFaction: currentFaction as PlayerState["actualFaction"],
      treatedAsFaction: treatedAsFaction as PlayerState["treatedAsFaction"],
      alive: row.alive,
      markedForDeath: false,
      markedForAnnihilation: false,
      tags: Array.isArray(engineState.tags) ? engineState.tags.filter((tag) => typeof tag === "string") : [],
      counters:
        engineState.counters && typeof engineState.counters === "object" && !Array.isArray(engineState.counters)
          ? engineState.counters as Record<string, number>
          : {},
      lastVoteTarget: marks.voteTargets?.[row.user_id] ?? null,
      lastSuspectTarget: marks.suspectTargets?.[row.user_id] ?? null,
    };

    if (row.alive && row.faction === "angel") state.angelCount += 1;
    if (row.alive && row.faction === "demon") state.demonCount += 1;
  }

  return state;
}

function actionRowsToInputs(actions: DbAction[]) {
  return actions.map((action) => ({
    actorUserId: action.actor_user_id,
    targetUserId: action.target_user_id,
    actionType: action.action_type,
    // 멀티타깃 복원: 저장된 result.targetUserIds 를 그대로 전달. 엔진이 ability.targetCount>1 일
    // 때만 사용하므로 단일 능력에선 무해(제네릭 — 직업 분기 없음).
    targetUserIds: action.result?.targetUserIds,
  }));
}

// 종료 reveal (M4-1, canon §9): 직업 변화(이전→최종)를 모두 공개한다.
// role/faction = 시작 확정 정체(DB, 변종 선택 반영), final_* = engine_state 의
// currentRole/currentFaction(전향·타락·낙인 재배정 등 게임 내 변환 반영).
function revealedPlayers(players: DbPlayer[]) {
  return players.map((player) => {
    const es = (player.engine_state ?? {}) as Record<string, unknown>;
    const finalRole = typeof es.currentRole === "string" ? es.currentRole : player.role;
    const finalFaction = typeof es.currentFaction === "string" ? es.currentFaction : player.faction;
    return {
      user_id: player.user_id,
      display_name: player.display_name,
      role: player.role,
      faction: player.faction,
      final_role: finalRole,
      final_faction: finalFaction,
      changed: finalRole !== player.role || finalFaction !== player.faction,
      alive: player.alive,
    };
  });
}

// 변종 선택 마감(role_assign → 첫째 밤 직전). 미선택(악마/조력자) 슬롯은 풀에서 랜덤
// 폴백하고, 변종 확정 후 가인이 있으면 악마에게 보호막 1을 재계산해 심고, 접선
// 정본에 따라 회로(채팅/통지)를 연다.
async function finalizeRoleSelection(supabase: ReturnType<typeof getSupabaseAdmin>, matchId: string, phaseId: string) {
  const rows = requireNoError(
    await supabase
      .from("match_players")
      .select("user_id, role, engine_state")
      .eq("match_id", matchId),
  ) as Array<{ user_id: string; role: string; engine_state: Record<string, unknown> | null }>;

  // 1. 미선택 변종 랜덤 폴백
  for (const p of rows) {
    const es = (p.engine_state ?? {}) as Record<string, unknown>;
    const pending = es.pendingSelection as { pool?: unknown } | undefined;
    const pool = pending && Array.isArray(pending.pool) ? (pending.pool as string[]) : null;
    if (pool && pool.length > 0) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      const next = { ...es };
      delete next.pendingSelection;
      requireNoError(
        await supabase.from("match_players").update({ role: pick, engine_state: next }).eq("match_id", matchId).eq("user_id", p.user_id),
      );
      p.role = pick;
      p.engine_state = next;
    }
  }

  // 2. 가인 → 악마 보호막 재계산 (선택이 끝나야 가인 여부가 확정되므로 여기서)
  if (rows.some((p) => p.role === "gain")) {
    const demon = rows.find((p) => DEMON_KILLER_ROLES.includes(p.role));
    if (demon) {
      const es = (demon.engine_state ?? {}) as Record<string, unknown>;
      const counters =
        es.counters && typeof es.counters === "object" && !Array.isArray(es.counters)
          ? { ...(es.counters as Record<string, number>) }
          : {};
      if (!((counters.shield ?? 0) > 0)) {
        counters.shield = 1;
        // shieldFromGain 마커: 이 보호막이 가인 패시브가 부여한 것임을 영속화. engine 이
        // 두 번째 밤 종료 시(canon "두 번째 밤 종료 시 패시브 삭제") 이 마커 보유자만 만료한다 —
        // 아서 자기 보호막(shieldFromGain 없음)은 영향 없음.
        counters.shieldFromGain = 1;
        const nextEs = { ...es, counters };
        requireNoError(
          await supabase.from("match_players").update({ engine_state: nextEs }).eq("match_id", matchId).eq("user_id", demon.user_id),
        );
        demon.engine_state = nextEs;
      }
    }
  }

  // 3. 접선 해소 (정본 2026-06-12 — 조력자 패시브가 결정, 기본은 서로 모름):
  //    가인 = 악마와 접선·대화(밤2 종료 시 채팅 만료) / 로건 = 시작 시 접선(영구)
  //    루나·엘런 = 접선 없음. 팬텀(악마)이면 접선 불가 — 상호 정체 통지만.
  //    circleChat = 채팅 회로(만료 가능), circleKnown = 정체 인지(영구, 뷰 노출).
  const demonRow = rows.find((p) => DEMON_KILLER_ROLES.includes(p.role));
  const helperRow = rows.find((p) => HELPER_ROLES.includes(p.role));
  if (demonRow && helperRow) {
    const contact = HELPER_CONTACT[helperRow.role];
    const blocked = CONTACT_BLOCKED_DEMONS.includes(demonRow.role);
    const link = async (
      self: typeof demonRow,
      peer: typeof demonRow,
      mode: "chat" | "notify",
    ) => {
      const es = (self.engine_state ?? {}) as Record<string, unknown>;
      const nextEs: Record<string, unknown> = { ...es, circleKnown: true };
      if (mode === "chat") {
        nextEs.circleChat = true;
        if (contact?.expiresAfterNight != null) nextEs.circleChatExpiresNight = contact.expiresAfterNight;
      }
      requireNoError(
        await supabase.from("match_players").update({ engine_state: nextEs }).eq("match_id", matchId).eq("user_id", self.user_id),
      );
      self.engine_state = nextEs;
      requireNoError(
        await supabase.from("match_events").insert({
          match_id: matchId,
          phase_id: phaseId,
          event_type: mode === "chat" ? "circle_contact" : "circle_notify",
          visibility: "private",
          recipient_user_id: self.user_id,
          payload: {
            user_id: peer.user_id,
            role: peer.role,
            expires_after_night: mode === "chat" ? contact?.expiresAfterNight ?? null : null,
          },
        }),
      );
    };
    if (contact && !blocked) {
      await link(demonRow, helperRow, "chat");
      await link(helperRow, demonRow, "chat");
    } else if (blocked) {
      await link(demonRow, helperRow, "notify");
      await link(helperRow, demonRow, "notify");
    }
    // 그 외(루나·엘런 + 비팬텀): 아무 일도 없음 — 서로 모른 채 시작.
  }
}

async function loadPlayers(supabase: ReturnType<typeof getSupabaseAdmin>, matchId: string): Promise<DbPlayer[]> {
  return requireNoError(
    await supabase
      .from("match_players")
      .select("user_id, display_name, role, faction, alive, engine_state")
      .eq("match_id", matchId),
  ) as DbPlayer[];
}

async function loadMatchEngineState(supabase: ReturnType<typeof getSupabaseAdmin>, matchId: string): Promise<EngineState> {
  const matchRecord = requireNoError(
    await supabase
      .from("matches")
      .select("engine_state")
      .eq("id", matchId)
      .single(),
  ) as { engine_state: EngineState | null };

  return matchRecord.engine_state || {};
}

// 로비에서 호스트가 정한 페이스 설정(settings.pace) 로드 — 페이즈 duration 해소에 쓴다.
async function loadMatchSettings(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  matchId: string,
): Promise<Record<string, unknown>> {
  const matchRecord = requireNoError(
    await supabase
      .from("matches")
      .select("settings")
      .eq("id", matchId)
      .single(),
  ) as { settings: Record<string, unknown> | null };

  return matchRecord.settings || {};
}

async function finishMatchIfWon(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  matchId: string,
  phaseId: string,
  players: DbPlayer[],
) {
  const state = playerStateFromRows(matchId, "ended", 0, players);
  const win = checkWinCondition(state.players);
  if (!win.winner) return null;

  const endedAt = new Date().toISOString();
  requireNoError(
    await supabase
      .from("matches")
      .update({ winner: win.winner, status: "ended", ended_at: endedAt })
      .eq("id", matchId),
  );

  requireNoError(
    await supabase
      .from("match_events")
      .insert({
        match_id: matchId,
        phase_id: phaseId,
        event_type: "game_ended",
        visibility: "public",
        payload: {
          winner: win.winner,
          winning_faction:
            win.winner === "angels" ? "angel" : win.winner === "neutral" ? "neutral" : "demon",
          alive_angels: win.aliveAngels,
          alive_demons: win.aliveDemons,
          players: revealedPlayers(players),
        },
      }),
  );

  return win;
}

async function performPresenceSweep(supabase: ReturnType<typeof getSupabaseAdmin>) {
  const { data: lobbies, error: lobbiesError } = await supabase
    .from("matches")
    .select("id")
    .eq("status", "lobby");

  if (lobbiesError || !lobbies || lobbies.length === 0) return;

  const threshold = new Date(Date.now() - 120 * 1000).toISOString(); // 2 minutes ago

  for (const lobby of lobbies) {
    const matchId = lobby.id;

    const { data: expiredPlayers, error: expiredError } = await supabase
      .from("match_players")
      .select("user_id")
      .eq("match_id", matchId)
      .lt("last_seen_at", threshold);

    if (expiredError || !expiredPlayers || expiredPlayers.length === 0) continue;

    const expiredUserIds = expiredPlayers.map((p) => p.user_id);

    const { error: deleteError } = await supabase
      .from("match_players")
      .delete()
      .eq("match_id", matchId)
      .in("user_id", expiredUserIds);

    if (deleteError) continue;

    for (const uid of expiredUserIds) {
      await supabase.from("match_events").insert({
        match_id: matchId,
        event_type: "player_left",
        visibility: "public",
        payload: { userId: uid, swept: true },
      });
    }

    const { count, error: countError } = await supabase
      .from("match_players")
      .select("user_id", { count: "exact", head: true })
      .eq("match_id", matchId);

    if (!countError && count === 0) {
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
}

// 진행 중(in-progress) 매치 버려짐 정리: 사람(비-AI) 참가자가 전원 heartbeat 끊기면
// (전원 이탈) 매치를 중단한다. AI 는 heartbeat 가 없으므로 present 판정에서 제외 — AI 만
// 남은 게임이 maxDays 타임아웃까지 도는 좀비화를 막는다. 로비 sweep(performPresenceSweep)
// 과 같은 2분 임계. 사람이 한 명이라도 최근 heartbeat 가 있으면 건드리지 않는다.
const IN_PROGRESS_STATUSES = ["role_assign", "night", "night_suspect", "night_resolve", "day", "vote", "verdict"];
async function performAbandonedMatchSweep(supabase: ReturnType<typeof getSupabaseAdmin>) {
  const threshold = new Date(Date.now() - 120 * 1000).toISOString();
  const { data: matches, error } = await supabase
    .from("matches")
    .select("id")
    .in("status", IN_PROGRESS_STATUSES);
  if (error || !matches || matches.length === 0) return;

  for (const m of matches) {
    const { count, error: countError } = await supabase
      .from("match_players")
      .select("user_id", { count: "exact", head: true })
      .eq("match_id", m.id)
      .eq("is_ai", false)
      .gte("last_seen_at", threshold);
    if (countError) continue;
    if ((count ?? 0) > 0) continue; // 사람이 한 명이라도 남아 있으면 유지.

    const endedAt = new Date().toISOString();
    await supabase.from("match_phases").update({ ended_at: endedAt }).eq("match_id", m.id).is("ended_at", null);
    await supabase
      .from("matches")
      .update({ status: "aborted", abort_reason: "abandoned_all_left", ended_at: endedAt })
      .eq("id", m.id)
      .in("status", IN_PROGRESS_STATUSES); // 동시 전환 레이스 방지(아직 진행 중일 때만).
    await supabase.from("match_events").insert({
      match_id: m.id,
      event_type: "match_aborted",
      visibility: "public",
      payload: { reason: "abandoned_all_left" },
    });
  }
}

// Called by pg_cron or an external scheduler. JWT verification is disabled in
// supabase/config.toml, so all authority stays in the service-role DB writes.
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

    // H-2: optional shared-secret gate for this public (verify_jwt=false) endpoint.
    // Set PHASE_ADVANCE_CRON_SECRET and send it as x-cron-key from pg_cron to enforce.
    const cronSecret = Deno.env.get("PHASE_ADVANCE_CRON_SECRET");
    if (cronSecret && req.headers.get("x-cron-key") !== cronSecret) {
      return jsonResponse(
        { error: { code: "forbidden", message: "Invalid cron key." } },
        { status: 403, origin },
      );
    }

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    // Perform Lobby Presence GC Sweep
    await performPresenceSweep(supabase).catch((err) => console.error("Presence sweep failed:", err));
    // 진행 중 매치 전원 이탈 → 자동 abort (좀비 게임 방지)
    await performAbandonedMatchSweep(supabase).catch((err) => console.error("Abandoned match sweep failed:", err));

    const expiredPhases = requireNoError(
      await supabase
        .from("match_phases")
        .select("id, match_id, phase_number, phase_type")
        .lt("expected_ended_at", now)
        .is("ended_at", null)
        .limit(10),
    ) as Array<{ id: string; match_id: string; phase_number: number; phase_type: string }>;

    if (expiredPhases.length === 0) {
      return jsonResponse({ message: "No expired phases to advance" }, { origin });
    }

    const results = [];

    for (const phase of expiredPhases) {
      const matchId = phase.match_id;
      const endedAt = new Date().toISOString();

      const claimedPhase = requireNoError(
        await supabase
          .from("match_phases")
          .update({ ended_at: endedAt })
          .eq("id", phase.id)
          .is("ended_at", null)
          .select("id"),
      ) as Array<{ id: string }>;
      // GAME-1: if a concurrent invocation already claimed this phase, skip it to
      // avoid double night-resolution, double votes, and duplicate next phases.
      if (!claimedPhase || claimedPhase.length === 0) {
        continue;
      }

      let engineState = await loadMatchEngineState(supabase, matchId);
      let players = await loadPlayers(supabase, matchId);
      // 페이스: 호스트가 로비에서 정한 시간(프리셋+오버라이드)을 settings 에서 해소.
      // 시작 후 settings 는 불변이라 매 페이즈마다 동일한 durations 가 나온다.
      const matchSettings = await loadMatchSettings(supabase, matchId);
      const durations = resolvePhaseDurations(matchSettings);
      let nextPhaseType: string | null = null;
      let nextDurationSec = 0;
      let nextPhaseNumber = phase.phase_number;

      if (phase.phase_type === "role_assign") {
        // 변종 선택 마감: 미선택 폴백 + 가인→악마 보호막 재계산 + 접선 회로. 그 뒤 첫째 밤으로.
        await finalizeRoleSelection(supabase, matchId, phase.id);
        const transition = firstNightTransition(durations);
        nextPhaseType = transition.phaseType;
        nextDurationSec = transition.durationSec;
        nextPhaseNumber = transition.phaseNumber;
      } else if (phase.phase_type === "night") {
        const isFirstNight = phase.phase_number === 1 && GOMDORI_RULES.firstNight.skipsAbilities;

        if (isFirstNight) {
          // 첫째 밤: 모든 능력 비활성. 정보 누적 전 첫 능력으로 결판나는 것 방지.
          // night_resolve 를 거치지 않고 바로 아침으로 — 야간 사망/조사 없음.
          requireNoError(
            await supabase
              .from("match_events")
              .insert({
                match_id: matchId,
                phase_id: phase.id,
                event_type: "first_night_silent",
                visibility: "public",
                payload: { day_number: 1 },
              }),
          );

          nextPhaseType = "day";
          nextDurationSec = durations.day;
        } else {
          const actions = requireNoError(
            await supabase
              .from("match_actions")
              .select("actor_user_id, target_user_id, action_type, result")
              .eq("phase_id", phase.id),
          ) as DbAction[];

          const state = playerStateFromRows(
            matchId,
            "night",
            phase.phase_number,
            players,
            engineState.modifiers || {},
            // substrate: 직전 투표/의심 대상 복원 — Effect.target VoteTarget/SuspectTarget 이 참조.
            { voteTargets: engineState.voteTargets, suspectTargets: engineState.suspectTargets },
          );
          state.actionStack = actionRowsToInputs(actions).map((action) => ({
            sourceUserId: action.actorUserId,
            targetUserId: action.targetUserId,
            targetUserIds: action.targetUserIds,
            actionType: action.actionType || "",
            // 봉인(세이카/팬텀)·변신(베스토 self)은 가장 먼저(1) — 대상 능력보다 앞서 처리.
            // 부활/치료=3, 처치=4, 조사·색출·포교·낙인·일식=5.
            priority:
              action.actionType === "seika_supernova" || action.actionType === "phantom_seal" || action.actionType === "logen_nullify" || action.actionType === "malen_possess" || action.actionType === "besto_shift" || action.actionType === "daeakma_dominion" ? 1
                : action.actionType === "demon_kill" || action.actionType === "phantom_nightmare" || action.actionType === "malen_release" || action.actionType === "besto_hidden" || action.actionType === "pasua_faith" || action.actionType === "arthur_judge" ? 4
                : action.actionType === "doctor_heal" || action.actionType === "mizlet_revive" || action.actionType === "mizlet_dessert" || action.actionType === "helen_revive" || action.actionType === "helen_sleep" || action.actionType === "arthur_emberblade" ? 3
                : 5,
          }));

          const { newState, events } = resolveNightActions(state);

          for (const [userId, playerState] of Object.entries(newState.players)) {
            const dbPlayer = players.find((player) => player.user_id === userId);
            if (!dbPlayer) continue;

            const nextEngineState = {
              ...(dbPlayer.engine_state || {}),
              tags: playerState.tags,
              counters: playerState.counters,
              currentRole: playerState.currentRole,
              // 포교로 바뀐 진영을 영속화(전향자 → neutral). 다음 리로드에서
              // playerStateFromRows 가 이 값을 actualFaction 으로 복원한다.
              currentFaction: playerState.actualFaction,
              // 사탄의 마 전역 취급(대악마): 천사팀 전원 vote 0 시 treatedAsFaction='demon' 플립.
              // playerStateFromRows 가 다음 리로드에서 복원해 countTeams·승리 판정에 자동 반영.
              treatedAsFaction: playerState.treatedAsFaction,
            };

            const updatePayload: Record<string, unknown> = { engine_state: nextEngineState };
            if (dbPlayer.alive && !playerState.alive) {
              updatePayload.alive = false;
              updatePayload.eliminated_at = endedAt;
              updatePayload.eliminated_phase_number = phase.phase_number;
              updatePayload.eliminated_cause = "night_kill";
            } else if (!dbPlayer.alive && playerState.alive) {
              // 부활(미즐렛/헬렌 Heal dead→alive) 영속화. 이 분기가 없으면 엔진은
              // 되살렸는데 match_players.alive 가 false 로 남아 부활이 무효였다
              // (2026-06-12 발견 — 부활 직업 2종이 라이브에서 작동하지 않던 원인).
              updatePayload.alive = true;
              updatePayload.eliminated_at = null;
              updatePayload.eliminated_phase_number = null;
              updatePayload.eliminated_cause = null;
            }

            requireNoError(
              await supabase
                .from("match_players")
                .update(updatePayload)
                .eq("match_id", matchId)
                .eq("user_id", userId),
            );
          }

          requireNoError(
            await supabase
              .from("matches")
              .update({ engine_state: { ...engineState, modifiers: newState.modifiers } })
              .eq("id", matchId),
          );

          // 타락(루나) 후속 처리 (vault canon §28): corrupted 가 된 자는 새 진영의
          // 동료 정체를 인지한다. circleKnown=true 로 영속화해 frontend 뷰가 demon
          // 라인업을 노출하도록 한다. 채팅 회로(circleChat)는 캐논상 명시 없음 → 통지만.
          // engine_state 갱신은 위 루프(line 555-588)가 currentFaction/currentRole 을
          // 이미 영속화했으므로, 여기서는 circleKnown 만 추가로 패치한다.
          const corruptedEvents = (events as Array<{ type: string; payload?: { user_id?: string; new_faction?: string } }>)
            .filter((e) => e.type === "faction_changed" && e.payload?.new_faction === "demon" && typeof e.payload?.user_id === "string");
          for (const ev of corruptedEvents) {
            const uid = ev.payload!.user_id!;
            const dbp = players.find((p) => p.user_id === uid);
            if (!dbp) continue;
            const es = (dbp.engine_state ?? {}) as Record<string, unknown>;
            requireNoError(
              await supabase
                .from("match_players")
                .update({ engine_state: { ...es, circleKnown: true } })
                .eq("match_id", matchId)
                .eq("user_id", uid),
            );
            dbp.engine_state = { ...es, circleKnown: true };
            requireNoError(
              await supabase.from("match_events").insert({
                match_id: matchId,
                phase_id: phase.id,
                event_type: "corruption_received",
                visibility: "private",
                recipient_user_id: uid,
                payload: { new_faction: "demon" },
              }),
            );
          }

          // 엔진 이벤트 가시성 분류 (2026-06-12): 마을 전체가 알아야 하는 결과만
          // public. 나머지(봉인·매료·빙의·전향·변신·낙인·차단 피드백 등)는 비밀
          // 정보라 영향받은 당사자에게만 private(recipient RLS)로 전달 — 전부
          // public 으로 쌓으면 포교/변신/낙인이 클라이언트에서 그대로 읽혔다.
          // role_revealed(우노 용맹함 '소속 공개')·demons_revealed(세이카 '자신만 아플 거야'
          // 소멸 이틀 후 악마팀 공개)는 canon 상 마을 전체 공개 정보라 public.
          const PUBLIC_ENGINE_EVENTS = new Set(["player_died", "player_revived", "role_revealed", "demons_revealed"]);
          const engineEvents = events as Array<{ type: string; payload?: { user_id?: string }; userId?: string }>;
          for (const event of engineEvents) {
            const isPublic = PUBLIC_ENGINE_EVENTS.has(event.type);
            const affectedUserId = event.payload?.user_id ?? event.userId ?? null;
            if (!isPublic && !affectedUserId) continue; // 수신자 특정 불가 — 저장 생략
            requireNoError(
              await supabase
                .from("match_events")
                .insert({
                  match_id: matchId,
                  phase_id: phase.id,
                  event_type: event.type,
                  visibility: isPublic ? "public" : "private",
                  recipient_user_id: isPublic ? null : affectedUserId,
                  payload: event.payload || { user_id: event.userId },
                }),
            );
          }

          // 아침 공표 집계(공개) — 클라이언트가 사망 1건 find 가 아니라 그 밤의
          // 사망·부활 명단을 한 이벤트로 읽는다 (다중 사망 누락 방지).
          const morningDeaths = engineEvents
            .filter((e) => e.type === "player_died")
            .map((e) => e.payload?.user_id)
            .filter((id): id is string => typeof id === "string");
          const morningRevivals = engineEvents
            .filter((e) => e.type === "player_revived")
            .map((e) => e.payload?.user_id)
            .filter((id): id is string => typeof id === "string");
          requireNoError(
            await supabase
              .from("match_events")
              .insert({
                match_id: matchId,
                phase_id: phase.id,
                event_type: "morning_report",
                visibility: "public",
                payload: { deaths: morningDeaths, revivals: morningRevivals, night_number: phase.phase_number },
              }),
          );

          // 접선 만료 (정본: 가인 "두 번째 밤 종료 시 패시브 삭제") — 만료 밤에
          // 도달하면 채팅 회로를 닫는다. 정체 인지(circleKnown)는 영구 유지.
          // 밤 해소가 engine_state 를 막 갱신했으므로 신선한 행을 다시 읽어 합친다.
          if (phase.phase_number >= 2) {
            const freshPlayers = await loadPlayers(supabase, matchId);
            for (const p of freshPlayers) {
              const es = (p.engine_state ?? {}) as Record<string, unknown>;
              const expires = typeof es.circleChatExpiresNight === "number" ? es.circleChatExpiresNight : null;
              if (es.circleChat === true && expires != null && phase.phase_number >= expires) {
                requireNoError(
                  await supabase
                    .from("match_players")
                    .update({ engine_state: { ...es, circleChat: false } })
                    .eq("match_id", matchId)
                    .eq("user_id", p.user_id),
                );
                requireNoError(
                  await supabase.from("match_events").insert({
                    match_id: matchId,
                    phase_id: phase.id,
                    event_type: "circle_expired",
                    visibility: "private",
                    recipient_user_id: p.user_id,
                    payload: { night_number: phase.phase_number },
                  }),
                );
              }
            }
          }

          nextPhaseType = "night_resolve";
          nextDurationSec = durations.nightResolve;
        }
      } else if (phase.phase_type === "night_suspect") {
        // 밤 의심 투표 집계 → 최다 의심자는 다가오는 밤 능력 사용 불가 (canon §3·§4).
        const actions = requireNoError(
          await supabase
            .from("match_actions")
            .select("actor_user_id, target_user_id, action_type")
            .eq("phase_id", phase.id)
            .eq("action_type", "suspect"),
        ) as DbAction[];

        const state = playerStateFromRows(matchId, "night", phase.phase_number, players);
        const suspicion = tallySuspicionVotes(actionRowsToInputs(actions), state.players);

        if (suspicion.candidateUserId) {
          const target = players.find((player) => player.user_id === suspicion.candidateUserId);
          if (target) {
            const existing = (target.engine_state || {}) as { tags?: unknown };
            const tags = Array.isArray(existing.tags)
              ? (existing.tags.filter((tag) => typeof tag === "string") as string[])
              : [];
            if (!tags.includes(TAG_SUSPECTED)) tags.push(TAG_SUSPECTED);
            requireNoError(
              await supabase
                .from("match_players")
                .update({ engine_state: { ...(target.engine_state || {}), tags } })
                .eq("match_id", matchId)
                .eq("user_id", suspicion.candidateUserId),
            );
          }
        }

        // substrate: 이번 의심 투표의 voter→target 을 기록(다가오는 밤 SuspectTarget 참조용).
        const suspectTargets: Record<string, string> = {};
        for (const a of actions) {
          if (a.target_user_id) suspectTargets[a.actor_user_id] = a.target_user_id;
        }
        engineState = { ...engineState, suspectTargets };
        requireNoError(
          await supabase.from("matches").update({ engine_state: engineState }).eq("id", matchId),
        );

        requireNoError(
          await supabase
            .from("match_events")
            .insert({
              match_id: matchId,
              phase_id: phase.id,
              event_type: "suspicion_revealed",
              visibility: "public",
              payload: {
                user_id: suspicion.candidateUserId,
                tie: suspicion.tie,
                tallies: suspicion.tallies,
              },
            }),
        );

        // 의심 투표와 그 밤은 같은 밤 번호 — phase_number 유지하고 night 로 전환.
        const transition = nightAfterSuspicionTransition(phase.phase_number, durations);
        nextPhaseType = transition.phaseType;
        nextDurationSec = transition.durationSec;
        nextPhaseNumber = transition.phaseNumber;
      } else if (phase.phase_type === "night_resolve") {
        // 아침 해소: 악몽(팬텀) 표식 보유 생존자 탈락. 밤 능력 해소와 분리된 단계라
        // 1_NIGHT 보호로 막히지 않는다(canon 악몽).
        const nmState = playerStateFromRows(matchId, "day", phase.phase_number, players);
        const nmEvents = resolveNightmares(nmState.players) as Array<{ payload?: { user_id?: string } }>;
        for (const ev of nmEvents) {
          const uid = ev.payload?.user_id;
          if (!uid) continue;
          const dbp = players.find((p) => p.user_id === uid);
          const nextEngineState = { ...(dbp?.engine_state || {}), counters: nmState.players[uid]?.counters ?? {} };
          requireNoError(
            await supabase
              .from("match_players")
              .update({ alive: false, eliminated_at: endedAt, eliminated_phase_number: phase.phase_number, eliminated_cause: "night_kill", engine_state: nextEngineState })
              .eq("match_id", matchId)
              .eq("user_id", uid),
          );
          requireNoError(
            await supabase
              .from("match_events")
              .insert({ match_id: matchId, phase_id: phase.id, event_type: "nightmare_death", visibility: "public", payload: { user_id: uid } }),
          );
        }
        if (nmEvents.length > 0) players = await loadPlayers(supabase, matchId);

        // 일식(팬텀, vault canon "다음 아침을 밤으로 변경, 대신 아침이 오면 팬텀 소멸"):
        // 2단계 모델 — 캐스트 라운드의 아침을 건너뛰고 추가 밤을 삽입 → 그 추가 밤이
        // 끝나고 오는 정상 아침에 팬텀 소멸. counter eclipse=1 (캐스트 그 밤) →
        // eclipsePending=1 + eclipse=0 (이번 night_resolve 에 아침 건너뛰기) →
        // eclipsePending>0 (다음 night_resolve = 정상 아침)에 소멸.
        // eclipseActive 가 true 면 이번 페이즈는 night_suspect 로 — 아래 분기에서 처리.
        let eclipseActive = false;
        let eclipseSoulOut = false;
        for (const p of players) {
          const counters = (p.engine_state as { counters?: { eclipse?: number; eclipsePending?: number } } | null)?.counters;
          if (!p.alive) continue;
          const eclipse = counters?.eclipse ?? 0;
          const pending = counters?.eclipsePending ?? 0;
          if (eclipse > 0) {
            // 캐스트 라운드의 night_resolve — 추가 밤 삽입 단계. 팬텀은 살아남는다.
            eclipseActive = true;
            const nextCounters = { ...(counters as Record<string, number>), eclipse: 0, eclipsePending: 1 };
            requireNoError(
              await supabase
                .from("match_players")
                .update({ engine_state: { ...(p.engine_state || {}), counters: nextCounters } })
                .eq("match_id", matchId)
                .eq("user_id", p.user_id),
            );
            requireNoError(
              await supabase
                .from("match_events")
                .insert({ match_id: matchId, phase_id: phase.id, event_type: "eclipse_cast_resolved", visibility: "public", payload: { user_id: p.user_id, night_number: phase.phase_number } }),
            );
          } else if (pending > 0) {
            // 추가 밤이 끝나고 오는 정상 아침 — 이때 팬텀 소멸. eclipseSoulOut 표식은
            // 정상 day 진입을 보장(추가 밤 한 번 더 삽입되지 않도록). vault canon §8 의
            // '소멸' — 부활 불가. counters.annihilated=1 로 영속화해 미즐렛/헬렌 부활이
            // 무효가 되도록(engine Heal effect 가 이 표식 체크).
            eclipseSoulOut = true;
            const nextCounters = { ...(counters as Record<string, number>), eclipsePending: 0, annihilated: 1 };
            requireNoError(
              await supabase
                .from("match_players")
                .update({ alive: false, eliminated_at: endedAt, eliminated_phase_number: phase.phase_number, eliminated_cause: "annihilation", engine_state: { ...(p.engine_state || {}), counters: nextCounters } })
                .eq("match_id", matchId)
                .eq("user_id", p.user_id),
            );
            requireNoError(
              await supabase
                .from("match_events")
                .insert({ match_id: matchId, phase_id: phase.id, event_type: "eclipse_annihilation", visibility: "public", payload: { user_id: p.user_id } }),
            );
          }
        }
        if (eclipseActive || eclipseSoulOut) players = await loadPlayers(supabase, matchId);

        // 침묵의 밤(팬텀): extendNight 표식이 있으면 아침을 건너뛰고 추가 밤을 삽입한다(eclipse 와
        // 같은 전이, 단 소멸 없음). 밤 대화 +1분(아래 transition 에서 가산). 생존 천사팀 카운트 +1 은
        // 엔진 effect 가 이미 적용. extendNight 는 소비(리셋)해 무한 연장을 막는다(밤마다 1회만).
        let silentNightActive = false;
        for (const p of players) {
          if (!p.alive) continue;
          const counters = (p.engine_state as { counters?: { extendNight?: number } } | null)?.counters;
          if ((counters?.extendNight ?? 0) > 0) {
            silentNightActive = true;
            const nextCounters = { ...(counters as Record<string, number>), extendNight: 0 };
            requireNoError(
              await supabase
                .from("match_players")
                .update({ engine_state: { ...(p.engine_state || {}), counters: nextCounters } })
                .eq("match_id", matchId)
                .eq("user_id", p.user_id),
            );
            requireNoError(
              await supabase
                .from("match_events")
                .insert({ match_id: matchId, phase_id: phase.id, event_type: "silent_night_extended", visibility: "public", payload: { user_id: p.user_id } }),
            );
          }
        }
        if (silentNightActive) players = await loadPlayers(supabase, matchId);

        // 행복을 파는 가게(미즐렛 다수복귀, canon 패시브·1회): 탈락자가 생존자보다 많아지면
        // 미즐렛이 가장 최근 탈락 2명을 복귀(소멸·부활불가 무시)시키고 자신은 탈락한다.
        // used_mizlet_comeback 으로 1회 제한 — 천사 진영 역전 장치. 승패 영향이라 win 체크 전에.
        {
          const aliveCount = players.filter((p) => p.alive).length;
          const deadCount = players.length - aliveCount;
          const mizlet = players.find((p) => {
            const cr = (p.engine_state as { currentRole?: string } | null)?.currentRole ?? p.role;
            return p.alive && cr === "mizlet";
          });
          const used = ((mizlet?.engine_state as { counters?: { used_mizlet_comeback?: number } } | null)?.counters?.used_mizlet_comeback ?? 0) > 0;
          if (mizlet && !used && deadCount > aliveCount && deadCount > 0) {
            const recentDead = (requireNoError(
              await supabase
                .from("match_players")
                .select("user_id, engine_state")
                .eq("match_id", matchId)
                .eq("alive", false)
                .order("eliminated_at", { ascending: false })
                .limit(2),
            ) as Array<{ user_id: string; engine_state: Record<string, unknown> | null }>);
            for (const r of recentDead) {
              const rc = { ...((r.engine_state as { counters?: Record<string, number> } | null)?.counters ?? {}) };
              delete rc.annihilated; // 소멸·부활불가 무시(canon).
              requireNoError(
                await supabase
                  .from("match_players")
                  .update({ alive: true, eliminated_at: null, eliminated_phase_number: null, eliminated_cause: null, engine_state: { ...(r.engine_state || {}), counters: rc } })
                  .eq("match_id", matchId)
                  .eq("user_id", r.user_id),
              );
              requireNoError(
                await supabase
                  .from("match_events")
                  .insert({ match_id: matchId, phase_id: phase.id, event_type: "player_revived", visibility: "public", payload: { user_id: r.user_id, source: "mizlet_comeback" } }),
              );
            }
            const mc = { ...((mizlet.engine_state as { counters?: Record<string, number> } | null)?.counters ?? {}), used_mizlet_comeback: 1 };
            requireNoError(
              await supabase
                .from("match_players")
                .update({ alive: false, eliminated_at: endedAt, eliminated_phase_number: phase.phase_number, eliminated_cause: "night_kill", engine_state: { ...(mizlet.engine_state || {}), counters: mc } })
                .eq("match_id", matchId)
                .eq("user_id", mizlet.user_id),
            );
            requireNoError(
              await supabase
                .from("match_events")
                .insert({ match_id: matchId, phase_id: phase.id, event_type: "mizlet_comeback", visibility: "public", payload: { user_id: mizlet.user_id, revived: recentDead.map((r) => r.user_id) } }),
            );
            players = await loadPlayers(supabase, matchId);
          }
        }

        const win = await finishMatchIfWon(supabase, matchId, phase.id, players);
        if (win) {
          results.push({ matchId, advancedTo: "ended", winner: win.winner });
          continue;
        }

        // 사건의 전말(도르단): caseClosed 가 설정되고 그 악마가 아직 생존해 있으면 아침을
        // 생략하고 곧장 판결(verdict)로 — 식별된 악마를 판결대에 세운다(표식 소비). 일식보다 우선.
        const caseClosed = (engineState as { caseClosed?: { demonUserId?: string } }).caseClosed;
        const caseDemonAlive = caseClosed?.demonUserId
          ? players.some((p) => p.user_id === caseClosed.demonUserId && p.alive)
          : false;
        if (caseClosed?.demonUserId && caseDemonAlive) {
          const { caseClosed: _cc, verdict: _v, ...rest } = engineState as Record<string, unknown>;
          engineState = { ...rest, verdict: { candidateUserId: caseClosed.demonUserId, tallies: {}, skipped: 0, tie: false, maxVotes: 0, phaseId: phase.id } };
          requireNoError(
            await supabase.from("matches").update({ engine_state: engineState }).eq("id", matchId),
          );
          requireNoError(
            await supabase.from("match_events").insert({ match_id: matchId, phase_id: phase.id, event_type: "case_closed", visibility: "public", payload: { user_id: caseClosed.demonUserId } }),
          );
          nextPhaseType = "verdict";
          nextDurationSec = durations.verdict;
        } else if (eclipseActive || silentNightActive) {
          // 아침을 건너뛰고 곧장 다음 밤(의심 투표)으로. 침묵의 밤이면 밤 대화 +1분(canon).
          const transition = nextNightSuspectTransition(phase.phase_number, durations);
          nextPhaseType = transition.phaseType;
          nextDurationSec = transition.durationSec + (silentNightActive ? 60 : 0);
          nextPhaseNumber = transition.phaseNumber;
        } else {
          // caseClosed 가 있었으나 악마가 이미 탈락했으면 표식만 정리.
          if (caseClosed?.demonUserId) {
            const { caseClosed: _cc, ...rest } = engineState as Record<string, unknown>;
            engineState = rest;
            requireNoError(await supabase.from("matches").update({ engine_state: engineState }).eq("id", matchId));
          }
          nextPhaseType = "day";
          nextDurationSec = durations.day;
        }
      } else if (phase.phase_type === "day") {
        nextPhaseType = "vote";
        nextDurationSec = durations.vote;
      } else if (phase.phase_type === "vote") {
        const actions = requireNoError(
          await supabase
            .from("match_actions")
            .select("actor_user_id, target_user_id, action_type")
            .eq("phase_id", phase.id)
            .eq("action_type", "vote"),
        ) as DbAction[];
        const state = playerStateFromRows(matchId, "vote", phase.phase_number, players, engineState.modifiers);
        const tally = tallyEliminationVotes(actionRowsToInputs(actions), state.players, engineState.modifiers);
        // 라운드성 투표 카운터 소비(canon "다음 아침" 1회 한정): 루루 무투(voteCountBonus) +
        // 미즐렛 고급 와인 1일 페널티(wineVotePenalty). 이 처형 투표 tally 직후 함께 해제한다.
        for (const p of players) {
          const es = (p.engine_state ?? {}) as Record<string, unknown>;
          const c = (es.counters ?? {}) as Record<string, number>;
          if ((c.voteCountBonus ?? 0) > 0 || (c.wineVotePenalty ?? 0) > 0) {
            const next = { ...es, counters: { ...c, voteCountBonus: 0, wineVotePenalty: 0 } };
            requireNoError(await supabase.from("match_players").update({ engine_state: next }).eq("match_id", matchId).eq("user_id", p.user_id));
            p.engine_state = next;
          }
        }
        const voteSummary = {
          candidateUserId: tally.candidateUserId,
          tallies: tally.tallies,
          skipped: tally.skipped,
          tie: tally.tie,
          maxVotes: tally.maxVotes,
          phaseId: phase.id,
        };

        // substrate: 이번 처형 투표의 voter→target 을 기록(다음 밤 VoteTarget 참조용).
        const voteTargets: Record<string, string> = {};
        for (const a of actions) {
          if (a.target_user_id) voteTargets[a.actor_user_id] = a.target_user_id;
        }

        const { verdict: _previousVerdict, ...engineStateWithoutVerdict } = engineState;
        engineState = tally.candidateUserId
          ? { ...engineStateWithoutVerdict, verdict: voteSummary, voteTargets }
          : { ...engineStateWithoutVerdict, voteTargets };

        requireNoError(
          await supabase
            .from("matches")
            .update({ engine_state: engineState })
            .eq("id", matchId),
        );

        requireNoError(
          await supabase
            .from("match_events")
            .insert({
              match_id: matchId,
              phase_id: phase.id,
              event_type: "vote_resolved",
              visibility: "public",
              payload: voteSummary,
            }),
        );

        if (tally.candidateUserId) {
          nextPhaseType = "verdict";
          nextDurationSec = durations.verdict;
        } else {
          // 부결: 최후의 반론(verdict)에 아무도 오르지 않음 — 명시적 로그 emit(채팅 로그/모닝 표시용).
          requireNoError(
            await supabase.from("match_events").insert({
              match_id: matchId,
              phase_id: phase.id,
              event_type: "verdict_no_candidate",
              visibility: "public",
              payload: { reason: tally.tie ? "tie" : "no_majority", skipped: tally.skipped },
            }),
          );
          // 다음 밤으로. 둘째 밤부터는 의심 투표(night_suspect)를 먼저 거친다.
          const transition = nextNightSuspectTransition(phase.phase_number, durations);
          nextPhaseType = transition.phaseType;
          nextDurationSec = transition.durationSec;
          nextPhaseNumber = transition.phaseNumber;
        }
      } else if (phase.phase_type === "verdict") {
        const actions = requireNoError(
          await supabase
            .from("match_actions")
            .select("actor_user_id, target_user_id, action_type")
            .eq("phase_id", phase.id)
            .in("action_type", ["verdict_approve", "verdict_reject"]),
        ) as DbAction[];
        const state = playerStateFromRows(matchId, "verdict", phase.phase_number, players, engineState.modifiers);
        const verdict = tallyVerdictVotes(actionRowsToInputs(actions), state.players, engineState.modifiers);
        const candidateUserId = engineState.verdict?.candidateUserId || null;
        const candidate = candidateUserId ? players.find((player) => player.user_id === candidateUserId) : null;
        let executed = false;
        let blockedByShield = false;

        if (verdict.approved && candidate?.alive) {
          const candidateEngineState = (candidate.engine_state ?? {}) as Record<string, unknown>;
          const candidateCounters =
            candidateEngineState.counters && typeof candidateEngineState.counters === "object" && !Array.isArray(candidateEngineState.counters)
              ? { ...(candidateEngineState.counters as Record<string, number>) }
              : {};
          if ((candidateCounters.shield ?? 0) > 0) {
            candidateCounters.shield = Math.max(0, (candidateCounters.shield ?? 0) - 1);
            blockedByShield = true;
            requireNoError(
              await supabase
                .from("match_players")
                .update({ engine_state: { ...candidateEngineState, counters: candidateCounters } })
                .eq("match_id", matchId)
                .eq("user_id", candidateUserId),
            );
            requireNoError(
              await supabase
                .from("match_events")
                .insert({
                  match_id: matchId,
                  phase_id: phase.id,
                  event_type: "execution_blocked_shield",
                  visibility: "public",
                  payload: {
                    user_id: candidate.user_id,
                    display_name: candidate.display_name,
                    role: candidate.role,
                    faction: candidate.faction,
                    cause: "vote",
                  },
                }),
            );
          } else {
            executed = true;
            requireNoError(
              await supabase
                .from("match_players")
                .update({
                  alive: false,
                  eliminated_at: endedAt,
                  eliminated_phase_number: phase.phase_number,
                  eliminated_cause: "vote",
                })
                .eq("match_id", matchId)
                .eq("user_id", candidateUserId),
            );

            requireNoError(
              await supabase
                .from("match_events")
                .insert({
                  match_id: matchId,
                  phase_id: phase.id,
                  event_type: "player_eliminated",
                  visibility: "public",
                  payload: {
                    user_id: candidate.user_id,
                    display_name: candidate.display_name,
                    role: candidate.role,
                    faction: candidate.faction,
                    cause: "vote",
                  },
                }),
            );
          }
        }

        requireNoError(
          await supabase
            .from("match_events")
            .insert({
              match_id: matchId,
              phase_id: phase.id,
              event_type: "verdict_resolved",
              visibility: "public",
              payload: {
                candidate_user_id: candidateUserId,
                approve: verdict.approve,
                reject: verdict.reject,
                skipped: verdict.skipped,
                approved: verdict.approved,
                executed,
                blocked_by_shield: blockedByShield,
              },
            }),
        );

        // 해가 저문다(루나): 1일 한정 — 처형 투표·찬반 투표가 끝나면 dawnRule 을 소비(0). 같은
        // 라운드에 처형 투표/찬반 양쪽이 같은 dawnRule 을 보고, 찬반 종료 시점에 만료된다.
        const { verdict: _verdict, modifiers: prevMods, ...restEngineState } = engineState;
        const nextModifiers = { ...(prevMods ?? {}) };
        if ((nextModifiers.dawnRule ?? 0) > 0) {
          nextModifiers.dawnRule = 0;
        }
        requireNoError(
          await supabase
            .from("matches")
            .update({ engine_state: { ...restEngineState, modifiers: nextModifiers } })
            .eq("id", matchId),
        );

        if (executed) {
          players = await loadPlayers(supabase, matchId);
          const win = await finishMatchIfWon(supabase, matchId, phase.id, players);
          if (win) {
            results.push({ matchId, advancedTo: "ended", winner: win.winner });
            continue;
          }
        }

        // 처형/부결 처리 후 다음 밤으로. 의심 투표(night_suspect)를 먼저 거친다.
        const transition = nextNightSuspectTransition(phase.phase_number, durations);
        nextPhaseType = transition.phaseType;
        nextDurationSec = transition.durationSec;
        nextPhaseNumber = transition.phaseNumber;
      }

      if (!nextPhaseType) {
        results.push({ matchId, skipped: true, reason: `Unsupported phase ${phase.phase_type}` });
        continue;
      }

      // M2-5 교착 안전망 — 최대 일수(gameLength.maxDays)에 도달했으면 다음 밤으로
      // 넘어가지 않고 우세 판정(checkTimeoutWinner: 카운트 비교, 동률=악마)으로 종착.
      // 다음 밤 진입의 단일 관문(부결/처형 후/일식 전부 night_suspect 경유)이라 여기 한 곳.
      // 근거: docs/gomdori-gameplay-verification.md P0-B (부활 루프 무한게임).
      if (
        nextPhaseType === PHASE_NIGHT_SUSPECT &&
        phase.phase_number >= GOMDORI_RULES.gameLength.maxDays
      ) {
        const finalPlayers = await loadPlayers(supabase, matchId);
        const finalState = playerStateFromRows(matchId, "ended", phase.phase_number, finalPlayers);
        const timeout = checkTimeoutWinner(finalState.players);
        const timeoutEndedAt = new Date().toISOString();

        requireNoError(
          await supabase
            .from("matches")
            .update({ winner: timeout.winner, status: "ended", ended_at: timeoutEndedAt })
            .eq("id", matchId),
        );

        requireNoError(
          await supabase
            .from("match_events")
            .insert({
              match_id: matchId,
              phase_id: phase.id,
              event_type: "game_ended",
              visibility: "public",
              payload: {
                winner: timeout.winner,
                winning_faction: timeout.winner === "angels" ? "angel" : "demon",
                alive_angels: timeout.aliveAngels,
                alive_demons: timeout.aliveDemons,
                timeout: true,
                max_days: GOMDORI_RULES.gameLength.maxDays,
                angel_count: timeout.angelCount,
                demon_count: timeout.demonCount,
                players: revealedPlayers(finalPlayers),
              },
            }),
        );

        results.push({ matchId, advancedTo: "ended", winner: timeout.winner, timeout: true });
        continue;
      }

      // 별이 떠오른 밤(세이카): 초신성 발동(starlitNext 표식) 다음 밤은 의심 투표를 생략하고
      // 곧장 밤으로 간다. 의심 진입의 단일 관문(maxDays 안전망 통과 후)이라 여기 한 곳에서 처리.
      if (nextPhaseType === PHASE_NIGHT_SUSPECT) {
        const starlit = (await loadPlayers(supabase, matchId)).filter(
          (p) => p.alive && (((p.engine_state as { counters?: { starlitNext?: number } } | null)?.counters?.starlitNext ?? 0) > 0),
        );
        if (starlit.length > 0) {
          for (const sp of starlit) {
            const c = { ...((sp.engine_state as { counters?: Record<string, number> } | null)?.counters ?? {}), starlitNext: 0 };
            requireNoError(
              await supabase.from("match_players").update({ engine_state: { ...(sp.engine_state || {}), counters: c } }).eq("match_id", matchId).eq("user_id", sp.user_id),
            );
          }
          requireNoError(
            await supabase.from("match_events").insert({ match_id: matchId, phase_id: phase.id, event_type: "starlit_night", visibility: "public", payload: { night_number: nextPhaseNumber } }),
          );
          nextPhaseType = PHASE_NIGHT;
          nextDurationSec = durations.night;
        }
      }

      const expectedEndedAt = new Date(Date.now() + nextDurationSec * 1000).toISOString();
      const newPhase = requireNoError(
        await supabase
          .from("match_phases")
          .insert({
            match_id: matchId,
            phase_number: nextPhaseNumber,
            phase_type: nextPhaseType,
            expected_ended_at: expectedEndedAt,
          })
          .select()
          .single(),
      ) as { id: string };

      requireNoError(
        await supabase
          .from("matches")
          .update({ status: nextPhaseType })
          .eq("id", matchId),
      );

      // 일식 추가 밤 (vault canon, B4) 표식 — 캐스트 라운드 night_resolve 가 다음
      // night_suspect 진입 시 eclipse_active=true 로 알린다. 그 다음 round (정상 밤)도
      // eclipsePending 보유자가 살아 있는 동안 추가 밤 컨텍스트라 표식 유지. UI(NightPhase)가
      // "일식의 밤" 안내를 켠다.
      const eclipseExtraNightActive = (await loadPlayers(supabase, matchId)).some((p) =>
        p.alive && (((p.engine_state as { counters?: { eclipsePending?: number } } | null)?.counters?.eclipsePending ?? 0) > 0)
      );

      requireNoError(
        await supabase
          .from("match_events")
          .insert({
            match_id: matchId,
            phase_id: newPhase.id,
            event_type: "phase_started",
            visibility: "public",
            payload: {
              phase_type: nextPhaseType,
              phase_number: nextPhaseNumber,
              expected_ended_at: expectedEndedAt,
              verdict_candidate_user_id: engineState.verdict?.candidateUserId || null,
              eclipse_active: eclipseExtraNightActive,
            },
          }),
      );

      results.push({ matchId, advancedTo: nextPhaseType });
    }

    return jsonResponse({ success: true, processed: results }, { origin });
  });
});
