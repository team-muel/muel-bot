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
import { GOMDORI_RULES } from "../_shared/gomdori-rules.ts";
import {
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
      let nextPhaseType: string | null = null;
      let nextDurationSec = 0;
      let nextPhaseNumber = phase.phase_number;

      if (phase.phase_type === "role_assign") {
        // 변종 선택 마감: 미선택 폴백 + 가인→악마 보호막 재계산 + 접선 회로. 그 뒤 첫째 밤으로.
        await finalizeRoleSelection(supabase, matchId, phase.id);
        const transition = firstNightTransition();
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
          nextDurationSec = GOMDORI_RULES.phases.day.durationSec;
        } else {
          const actions = requireNoError(
            await supabase
              .from("match_actions")
              .select("actor_user_id, target_user_id, action_type")
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
            actionType: action.actionType || "",
            // 봉인(세이카/팬텀)·변신(베스토 self)은 가장 먼저(1) — 대상 능력보다 앞서 처리.
            // 부활/치료=3, 처치=4, 조사·색출·포교·낙인·일식=5.
            priority:
              action.actionType === "seika_supernova" || action.actionType === "phantom_seal" || action.actionType === "logen_nullify" || action.actionType === "malen_possess" || action.actionType === "besto_shift" || action.actionType === "daeakma_dominion" ? 1
                : action.actionType === "demon_kill" || action.actionType === "phantom_nightmare" || action.actionType === "malen_release" || action.actionType === "besto_hidden" || action.actionType === "pasua_faith" ? 4
                : action.actionType === "doctor_heal" || action.actionType === "mizlet_revive" || action.actionType === "helen_revive" || action.actionType === "helen_sleep" || action.actionType === "arthur_emberblade" ? 3
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

          // 엔진 이벤트 가시성 분류 (2026-06-12): 마을 전체가 알아야 하는 결과만
          // public. 나머지(봉인·매료·빙의·전향·변신·낙인·차단 피드백 등)는 비밀
          // 정보라 영향받은 당사자에게만 private(recipient RLS)로 전달 — 전부
          // public 으로 쌓으면 포교/변신/낙인이 클라이언트에서 그대로 읽혔다.
          const PUBLIC_ENGINE_EVENTS = new Set(["player_died", "player_revived"]);
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
          nextDurationSec = GOMDORI_RULES.phases.nightResolve.durationSec;
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
        const transition = nightAfterSuspicionTransition(phase.phase_number);
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

        // 일식(팬텀): counters.eclipse 표식 보유자는 이 아침에 소멸하고, 아침(day) 대신
        // 다음 밤으로 넘어간다. 표식은 소비(0). 팬텀 소멸이 승패에 영향하므로 win 체크 전에.
        let eclipseActive = false;
        for (const p of players) {
          const counters = (p.engine_state as { counters?: { eclipse?: number } } | null)?.counters;
          if (p.alive && (counters?.eclipse ?? 0) > 0) {
            eclipseActive = true;
            const nextCounters = { ...(counters as Record<string, number>), eclipse: 0 };
            requireNoError(
              await supabase
                .from("match_players")
                .update({ alive: false, eliminated_at: endedAt, eliminated_phase_number: phase.phase_number, eliminated_cause: "night_kill", engine_state: { ...(p.engine_state || {}), counters: nextCounters } })
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
        if (eclipseActive) players = await loadPlayers(supabase, matchId);

        const win = await finishMatchIfWon(supabase, matchId, phase.id, players);
        if (win) {
          results.push({ matchId, advancedTo: "ended", winner: win.winner });
          continue;
        }

        if (eclipseActive) {
          // 아침을 건너뛰고 곧장 다음 밤(의심 투표)으로.
          const transition = nextNightSuspectTransition(phase.phase_number);
          nextPhaseType = transition.phaseType;
          nextDurationSec = transition.durationSec;
          nextPhaseNumber = transition.phaseNumber;
        } else {
          nextPhaseType = "day";
          nextDurationSec = GOMDORI_RULES.phases.day.durationSec;
        }
      } else if (phase.phase_type === "day") {
        nextPhaseType = "vote";
        nextDurationSec = GOMDORI_RULES.phases.vote.durationSec;
      } else if (phase.phase_type === "vote") {
        const actions = requireNoError(
          await supabase
            .from("match_actions")
            .select("actor_user_id, target_user_id, action_type")
            .eq("phase_id", phase.id)
            .eq("action_type", "vote"),
        ) as DbAction[];
        const state = playerStateFromRows(matchId, "vote", phase.phase_number, players);
        const tally = tallyEliminationVotes(actionRowsToInputs(actions), state.players);
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
          nextDurationSec = GOMDORI_RULES.phases.verdict.durationSec;
        } else {
          // 부결: 다음 밤으로. 둘째 밤부터는 의심 투표(night_suspect)를 먼저 거친다.
          const transition = nextNightSuspectTransition(phase.phase_number);
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
        const state = playerStateFromRows(matchId, "verdict", phase.phase_number, players);
        const verdict = tallyVerdictVotes(actionRowsToInputs(actions), state.players);
        const candidateUserId = engineState.verdict?.candidateUserId || null;
        const candidate = candidateUserId ? players.find((player) => player.user_id === candidateUserId) : null;
        let executed = false;
        let blockedByShield = false;

        if (verdict.approved && candidate?.alive) {
          const counters =
            candidate.engine_state?.counters && typeof candidate.engine_state.counters === "object" && !Array.isArray(candidate.engine_state.counters)
              ? { ...(candidate.engine_state.counters as Record<string, number>) }
              : {};
          const shield = typeof counters.shield === "number" ? counters.shield : 0;

          if (shield > 0) {
            blockedByShield = true;
            counters.shield = shield - 1;
            requireNoError(
              await supabase
                .from("match_players")
                .update({ engine_state: { ...(candidate.engine_state || {}), counters } })
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

        const { verdict: _verdict, ...restEngineState } = engineState;
        requireNoError(
          await supabase
            .from("matches")
            .update({ engine_state: restEngineState })
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
        const transition = nextNightSuspectTransition(phase.phase_number);
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
            },
          }),
      );

      results.push({ matchId, advancedTo: nextPhaseType });
    }

    return jsonResponse({ success: true, processed: results }, { origin });
  });
});
