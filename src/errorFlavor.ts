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
 *
 * P0 — postgrest-js only builds a real `PostgrestError` when PostgREST answered
 * with an HTTP error body. When the *fetch itself* fails (DNS, TLS, socket
 * reset, abort, headers overflow) it resolves a bare object literal instead:
 *
 *   { message: 'FetchError: fetch failed', details: '<stack>', hint: '', code: '' }
 *
 * Every field this module used to key on is empty there, so the label collapsed
 * to the constructor name — the literally useless "(Object)" users saw in
 * Discord, with `[object Object]` in the logs and `error_class='object'` in
 * muel_ai_events. A whole class of transport outages was therefore invisible in
 * telemetry. `errorTypeName` now recovers a real label from such objects, and
 * `errorDetail` gives callers a log/telemetry string that is never
 * `[object Object]`.
 */

const FLAVOR_LINES = [
  '어라? 알 수 없는 마법이 나를 방해하고 있어',
  '음... 보이지 않는 힘이 방금 그걸 막았어',
  '이런, 마법 회로가 잠깐 엉켰나 봐',
  '흠, 예상 못 한 주문이 끼어들었어',
  '어? 안 보이는 뭔가가 나를 붙잡고 있어',
];

/** `"FetchError: fetch failed"` / `"AbortError: ..."` -> the leading error name. */
const LEADING_ERROR_NAME_RE = /^([A-Za-z_$][\w$]*(?:Error|Exception))\b/;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

type ErrorLike = {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
  status?: unknown;
  statusCode?: unknown;
  cause?: unknown;
  constructor?: { name?: string };
};

export const errorTypeName = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error && typeof error === 'object') {
    const o = error as ErrorLike;
    const name = nonEmptyString(o.name);
    if (name) return name;
    const code = nonEmptyString(o.code);
    if (code) return code;
    if (typeof o.code === 'number') return String(o.code);

    // Transport-level postgrest failures: name/code are blank, but the message
    // is prefixed with the original error's name ("FetchError: fetch failed").
    const fromMessage = LEADING_ERROR_NAME_RE.exec(nonEmptyString(o.message) ?? '');
    if (fromMessage) return fromMessage[1]!;

    // Undici/native errors nest the real cause (getaddrinfo ENOTFOUND, ECONNRESET…).
    const cause = o.cause;
    if (cause && cause !== error) {
      const causeName = errorTypeName(cause);
      if (causeName && causeName !== 'UnknownError' && causeName !== 'Object') return causeName;
    }

    const status = typeof o.status === 'number' ? o.status : typeof o.statusCode === 'number' ? o.statusCode : null;
    if (status !== null && status > 0) return `HTTP(${status})`;

    const ctor = nonEmptyString(o.constructor?.name);
    if (ctor && ctor !== 'Object') return ctor;

    // Gateway-shaped errors carry only a short prose message and no code — e.g.
    // Supabase answering 402 once the project is over its plan's disk quota, or
    // 401 "No API key found in request". postgrest-js hands those to us as
    // `JSON.parse(body)` / `{ message: body }`, so the message is the only
    // identifying thing there is. Surfacing it beats a generic label.
    const message = nonEmptyString(o.message);
    if (message && !message.includes('\n') && message.length <= 60) return message;

    return 'UnknownError';
  }
  return typeof error;
};

/**
 * Human/log-readable detail for an unknown throwable. Unlike `String(error)`
 * this never degrades to `[object Object]`: postgrest-shaped objects are
 * flattened to `message | details | hint`, and anything else falls back to JSON.
 */
export const errorDetail = (error: unknown): string => {
  if (error instanceof Error) {
    const base = nonEmptyString(error.message) ?? error.name ?? 'Error';
    const causeDetail = error.cause && error.cause !== error ? errorDetail(error.cause) : '';
    return causeDetail && !base.includes(causeDetail) ? `${base} | caused by: ${causeDetail}` : base;
  }
  if (error && typeof error === 'object') {
    const o = error as ErrorLike;
    const parts = [nonEmptyString(o.message), nonEmptyString(o.details), nonEmptyString(o.hint)].filter(
      (part): part is string => part !== null,
    );
    const code = nonEmptyString(o.code) ?? (typeof o.code === 'number' ? String(o.code) : null);
    if (parts.length > 0) return code ? `${parts.join(' | ')} (code=${code})` : parts.join(' | ');
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // Circular or non-serializable — fall through.
    }
    return errorTypeName(error);
  }
  return String(error);
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
