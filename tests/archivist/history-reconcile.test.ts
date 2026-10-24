import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelHistoryReconcileStatus, parseHistoryChannelIds, reconcileForwardSlice, startChannelHistoryReconcileWorker } from '../../src/archivist/channelHistoryReconcile.js';

const base = 1000000000000000000n;
const row = (offset: number) => ({ id: String(base + BigInt(offset)) });

test('forward history sorts snowflakes without Number precision loss and checkpoints after writes', async () => {
  const sequence: string[] = [];
  const result = await reconcileForwardSlice({
    cursor: String(base),
    fetchPage: async (after) => {
      sequence.push(`fetch:${after}`);
      return after === String(base) ? [row(2), row(1)] : [];
    },
    persist: async (rows) => { sequence.push(`persist:${rows.map((r) => r.id).join(',')}`); },
    checkpoint: async (cursor, done) => { sequence.push(`save:${cursor}:${done}`); },
  });
  assert.deepEqual(result, { cursor: row(2).id, caughtUp: true, checked: 2 });
  assert.deepEqual(sequence, [
    `fetch:${base}`, `persist:${row(1).id},${row(2).id}`, `save:${row(2).id}:false`,
    `fetch:${row(2).id}`, `save:${row(2).id}:true`,
  ]);
});

test('short nonempty pages are not terminal and a stream high-water mark is never consulted', async () => {
  const visited: string[] = [];
  const result = await reconcileForwardSlice({
    cursor: String(base),
    fetchPage: async (after) => BigInt(after) < base + 3n ? [{ id: String(BigInt(after) + 1n) }] : [],
    persist: async (rows) => { visited.push(...rows.map((r) => r.id)); },
    checkpoint: async () => {},
  });
  assert.deepEqual(visited, [row(1).id, row(2).id, row(3).id]);
  assert.equal(result.caughtUp, true);
});

test('storage failure leaves the cursor unchanged for replay', async () => {
  let saves = 0;
  await assert.rejects(reconcileForwardSlice({
    cursor: String(base), fetchPage: async () => [row(1)],
    persist: async () => { throw new Error('storage unavailable'); },
    checkpoint: async () => { saves += 1; },
  }), /storage unavailable/);
  assert.equal(saves, 0);
});

test('checkpoint failure does not fetch a later page', async () => {
  let fetches = 0;
  await assert.rejects(reconcileForwardSlice({
    cursor: String(base), fetchPage: async () => { fetches += 1; return [row(1)]; },
    persist: async () => {}, checkpoint: async () => { throw new Error('concurrent cursor change'); },
  }), /concurrent cursor change/);
  assert.equal(fetches, 1);
});

test('bounded slices resume at the last committed page', async () => {
  let saved = String(base);
  const result = await reconcileForwardSlice({
    cursor: saved, maxPages: 2,
    fetchPage: async (after) => [{ id: String(BigInt(after) + 1n) }],
    persist: async () => {}, checkpoint: async (cursor) => { saved = cursor; },
  });
  assert.equal(saved, row(2).id);
  assert.deepEqual(result, { cursor: saved, caughtUp: false, checked: 2 });
});

test('repeated or backwards pages fail rather than claiming catch-up', async () => {
  for (const offset of [0, -1]) {
    let writes = 0;
    await assert.rejects(reconcileForwardSlice({
      cursor: String(base), fetchPage: async () => [row(offset)],
      persist: async () => { writes += 1; }, checkpoint: async () => { writes += 1; },
    }), /did not advance/);
    assert.equal(writes, 0);
  }
});

test('fetch errors are not empty history', async () => {
  let saves = 0;
  await assert.rejects(reconcileForwardSlice({
    cursor: String(base), fetchPage: async () => { throw new Error('403'); },
    persist: async () => {}, checkpoint: async () => { saves += 1; },
  }), /403/);
  assert.equal(saves, 0);
});

