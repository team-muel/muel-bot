# Handoff → Codex (2026-06-07 세션)

작성: Claude (frontend/UX/룰·설계 담당). 대상: Codex (Edge Function 엔진 · pg_cron · 테스트 자동화 · Supabase 운영 · 배포 · backend).
협업 경계(재확인): **User** = 룰·디자인·밸런스 결정·QA · **Claude** = vault 룰/ADR/UI·UX/frontend/매니페스트 변환 · **Codex** = backend 엔진·배포·운영.

> 이번 세션은 길었고 여러 갈래로 갔다. 아래는 *지금 Codex가 1차로 받아야 할 것* → *세션 전체 요약* → *미완·사이드트랙* → *남은 작업 설계* 순.

## Codex 수신 검증 (2026-06-07 KST)

Codex가 로컬에서 다시 확인한 현재 상태:

- `muel-bot` 로컬 worktree는 `fix/muel-intro-copy`에 있으며 `origin/master` 최신(#44, #45, #47, #48, #49, #50)을 포함하지 않는다. 이 로컬 HEAD에서 배포 판단 금지.
- `docs/handoff-2026-06-07-codex.md`와 `docs/gomdori-phase2-game-track-design.md`는 아직 untracked 문서다. 브랜치 전환/정리 전에 보존 필요.
- `origin/master` 기준으로 #44, #45, #47, #48, #49, #50은 확인됨.
- **드리프트 발견:** #46 `night suspicion vote phase machine (W1b)`는 `origin/master`에 없다. `origin/feat/suspicion-vote-flow`의 `6f30a25` 단일 커밋으로 남아 있으며, #47~#50 이전 기반이다.
- `muel-tree` `origin/master`에는 `SuspicionPhase.tsx`, `submitAction(..., "suspect", ...)`, `nightSuspect` 룰 상수가 이미 들어와 있다. 따라서 백엔드 #46 누락 시 프론트는 `suspect`/`night_suspect` 경로에서 깨질 수 있다.

## Codex 실행 업데이트 (2026-06-07 KST)

- 작업 브랜치: `codex/gomdori-w1b-deploy`.
- W1b 재적용: `origin/master` 위에 #46을 재적용하고, `TAG_SUSPECTED` shared export + `phase-flow.ts` 전이 helper + phase flow 테스트를 추가했다.
- 추가 운영 수정: Render root status에서 Muel app legacy Entry Point command 삭제 순서 때문에 degraded가 발생했다. `src/index.ts`에서 legacy global command cleanup을 bulk PUT 전에 실행하도록 수정하고 regression을 추가했다.
- 테스트: `npm run test:gomdori`, `npm run test:smoke`, `npm run build` 통과.
- Supabase 배포 완료:
  - `match-action` v4, `phase-advance` v11, `match-leave` v1, `match-kick` v1.
  - `phase-advance` no-auth POST 확인: `200 {"message":"No expired phases to advance"}`.
  - `match-action`, `match-leave`, `match-kick` no-auth POST 확인: 함수 내부 `requireGameAuth`의 `401 {"error":"missing bearer token"}`까지 도달. 즉 gateway JWT 검증은 꺼져 있고 custom game JWT 경계가 작동한다.
- Render 확인:
  - live deploy `dep-d8i788rrjlhs739luhl0`, commit `e0e581b` (#50) 확인.
  - `/health`는 `200 OK`.
  - root `/`는 `ok=false`: Muel command registration error가 남아 있음. local fix commit `244d686`은 아직 Render live가 아니며, PR merge 후 Render auto-deploy로 확인 필요.

---

## 0. 🚨 Codex 1차 액션 (배포 + 검증) — 가장 중요

이번 세션에 머지된/머지 예정인 muel-bot 변경들이 **아직 배포 안 됐을 수 있음**. 프론트(muel-tree)는 이미 의심투표/강퇴/이탈 백엔드를 호출한다 → 백엔드 누락 또는 미배포 시 런타임 깨짐.

0. **작업 기준선 정리**:
   - `git fetch --all --prune`
   - untracked 문서 보존 후 `origin/master` 기반 새 작업 브랜치에서 진행.
   - #46 상태를 먼저 결정: `origin/feat/suspicion-vote-flow`의 `6f30a25`를 `origin/master` 위에 rebase/cherry-pick해 W1b를 살릴지, 아니면 W1b를 별도 PR로 다시 정리할지 선택.
1. **W1b 병합/재검증**:
   - 수용 기준: `phase-advance`가 `night_suspect`를 생성하고, `match-action`이 `suspect`를 수락하며, `gomdori-rules.ts`에 `nightSuspect.durationSec`가 있고, 의심 후보 태그/부결 경로가 테스트로 확인됨.
   - #46 브랜치는 #47~#50 전 기반이라 그대로 merge하지 말고 `origin/master` 위에 충돌/회귀 확인.
2. **Supabase Edge Functions 재배포** (W1b 기준선 결정 후):
   CLI v2.98.2 기준 `functions deploy`는 함수명을 하나씩 받는다. 실제 실행은 아래처럼 개별 배포:
   `npx supabase functions deploy match-action --project-ref pqzmehtuwnxyspfhyucd --no-verify-jwt --use-api`
   `npx supabase functions deploy phase-advance --project-ref pqzmehtuwnxyspfhyucd --no-verify-jwt --use-api`
   `npx supabase functions deploy match-leave --project-ref pqzmehtuwnxyspfhyucd --no-verify-jwt --use-api`
   `npx supabase functions deploy match-kick --project-ref pqzmehtuwnxyspfhyucd --no-verify-jwt --use-api`
   - `match-leave`/`match-kick` = **신규 함수**(PR #47). config.toml 에 `verify_jwt=false` 항목 추가돼 있음. 미배포 시 프론트 강퇴/이탈(muel-tree #26)이 404.
   - `phase-advance`/`match-action` = W1 의심투표(#45/#46) + 카운트 승리(#44)로 `_shared/engine`·`_shared/gomdori-rules` 변경됨 → 재배포 필요.
   - `phase-advance`, `match-leave`, `match-kick`는 JWT 검증 비활성 상태가 유지되어야 한다. 배포 후 Function 설정을 확인.
3. **봇 서비스 재배포(Render)**: PR #48(capabilities 휴리스틱), #49(muelAgent/mentionHandler), #50(discordRenderer) 은 봇 프로세스(src/) 변경 → 봇 서비스 재배포로 반영.
4. **W1 의심투표 라이브/시뮬 검증** (아래 §3-A): Deno 가 로컬에 없어 W1b(phase machine)는 **리뷰 검증만** 됐다. Codex가 sim/통합으로 night_suspect 흐름을 끝까지 확인 요망.

---

## 1. 이번 세션에 머지된 것

### muel-bot (엔진/봇) — 대부분 머지됨, #46 드리프트 확인됨
- **#44** count-based win (W3): `checkWinCondition` 을 `counters` 기반 가중 카운트로 일반화. **회귀 0**(counters 비면 기존 생존패리티와 동일). `runCountBonusSimulation` 테스트 추가.
- **#45** night suspicion vote engine (W1a): `tallySuspicionVotes`(의심가치 가중, 동률/무표=부결) + `TAG_SUSPECTED` actor 행동 무효(`action_blocked_suspected`, cleanup서 태그 제거). sim 테스트 추가.
- **#46** night suspicion phase machine (W1b): 새 `night_suspect` phase. vote-부결/verdict → night_suspect → (집계·`suspicion_revealed`·TAG_SUSPECTED set) → night. 첫밤은 그대로 silent. `match-action` 이 `suspect` 수락. 매니페스트 `nightSuspect.durationSec`. **마이그레이션 불필요**(phase_type/status/action_type 모두 text).  
  **Codex 검증:** `origin/master`에는 아직 없음. `origin/feat/suspicion-vote-flow` 커밋 `6f30a25`로 존재하므로 `master` 위에 재적용 필요.
- **#47** match-leave + match-kick: 로비 한정 본인 이탈 / 방장 강퇴. player_left/player_kicked 이벤트. config.toml verify_jwt=false.
- **#48** capabilities 휴리스틱 정밀화: `주가` 부분문자열 오발(명일방주가→주식 면책) 수정(`(?<![가-힣])주가`) + 정의질문 제외 + MODEL_INFO 자기참조 한정. `tests/regression/preflight-finance.test.ts`(+smoke).
- **#49** 봇 응답 문장경계 절단 + recentRequests 5000 상한.
- **#50** 임베드 25필드 초과 표시(N개 더) + 링크버튼 URL 길이 512 한도.

테스트: Claude 세션 기준 `npm run test:gomdori`(엔진 sim), `npm run test:smoke`(preflight 포함) 그린. Codex는 #46을 `origin/master` 위에 재적용한 뒤 반드시 재실행.

### muel-tree (frontend) — 전부 머지됨, Vercel 자동 배포
- Activity 진입: 랜딩 우회 SPA 리다이렉트(#19→#25, 하드리로드가 Discord SDK 핸드셰이크 깨던 것 수정).
- 게임: 페이즈 타이머(#20, match_phases.expected_ended_at) · 인라인 에러(#21) · 로비 시작조건 체크리스트(#23) · game/ui 프리미티브(#24) · 강퇴/이탈 UI(#26) · 의심투표 UI(#22) · VotePhase Button 적용(#39) · **GF-1 페이즈 톤+전환 인터스티셜+진입 애니(#40)**.
- Weave: 내기록 필터 수정(#27) · 빈/에러 상태+제출피드백(#28) · 노드 id머지(재배치 점프 제거, #29) · 캔버스 라벨+LOD(#30) · 내꿈→노드(#31) · a11y+폴링 visibility가드(#32) · Edge memo+엣지 가독성(#33).
- 공통: 에러 바운더리(#34) · Nav 활성링크(#35) · Supabase 프록시 config 플래그(#36) · submit visibility 허용목록(#37) · visibility union(#38).

---

## 2. 미완료 / 사이드트랙 (정직하게)

- **W1b 라이브 미검증**: Deno 로컬 부재로 `phase-advance`/`match-action` 글루는 typecheck+리뷰만. night_suspect 전이·TAG_SUSPECTED 잠금·부결처리를 실게임/sim으로 끝까지 확인 필요(Codex).
- **마운트↔호스트 파일 동기화 이슈**: muel-tree 대용량 파일(weave/page.tsx)에서 Linux 마운트가 stale/CRLF churn 유발 → Claude는 호스트에서 Node 스크립트로 편집해 회피. 일부 파일 CRLF/LF 혼재. (frontend 편집 시 주의.)
- **진단 신뢰도 경고**: 일부 자동 진단이 stale 마운트를 읽어 *이미 머지된 것을 미구현으로 오진*했다(예: discordRenderer 경로 오기, MODEL_INFO 옛 정규식). 진단 인용 시 호스트로 재확인.
- **사운드·BoW 모티프**: 게임감 작업에서 후순위로 미룸(User 결정).
- **DayPhase "(방장) 강제 넘기기" 죽은 버튼**: 제거하기로 결정(frontend GF-6에서 처리 예정). 서버 host-advance 는 구현 안 함.

---

## 3. 남은 작업 설계

### 3-A. Codex 즉시 (배포·검증)
1. ~~§0 기준선 정리 + #46 W1b 재적용/머지 여부 확정.~~ 완료: branch `codex/gomdori-w1b-deploy`.
2. ~~Supabase Edge Functions 배포.~~ 완료: `match-action`, `phase-advance`, `match-leave`, `match-kick`.
3. Render 봇 서비스 재배포 또는 현재 배포 commit 확인. #50은 live 확인, `244d686` command-registration fix는 PR/merge 후 deploy 필요.
4. W1 의심투표 end-to-end sim/통합 테스트 (night_suspect → night 행동 잠금 → resolve → day). 부결/동률 경로 포함. 현재는 pure sim + live function reachability까지 확인.
5. count-win(#44) 라이브 회귀 확인(기존 5인 게임 결과 불변).

#### 3-A-1. Codex 실행 설계

**Lane 1 — repo 기준선**

```powershell
cd C:\Users\fancy\Documents\Codex\2026-05-05\obsidian-rag-memory-eval-observer-crm\muel-bot
git fetch --all --prune
git status --short --branch
git log --oneline --decorate origin/master -12
git show --stat --oneline origin/feat/suspicion-vote-flow
```

판정:
- 현재 로컬 브랜치가 `origin/master`보다 오래되면 배포/테스트 기준으로 쓰지 않는다.
- #46은 `origin/master`에 없으면 새 브랜치에서 `6f30a25`만 재적용한다. #47~#50 이후 변경을 되돌리는 diff가 생기면 중단.

**Lane 2 — W1b 재적용**

권장 브랜치:

```powershell
git switch -c codex/gomdori-w1b-deploy origin/master
git cherry-pick 6f30a25
npm run test:gomdori
npm run test:smoke
```

확인 파일:
- `supabase/functions/_shared/gomdori-rules.ts` — `nightSuspect.durationSec`.
- `supabase/functions/match-action/index.ts` — `suspect` action accept.
- `supabase/functions/phase-advance/index.ts` — `night_suspect` transition, `suspicion_revealed`, tie/null handling.
- `supabase/functions/_shared/engine/engine.ts` — `TAG_SUSPECTED` actor action block and cleanup.

**Lane 3 — Supabase 배포**

```powershell
npx supabase functions deploy match-action --project-ref pqzmehtuwnxyspfhyucd --no-verify-jwt --use-api
npx supabase functions deploy phase-advance --project-ref pqzmehtuwnxyspfhyucd --no-verify-jwt --use-api
npx supabase functions deploy match-leave --project-ref pqzmehtuwnxyspfhyucd --no-verify-jwt --use-api
npx supabase functions deploy match-kick --project-ref pqzmehtuwnxyspfhyucd --no-verify-jwt --use-api
npx supabase functions list --project-ref pqzmehtuwnxyspfhyucd
```

배포 후 확인:
- `match-leave`와 `match-kick`가 목록에 존재.
- `phase-advance`가 JWT 없이 cron/scheduler에서 호출 가능해야 함(`verify_jwt=false` 유지).
- `match-action`이 `suspect`를 거부하지 않음.

**Lane 4 — Render 봇 반영**

목표:
- #48~#50의 `src/` 변경이 운영 봇에 반영됐는지 확인.
- 자동 배포가 없다면 Render에서 최신 `origin/master` 또는 W1b 포함 브랜치/커밋 배포.

검증 신호:
- `https://muel-bot.onrender.com/health`가 OK.
- root status에서 `muel`/`gomdori` websocket 상태와 loginError가 정상.
- Discord 출력에서 25필드 초과 표시와 링크 URL cap 회귀 없음.

**Lane 5 — W1 E2E**

최소 시나리오:
- 5인 이상 match 생성 → ready → start.
- 첫밤은 기존 silent 경로 유지.
- 둘째 밤부터 `night_suspect` 진입.
- 단일 최다 의심자: `suspicion_revealed` public event 발생, 대상의 밤 능력 action이 `action_blocked_suspected`로 무효.
- 동률/무표: 부결 처리, 전원 밤 능력 가능.
- 이후 `night_resolve` → `day` → `vote`/`verdict` → win check가 기존 흐름을 깨지 않음.

완료 시 남길 것:
- 배포 commit/함수 목록/Render deploy id(값은 secret 아님)를 이 문서 또는 `Personal Agent Memory\40_Projects\Muel Platform\00 Current Status.md`에 업데이트.
- 실패 시 재현 절차와 실제 Edge Function 응답만 요약. 토큰/secret 원문 금지.

### 3-B. 게임 디자인 엔진 (Codex 주도, User 밸런스 결정 선행) — 설계는 `docs/gomdori-phase2-game-track-design.md` 참조
순서: **W4 직업 매니페스트+핸들러** → **W5 직업 선택 배정** → **W6 중립 직업** → **W7 죽음 종류/부활**.
- 엔진 타입(`_shared/engine/types.ts`)은 이미 canon 선반영: `baseVoteValue/bonusVoteValue/suspicionValue/markedForAnnihilation/tags/counters`. W4 능력 핸들러가 이 슬롯을 채우는 구조.
- 인원별 분포는 `match-start.generateRoles(5..12)` 에 이미 결정론적. W4 시 이를 매니페스트로 승격 + 클라 미러(로비 구성 미리보기).
- **User 결정 필요**: 밸런스 목표(인원별 악마 승률), W4 첫 트랜치 범위(소수 고임팩트 vs 중립 파스아 vs 전체), 중립 도입 시점.

### 3-C. 운영
- **P2-9 마이그레이션 drift 정리** (Codex): 과거 migration timestamp drift → `supabase db push --dry-run` 통과. `supabase-operations-playbook.md` 참조.
- **muel-tree `/api/dreams` 서버 레이아웃 캐시**(Claude 도메인, 후순위): 매 요청 force-layout(170)+O(n²) 유사도 재계산. 서버리스라 신중. 클라 머지(#29)로 UX 지터는 이미 해결됨.

### 3-D. Claude 가 병행 중인 frontend (Codex 의존 없음) — `docs/...`는 muel-tree/docs
게임감 큐(설계 `muel-tree/docs/gomdori-game-feel-plan.md`): GF-1(#40 완료) → **GF-2 역할공개 드라마** → GF-6(프리미티브/a11y/반응형 흡수+죽은버튼 제거) → GF-4(juice) → GF-3/5. Weave P2-1 토큰 중앙화는 잔여.
- 결정 반영됨: 드라마틱 모션·reduced-motion 존중·사운드/모티프 후순위.

---

## 4. 참조 문서
- `muel-bot/docs/gomdori-phase2-game-track-design.md` — 게임 트랙 cross-repo 설계(W1~W8, 격차 G1~G9).
- `muel-bot/docs/phase2-task-breakdown.md` — 기존 P2-1~P2-9.
- `muel-tree/docs/remaining-opportunities.md` — 잔여 개선 통합(A/B/C).
- `muel-tree/docs/gomdori-game-feel-plan.md` — 인게임 게임감(GF-1~GF-8).
- `muel-tree/docs/weave-uiux-plan.md` — Weave 진단/계획(P0~P2, 대부분 완료).
- vault `[[Universes/BoW/Lore/Gomdori-마피아-규칙]]` — 룰 정본.

## 5. 매니페스트 sync 경고
룰 상수는 3곳 동기화: vault 정본 → `muel-bot/.../_shared/gomdori-rules.ts` → `muel-tree/src/config/gomdori-rules.ts`. 한쪽 변경 시 양쪽 PR 동시. 이번에 `nightSuspect.durationSec` 가 양쪽에 추가됨 — 일치 확인.
