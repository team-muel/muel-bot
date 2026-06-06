# Gomdori Game-Track 작업 설계 (cross-repo)

작성 2026-06-07 · 정본 = vault `[[Universes/BoW/Lore/Gomdori-마피아-규칙]]` · 운영 sync = 본 문서 + `phase2-task-breakdown.md`
대상: `muel-bot`(엔진·권위) + `muel-tree`(UI) + Supabase(스키마) + vault(룰 정본)

**진행(2026-06-07)**: W2(투표 가중치)는 기존 구현 확인 — `tally*Votes`가 `baseVoteValue+bonusVoteValue` 사용. W3(카운트 승리) 머지 → muel-bot #44. 다음 = **W1 의심투표**, 페이즈 모델 = **새 `night_suspect` phase_type**(사용자 결정). 직업(W4) 보류, UI track 병행.

> 이 문서는 기존 `phase2-task-breakdown.md`(P2-1…P2-9)를 **대체하지 않고 정밀화**한다. 조사로 드러난 "이미 구현됨 / 선반영됨 / 미구현"을 반영해 다음 작업을 결정 가능한 단위로 쪼갠다.

---

## 0. 기준선 — 정본 vs 현재 구현

조사 결과(2026-06-07), 엔진은 MVP 설계서가 말하는 것보다 더 진행돼 있고 **타입 모델이 canon을 선반영**한다.

