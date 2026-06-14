import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, forbidden, withErrorHandling } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import {
  AI_BOT_USER_IDS,
  AI_PROVIDER_LABEL,
  AI_PROVIDERS,
  type AiProvider,
  getMatch,
  MAX_AI_PLAYERS,
  readJsonObject,
  readRequiredString,
  toPlayerSummary,
} from "../_shared/game.ts";

// match-invite-ai (ADR-005): 호스트가 로비에서 AI 용병 1명을 영입한다.
// - 미사용 프로바이더(chatgpt/gemini/claude) 중 랜덤 1 + 미사용 봇 슬롯 1.
// - AI 는 인원수에 포함되고 ready=true(준비 체크를 막지 않음).
// - 정체(프로바이더)는 처음부터 공개 — display_name=모델명, ai_provider=키.
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
      throw conflict("invalid_status", "로비 상태에서만 AI를 영입할 수 있습니다.");
    }
    if (match.hostUserId !== claims.sub) {
      throw forbidden("not_host", "방장만 AI를 영입할 수 있습니다.");
    }

    const supabase = getSupabaseAdmin();

    const { data: rows, error: rowsError } = await supabase
      .from("match_players")
      .select("user_id, is_ai, ai_provider")
      .eq("match_id", matchId);
    if (rowsError) throw rowsError;

    const players = rows ?? [];
    if (players.length >= 12) {
      throw conflict("match_full", "정원이 가득 찼습니다 (최대 12명).");
    }

    const aiPlayers = players.filter((p) => p.is_ai);
    if (aiPlayers.length >= MAX_AI_PLAYERS) {
      throw conflict("ai_limit", `AI는 최대 ${MAX_AI_PLAYERS}명까지 영입할 수 있습니다.`);
    }

    // 미사용 프로바이더 / 봇 슬롯 선택.
    const usedProviders = new Set(
      aiPlayers.map((p) => p.ai_provider).filter((p): p is string => typeof p === "string"),
    );
    const freeProviders = AI_PROVIDERS.filter((p) => !usedProviders.has(p));
    const usedUserIds = new Set(players.map((p) => String(p.user_id)));
    const freeSlots = AI_BOT_USER_IDS.filter((id) => !usedUserIds.has(id));

    if (freeProviders.length === 0 || freeSlots.length === 0) {
      throw conflict("ai_limit", `AI는 최대 ${MAX_AI_PLAYERS}명까지 영입할 수 있습니다.`);
    }

    const provider: AiProvider = freeProviders[Math.floor(Math.random() * freeProviders.length)];
    const botUserId = freeSlots[0];
    const displayName = AI_PROVIDER_LABEL[provider];

    const { data: player, error: playerError } = await supabase
      .from("match_players")
      .upsert(
        {
          match_id: matchId,
          user_id: botUserId,
          display_name: displayName,
          avatar_url: null,
          is_ai: true,
          ai_provider: provider,
          ready: true,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "match_id,user_id" },
      )
      .select("*")
      .single();
    if (playerError) throw playerError;

    const { error: eventError } = await supabase.from("match_events").insert({
      match_id: matchId,
      event_type: "player_joined",
      visibility: "public",
      payload: { userId: botUserId, displayName, isAi: true, aiProvider: provider },
    });
    if (eventError) throw eventError;

    return jsonResponse(
      { player: toPlayerSummary(player as Record<string, unknown>) },
      { origin },
    );
  });
});
