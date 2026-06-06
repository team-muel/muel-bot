import assert from "node:assert/strict";
import { getPreflightGuard } from "../../src/capabilities.ts";

// 오발 회귀: 게임/고유명사 + 조사 "가" 가 "주가" 로 잡히면 안 됨.
assert.equal(getPreflightGuard("@Muel 명일방주가 뭐야")?.reason, undefined, "명일방주가 뭐야 → 금융 가드 발동 금지");
assert.equal(getPreflightGuard("우주가 뭐야"), null, "우주가 뭐야 → null");
assert.equal(getPreflightGuard("명일방주가 재밌어?"), null, "명일방주가 재밌어 → null (한글 앞글자)");

// 정의 질문은 금융 가드 제외 (LLM 이 설명).
assert.equal(getPreflightGuard("비트코인이 뭐야"), null, "비트코인이 뭐야 → 정의 질문, null");

// 진짜 시세/예측 질문은 여전히 가드.
assert.equal(getPreflightGuard("삼성전자 주가 얼마야")?.reason, "realtime_finance", "주가 얼마 → 가드");
assert.equal(getPreflightGuard("코스피 지금 어때")?.reason, "realtime_finance", "코스피 → 가드");
assert.equal(getPreflightGuard("테슬라 오를까 살까")?.reason, "realtime_finance", "예측 → 가드");

console.log("preflight finance regression passed.");