이미 구현(엔진/Edge):
- 전체 페이즈 머신: `role_assign → night → night_resolve → day → vote → verdict(찬반) → WinCheck → end` (`phase-advance/index.ts`).
- 첫째 밤 비활성 + `first_night_silent` (canon §34, P2-1) — **완료**.
- 5 archetype 능력: `demon_kill / doctor_heal / police_investigate`, `vote`, `verdict_approve/reject`.
- 인원별 분포 `generateRoles(5..12)` (`match-start`) — **결정론적, 이미 존재**.
- 죽음 원인 컬럼 `match_players.eliminated_cause / eliminated_phase_number`.
- 이벤트 소싱 `match_events` (+ public/private RLS), 페이즈 타임스탬프 `match_phases.expected_ended_at`(타이머 PR #20 이게 사용).

**선반영(타입에 있으나 로직 미사용)** — `engine/types.ts`:
`baseVoteValue, bonusVoteValue, suspicionValue, markedForDeath, markedForAnnihilation, tags, counters`.
→ 투표가치·의심가치·소멸·태그/카운터 시스템의 **자리(slot)는 이미 파여 있다**. 로직만 비었다.

현재 승리 판정(`engine.ts`): 단순 생존 패리티 — `aliveDemons===0 → angels`, `aliveDemons>=aliveAngels → demons`. canon의 카운트 시스템 아님.

---

## 1. 격차 목록 (canon에 있으나 미구현)

| ID | 메커니즘 | canon 근거 | 현재 | 비고 |
|---|---|---|---|---|
| G1 | **카운트 기반 승리** (생존=+1, 능력으로 개인/팀 카운트 가감, 조력자 천사변환 −1/+1, 백호 +3, 수호병 +1) | §1,§10 | 생존 패리티 | `counters` 필드 선반영. 능력 없으면 체감 0 → 직업과 함께 가동 |
| G2 | **의심 투표(밤)** — 밤토론→의심투표→행동, 최다의심자 그 밤 능력 불가 + 전원 공개, 천사팀 용의자 제외 | §2,§3 | 없음(밤=능력만) | archetype 불필요. 천사팀 게임성의 코어 |
| G3 | **투표가치 / 의심가치** (per-player, 기본 1, 능력으로 가감; 최다득표 단계에만, 찬반은 1) | §11,§12 | 없음 | `baseVoteValue/suspicionValue` 선반영 |
| G4 | **최후의 반론** 별도 발언 구간 | §2 | verdict=찬반에 통합 | 분리할지 결정 |
| G5 | **직업 선택 배정** (악마·조력자 본인 직업 선택, 이후 랜덤) | §5,§26 | 전원 랜덤 셔플 | 직업 풀>5 일 때 의미 |
| G6 | **직업 매니페스트 + 핸들러** (68직업: 천사33·악마14·조력자14·중립7) | §21,§26 / P2-4 | 5 archetype | 데이터+hook. 가장 큰 콘텐츠 |
| G7 | **중립 직업** (각자 고유 단독 승리: 렌·파스아·아렌·베이즈·캐서린 …) | §1 중립 | 없음 | 승리 판정 다분기 |
| G8 | **죽음 종류** 탈락(부활 가능)/처형/소멸(부활 불가) 능력 연동 | §8,§19 | 컬럼만 | `markedForAnnihilation` 선반영 |
| G9 | **통지 타이밍** 탈락은 *다음 페이즈 시작*에 일괄 | §14,§16 | 부분 | 표준화 필요 |
| — | 콘텐츠/인프라: P2-5 단편 · P2-6 모티프 · P2-7 매칭큐 · P2-8 음성 | — | 없음 | 별도 우선순위 |

---

## 2. 설계 원칙 (운영)

1. **정본 = vault.** 룰 변경은 vault 카드 먼저 → 매니페스트 2곳(`muel-bot/.../gomdori-rules.ts`, `muel-tree/src/config/gomdori-rules.ts`) PR 동시 (canon §35). 매니페스트는 *작동 상수*만, vault는 *의도·예시*까지.
2. **권위 = 게임 서버.** 모든 판정은 Edge Function + Supabase. 클라는 표시·입력만 (ADR-001 §0-3).
3. **이벤트 소싱.** 모든 행동 `match_events` append-only; UI는 스트림 구독 (P2 원칙 5).
4. **엔진 먼저, 콘텐츠 나중.** 메커니즘(G1~G3)을 직업보다 먼저 단단히 — 직업은 그 위 플러그인.
5. **cross-repo 단위.** 각 작업 = vault 갱신 + muel-bot PR + muel-tree PR 한 묶음. 한쪽만 머지 금지.

---

## 3. 의존성·시퀀싱

```
[메커니즘 코어]  G2 의심투표 ─┐
                 G3 가중치 ───┼─> G1 카운트 승리 ─┐
                 G9 통지표준 ─┘                    ├─> G6 직업 매니페스트+핸들러 ─> G5 직업선택배정 ─> G7 중립
[독립]           G4 반론분리(소규모)                │
                 G8 죽음종류(능력 도입 시)──────────┘
[콘텐츠/인프라]  P2-5 단편 · P2-6 모티프 · P2-7 매칭큐 · P2-8 음성  (병렬, 우선순위 별도)
[UI track]       A 프리미티브 · D a11y · E/F/M · G 로비체크 (muel-tree 단독, 게임트랙과 병행 가능)
```

핵심: **G2(의심 투표)는 직업 0개로도 가능**하고 천사팀 게임성을 즉시 키운다 → 메커니즘 코어의 가장 좋은 출발점. G6(직업)은 가장 크고 G1/G3 위에 선다.

---

## 4. 작업 단위 (cross-repo)

각 단위: 규모(S/M/L), vault/bot/tree 분담, 수용 기준.

### W1 — 의심 투표(밤) G2  · 규모 L  · **페이즈 모델: 새 `night_suspect` (결정)**

canon §2(밤: 밤토론→의심투표→행동), §3(의심), §4(부결/동률). 페이즈 순서:

```
role_assign → (첫밤? night[silent] : night_suspect) → night → night_resolve → day → ...
첫밤(phase_number=1): 기존대로 night silent 후 바로 day (의심·능력 모두 skip).
둘째밤+: night_suspect(의심 투표) → night(행동, 최다의심자 능력잠금) → night_resolve.
```

스키마: `match_phases.phase_type` / `matches.status` / `match_actions.action_type` 모두 `text` → **마이그레이션 불필요**. 새 값 `night_suspect`(phase/status), `suspect`(action)만 추가.

**W1a — 엔진 (muel-bot, 테스트 검증)**
- `tallySuspicionVotes(actions, players)`: 의심가치 가중 = `max(0, 1 + suspicionValue)`(canon §12 기본 1; 필드 default 0 → 1). 최다 1인 → candidate, 동률/무표 → null(부결, canon §4).
- `resolveNightActions`: actor.tags에 `TAG_SUSPECTED` 있으면 그 actor의 night 행동 skip + `action_blocked_suspected` 이벤트. (정리 단계에서 태그 제거.)
- 수용: 의심 집계 후보/부결 정확, 잠긴 actor의 kill/heal 무시. 신규 sim 테스트.

**W1b — phase-advance + 매니페스트 (muel-bot)**
- `gomdori-rules.ts`(vault→backend→frontend) phases에 `night_suspect.durationSec`(예: 30) 추가.
- `phase-advance`: role_assign→(첫밤 분기). night_suspect 종료 시 `tallySuspicionVotes` → candidate에 `TAG_SUSPECTED` set + `suspicion_revealed`(public, payload {user_id|null, tie}) 발행 → night 로 transition. night는 기존 흐름(행동→night_resolve)인데 잠긴 actor 행동 무효.
- 수용: 둘째밤부터 night_suspect 등장, 부결 시 전원 행동 가능, 후보는 그 밤 능력 불가. (가능하면 phase-advance 단위 테스트.)

**W1c — frontend (muel-tree)**
- `matches.status === "night_suspect"` 분기: 의심 투표 UI(생존자 타겟 + 기권), `suspect` 액션 제출.
- night 진입 시 `suspicion_revealed` 수신 → 최다 의심자 공개 배너. 본인이 잠겼으면 능력 UI 잠금 + 사유 표시. 부결이면 "의심 부결" 안내.
- 타이머(PR #20)는 `night_suspect`에도 자동 적용(phaseEndsAt 기존 경로).
- 수용: typecheck/lint. 라이브 플레이테스트는 사용자.

**시퀀스**: W1a(엔진+테스트) → W1b(phase-advance+매니페스트 cross-repo) → W1c(UI). 각 PR 독립 머지, W1a 먼저(가장 안전·검증 가능).

### W2 — 투표가치/의심가치 G3 · 규모 M
- **muel-bot**: 최다득표·최다의심 집계를 `baseVoteValue+bonusVoteValue` / `suspicionValue` 가중으로. 찬반은 1 고정(canon §11). 집계 함수만 교체, 능력이 값을 바꾸는 건 W4에서.
- **muel-tree**: 표 집계 표시(선택), 자기 가치 노출.
- **수용**: 가중치 1일 때 기존과 동일(회귀 0). 가중치 주입 시 집계 반영. 단위 테스트.

### W3 — 카운트 기반 승리 G1 · 규모 M (W2 후)
- **vault**: 카운트 규칙 확정(생존 +1, 조력자 변환, 백호/수호병 등 — 직업 도입 전엔 기본 카운트만).
- **muel-bot**: WinCheck를 `teamCount` 기반으로 일반화(`counters` 활용). 능력 없는 현 상태에선 결과가 생존 패리티와 동일하도록(회귀 0).
- **수용**: 5 archetype 게임 결과 불변. 카운트 가감 훅 존재. 테스트.

### W4 — 직업 매니페스트 + 핸들러 G6 (P2-4) · 규모 L (트랜치로 분할)
- **vault**: `[[Universes/BoW/Roles/*]]` 카드 → 능력 공통부(이름·횟수·타이밍·타입) 매니페스트화 검토.
- **muel-bot**: `_shared/gomdori-roles.ts`(데이터) + `engine/role-handlers/<id>.ts`(고유 로직). 엔진이 핸들러를 디스패치. baseVoteValue/suspicionValue/counters/마킹을 능력이 변경.
- **muel-tree**: `gomdori-roles.ts` sync + 직업별 밤 UI(RoleAssign/Night 일반화).
- **수용**: 트랜치 단위(직업 N개)로 머지. 각 직업 시뮬 테스트. **트랜치 범위는 사용자 결정(질문)**.

### W5 — 직업 선택 배정 G5 · 규모 M (W4 후)
- **muel-bot**: `match-start` 배정 순서 악마→조력자(직업 선택)→랜덤. RoleAssign에 선택 스텝.
- **muel-tree**: 악마/조력자 직업 선택 UI.
- **수용**: 악마·조력자가 풀에서 선택, 나머지 랜덤. 대천사 룰(canon §5) 후속.

### W6 — 중립 직업 G7 · 규모 L (W3·W4 후)
- **vault**: 중립 승리 조건 확정(렌/파스아/… 우선순위).
- **muel-bot**: WinCheck 다분기(중립 단독 승리), 배정 0~2.
- **muel-tree**: 중립 UI/결과.
- **수용**: 중립 승리 조건 독립 판정. **도입 시점·첫 중립 = 사용자 결정(질문)**.

### W7 — 죽음 종류/부활 G8 · 규모 S~M (능력 도입과 함께)
- **muel-bot**: 탈락(부활 가능)/소멸(`markedForAnnihilation`, 부활 불가) 구분, 부활은 능력 매개(canon §19). 통지 G9 표준화(다음 페이즈 시작 일괄).
- **수용**: 소멸 대상 부활 불가, 탈락 대상 능력으로 부활.

### W8 — 최후의 반론 분리 G4 · 규모 S
- 현 verdict(찬반)에 후보 발언 구간을 명시(타임박스/표시). 분리 vs 유지는 결정(질문).

> 콘텐츠/인프라 P2-5(단편)·P2-6(모티프)·P2-7(매칭큐)·P2-8(음성)은 기존 breakdown 유지. 이번 사이클 포함 여부 = 질문.

---

## 5. 권장 로드맵

1. ~~W2 가중치~~(기존 구현) → ~~W3 카운트 승리~~(머지 #44) — 토대 완료.
2. **W1 의심 투표** — W1a→W1b→W1c. 코어에 남은 유일한 큰 건. **진행 중**.
3. **W4 직업 매니페스트(트랜치)** — 가장 큰 콘텐츠. 트랜치 범위는 사용자.
4. **W5 직업선택 → W6 중립 → W7 죽음/부활** — 직업 위에 순차.
5. **W8 반론분리** 및 콘텐츠/인프라 — 우선순위에 따라 삽입.
6. **UI track(A/D/E/F/M)** — muel-tree 단독, 위와 병행.

---

## 6. 결정 필요 (사용자)

1. **메커니즘 출발점**: W1 의심투표 / W2-3 카운트엔진 / W4 직업 / W6 중립 중 무엇부터?
2. **직업 트랜치(W4)**: 소수 고임팩트부터 / 중립(파스아 교주)부터 / 68 전체 매니페스트화(로직 점진) / 메커니즘 먼저라 보류?
3. **중립 도입(W6)**: 이번 사이클 / Phase 후순위? (밸런스 목표치 — 예: 악마 승률 타깃 — 있으면)
4. **반론(W8)**: 별도 발언 페이즈로 분리 / 현 verdict 통합 유지?
5. **UI track vs Game track**: UI 먼저 마무리 / 게임 먼저 / 병행(내가 인터리브)?
6. **콘텐츠·인프라**: P2-5 단편 / P2-6 모티프 / P2-7 매칭큐 / P2-8 음성 중 이번 사이클 포함할 것?
