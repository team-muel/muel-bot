type MaybePostgresError = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
};

const POSTGRES_CONSTRAINT_CODES = new Set(['23502', '23503', '23505', '23514', '23P01']);

export const postgresErrorCode = (error: unknown): string | null => {
  if (!error || typeof error !== 'object') return null;
  const code = (error as MaybePostgresError).code;
  return typeof code === 'string' ? code : null;
};

export const isPostgresConstraintError = (error: unknown): boolean => {
  const code = postgresErrorCode(error);
  return Boolean(code && POSTGRES_CONSTRAINT_CODES.has(code));
};

export const postgresErrorClass = (error: unknown): string => {
  const code = postgresErrorCode(error);
  return code ? `PostgresConstraint(${code})` : 'PostgresError';
};

export const postgresErrorMessage = (error: unknown): string => {
  if (!error || typeof error !== 'object') return String(error);
  const maybe = error as MaybePostgresError;
  const message = typeof maybe.message === 'string' ? maybe.message : '';
  const details = typeof maybe.details === 'string' ? maybe.details : '';
  const hint = typeof maybe.hint === 'string' ? maybe.hint : '';
  return [message, details, hint].filter(Boolean).join(' | ') || String(error);
};
