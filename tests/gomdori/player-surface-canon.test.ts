import assert from "node:assert/strict";
import { GOMDORI_CODEX } from "../../src/gomdoriCodex.ts";

/**
 * 플레이어 표면 = 캐논 순수텍스트 가드 (2026-06-27).
 *
 * /도감 등 플레이어에게 노출되는 텍스트 필드(name·title·summary·abilities[].name·
 * abilities[].text)는 *캐논 순수 텍스트*만 담아야 한다 — 구현 상태칩·버전 마커
 * (v1/v2)·내부 식별자(카운터/이펙트/액션 id)가 새면 안 된다. 구현 메타는 내부
 * 전용 필드(v1·v2·status·actionType·vault)에만 둔다(플레이어 미노출).
 *
 * 이 가드는 그 분리를 데이터 차원에서 고정한다(수동 리뷰 → 자동). 누수 발견 시:
 *  - 캐논 표현으로 고쳐 쓰거나(예: "willCount≥2" → "강한 의지를 2회 모으면"),
 *  - 진짜 메타면 v1/v2 로 옮긴다.
 */

// 플레이어에게 보이는 텍스트 필드만 검사한다(v1/v2/status/actionType/vault = 내부 메타, 제외).
type Hit = { id: string; field: string; text: string; matches: string[] };

const RULES: { label: string; re: RegExp }[] = [
  // 버전 마커 — 캐논 문구에 v1/v2 가 들어갈 일은 없다.
  { label: "버전 마커", re: /\bv[12]\b/g },
  // 구현 상태/메타 단어.
  { label: "구현메타 단어", re: /구현됨|미구현|미완성|\bTODO\b|\bFIXME\b|\bWIP\b|planned|partial/gi },
  // 내부 식별자: camelCase(willCount·romazSuspect 등) — 한글 캐논엔 안 나온다.
  { label: "camelCase 식별자", re: /\b[a-z]+[A-Z][a-zA-Z0-9]*\b/g },
  // 내부 식별자: snake_case 액션 id(romaz_suspect·police_investigate 등).
  { label: "snake_case 식별자", re: /\b[a-z]{2,}_[a-z][a-z_]*[a-z]\b/g },
];

// 캐논 표현으로 정당한 ASCII 토큰(오탐 방지 화이트리스트). 필요한 것만 최소로.
const WHITELIST = new Set<string>([]);

function scan(id: string, field: string, text: string, hits: Hit[]) {
  if (!text) return;
  const matches: string[] = [];
  for (const { re } of RULES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!WHITELIST.has(m[0])) matches.push(m[0]);
    }
  }
  if (matches.length > 0) hits.push({ id, field, text, matches });
}

const hits: Hit[] = [];
for (const e of GOMDORI_CODEX) {
  scan(e.id, "name", e.name, hits);
  scan(e.id, "title", e.title, hits);
  scan(e.id, "summary", e.summary, hits);
  for (let i = 0; i < e.abilities.length; i++) {
    const a = e.abilities[i];
    scan(e.id, `abilities[${i}].name`, a.name, hits);
    scan(e.id, `abilities[${i}].text`, a.text, hits);
  }
}

if (hits.length > 0) {
  const report = hits
    .map((h) => `  ${h.id}.${h.field}: [${h.matches.join(", ")}]\n      "${h.text}"`)
    .join("\n");
  assert.fail(
    `플레이어 표면 텍스트에 내부 메타/식별자 누수 ${hits.length}건 — 캐논 표현으로 고치거나 v1/v2 로 이동:\n${report}`,
  );
}

console.log(`Gomdori 플레이어 표면 캐논 가드 passed (${GOMDORI_CODEX.length} 직업 검사)`);
