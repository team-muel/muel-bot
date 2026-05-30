# Phase 1 (Gomdori 마피아 MVP) 작업 분해

**대상**: 5 archetype (시민/의사/경찰/악마/조력자) 으로 게임 루프 end-to-end 검증
**진단 일자**: 2026-05-30 (Phase 1 진단 보고)
**관련**: `adr-001-bow-activity-architecture.md`, `gomdori-mafia-design.md`

## 현재 진단 (2026-05-30)

이미 거의 완성:
- muel-tree `/components/game/` 7개 페이즈 컴포넌트 (Lobby / RoleAssign / Night / Day / Vote / Verdict / Result) + `/(activities)/game/` 라우트
- muel-tree `ActivityLayout` Discord SDK 초기화 + auth + service-events 자동 로깅
- Supabase Edge Function `engine.ts` (직업 배정 · NightResolve · 조사 결과 · 사망 처리)
- Supabase Edge Function 7개 REST 엔드포인트 (`auth-exchange`, `match-create`, `match-join`, `match-start`, `match-ready`, `match-action`, `match-chat`)
- Realtime 구독 (`match_events` publication)
- muel-bot `gomdoriClient` 별도 Discord.js 인스턴스 + `/게임` 슬래시 명령

## 미완 — Phase 1 PR 단위 task (5개)

### Task 1: Gomdori 슬래시 명령 정리 — Activity entry point 만 등록

**상태**: ✅ Done (2026-05-30, ADR-001 채택 시)

- chat input `/게임` (type=1) + entry point `/게임` (type=4 handler=2) 동시 등록 → entry point 만 남김.
- fallback 텍스트 응답 주석으로 정리.
- 변경: `muel-bot/src/index.ts` + `muel-bot/src/discordInteractions.ts`

### Task 2: phase-advance Vote 집계 + 처형 대상 결정 로직

**담당**: Codex (Edge Function engine.ts)
**위치**: `muel-bot/supabase/functions/_shared/engine.ts` 또는 `muel-bot/supabase/functions/phase-advance/`

**스펙**:
- Vote 페이즈에서 모든 `match_actions` (또는 `match_events` of `vote_cast`) 집계.
- 최다 득표자 결정. 동률 시 부결.
- 최다 득표자가 결정되면 → Verdict 페이즈 진입 (찬반 투표).
- Verdict 페이즈 종료 시 찬성 다수 → 처형 (alive=false, role 공개, `match_events` 발행).
- 부결 시 다음 Night 으로.
- 자투 / 무투 처리 (vault [[Gomdori-마피아-규칙]] §3 참조).

**테스트**: 5인 게임 시뮬레이션에서 처형이 한 번 일어나는지 확인.

### Task 3: Game-end 판정 로직

**담당**: Codex
**위치**: `engine.ts` (각 페이즈 종료 시 호출되는 WinCheck 함수)

**스펙**:
- 매 페이즈 종료 시 `checkWinCondition(matchId)` 호출.
- 천사 승리: 살아있는 악마 수 == 0.
- 악마 승리: `aliveTeam('demon') >= aliveTeam('angel')`.
- 승리 결정 시:
  - `matches.status = 'ended'`
  - `matches.winner = 'angel' | 'demon'`
  - `match_events` 에 `game_ended` 이벤트 발행 (전 플레이어 직업 공개 포함)
- 클라이언트 `ResultPhase.tsx` 가 이 이벤트로 결과 화면 전환.

**테스트**: 시뮬레이션에서 천사 / 악마 각 승리 케이스 확인.

### Task 4: pg_cron 활성화 + phase-advance 스케줄

**담당**: Codex / 사용자 (Supabase 권한 필요)
**위치**: `muel-bot/supabase/migrations/20260516000000_setup_phase_advance_cron.sql`

**스펙**:
- `CREATE EXTENSION IF NOT EXISTS pg_cron;` + `pg_net` (Supabase 가 이미 enable 했을 수도, 확인 필요).
- 매 5초 또는 매 분마다 `phase-advance` Edge Function 호출 cron 등록.
- 환경 변수로 Edge Function URL + Auth Bearer 전달.

**대안**: pg_cron 부담스럽다면 외부 cron (Cloudflare Workers, Render scheduled job) 사용 가능.

**테스트**: 페이즈 만료 후 자동 전환 확인 (수동 호출 없이 게임이 멈추지 않음).

### Task 5: End-to-end 5인 시뮬레이션 테스트

**담당**: Codex (자동화) · 사용자 (수동 검증)
**위치**: `muel-bot/tests/gomdori/` 또는 `muel-tree/tests/`

**스펙**:
- Supabase test database (or 별도 schema) 에 5인 매치 시뮬레이션.
- 모든 페이즈 (Lobby → RoleAssign → Night → Day → Vote → Verdict → WinCheck) 순회.
- 의사/경찰/악마/조력자/시민 모든 능력 발동 케이스 1회씩.
- 천사 승리 케이스 1 + 악마 승리 케이스 1.

## Phase 2 이후 (참고)

- BoW 직업 점진 추가 (5 archetype → 70 직업). 능력 hook 매니페스트 시스템 구축.
- 단편 노출 (게임 종료 시 직업 단편 인용).
- 능력 시각화 (잔불 대검·굿거리·인터스텔라 톤).
- 매칭 큐 + 랭킹.
- 음성 통합 (Discord 보이스 채널).

## 협업 흐름

- Claude: vault [[Gomdori-마피아-규칙]] 유지 + UI/UX 디자인 검토 + ADR 갱신.
- Codex: Edge Function · pg_cron · 테스트 자동화 · 능력 hook 매니페스트 구현.
- 사용자: 게임 룰 결정권 · 최종 QA · 디스코드 운영.
