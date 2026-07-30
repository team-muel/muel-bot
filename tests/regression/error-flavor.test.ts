/**
 * Regression for opaque error labels ("(Object)").
 *
 * Observed in #아무말 on 2026-07-30: every @Muel mention answered with
 * "흠, 예상 못 한 주문이 끼어들었어! (Object) 잠깐 뒤에 다시 불러줘." — a label that
 * says nothing, backed by `[object Object]` in the logs and error_class='object'
 * in muel_ai_events, so the outage was invisible in telemetry.
 *
 * Cause: postgrest-js only builds a real PostgrestError when PostgREST answered
 * with an HTTP error body. When the fetch itself fails it resolves a bare object
 * literal whose name/code are empty, which handlers then `throw`.
 *
 * Run: npx tsx tests/regression/error-flavor.test.ts
 */

import assert from 'node:assert/strict';
import { errorDetail, errorTypeName, flavorError } from '../../src/errorFlavor.js';
import { classifyAiError } from '../../src/muelAiEvents.js';

let passed = 0;
let failed = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`❌ ${name} — ${error instanceof Error ? error.message : String(error)}`);
    failed += 1;
  }
};

// Exactly the shape postgrest-js resolves when the fetch itself rejects.
const transportError = {
  message: 'FetchError: fetch failed',
  details:
    'TypeError: fetch failed\n\nCaused by: Error: getaddrinfo EAI_AGAIN db.example.supabase.co (EAI_AGAIN)',
  hint: '',
  code: '',
};

check('a transport-level postgrest failure no longer labels itself "(Object)"', () => {
  assert.equal(errorTypeName(transportError), 'FetchError');
  const copy = flavorError(transportError);
  assert.doesNotMatch(copy, /\(Object\)/);
  assert.match(copy, /\(FetchError\)/);
});

check('errorDetail never degrades to [object Object]', () => {
  const detail = errorDetail(transportError);
  assert.doesNotMatch(detail, /\[object Object\]/);
  assert.match(detail, /fetch failed/);
  assert.match(detail, /EAI_AGAIN/); // the actual cause survives into the log line
});

check('telemetry classification agrees with the user-facing label', () => {
  const { errorClass, errorMessage, status } = classifyAiError(transportError);
  assert.equal(errorClass, 'FetchError');
  assert.notEqual(errorClass, 'object');
  assert.doesNotMatch(errorMessage, /\[object Object\]/);
  assert.equal(status, 'error');
});

check('a real PostgrestError still reports its SQLSTATE, not the class name', () => {
  const pgError = { name: '', message: 'column does not exist', details: '', hint: '', code: '42703' };
  assert.equal(errorTypeName(pgError), '42703');
  assert.match(errorDetail(pgError), /code=42703/);
});

check('Error instances and their causes are unchanged / enriched', () => {
  assert.equal(errorTypeName(new TypeError('x')), 'TypeError');
  assert.equal(errorDetail(new TypeError('boom')), 'boom');
  const wrapped = new Error('outer', { cause: new Error('inner') });
  assert.match(errorDetail(wrapped), /outer/);
  assert.match(errorDetail(wrapped), /inner/);
});

check('an undici-style error with only a nested cause resolves the cause name', () => {
  const undiciish = { cause: { name: 'ConnectTimeoutError', message: 'Connect Timeout Error' } };
  assert.equal(errorTypeName(undiciish), 'ConnectTimeoutError');
});

check('a Supabase gateway error surfaces its message instead of a generic label', () => {
  // The 2026-07-30 outage itself: the project was over its free-plan disk quota,
  // so every REST call came back 402 with only a prose body. postgrest-js hands
  // that to callers as a bare `{ message }` (or JSON.parse of the body).
  const quotaError = { message: 'Payment Required' };
  assert.equal(errorTypeName(quotaError), 'Payment Required');
  assert.equal(errorTypeName({ message: 'No API key found in request', hint: 'no apikey header' }),
    'No API key found in request');
  // Long or multi-line bodies (an HTML error page) must not leak into Discord.
  assert.equal(errorTypeName({ message: '<!DOCTYPE html>\n<html><body>502</body></html>' }), 'UnknownError');
  assert.equal(errorTypeName({ message: 'x'.repeat(200) }), 'UnknownError');
});

check('a truly empty object degrades to UnknownError, never Object', () => {
  assert.equal(errorTypeName({}), 'UnknownError');
  assert.doesNotMatch(flavorError({}), /\(Object\)/);
});

check('schema-failure classification is preserved through the shared helpers', () => {
  const schemaErr = Object.assign(new Error('response did not match schema'), {
    name: 'AI_NoObjectGeneratedError',
  });
  const { isSchemaFailure, status } = classifyAiError(schemaErr);
  assert.equal(isSchemaFailure, true);
  assert.equal(status, 'fallback');
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
