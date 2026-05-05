import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

let client: SupabaseClient | null = null;

export const getSupabaseClient = (): SupabaseClient => {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  client ??= createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return client;
};