test('empty confirmed history preserves the cursor', async () => {
  const saves: unknown[] = [];
  const result = await reconcileForwardSlice({
    cursor: String(base), fetchPage: async () => [],
    persist: async () => { assert.fail('no rows to persist'); },
    checkpoint: async (cursor, done) => { saves.push([cursor, done]); },
  });
  assert.equal(result.checked, 0);
  assert.deepEqual(saves, [[String(base), true]]);
});

test('channel scope is disabled by default, deduplicated, and rejects invalid or broad scope', () => {
  assert.deepEqual(parseHistoryChannelIds(''), []);
  assert.deepEqual(parseHistoryChannelIds(' 100000000000000001,100000000000000001 '), ['100000000000000001']);
  assert.throws(() => parseHistoryChannelIds('*'), /at most 10/);
  assert.throws(() => parseHistoryChannelIds('123'), /at most 10/);
  assert.throws(() => parseHistoryChannelIds(Array.from({ length: 11 }, (_, i) => row(i).id).join(',')), /at most 10/);
});

test('invalid cursors and page budgets cannot fetch or mutate', async () => {
  for (const input of [{ cursor: 'bad', maxPages: 1 }, { cursor: String(base), maxPages: 0 }]) {
    await assert.rejects(reconcileForwardSlice({
      ...input, fetchPage: async () => { assert.fail('must not fetch'); },
      persist: async () => { assert.fail('must not persist'); },
      checkpoint: async () => { assert.fail('must not checkpoint'); },
    }), /invalid history/);
  }
});

// APIRequest.route is a normalized bucket route; only path contains the
// actual channel ID. These checks must never log arbitrary webhook paths.
test('source observer uses full request path while preserving rate-limit waits', (t) => {
  const id = '100000000000000001';
  const oldScope = process.env.ARCHIVE_HISTORY_RECONCILE_CHANNEL_IDS;
  process.env.ARCHIVE_HISTORY_RECONCILE_CHANNEL_IDS = id;
  channelHistoryReconcileStatus.running = false;
  const handlers = new Map<string, (...args: any[]) => void>();
  const warnings: string[] = [];
  let scheduled = 0;
  t.mock.method(globalThis, 'setTimeout', (() => {
    scheduled += 1;
    return { unref() {} };
  }) as never);
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', (...args) => { warnings.push(args.map(String).join(' ')); });
  t.after(() => {
    if (oldScope === undefined) delete process.env.ARCHIVE_HISTORY_RECONCILE_CHANNEL_IDS;
    else process.env.ARCHIVE_HISTORY_RECONCILE_CHANNEL_IDS = oldScope;
    channelHistoryReconcileStatus.running = false;
  });
  const client = { rest: { on: (name: string, handler: (...args: any[]) => void) => { handlers.set(name, handler); } } };
  startChannelHistoryReconcileWorker(client as never, {} as never);
  const response = handlers.get('response');
  assert.ok(response);
  assert.equal(scheduled, 1, 'only the initial worker tick is scheduled');
  response({ route: '/channels/:id/messages', path: `/channels/${id}/messages?limit=100` }, {
    status: 429, headers: new Headers({ 'retry-after': '120', 'x-ratelimit-scope': 'shared' }),
  });
  assert.equal(channelHistoryReconcileStatus.lastSourceHttpStatus, 429);
  assert.equal(channelHistoryReconcileStatus.lastSourceRetryAfter, '120');
  assert.equal(warnings.length, 1);
  assert.equal(scheduled, 1, 'observation must not create a new request or retry timer');
  response({ route: '/webhooks/:id/:token', path: '/webhooks/private/DO_NOT_LOG' }, {
    status: 401, headers: new Headers(),
  });
  assert.equal(warnings.length, 1, 'unrelated secret-bearing paths are ignored');
  assert.ok(!warnings.join(' ').includes('DO_NOT_LOG'));
  assert.equal(channelHistoryReconcileStatus.lastSourceHttpStatus, 429);
  response({ route: '/channels/:id/messages', path: `/channels/${id}/messages` }, {
    status: 200, headers: new Headers(),
  });
  assert.equal(channelHistoryReconcileStatus.lastSourceHttpStatus, 200);
  assert.equal(channelHistoryReconcileStatus.lastSourceRetryAfter, null);
});
