import { errorDetail } from './errorFlavor.js';

/**
 * Supabase Fair Use restrictions are returned by PostgREST as plain objects,
 * usually with a prose message and no stable error code. Keep this predicate
 * narrow: schema bugs and ordinary database failures must still surface.
 */
export const isSupabaseQuotaRestriction = (error: unknown): boolean => {
  const detail = errorDetail(error);
  return /exceed_db_size_quota|service for this project is restricted|payment required/i.test(detail);
};
