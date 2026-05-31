import { preflight, jsonResponse } from "../_shared/cors.ts";
import { conflict, withErrorHandling } from "../_shared/errors.ts";
import { requireGameAuth } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import {
  findOpenMatchByDiscordChannel,
  findOpenMatchByInstance,
  getGameUser,
  readJsonObject,
  readRequiredString,
  toMatchSummary,
} from "../_shared/game.ts";

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
    const discordChannelId = readRequiredString(body, "discordChannelId");
    const discordGuildId =
      typeof body.discordGuildId === "string" && body.discordGuildId.trim()
        ? body.discordGuildId.trim()
        : null;
    const instanceId =
      typeof body.instanceId === "string" && body.instanceId.trim()
        ? body.instanceId.trim()
        : null;

    const existing = instanceId
      ? (await findOpenMatchByInstance(instanceId)) ?? (await findOpenMatchByDiscordChannel(discordChannelId))
      : await findOpenMatchByDiscordChannel(discordChannelId);
    if (existing) {
      return jsonResponse({ match: existing, created: false }, { origin });
    }

    const host = await getGameUser(claims.sub);
    const supabase = getSupabaseAdmin();
    const { data: matchRow, error: matchError } = await supabase
      .from("matches")
      .insert({
        host_user_id: host.id,
        context_type: "discord_voice",
        context_id: discordChannelId,
        notification_kind: "discord_channel",
        notification_id: discordChannelId,
        instance_id: instanceId,
      })
      .select("*")
      .single();
    if (matchError) throw matchError;

    const match = toMatchSummary(matchRow as Record<string, unknown>);

    const { error: playerError } = await supabase.from("match_players").insert({
      match_id: match.id,
      user_id: host.id,
      display_name: host.displayName,
      avatar_url: host.avatarUrl,
      is_host: true,
      last_seen_at: new Date().toISOString(),
    });
    if (playerError) {
      throw conflict("host_join_failed", playerError.message);
    }

    const { error: eventError } = await supabase.from("match_events").insert({
      match_id: match.id,
      event_type: "match_created",
      visibility: "public",
      payload: { hostUserId: host.id, discordChannelId, discordGuildId },
    });
    if (eventError) throw eventError;

    return jsonResponse({ match, created: true }, { origin });
  });
});
