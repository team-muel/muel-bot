/**
 * In-character error copy for user-facing failures.
 *
 * Instead of a flat "잠시 뒤 다시 시도해줘." this speaks in Muel's voice AND
 * surfaces the underlying error type/name so the message stays diagnosable:
 *
 *   flavorError(new TypeError('x'))
 *     -> "어라? 알 수 없는 마법이 나를 방해하고 있어! (TypeError) 잠깐 뒤에 다시 불러줘."
 *
 * Supabase / Postgrest errors aren't Error instances, so we also read `.name`
 * then `.code` (e.g. a Postgres SQLSTATE) before falling back to constructor name.
 */

const FLAVOR_LINES = [
  '어라? 알 수 없는 마법이 나를 방해하고 있어',
  '음... 보이지 않는 힘이 방금 그걸 막았어',
  '이런, 마법 회로가 잠깐 엉켰나 봐',
  '흠, 예상 못 한 주문이 끼어들었어',
  '어? 안 보이는 뭔가가 나를 붙잡고 있어',
];

export const errorTypeName = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error && typeof error === 'object') {
    const o = error as { name?: unknown; code?: unknown; constructor?: { name?: string } };
    if (typeof o.name === 'string' && o.name) return o.name;
    if (typeof o.code === 'string' && o.code) return o.code;
    if (typeof o.code === 'number') return String(o.code);
    return o.constructor?.name ?? 'UnknownError';
  }
  return typeof error;
};

export const flavorError = (
  error: unknown,
  opts: { retry?: boolean; line?: string } = {},
): string => {
  const line = opts.line ?? FLAVOR_LINES[Math.floor(Math.random() * FLAVOR_LINES.length)]!;
  const type = errorTypeName(error);
  const tail = opts.retry === false ? '' : ' 잠깐 뒤에 다시 불러줘.';
  return `${line}! (${type})${tail}`;
};
