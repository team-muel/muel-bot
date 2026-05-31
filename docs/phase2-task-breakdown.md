# Phase 2 (Gomdori 마피아 디자인 + 확장) 작업 분해

**진입 일자**: 2026-05-31
**전제**: Phase 1 MVP 5 archetype 기능 검증 완료 (vote/처형, WinCheck, pg_cron, 엔진 시뮬레이션). Phase 1 라이브 5인 Discord Activity QA 는 사용자 수동.
**관련**: `adr-001-bow-activity-architecture.md`, `phase1-task-breakdown.md`, vault `[[Universes/BoW/Lore/Gomdori-마피아-규칙]]`

## 사용자 결정 (2026-05-31)

> *하드코딩 박지 말기. 첫째 밤은 직업 배정 이후 바로 아침 돌입, 능력 사용 X.*

config-centric 뼈대를 먼저 정착 → 그 위에서 디자인·룰 작업을 안전하게 진행.

## 진입 PR (config-centric 뼈대, 완료)

- **muel-tree PR #3** *refactor(activity): centralize Discord credentials + DayPhase event matching* — `activities.ts` / `activity-server.ts` 중심화. switch 하드코딩 제거.
- **muel-bot PR #21** *feat(gomdori): rules manifest* — `_shared/gomdori-rules.ts` 신규. 페이즈 duration + 첫째 밤 비활성 + 승리 조건의 single source.
- **muel-tree PR #4** *feat(game): rules manifest + design tokens + /game/preview* — frontend 매니페스트, 디자인 토큰 (진영 색 / 페이즈 톤 / surface / 타이포), `/game/preview` 디자인 작업대.

매니페스트 sync 정책 ([[Gomdori-마피아-규칙]] §35): vault 본 카드 = 정본 → backend / frontend 매니페스트는 vault 갱신 후 PR.

## Phase 2 task 분해

### Task P2-1: 첫째 밤 능력 비활성 룰 구현

**상태**: 매니페스트는 신규 PR 들에 정착 완료. backend 측 phase-advance 구현이 남음.
**의존**: Codex Phase 1 Task 2-5 dirty 가 master 머지된 후.
**담당**: Codex (backend) / Claude (frontend UI 분기).

**스펙**:
- `supabase/functions/phase-advance/index.ts`:
  - `role_assign → night` transition 시 duration = `GOMDORI_RULES.firstNight.durationSec` (8초).
  - `night` 페이즈 처리 시 `phase.phase_number === 1` + `GOMDORI_RULES.firstNight.skipsAbilities` 면 `resolveNightActions` 스킵.
  - 대신 `first_night_silent` 이벤트 발행 (`payload: { day_number: 1 }`).
  - 바로 `day` phase 로 transition (`night_resolve` 거치지 않음).
- frontend `muel-tree/src/components/game/NightPhase.tsx`:
  - `first_night_silent` 이벤트 수신 시 능력 UI 숨김 + `GOMDORI_RULES.firstNight.silentMessage` 표시.
  - 또는 `match.day_count === 1` 컬럼 추가 후 그것으로 분기 (스키마 결정 필요).

**테스트**: 시뮬레이션에서 첫째 밤 능력 액션 무시 + first_night_silent 이벤트 발행 + 둘째 밤부터 정상 능력 발동 확인.

### Task P2-2: NightPhase 첫째 밤 분기 UI

**의존**: P2-1 backend.
**담당**: Claude (frontend).

**스펙**:
- `NightPhase.tsx` 가 `first_night_silent` 이벤트를 receive 또는 `match.day_count` 컬럼 read.
- 능력 선택 UI 숨김 + 안내 카드 표시 (`firstNight.silentMessage`).
- 디자인 토큰 `PHASE_TONES.night` + `SURFACE.statusBlock` 만 사용.

### Task P2-3: 페이즈 컴포넌트 1차 폴리시

**의존**: PR muel-tree#4 머지 (디자인 작업대 + 토큰).
**담당**: Claude + 사용자 검토 사이클.

**스펙**:
- 7개 페이즈 컴포넌트 (Lobby/RoleAssign/Night/Day/Vote/Verdict/Result) 의 색·spacing·타이포를 `design-tokens.ts` 만 사용하도록 폴리시.
- 각 페이즈의 톤이 명확 (PHASE_TONES 적용).
- 진영 색상 일관 (FACTION_COLORS 적용).
- `/game/preview` 에서 사용자가 확인 후 PR 단위로 진행 (페이즈 1개 = PR 1개 정도).

