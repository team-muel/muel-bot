import { preflight, jsonResponse } from "../_shared/cors.ts";
import { withErrorHandling } from "../_shared/errors.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { resolveNightActions } from "../_shared/engine/engine.ts";
import type { MatchState } from "../_shared/engine/types.ts";

// Note: This endpoint is designed to be called by a pg_cron job or an external scheduler.
// Since it's server-to-server, we might want to protect it with a secret. For now, we allow it.
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

    const supabase = getSupabaseAdmin();

    // 1. Find an expired phase
    const { data: expiredPhases, error: findError } = await supabase
      .from("match_phases")
      .select(`
        id,
        match_id,
        phase_number,
        phase_type
      `)
      .lt("expected_ended_at", new Date().toISOString())
      .is("ended_at", null)
      .limit(10);
      
    if (findError) throw findError;

    if (!expiredPhases || expiredPhases.length === 0) {
      return jsonResponse({ message: "No expired phases to advance" }, { origin });
    }

    const results = [];

    // Process each expired phase
    for (const phase of expiredPhases) {
      const matchId = phase.match_id;
      
      // End the current phase
      await supabase
        .from("match_phases")
        .update({ ended_at: new Date().toISOString() })
        .eq("id", phase.id);

      // 1. Process Actions from the ending phase BEFORE state transition
      let eliminatedCause: string | null = null;
      let killedUserId: string | null = null;
      let nightEvents: any[] = [];
      
      if (phase.phase_type === "night") {
        const { data: actions } = await supabase
          .from("match_actions")
          .select("*")
          .eq("phase_id", phase.id);
          
        const { data: dbPlayers } = await supabase
          .from("match_players")
          .select("*")
          .eq("match_id", matchId);
          
        const { data: matchRecord } = await supabase
          .from("matches")
          .select("engine_state")
          .eq("id", matchId)
          .single();

        if (dbPlayers && matchRecord) {
          // Reconstruct State
          const state: MatchState = {
            matchId,
            dayCount: phase.phase_number,
            phase: "night",
            angelCount: 0,
            demonCount: 0,
            players: {},
            actionStack: actions ? actions.map(a => ({
              sourceUserId: a.actor_user_id,
              targetUserId: a.target_user_id,
              actionType: a.action_type,
              priority: a.action_type === "demon_kill" ? 4 : (a.action_type === "doctor_heal" ? 3 : 5)
            })) : [],
            modifiers: matchRecord.engine_state.modifiers || {}
          };
          
          for (const dp of dbPlayers) {
            state.players[dp.user_id] = {
              userId: dp.user_id,
              originalRole: dp.role,
              currentRole: dp.engine_state.currentRole || dp.role,
              baseVoteValue: dp.engine_state.baseVoteValue || 1,
              bonusVoteValue: dp.engine_state.bonusVoteValue || 0,
              suspicionValue: dp.engine_state.suspicionValue || 0,
              actualFaction: dp.faction,
              treatedAsFaction: dp.engine_state.treatedAsFaction || dp.faction,
              alive: dp.alive,
              markedForDeath: false,
              markedForAnnihilation: false,
              tags: dp.engine_state.tags || [],
              counters: dp.engine_state.counters || {}
            };
            if (dp.alive && dp.faction === "angel") state.angelCount++;
            if (dp.alive && dp.faction === "demon") state.demonCount++;
          }

          // Run Engine
          const { newState, events } = resolveNightActions(state);
          nightEvents = events;

          // Apply State Changes to DB
          for (const userId in newState.players) {
            const sp = newState.players[userId];
            const dp = dbPlayers.find(p => p.user_id === userId)!;

            if (dp.alive && !sp.alive) {
              killedUserId = userId;
              eliminatedCause = "night_kill";
              
              await supabase
                .from("match_players")
                .update({ 
                  alive: false, 
                  eliminated_at: new Date().toISOString(),
                  eliminated_phase_number: phase.phase_number,
                  eliminated_cause: eliminatedCause,
                  engine_state: {
                    ...dp.engine_state,
                    tags: sp.tags,
                    counters: sp.counters,
                    currentRole: sp.currentRole
                  }
                })
                .eq("match_id", matchId)
                .eq("user_id", userId);
            } else if (dp.alive) {
               // Update tags for living players
               await supabase
                .from("match_players")
                .update({ 
                  engine_state: {
                    ...dp.engine_state,
                    tags: sp.tags,
                    counters: sp.counters,
                    currentRole: sp.currentRole
                  }
                })
                .eq("match_id", matchId)
                .eq("user_id", userId);
            }
          }
          
          // Save Match Engine State
          await supabase
            .from("matches")
            .update({ engine_state: { modifiers: newState.modifiers } })
            .eq("id", matchId);
        }
      } else if (phase.phase_type === "vote") {
        const { data: actions } = await supabase
          .from("match_actions")
          .select("*")
          .eq("phase_id", phase.id)
          .eq("action_type", "vote");
          
        if (actions && actions.length > 0) {
          // simple majority vote tally
          const tallies: Record<string, number> = {};
          let maxVotes = 0;
          let maxUserId = null;
          let tie = false;
          
          for (const a of actions) {
            if (!a.target_user_id) continue;
            // Vote Engine scaling will go here later
            tallies[a.target_user_id] = (tallies[a.target_user_id] || 0) + 1;
            if (tallies[a.target_user_id] > maxVotes) {
              maxVotes = tallies[a.target_user_id];
              maxUserId = a.target_user_id;
              tie = false;
            } else if (tallies[a.target_user_id] === maxVotes) {
              tie = true;
            }
          }
          
          if (!tie && maxUserId) {
            killedUserId = maxUserId;
            eliminatedCause = "vote";
            
            await supabase
              .from("match_players")
              .update({ 
                alive: false, 
                eliminated_at: new Date().toISOString(),
                eliminated_phase_number: phase.phase_number,
                eliminated_cause: eliminatedCause
              })
              .eq("match_id", matchId)
              .eq("user_id", killedUserId);
          }
        }
      }

      // Record any events (deaths, tags, etc.)
      for (const ev of nightEvents) {
        await supabase
          .from("match_events")
          .insert({
            match_id: matchId,
            phase_id: phase.id,
            event_type: ev.type,
            visibility: "public", // we can make this conditional
            payload: ev.payload || { user_id: ev.userId },
          });
      }
      
      // Legacy Death Event mapping (keep for compatibility during transition)
      if (eliminatedCause === "vote" && killedUserId) {
        await supabase
          .from("match_events")
          .insert({
            match_id: matchId,
            phase_id: phase.id,
            event_type: "player_eliminated",
            visibility: "public",
            payload: { user_id: killedUserId, cause: eliminatedCause },
          });
      }

      // 3. Determine Next Phase
      let nextPhaseType = "ended";
      let nextDurationSec = 0;
      let nextPhaseNumber = phase.phase_number;

      // Simple state machine for Phase 1
      if (phase.phase_type === "role_assign") {
        nextPhaseType = "night";
        nextDurationSec = 60;
        nextPhaseNumber = 1;
      } else if (phase.phase_type === "night") {
        nextPhaseType = "night_resolve";
        nextDurationSec = 3;
      } else if (phase.phase_type === "night_resolve") {
        nextPhaseType = "day";
        nextDurationSec = 180;
      } else if (phase.phase_type === "day") {
        nextPhaseType = "vote";
        nextDurationSec = 60;
      } else if (phase.phase_type === "vote") {
        nextPhaseType = "verdict";
        nextDurationSec = 5;
      } else if (phase.phase_type === "verdict") {
        // Here we would check win conditions. 
        // Quick check:
        const { data: players } = await supabase
          .from("match_players")
          .select("faction, alive")
          .eq("match_id", matchId);
          
        const aliveAngels = players?.filter(p => p.alive && p.faction === "angel").length || 0;
        const aliveDemons = players?.filter(p => p.alive && p.faction === "demon").length || 0;
        
        if (aliveDemons === 0) {
          nextPhaseType = "ended";
          await supabase.from("matches").update({ winner: "angels", status: "ended", ended_at: new Date().toISOString() }).eq("id", matchId);
        } else if (aliveDemons >= aliveAngels) {
          nextPhaseType = "ended";
          await supabase.from("matches").update({ winner: "demons", status: "ended", ended_at: new Date().toISOString() }).eq("id", matchId);
        } else {
          nextPhaseType = "night";
          nextDurationSec = 60;
          nextPhaseNumber += 1;
        }
      }

      if (nextPhaseType !== "ended") {
        const expectedEndedAt = new Date(Date.now() + nextDurationSec * 1000).toISOString();
        
        // Insert next phase
        const { data: newPhase } = await supabase
          .from("match_phases")
          .insert({
            match_id: matchId,
            phase_number: nextPhaseNumber,
            phase_type: nextPhaseType,
            expected_ended_at: expectedEndedAt,
          })
          .select()
          .single();

        // Update match status (only if we didn't end it)
        if (nextPhaseType !== "ended") {
          await supabase
            .from("matches")
            .update({ status: nextPhaseType, current_phase_number: nextPhaseNumber })
            .eq("id", matchId);
        }

        // Emit public event
        await supabase
          .from("match_events")
          .insert({
            match_id: matchId,
            phase_id: newPhase?.id,
            event_type: "phase_started",
            visibility: "public",
            payload: { phase_type: nextPhaseType, phase_number: nextPhaseNumber, expected_ended_at: expectedEndedAt },
          });

        results.push({ matchId, advancedTo: nextPhaseType });
      }
    }

    return jsonResponse({ success: true, processed: results }, { origin });
  });
});
