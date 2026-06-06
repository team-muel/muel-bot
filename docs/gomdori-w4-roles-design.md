# Gomdori W4 — 직업 확장 작업 설계 (2026-06-07)

결정 반영: **밸런스 = 악마 약간 유리 · W4 첫 트랜치 = 소수 고임팩트 · 중립(W6) = Phase 후순위.**
정본: vault `[[Universes/BoW/Characters/*]]` (직업 70). 협업: User = 능력 설계 정본 · Claude/Codex = 매니페스트+엔진 핸들러+UI.

---

## 0. 핵심 현실: 엔진 갭

현재 엔진(`_shared/engine`)의 능력 모델은 단순하다:
- `RoleDefinition.actions.night[].effects[]` + `applyEffect` 가 처리하는 Effect: **Kill / Heal / Protect / AddTag / RemoveTag / ChangeFaction** 만.
- 타입(`types.ts`)엔 슬롯이 더 파여 있음(미사용): `ModifyVoteValue`, `Annihilate`, `RevealRole` Effect + `baseVoteValue/bonusVoteValue/suspicionValue/markedForAnnihilation/counters/tags` 필드.

그런데 vault BoW 직업은 **다단계·조건부**다:
- **로마즈**(천사 경찰): 용의자 지목 → +5 투표가치/+10 의심가치, 조사장 3개 충전 → 강제 구금, 신념(조건부 탈락).
- **라이너**(천사): 백호 패시브 → 천사 카운트 +3(생존 무관), 강한 의지 충전 → 거친 포효(카운트 -1 + 2명 그어 조건부 소멸).
- **줄**(천사): 생존 시 전원 악마 취급(조사 왜곡) → 대가 중첩 → 원죄, 용서(취급 뒤집기).

→ 이 능력들을 **그대로** 구현하려면 충전 카운터·조건 트리거·취급 변환 캐스케이드·다중 타겟·조건부 소멸 등 **엔진 대공사**가 필요하다. "소수"라도 한 직업이 고비용.

---

## 1. 권장 접근: 2단계로 쪼갠다

### v1 (이번 트랜치) — *핵심 메커닉만*, 엔진 슬롯에 매핑되는 것 우선
다단계 서브시스템(조사장/충전/원죄 등)은 빼고 **각 직업의 시그니처 한 줄**만 구현. 추가로 필요한 Effect 핸들러는 *3개*뿐:
- `ModifyVoteValue` → `bonusVoteValue += amount` (이미 tally가 사용).
- `ModifySuspicion`(신규 type) → `suspicionValue += amount` (의심 tally가 사용).
- `CountBuff`(또는 `counters.deadCountBonus` 직접 set) → W3 카운트 승리 훅(이미 가동).

`RevealRole`/`Annihilate` 핸들러도 같이 추가해두면 후속 직업이 데이터로 붙는다.

### v2 (후속) — 다단계 능력
충전 카운터(`counters`), 조건 트리거(passive `condition` 평가), 취급 변환(`treatedAsFaction` 캐스케이드)을 엔진에 도입한 뒤 로마즈 조사장/줄 원죄 등 풀 구현.

---

## 2. v1 트랜치 후보 (소수 고임팩트, 악마 약간 유리)

**주의 — 밸런스 방향성**: 로마즈·라이너는 *천사 강화*라, 그것만 넣으면 천사 유리로 기운다. 악마 약간 유리를 맞추려면 **악마측 고임팩트 1개 이상**을 함께 넣어야 한다. 현재 악마는 단순 킬뿐이라 디스럽션형 악마/조력자 변형이 필요.

권장 v1 트랜치(엔진 비용 낮은 순):
1. **라이너(천사)** — 백호 패시브 = 천사 카운트 +3(생존 무관). 엔진 비용 최저(W3 `deadCountBonus` set). *천사 강화.*
2. **로마즈(천사)** — 핵심만: 지목 대상 +투표가치/+의심가치(ModifyVoteValue/ModifySuspicion). 조사장/신념 제외. *천사 강화.*
3. **악마측 1개 (User 선택 필요)** — 균형상 필수. 예: 조사 왜곡 악마(경찰 결과 무력화) 또는 킬 보호형 조력자. vault 악마 슬롯(대악마/가인/세야카 등)에서 *시그니처 한 줄이 디스럽션인* 직업을 골라야.

→ 이렇게 천사 2 + 악마 1(강력)로 **악마 약간 유리** 튜닝. 정확한 수치는 라이브/sim QA로 반복.

---

## 3. 구현 단위 (cross-repo, v1)

- **vault**: 선택된 직업 카드의 *v1 단순화 버전* 능력을 정본에 명시(원본 보존 + v1 구현 범위 주석).
- **muel-bot 엔진**: `applyEffect`에 ModifyVoteValue/ModifySuspicion/RevealRole/Annihilate 핸들러 추가(+sim 테스트). `engine/roles.ts`(또는 신규 `gomdori-roles.ts`)에 새 RoleDefinition 추가. `match-start.generateRoles` 분포에 신규 직업 편입(인원대별).
- **muel-tree**: `gomdori-roles` 매니페스트 sync(직업명/능력 1줄), RoleAssign 능력 설명, Night 능력 타겟 UI(직업별).
- **매니페스트 sync**(§canon 35): vault → backend → frontend 동시.

## 4. 결정 필요 (User)
1. **충실도** — v1 단순화(시그니처 한 줄)로 시작 vs 처음부터 풀 능력(엔진 대공사)?
2. **악마측 직업** — 균형상 필수. 어느 악마/조력자를 v1에 넣을지(vault 슬롯에서).
3. **천사측 확정** — 라이너+로마즈로 갈지, 다른 고임팩트로 바꿀지.

확정되면: 엔진 Effect 핸들러(decision-free) 먼저 구현 → 선택 직업 데이터+UI 순으로 cross-repo PR.
