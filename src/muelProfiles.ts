import type { SupabaseClient } from '@supabase/supabase-js';
import type { User } from 'discord.js';

const discordAvatarUrl = (user: User): string | null => {
  return user.avatarURL({ size: 128 }) ?? null;
};

export const upsertDiscordMuelProfile = async (
  supabase: SupabaseClient,
  user: User,
): Promise<string> => {
  const avatarUrl = discordAvatarUrl(user);

  const { data: existing, error: existingError } = await supabase
    .from('muel_profile_identities')
    .select('profile_id')
    .eq('provider', 'discord')
    .eq('provider_user_id', user.id)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existing?.profile_id) {
    const { error: updateProfileError } = await supabase
      .from('muel_profiles')
      .update({
        display_name: user.globalName ?? user.username,
        avatar_url: avatarUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.profile_id);

    if (updateProfileError) {
      throw updateProfileError;
    }

    const { error: updateIdentityError } = await supabase
      .from('muel_profile_identities')
      .update({
        username: user.username,
        avatar_url: avatarUrl,
        metadata: {
          global_name: user.globalName,
          bot: user.bot,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('provider', 'discord')
      .eq('provider_user_id', user.id);

    if (updateIdentityError) {
      throw updateIdentityError;
    }

    return existing.profile_id as string;
  }

  const { data: profile, error: profileError } = await supabase
    .from('muel_profiles')
    .insert({
      display_name: user.globalName ?? user.username,
      avatar_url: avatarUrl,
    })
    .select('id')
    .single();

  if (profileError) {
    throw profileError;
  }

  const { error: identityError } = await supabase
    .from('muel_profile_identities')
    .insert({
      profile_id: profile.id,
      provider: 'discord',
      provider_user_id: user.id,
      username: user.username,
      avatar_url: avatarUrl,
      metadata: {
        global_name: user.globalName,
        bot: user.bot,
      },
    });

  if (identityError) {
    throw identityError;
  }

  return profile.id as string;
};
