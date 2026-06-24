import assert from "node:assert/strict";
import { GOMDORI_CODEX } from "../../src/gomdoriCodex.ts";
import { CORE_ROLES } from "../../supabase/functions/_shared/engine/roles.ts";

/**
 * 캐논 ↔ 엔진 구조 정합 검증 (2026-06-24).
 *
 * 로컬 캐논(gomdoriCodex.ts, kind=패시브/특수 패시브/능력/능력2 + actionType)과
 * 엔진(roles.ts actions.night[])이 어긋나지 않도록 고정한다. 직업 프로필이
 * "사용 슬롯 N개"로 보이던 미스매치의 재발 방지선.
 *
 * 규칙:
 *  1) 엔진 밤 슬롯은 전부 도감 능력(actionType)에 대응돼야 한다 — 고아 슬롯 금지.
 *  2) status:"live" + actionType 인 도감 능력은 엔진 밤 액션에 실제로 배선돼야 한다.
 *  3) 패시브(패시브/특수 패시브)인데 사용 슬롯(actionType)으로 노출된 능력은
 *     "의도된 야간 발동 패시브"로 명시 등록(KNOWN_PASSIVE_SLOTS)된 것만 허용.
 *     새로 생기면 실패 → 의도면 등록, 아니면 진짜 패시브로 전환(캐논 충실도, Stage 3).
 */

const PASSIVE_KINDS = new Set(["패시브", "특수 패시브"]);

// 엔진 액션(밤+낮) id 집합 (직업별)
const engineActions: Record<string, Set<string>> = {};
for (const r of CORE_ROLES) {
  const ids = [...(r.actions?.night ?? []), ...(r.actions?.day ?? [])].map((a) => a.id);
  engineActions[r.id] = new Set(ids);
}

// 의도된 "야간 발동 패시브" — 캐논상 패시브지만 적용에 밤 제출이 필요해 슬롯으로 노출.
// 캐논 충실도(Stage 3)에서 self 전용 항목은 자동/배정주입으로 전환해 이 목록에서 뺀다.
const KNOWN_PASSIVE_SLOTS = new Set<string>([
  "rainer:rainer_summon",      // 수호신 백호 (self 소환)
  "luru:luru_sonata",          // 소나타 (매료 3 누적 발동)
  "demon:daeakma_brand",       // 메피스토 낙인 (대상 지정)
  "phantom:phantom_silentnight", // 침묵의 밤 (self 연장)
  "phantom:phantom_seal",      // 어둠이 내린 도시 (대상 봉인)
  "malen:malen_possess",       // 악령 마야 (대상 빙의)
  "besto:besto_shift",         // 두 번째 자아 (self 변신)
  "ellen:ellen_persecute",     // 박해자 (self/자동 누진)
]);

let passiveSlotCount = 0;

for (const e of GOMDORI_CODEX) {
  const engine = engineActions[e.id] ?? new Set<string>();
  const canonActionTypes = new Map<string, { kind: string; name: string; status?: string }>();
  for (const a of e.abilities) {
    if (a.actionType) canonActionTypes.set(a.actionType, { kind: a.kind, name: a.name, status: a.status });
  }

  // 1) 엔진 밤 슬롯 ⊆ 도감 actionType (고아 슬롯 금지)
  for (const id of engine) {
    assert.ok(
      canonActionTypes.has(id),
      `[고아 슬롯] ${e.id}: 엔진 액션 '${id}' 에 대응하는 도감 능력(actionType)이 없음`,
    );
  }

  // 2) live + actionType 도감 능력은 엔진에 배선
  for (const a of e.abilities) {
    if (a.actionType && a.status === "live") {
      assert.ok(
        engine.has(a.actionType),
        `[미구현 live] ${e.id}: 도감 '${a.name}'(${a.actionType}, live) 가 엔진 액션에 없음`,
      );
    }
  }

  // 3) 패시브-as-슬롯 은 의도 등록된 것만
  for (const a of e.abilities) {
    if (PASSIVE_KINDS.has(a.kind) && a.actionType) {
      passiveSlotCount++;
      assert.ok(
        KNOWN_PASSIVE_SLOTS.has(`${e.id}:${a.actionType}`),
        `[패시브→슬롯] ${e.id}: 패시브 '${a.name}'(${a.actionType}) 가 사용 슬롯으로 노출됨 — ` +
          `의도면 KNOWN_PASSIVE_SLOTS 에 등록, 아니면 진짜 패시브로 전환(캐논 충실도)`,
      );
    }
  }
}

// 등록한 의도 갭이 실제로 전부 존재하는지(오타·이미 전환 정리)도 고정
for (const key of KNOWN_PASSIVE_SLOTS) {
  const [roleId, actionType] = key.split(":");
  const entry = GOMDORI_CODEX.find((e) => e.id === roleId);
  assert.ok(entry, `KNOWN_PASSIVE_SLOTS: 도감에 ${roleId} 없음`);
  const ab = entry.abilities.find((a) => a.actionType === actionType);
  assert.ok(ab, `KNOWN_PASSIVE_SLOTS: ${roleId} 에 ${actionType} 능력 없음(전환됐으면 목록에서 제거)`);
  assert.ok(PASSIVE_KINDS.has(ab.kind), `KNOWN_PASSIVE_SLOTS: ${key} 는 더 이상 패시브 아님 — 목록에서 제거`);
}

console.log(`Gomdori 캐논↔엔진 정합 checks passed (passive→slot 갭 ${passiveSlotCount}건 추적 중)`);
