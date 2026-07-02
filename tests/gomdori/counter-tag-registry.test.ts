import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CORE_ROLES } from "../../supabase/functions/_shared/engine/roles.ts";
import {
  COUNTER_TAG_NAMES,
  isKnownCounterTag,
} from "../../supabase/functions/_shared/engine/counter-tags.ts";

/**
 * 카운터/태그 이름 레지스트리 가드 (2026-06-27).
 *
 * PlayerState.counters(Record<string,number>) / tags(string[]) 는 자유 문자열이라
 * 타입 안전성이 없다 — 생산자(roles.ts 효과)와 소비자(engine.ts)가 같은 철자를
 * 써야 하는데 한 글자만 어긋나면 조용한 no-op. counter-tags.ts 레지스트리가 단일
 * 출처이고, 이 테스트가 양쪽을 거기에 고정한다:
 *   1) CORE_ROLES 가 생산하는 모든 카운터/태그 이름 ⊆ 레지스트리
 *   2) engine.ts 가 소비하는 모든 리터럴 카운터/태그 이름 ⊆ 레지스트리
 * 어느 한쪽에만 있는 오타는 다른 쪽에 없으므로 isKnownCounterTag 에서 걸린다.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 1) 생산자: CORE_ROLES 구조 순회로 카운터/태그 이름 수집 ──────────────────
type Loose = Record<string, any>;
const producer = new Map<string, string>(); // name -> 출처(roleId/abilityId)

function note(name: unknown, where: string) {
  if (typeof name === "string" && name.length > 0 && !producer.has(name)) {
    producer.set(name, where);
  }
}

function collectFromEffect(e: Loose, where: string) {
  note(e.tag, where);
  note(e.onlyIfTargetTag, where);
  note(e.skipIfTargetTag, where);
  note(e.onlyIfAnyPlayerTag, where);
  note(e.skipIfAnyPlayerTag, where);
  for (const g of [
    e.onlyIfTargetCounter,
    e.skipIfTargetCounter,
    e.onlyIfSourceCounter,
    e.skipIfSourceCounter,
    e.onlyIfAnyPlayerCounter,
    e.skipIfAnyPlayerCounter,
  ]) {
    if (g && typeof g === "object") note(g.key, where);
  }
}

function collectFromAbility(a: Loose, where: string) {
  note(a.targetCountCounter, where);
  if (a.requiresCounter) note(a.requiresCounter.key, where);
  if (a.onFireSetCounter) note(a.onFireSetCounter.key, where);
  if (a.onSaveGrantSelf) note(a.onSaveGrantSelf.counter, where);
  for (const e of a.effects ?? []) collectFromEffect(e, where);
}

for (const r of CORE_ROLES as Loose[]) {
  const rid = r.id;
  for (const p of r.passives ?? []) {
    for (const e of p.effects ?? []) collectFromEffect(e, `${rid}:passive`);
  }
  for (const a of [...(r.actions?.night ?? []), ...(r.actions?.day ?? [])]) {
    collectFromAbility(a, `${rid}:${a.id}`);
  }
  if (r.deathHook) {
    note(r.deathHook.perDeath?.counter, `${rid}:deathHook`);
    note(r.deathHook.convert?.from, `${rid}:deathHook`);
    note(r.deathHook.convert?.to, `${rid}:deathHook`);
  }
}

// ── 2) 소비자: engine.ts 소스에서 리터럴 카운터/태그 이름 수집 ────────────────
const engineSrc = readFileSync(
  join(__dirname, "../../supabase/functions/_shared/engine/engine.ts"),
  "utf8",
);
const consumer = new Set<string>();
const patterns: RegExp[] = [
  /counters\.([A-Za-z_]\w*)/g, // counters.willCount
  /counters\["([^"]+)"\]/g, // counters["foo"]
  /tags\.(?:includes|push|indexOf|filter|some|every)\("([^"]+)"\)/g, // tags.includes("dessert")
  /\btag === "([^"]+)"/g, // tag === "noticeSuppressed"
];
for (const re of patterns) {
  let m: RegExpExecArray | null;
  while ((m = re.exec(engineSrc)) !== null) consumer.add(m[1]);
}

// ── 3) 단언: 생산자/소비자 이름이 전부 레지스트리에 등록돼 있어야 한다 ─────────
const unknownProducer: string[] = [];
for (const [name, where] of producer) {
  if (!isKnownCounterTag(name)) unknownProducer.push(`${name} (roles ${where})`);
}
const unknownConsumer: string[] = [];
for (const name of consumer) {
  if (!isKnownCounterTag(name)) unknownConsumer.push(`${name} (engine.ts)`);
}

assert.deepEqual(
  unknownProducer,
  [],
  `미등록 카운터/태그(생산자 roles.ts) — counter-tags.ts 에 추가하거나 오타 수정:\n  ${unknownProducer.join("\n  ")}`,
);
assert.deepEqual(
  unknownConsumer,
  [],
  `미등록 카운터/태그(소비자 engine.ts) — counter-tags.ts 에 추가하거나 오타 수정:\n  ${unknownConsumer.join("\n  ")}`,
);

// ── 4) 레지스트리 위생: 죽은 항목(생산자·소비자 어디서도 안 쓰임)은 경고만 ─────
const observed = new Set<string>([...producer.keys(), ...consumer]);
const dead = COUNTER_TAG_NAMES.filter((n) => !observed.has(n));
if (dead.length > 0) {
  console.warn(`⚠️ counter-tags 레지스트리 미관측 항목(정리 후보): ${dead.join(", ")}`);
}

console.log(
  `Gomdori 카운터/태그 레지스트리 checks passed ` +
    `(생산자 ${producer.size} · 소비자 ${consumer.size} · 레지스트리 ${COUNTER_TAG_NAMES.length})`,
);
