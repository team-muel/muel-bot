import { preflight, jsonResponse } from "../_shared/cors.ts";
import { badRequest, unauthorized, withErrorHandling } from "../_shared/errors.ts";
import { issueGameJwt } from "../_shared/jwt.ts";
import { getSupabaseAdmin } from "../_shared/supabase-admin.ts";
import { readJsonObject } from "../_shared/game.ts";

type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
};

function discordAvatarUrl(user: DiscordUser): string | null {
  if (!user.avatar) return null;
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
}

async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw unauthorized("discord_auth_failed", "Discord access token is invalid.");
  }
  const user = (await res.json()) as DiscordUser;
  if (!user.id || !user.username) {
    throw unauthorized("discord_auth_failed", "Discord user payload is invalid.");
  }
  return user;
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

    const body = readJsonObject(await req.json().catch(() => null));
    const token = body.discordAccessToken;
    if (typeof token !== "string" || token.trim().length === 0) {
      throw badRequest("missing_discord_token", "discordAccessToken is required.");
    }

    const discordUser = await fetchDiscordUser(token.trim());
    const displayName = discordUser.global_name || discordUser.username;
    const avatarUrl = discordAvatarUrl(discordUser);
    const supabase = getSupabaseAdmin();

    const { data: existingIdentity, error: identityReadError } = await supabase
      .from("identities")
      .select("user_id")
      .eq("provider", "discord")
      .eq("provider_user_id", discordUser.id)
      .maybeSingle();
    if (identityReadError) throw identityReadError;

    let userId = existingIdentity?.user_id as string | undefined;

    if (!userId) {
      const { data: createdUser, error: createUserError } = await supabase
        .from("users")
        .insert({ display_name: displayName, avatar_url: avatarUrl })
        .select("id")
        .single();
      if (createUserError) throw createUserError;
      userId = String(createdUser.id);
    } else {
      const { error: updateUserError } = await supabase
        .from("users")
        .update({
          display_name: displayName,
          avatar_url: avatarUrl,
          updated_at: new Date().toISOString(),
        })
        .eq("id", userId);
      if (updateUserError) throw updateUserError;
    }

    const { error: upsertIdentityError } = await supabase.from("identities").upsert(
      {
        provider: "discord",
        provider_user_id: discordUser.id,
        user_id: userId,
        username: discordUser.username,
        avatar_url: avatarUrl,
        metadata: {
          global_name: discordUser.global_name ?? null,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "provider,provider_user_id" },
    );
    if (upsertIdentityError) throw upsertIdentityError;

    const gameJwt = await issueGameJwt(userId);
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

    return jsonResponse(
      { userId, displayName, avatarUrl, gameJwt, expiresAt },
      { origin },
    );
  });
});
