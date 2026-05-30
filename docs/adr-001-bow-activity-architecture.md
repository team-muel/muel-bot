# ADR-001: BoW (Gomdori 마피아) Discord Activity 아키텍처

**상태**: Accepted (2026-05-30)
**대상**: muel-bot · muel-tree · Supabase
**관련**: `gomdori-mafia-design.md` (게임 룰 명세) · vault `[[Universes/BoW/Lore/Gomdori-마피아-규칙]]`

## 배경

BoW (블랙오어화이트) 가 추리 / 마피아 게임으로 5년 (2021~) 누적된 후, Discord Activity 로 실제 플레이 가능한 형태로 구현 단계 진입. 직업 풀 70+ 종 · 자투/무투 같은 비표준 메커닉 · 의심/처형 분리 · 단편 세계관 깊이가 표준 마피아와 차별점.

## 결정

### 1. 시스템 구조 — **muel-bot 백엔드 + muel-tree 프론트** (옵션 2)

- **muel-tree** (Vercel, Next.js 14): Discord Activity 프론트엔드. `@discord/embedded-app-sdk` 사용. 게임 UI 와 상태 표시만 담당. `(activities)/game/` 라우트.
- **muel-bot** (Render, TypeScript): 별도 `gomdoriClient` (Discord.js) 로 `/게임` 슬래시 명령 + Activity entry point. Activity 자동 launch 만 담당. 게임 룰·상태 변경의 권위 주체 아님.
- **게임 엔진 (Supabase Edge Function)**: `phase-advance` Edge Function 이 `match_phases` 만료 시 호출되어 페이즈 전환·액션 해석·이벤트 발행. TypeScript `engine.ts` (Supabase Edge `_shared/`). **게임의 권위는 여기**.
- **DB (Supabase)**: 이벤트 소싱 (`match_events` append-only) + 상태 테이블 (`matches`, `match_players`, `match_phases`). Realtime publication 으로 클라이언트 자동 구독.

### 2. 게임 진행 모델 — **룸 코드 / 정해진 시간 (Phase 1-2) → 매칭 큐 (Phase 3+)**

70 직업 균형이 자동 매칭 전에 사람 사회자 노하우 데이터로 축적되어야 함. 매칭 큐 너무 일찍 = 봇이 처리 못 하는 케이스 누적.

### 3. 직업 능력 처리 — **데이터 + hook 혼합**

능력의 공통 부분 (이름·횟수·타이밍·타입) = JSON 매니페스트. 고유 로직 = TS 이벤트 핸들러. vault [[Gomdori-마피아-규칙]] 의 통지·타이밍·페이즈가 이벤트로 매핑.

### 4. 클라이언트-서버 통신 — **REST 액션 제출 + Supabase Realtime 구독**

- 클라이언트가 `/api/match/...` REST 엔드포인트로 액션 제출 (gameJwt 인증).
- 클라이언트는 `match_events` Realtime 구독으로 상태 변화 자동 수신.
- 클라이언트는 *순수 표시* — 권위는 Edge Function 만.

### 5. Discord Activity Entry Point — **`/게임` = type=4 handler=2 (Activity Launch)**

Gomdori 봇이 등록하는 `/게임` 슬래시 명령은 Application Command Type 4 (Entry Point) + Handler 2 (Discord Activity Launch). Discord 가 자동으로 `https://muel-tree.vercel.app/game` Activity 를 띄움. **봇 인터랙션 핸들러를 거치지 않음**. 이전 chat input command (type=1) 동시 등록은 충돌 야기 → 제거 (이 ADR 채택 시점에 patch).

### 6. 운영 인프라

- Vercel (muel-tree 프론트)
- Render (muel-bot 봇 게이트웨이)
- Supabase (DB + Edge Functions + Realtime + Auth)
- Discord Application (Gomdori 별도 봇·Activity)
- 환경 변수: `GOMDORI_BOT_TOKEN`, `GOMDORI_APPLICATION_PUBLIC_KEY`, `NEXT_PUBLIC_GOMDORI_DISCORD_CLIENT_ID`

## 트레이드오프

### 채택안의 장점
- 인프라 재사용 (muel-tree weave Activity 패턴 그대로). 빠른 시작.
- 게임 권위가 Edge Function 1곳에 집중 → 클라이언트 신뢰 불필요.
- 이벤트 소싱으로 디버깅·관전·재현 모두 같은 채널.
- 봇과 게임 엔진 분리 → muel-bot 의 다른 책임 (멘션·구독·AI) 과 격리.

### 트레이드오프
- Render free tier 의 cold-start 가 muel-bot 가용성에 영향.
- Supabase Edge Function 의 stateless 제약 → 게임 상태는 DB 에 100% 의존.
- pg_cron 활성화 없으면 phase-advance 자동 호출 안 됨 (현재 `20260516000000_setup_phase_advance_cron.sql` 주석 처리됨 — Phase 1 마무리에 활성화 필요).

## 거부된 대안

### 옵션 1: muel-tree 풀 활용 (모든 게임 로직을 muel-tree API 라우트)
- 거부 이유: muel-tree 가 *얇은 클라이언트* 정체성 잃음. 게임 / 다른 Activity 의 책임 충돌.

### 옵션 3: gomdori-server 분리 (별도 서비스)
- 거부 이유: 새 호스팅 추가 부담. 현재 단계 무리. Phase 4 이후 재고 가능.

### JSON-only 능력 데이터
- 거부 이유: 메타 능력 ([[대천사]] "천사팀에 직업 배정 X" 같은) 표현 한계.

### TypeScript-only 능력 (함수만)
- 거부 이유: 70 직업 = 70 함수. 룰 일관성 깨짐.

## Phase 1 결정 사항

- 직업 5종 (시민/의사/경찰/악마/조력자) 만 — `gomdori-mafia-design.md` §1.3 명세
- 4-8명 룸 (룸 코드 방식)
- 페이즈: Lobby → RoleAssign → Night → Day → Vote → Verdict → WinCheck → (End or Night N+1)
- 승리 조건: 천사 = 악마 0명, 악마 = 천사 ≤ 악마

## 변경 이력

- 2026-05-30: 초안. Phase 1 진단 결과 (Vote 집계·Game-end 판정·pg_cron 미완) 반영.
