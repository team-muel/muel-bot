# Muel — 이어서 할 작업 통합 설계 (2026-06-07, post-W4-live)

W4 v1 라이브 직후 기준. 이미 끝난 것(W1~W4 v1, 5인부터 전 직업, 악마팀 2 고정, migration drift 해소, repo=live)은 제외하고 **이어서 가능한 작업만** 트랙별로 정리.

범례: **[safe]** 헤드리스 검증(tsc/lint/test) · **[visual]** /game/preview·실행 확인 · **[reg0]** 회귀 0 · **[결정]** 사용자 결정 선행 · 규모 S/M/L.

> 최우선 컨텍스트: **지금은 라이브 플레이 → 피드백 루프가 1순위.** 아래 트랙은 그와 병행하거나 피드백 이후 진행. "결정 불필요 + safe"는 즉시, "결정 필요"는 플레이 피드백과 함께.

---

## 트랙 A — Gomdori 게임 엔진 (본 게임 깊이, 최고 가치)

| ID | 작업 | 규모 | 의존/결정 |
|----|------|------|-----------|
| A1 | **W6 중립팀** — 대규모 인원 밸런스의 핵심(원안). | L | [결정] |
| A2 | **W4 v2 다단계 능력** — 직업 시그니처 풀구현. | L(분할) | A1 무관, [결정] 우선순위 |
| A3 | **W5 직업 선택 배정** — 랜덤→드래프트/선택. | M | W4 후, [결정] 방식 |
| A4 | **W7 죽음/부활** — 소멸 vs 탈락 구분 + 부활. | S~M | 능력 도입과 함께 |
| A5 | **밸런스 튜닝** — 라이너 카운트·로마즈 +5/+10·악마 약간 유리 타깃. | S~M | 라이브 피드백 |
| A6 | **BoW 직업 추가 트랜치** — 70 카드 풀에서 다음 고임팩트. | M/트랜치 | [결정] 직업 선택 |
| A8 | **W8 최후의 반론** — verdict 전 피고 변론 단계. | S | 독립 |

**A1 W6 중립팀 (상세)** — 가장 큰 본 작업.
- 엔진: `checkWinCondition`에 중립 단독 승리 로직(예: 특정 조건 생존). `Faction`에 'neutral' 이미 존재 — 카운트 버킷·승리판정 분기 추가.
- 직업: vault 중립 슬롯(파스아 교주 등) → 매니페스트 + 핸들러.
- DB/RLS: 중립은 demon_circle 비포함(faction='neutral'). `match_players_visible`·`is_demon_circle_member` 영향 없음(이미 faction='demon' 기준). role CHECK에 중립 role 추가(migration).
- 프론트: RoleAssign 중립 설명, 중립 진영색(design-tokens FACTION_COLORS.neutral 존재), 승리조건 안내, Result 중립 표기.
- [결정] 필요: (a) 중립 승리조건(생존형? 특정 미션?), (b) 중립 도입 인원 임계(예: 9인+?), (c) 첫 중립 직업.

**A2 W4 v2 (상세)** — 엔진 확장 3종 선행:
- 충전 카운터(ability `maxUses`/counters 누적), 조건부 트리거(passive `condition` 평가기), 취급 변환 캐스케이드(`treatedAsFaction` 연쇄). 그 위에 로마즈 조사장/신념, 라이너 거친포효, 가인 급습, 줄 취급변환 순차.

---

## 트랙 B — Gomdori 게임감/연출 (라이브 첫인상)

| ID | 작업 | 규모 | 비고 |
|----|------|------|------|
| B1 | GF-7 사운드 — 페이즈 전환·처형·결과 SFX + 음소거 토글. | M | [visual] 후순위였음 |
| B2 | GF-8 BoW 비주얼 모티프 — 배경·진영 상징·아이콘. | M | [visual] |
| B3 | 관전(사망자) 실시간 로그 — `match_events` 피드. | M | [safe 로직+visual] |
| B4 | 액션 확정 다이얼로그 + 역할 능력 툴팁. | S | [safe] |
| B5 | 반응형 — 모바일 악마채팅 드로어, 타겟 그리드 `grid-cols-1 sm:2 md:3`. | M | [visual] |

---

## 트랙 C — muel-bot Discord 품질 (전부 [safe], 묶음 PR 1개 가능)

