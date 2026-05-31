# Phase 1 라이브 End-to-End 준비 상태

**작성**: 2026-05-31
**범위**: 5인 실사용자가 Discord Activity 안에서 Gomdori 마피아 한 판을 끝까지 도는 데 필요한 전 구간 점검.
**관련**: `adr-001-bow-activity-architecture.md`, `phase1-task-breakdown.md`, `phase2-task-breakdown.md`, `supabase-operations-playbook.md`

엔진/룰 코드는 검증 완료(5 archetype 루프 + 첫 밤 룰). 라이브를 막는 건 **엔진 바깥 링크 — iframe 네트워크 경계, 인원 동기화, 끊김 복구**다. 이 문서는 그 사슬을 상태와 함께 정리한다.

상태 표기: ✅ 완료(검증됨) · ⚙️ 사용자 설정 필요 · ❓ 라이브 QA 미검증

## 1. 코드 / 배포 상태

| 항목 | 상태 | 근거 |
|---|---|---|
| 첫 밤 룰 backend (phase-advance) | ✅ | muel-bot #24 머지. phase_number 1 능력 스킵 + `first_night_silent` + day 직행. 모든 duration 매니페스트화. |
| 첫 밤 룰 frontend (NightPhase silent 화면) | ✅ | muel-tree #5 머지. |
| Supabase 프록시 우회 (patchUrlMappings) | ⚙️ | muel-tree #6 — 코드는 머지 대기/머지됨. **portal URL Mapping 동반 필요(아래 2번).** |
| phase-advance Edge Function 배포 | ✅ | Supabase `pqzmehtuwnxyspfhyucd` 에 v10 배포. verify_jwt=false 유지. first_night_silent 포함 확인. |
| pg_cron `mafia-phase-advance` | ✅ | active, `* * * * *`, 최근 run 전부 succeeded. 페이즈 자동 전환 가동. |
| muel-tree (Vercel) 배포 | ✅ | production 최신 = master(#5 머지) READY. git 자동배포. |
| muel-bot (Render) 배포 | ✅ | render.yaml `autoDeployTrigger: commit`. 봇은 Activity launcher일 뿐, 게임 루프 임계경로 아님. |

> CI(ci.yml)는 typecheck + smoke만 한다. **Edge Function은 자동 배포되지 않으므로** phase-advance 등 함수 변경 시 `supabase functions deploy <fn> --project-ref pqzmehtuwnxyspfhyucd --no-verify-jwt --use-api` 수동 배포가 항상 필요하다(playbook 참조).

## 2. ⚙️ Discord Developer Portal — URL Mappings (라이브 #1 blocker)

Gomdori Application → Activities → URL Mappings:

- root `/` → `muel-tree.vercel.app` (Activity 진입)
- prefix `/supabase` → `pqzmehtuwnxyspfhyucd.supabase.co` (**#6의 patchUrlMappings와 짝**)

`/supabase` 매핑이 없으면 iframe 안에서 REST·Realtime·Edge Function 호출이 전부 차단되어 로비조차 못 넘어간다. #6 코드는 이 매핑이 있어야 동작한다(없으면 회귀 없이 기존과 동일한 차단 상태).

## 3. ⚙️ Vercel 환경 변수 (Production)

`.env.local.example` 기준 Gomdori 진입에 필요한 값:

- `NEXT_PUBLIC_GOMDORI_DISCORD_CLIENT_ID` — **비어 있으면 `initDiscord`가 throw**("No Discord client_id configured")하여 Activity 부팅 실패. Vercel production에 실제 Gomdori Application client_id가 설정돼 있는지 확인.
- `GOMDORI_DISCORD_CLIENT_SECRET` — `/api/discord/token` OAuth 교환용(server-side).
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_MAFIA_GAME_API_BASE_URL` — 게임 서버 연결.

## 4. ❓ 라이브 QA로만 검증되는 항목 (5인 세션)

엔진 시뮬레이션이 못 잡는, 실제 사람 N명 + 디스코드 환경에서만 드러나는 것들:

1. **인원 동기화** — 같은 보이스 채널의 4~8명이 *하나의 매치*에 모이는가. instance_id ↔ match 바인딩(또는 룸 코드) 경로가 다중 클라이언트에서 일관적인가.
2. **재접속 / AFK** — 도중 새로고침·이탈한 플레이어가 현재 페이즈·자기 액션 상태로 복원되는가. NightPhase는 자기 액션 복원만 구현됨; 누락 이벤트 replay·AFK 처리는 미검증.
3. **Realtime 도달성** — 모든 클라이언트가 `match_events`를 빠짐없이 받는가(프록시 WebSocket 경유 포함).
4. **클럭 동기** — 클라이언트 카운트다운 vs 서버(pg_cron) 만료 시점의 어긋남이 UX상 허용 범위인가.
5. **첫 밤 흐름** — 배정 → 8초 silent 첫 밤(능력 UI 숨김) → 아침 정상 전환 → 둘째 밤부터 능력 복귀.
6. **gameJwt 수명** — 한 판(여러 라운드, 길면 20분+) 동안 토큰 만료로 액션이 거부되지 않는가.

## 5. 관찰만, 추후 하드닝 후보

- **phase-advance 멱등성** — 만료 페이즈를 select 후 `ended_at`을 쓰는 사이 동시 실행이 같은 페이즈를 이중 처리할 여지. 현재 cron은 분당 1회(내부 5초 루프)라 충돌 확률 낮으나, 인원·매치 증가 시 페이즈 전환에 조건부 업데이트(낙관적 락) 추가 검토.
- **Migration drift**(P2-9) — `db push --dry-run` 정상화는 운영 안정화 후.

## 6. 권장 라이브 QA 순서

1. #6 머지 → Vercel 자동배포 확인.
2. Portal URL Mappings(2번) + Vercel env(3번) 확정.
3. 보이스 채널에 5명 입장 → `/게임` → Activity launch.
4. 로비 모임 → 시작 → 배정 → silent 첫 밤 → 아침/투표/판결 → 승패/직업 공개까지 1회 완주.
5. 도중 1명 새로고침(재접속) 테스트.
6. 막히는 링크를 이 문서 4·5번에 기록 → 다음 PR 단위.