### Task P2-4: 70 직업 능력 매니페스트

**스펙**:
- `_shared/gomdori-roles.ts` (또는 JSON) 신규 — 능력의 공통 부분 (이름·횟수·타이밍·타입) 매니페스트화.
- 고유 로직은 TS 이벤트 핸들러로 분리 (`_shared/engine/role-handlers/<id>.ts`).
- vault `[[Universes/BoW/Roles/*]]` 카드 → 매니페스트 자동 또는 반자동 변환 검토.
- frontend `gomdori-roles.ts` 와 sync (P2-1 패턴).

**관련**: ADR-001 § 3 (데이터 + hook 혼합).

### Task P2-5: 단편 노출 (게임 종료 화면)

**스펙**:
- 게임 종료 시 ResultPhase 에 각 플레이어 직업 카드 + 해당 직업의 **단편 인용** 표시.
- 단편 데이터 = vault `[[Universes/BoW/Plot-Threads/*]]` 의 정본 문장 한 줄 (예: 「오스이는 세이카가 이끌어낸 많은 기적들과 함께했다」).
- 인용 매니페스트 = `gomdori-quotes.ts` (직업 id → 단편 한 줄).
- vault → 매니페스트 변환 또는 직접 정착.

### Task P2-6: 모티프 시각화

**스펙**:
- vault `[[Universes/BoW/Lore/모티프-추적]]` 의 시각 어휘를 페이즈 / 능력 발동 시각으로 반영.
  - 잔불 대검 푸른 불꽃 (특정 천사 직업 능력 시각)
  - 케오베 굿거리 (조선 무속 모티프)
  - 시미아 인터스텔라 (블랙홀·중력·블루 라이트)
  - 세이카·세야카 별빛 (디오스쿠로이)
- 디자인 토큰 확장 (`design-tokens.ts` 에 motif-specific 클래스 추가).
- 사운드 옵션 검토 (Tone.js 또는 정적 mp3).

### Task P2-7: 매칭 큐 · 랭킹

**스펙**:
- 룸 코드 방식에서 매칭 큐로 진입 (ADR-001 § 2).
- 매칭 알고리즘: 인원 + 친밀도 + 직업 풀 균형 (단순부터).
- 랭킹 테이블 + "내가 만난 직업들" 컬렉션.
- DB 스키마 변경 + Edge Function 신규.

### Task P2-8: 음성 통합

**스펙**:
- Discord Activity 안에서 음성 채널 활용. `@discord/embedded-app-sdk` 의 voice API.
- 토론 페이즈 (day) 에 음성 push-to-talk 또는 자동 활성.

### Task P2-9: Migration drift 정리

**의존**: Phase 1 운영 안정화 후.
**담당**: Codex / 사용자.

**스펙**:
- 과거 13개 migration 의 timestamp drift 정리. `supabase db push --dry-run` 정상 통과.
- Codex `supabase-operations-playbook.md` 참조.

## 협업 흐름

- **사용자**: 룰 결정 + 디자인 방향 결정 + 최종 QA + 운영.
- **Claude**: vault 룰 + ADR/breakdown + UI/UX + 명세 변환 + frontend.
- **Codex**: Edge Function 게임 엔진 + pg_cron + 테스트 자동화 + Supabase 운영 + backend.

## 진행 우선순위 (권장)

1. PR #3 / #21 / #4 머지 → vercel 배포 → `/game/preview` 시각 검토.
2. Codex Phase 1 dirty 머지 (vote/verdict/WinCheck/pg_cron 잔여 + 운영 playbook).
3. Task P2-1 (첫째 밤 backend) + Task P2-2 (frontend UI 분기) 병행.
4. Task P2-3 (페이즈 컴포넌트 1차 폴리시) — `/game/preview` 작업대 위에서 사용자 검토 사이클.
5. Task P2-4 (70 직업 매니페스트) — vault Roles 카드와의 sync 패턴 정착.
6. Task P2-5 ~ P2-8 — 사용자 우선순위에 따라.
7. Task P2-9 — 운영 안정화 후.