`remaining-opportunities.md` A1~A7 중 미처리:

1. **응답 절단 문장경계** — `muelAgent.ts` toDiscordReply: 1890자 무조건 절단 → 문장경계(.。?!\n)에서 + "(생략됨)". [safe]
2. **임베드 25필드 초과 표시** — `discordRenderer.ts`: slice(0,25) 후 소실 → 25번째 "N개 더" 필드. [safe]
3. **링크 버튼 URL 길이** — `url.length<=512` 검증 추가. [safe]
4. **recentRequests 캐시 상한** — `mentionHandler.ts`: size>5000 강제 스윕. [safe]
5. **isLightweightTurn 중복 제거** — mentionHandler+muelAgent → 단일 export. [safe][reg0]
6. **describeError/truncate 공용화** — 다중 파일 중복 → util. [safe][reg0]
7. **withTimeout 취소** — AbortController 연동(가능 범위). [safe, 중간]

→ 1·5·6은 즉시. 2·3·4도 작음. 7은 중간. 한 PR로 묶어도 됨.

---

## 트랙 D — Weave / 공통 (muel-tree)

`remaining-opportunities.md` C track 중 미처리(C-2 토큰=#45 완료, C-10 서버캐시=후순위 제외):

| ID | 작업 | 규모 | 태그 |
|----|------|------|------|
| D1 | 엣지 가독성 opacity 하한 0.15→0.3. | S | [visual] |
| D2 | `Edge` React.memo + 노드 id→Map(매 렌더 O(n) find 제거). | S | [safe 성능] |
| D3 | 카메라 포커스(선택 노드 이동/하이라이트). | M | [visual 기능] |
| D4 | 상세 패널 드릴다운(dream 전체·연결 노드). | M | [visual 기능] |
| D5 | ActivityLayout 에러바운더리 + `app/error.tsx`. | S | [safe] |
| D6 | Nav 활성 링크(`usePathname`). | S | [safe] |
| D7 | submit 라우트 zod 검증(visibility allowlist·길이). | S | [safe 보안] |
| D8 | `discord.ts` 슬러그 하드코딩 설정화. | S | [safe][reg0] |

> 게임 UI 프리미티브(B-A)·a11y(B-D)는 세션 중 상당 부분 머지됨(#39/#42 등). 잔여만 호스트 앵커 재확인 후 마무리.

---

## 트랙 E — 인프라/정합 (마무리·재발 방지)

| ID | 작업 | 규모 |
|----|------|------|
| E1 | `db push --dry-run` 실제 1회 실행 → 드리프트 해소 확인(라이브 history=repo 45 정합 완료, CLI 확인만). | S |
| E2 | match-start 번들 `game.ts` 축소본(커넥터 배포 시 미사용 export 제거됨) → 다음 **repo 기반 배포 1회**로 원복. 기능 영향 없음. | S |
| E3 | `w4-runtime-contract.test.ts`를 `test:smoke`에 편입(회귀 가드). | S |
| E4 | 엣지 함수 전수 repo=live 점검(match-start/action/chat/phase-advance/test-engine 버전 vs repo). | S |

---

## 권장 로드맵

1. **(지금) 라이브 플레이 → 피드백 수집.**
2. **병행 즉시(결정 불필요)**: 트랙 C 전체(봇 품질) + D5/D6/D8/D1/D2 + E3 — 전부 safe/reg0, 한두 PR로.
3. **피드백 직후**: A5 밸런스 튜닝 → (결정 후) A1 중립팀 → A2 v2 능력.
4. **연출**: B1/B2 사운드·모티프, B3 관전 로그.
5. **정합 마무리**: E1/E2/E4.

## 모아둔 [결정] 항목

- **A1 중립**: 승리조건 / 도입 인원 임계 / 첫 중립 직업.
- **A2 v2 능력**: 어느 직업부터, 어디까지 충실히.
- **A3 배정**: 랜덤 유지 vs 선택/드래프트.
- **A5 밸런스**: 인원별 악마 승률 타깃 수치(현재 "약간 유리" 정성).
- **A6 트랜치**: 다음 추가 직업.

라이브 한 판 돌려보고 A5/A1 결정을 주면, 2번(즉시 가능 묶음)은 그와 무관하게 바로 진행 가능.
