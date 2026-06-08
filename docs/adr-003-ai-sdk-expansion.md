# ADR-003: AI SDK 활용 확장 마스터플랜

**상태**: Proposed (2026-06-08)
**대상**: muel-bot · muel-tree · Supabase
**관련**: ADR-001 (BoW Activity), ADR-002 (Weave 통합)

## 배경

사용자 결정 (2026-06-08): *AI SDK 로 할 수 있는 게 더 많다고 생각해. ALL.*

현재 muel-bot 의 `ai` package 사용 = `generateText` + `generateObject(zod)` + `stepCountIs(4)` + read-only tools. SDK 가 제공하는 표면의 약 1/3.

## 확장 영역 (10 + 우선순위)

### Tier 1 — 작은 비용, 큰 효과

**P1 — `generateObject` 광역화**
- 적용처: `/메모 add` 자동 tagging + kind 분류 / AI-Q 리포트 카테고리 자동 / 구독 신호 주제 분류 / `auto_memo` 의 importance 자동.
- zod schema 한 줄로 끝. 메타데이터 품질 즉시 향상 → Weave 노드 검색·시각화 모두 이득.

**P2 — Provider middleware**
- `wrapLanguageModel` 로 caching / rate-limit / telemetry / fallback rotation 을 모델별 wrap.
- 현 `modelRegistry` 의 lane 분리 위에 *공통 동작* 추가.
- `muel_ai_events` 와 자동 통합.

**P3 — Multi-step agent 강화**
- 현재 `stepCountIs(4)`. 늘릴 영역:
  - *리서치 → 정리 → 메모 추가 → weave_node 생성* 자율 chain.
  - *대화 → 검색 → 답 → 메모 candidate 제안* 흐름.
- `prepareStep` 으로 단계별 모델/tool/시스템 프롬프트 변경.

### Tier 2 — 중간 비용

**P4 — Write-tools (사용자 confirm)**
- `actionConfirmations.ts` 위에 얹기.
- 예시 tools:
  - `propose_memo` — Muel 이 사용자 답에서 *메모 candidate* 추출 → 사용자 confirm → insert.
  - `propose_weave_node` — community visibility 노드 작성 제안.
  - `propose_subscription` — `/구독 add` 제안 (이미 부분 구현).
- 모든 write 는 *제안 → 사용자 클릭* 2단계.

**P5 — `embed` 통합 + 검색 도구화**
- `muelEmbeddings.ts` → SDK `embed` 로 통일.
- *Muel 이 자기 메모·노드 db 를 검색* 하는 명시적 tool: `search_my_memos`, `search_weave_tree`.
- multi-step agent 가 이 tool 로 자기 메모 활용 → 답 일관성 ↑.

**P6 — `streamText` deferred edit 패턴**
- Discord 가 직접 streaming X. *deferred reply + 점진 edit* 으로 흉내.
- 사용자가 *생각 → 키워드 → 본문* 단계로 보임. 긴 답 UX 향상.

### Tier 3 — 큰 변경, 큰 효과

**P7 — AI SDK UI 웹 채팅 surface** ⚠️ 큰 작업
- `@ai-sdk/react` 의 `useChat` 으로 muel-tree 안에 Muel 채팅 페이지.
- Discord 외부에서도 Muel 사용. ADR-002 의 visibility 정책 그대로.
- 인증 = Discord OAuth (이미 `/api/discord/token` 있음) 재사용.
- 메모·history 분리: 같은 Muel 페르소나, 같은 메모 풀, 다른 surface.

**P8 — Image / Speech 통합**
- `experimental_generateImage` — Muel 캐릭터 이미지 / 메모 illustration / weave node 시각 보조.
- `experimental_transcribe` — Discord voice 채널 transcript → Muel 답.
- 비용 평가 후 도입.

**P9 — Provider 다양화**
- Claude (한국어 캐주얼·코드 강) / Cohere (embedding) / Mistral (저렴 lane) 추가.
- modelRegistry 가 lane 별 best provider 자동 선택.

**P10 — `experimental_telemetry`**
- turn 별 비용/토큰/latency 자동 로깅 → `muel_ai_events`.
- Render free tier cold-start 영향 분리 가능.

## 진행 상태 (현재 master 기준)

이미 진행 중 / 부분 적용:
- `generateObject` (memoryWorker) — P1 의 첫 사례 (확장 여지).
- Multi-step `stepCountIs(4)` — P3 의 첫 단계.
- Tool use (read-only 8개) — P4 의 *write-tools 미적용*.
- Provider 2 lane (Gemini + NVIDIA) — P9 의 일부.
- `actionConfirmations.ts` — P4 의 *confirm 패턴* 베이스.
- `proactiveSpeaker.ts` (신규) — P3 의 *자율 trigger* 한 형태.
- `welcomeHandler.ts` (신규) — DM 환영 + 일관성.
- `rollingPaperHandler.ts` (신규) — 멤버 활동 도구 (write 측에 가까움).
- `weaveNodes.ts` (신규) — ADR-002 Phase 1 producer 측 일부.

## 우선순위 권장

1. **P1 (generateObject 광역화)** 즉시 — `/메모 add` 자동 tagging 부터.
2. **P2 (middleware)** 곧 — 모든 LLM 호출 공통 동작.
3. **P3 + P4 (multi-step + write-tools)** — *제안형 Muel* 완성. ADR-002 의 weave_node 자동 작성과 직결.
4. **P5 (embed 통합 + 검색 tool)** — Muel 의 자기 회상 능력.
5. **P6 (streamText)** — UX 개선.
6. **P10 (telemetry)** — 운영 가시성.
7. **P9 (provider 다양화)** — 모델별 효용 분리 후.
8. **P7 (web 채팅 surface)** — 큰 작업, 별도 ADR (ADR-004 검토).
9. **P8 (image/speech)** — 사용자 결정 후.

## 책임 분담

- **Claude**: ADR + zod schema 설계 + write-tools UX + 매니페스트 분리.
- **Codex**: middleware + telemetry + provider 추가 + 인프라.
- **사용자**: 우선순위 결정 + 비용 한도 + 디자인 검토.

## 위험

- **비용 폭증** — P3 multi-step + P8 image 가 토큰/요청 단가 큼. middleware (P2) 의 rate-limit 먼저.
- **사용자 confirm 피로** — P4 write-tools 가 너무 많으면 사용자가 *Yes 만 누름*. 의미 있는 제안만.
- **모델 응답 일관성** — P9 provider 다양화 시 페르소나 톤 일관 유지 필요.

---

## (보강) 의존성 그래프

각 P 의 *기술적 선행 조건*. 비용/효과 tier 와 다름.

```
P2 (middleware)
   ├── 선행 의무 X (지금 도입 가능)
   ├── 후행 의무: P9 provider 다양화 (rotation 의 베이스)
   └── 후행 권장: P10 telemetry (middleware 가 hook point)

P1 (generateObject 광역화)
   ├── 선행 의무 X (memoryWorker 가 이미 패턴 갖고 있음)
   ├── 후행 권장: P4 write-tools (제안 schema 가 zod object)
   └── 의존: muel_user_memos 에 metadata jsonb 컬럼 추가 (작은 migration)

P3 (multi-step 강화)
   ├── 선행 권장: P5 (search tool) — 그래야 multi-step 이 자기 db 검색 가능
   ├── 선행 권장: P4 (write tools) — multi-step 끝에 *제안*으로 마무리
   └── 후행: P6 streamText (중간 단계 가시화)

P4 (write-tools)
   ├── 선행 의무: actionConfirmations 패턴 확장
   ├── 선행 권장: P1 (zod schema 가 제안 payload)
   └── 의존: weaveNodes producer (ADR-002 P1)

P5 (embed 통합 + search tool)
   ├── 선행 의무 X (현 muelEmbeddings 그대로 사용 가능)
   └── 후행: P3 multi-step 의 자기 회상

P6 (streamText deferred edit)
   ├── 선행 의무 X
   └── Discord rate-limit 검토 필요 (edit 5/5s)

P7 (web 채팅 surface) — 별도 ADR-004
   ├── 선행 의무: Discord OAuth 재사용 (있음)
   ├── 선행 의무: visibility 정책 (ADR-002 의 weave_nodes)
   └── 큰 작업 — 인증/UI/메모 isolation/RLS 검증

P8 (image/speech)
   ├── 선행 권장: P2 middleware (비용 통제)
   └── 사용자 결정 필요 (모델·예산)

P9 (provider 다양화)
   ├── 선행 의무: P2 middleware (rotation hook)
   └── 사용자 결정: 어떤 provider, 어떤 lane

P10 (telemetry)
   ├── 선행 권장: P2 middleware (hook point)
   └── muel_ai_events schema 확장 가능
```

**임계 경로** (최단 도달 = P7 웹 채팅):
P1 → P5 → P3 → P4 → P7 (= 자기 회상 + 다단계 + 제안 + 웹 surface).

**임계 경로** (운영 안전):
P2 → P10 → P9 (= middleware + telemetry + provider 분기).

## (보강) 현재 코드 → P 매핑

| 모듈 | 현재 상태 | 해당 P | 보강 방향 |
|---|---|---|---|
| `muelAgent.ts` `generateText` | mention 답 | P3, P6 | multi-step 늘림, streamText 전환 |
| `memoryWorker.ts` `generateObject` | extract schema | P1 | tag/importance 정확도 ↑, importance 임계값 자율 조정 |
| `buildAgentTools` (read-only 8) | 도구 사용 | P5 | + `search_my_memos`, `search_weave_tree` |
| `actionConfirmations.ts` | 버튼 confirm 패턴 | P4 | propose_memo / propose_weave_node 추가 |
| `modelRegistry.ts` | 2 lane (Gemini + NVIDIA) | P2, P9 | wrapLanguageModel + Claude lane |
| `muelEmbeddings.ts` | 자체 fn | P5 | SDK `embed` 로 교체 |
| `muel_ai_events` 적재 | 직접 insert | P10 | middleware hook 으로 자동 |
| `proactiveSpeaker.ts` (신규) | 자율 trigger | P3 의 한 형태 | multi-step + write-tools 와 결합 시 *진짜 자율* |
| `welcomeHandler.ts` (신규) | DM 환영 일관 | (외) | identity surface 일관성 |
| `rollingPaperHandler.ts` (신규) | 멤버 활동 도구 | P4 의 한 형태 (write) | confirm 패턴 적용 검토 |
| `weaveNodes.ts` (신규) | ADR-002 producer | P4 의 한 형태 | LLM 제안 → weave_node insert |

## (보강) PR 단위 세분화

각 PR = *한 턴 (Claude or Codex) 안에 가능한 크기*. 너무 큰 P 는 a/b/c 로 쪼갬.

| PR 단위 | 작업 | 담당 | migration 필요 | 사용자 결정 포인트 |
|---|---|---|---|---|
| P1a | `muel_user_memos` + `muel_memory_entries` 의 metadata jsonb 컬럼 (이미 있다면 skip) | Claude | yes | metadata schema 결정 |
| P1b | `/메모 add` 후 `generateObject` 로 tag/kind/visibility 자동 추출 (fire-and-forget) | Claude | no | tag 자동 생성 OK 인지 |
| P1c | AI-Q 리포트 발행 시 generateObject 로 카테고리/태그 추출 | Codex | no | — |
| P1d | YouTube 구독 신호 발행 시 generateObject 로 주제 분류 | Codex | no | — |
| P2a | `wrapLanguageModel` 래퍼 신규 + `modelRegistry` 통합 | Codex | no | — |
| P2b | rate-limit middleware (per-user, per-provider) | Codex | yes (rate_limit 테이블) | 한도 값 |
| P2c | caching middleware (semantic cache 또는 단순 fingerprint) | Codex | yes (cache 테이블) | 캐시 정책 |
| P3a | `stepCountIs(N>4)` + 단계별 시스템 프롬프트 (`prepareStep`) | Claude | no | step 한도 |
| P3b | multi-step 의 turn-level audit (어느 step 에서 어느 tool 호출) | Codex | yes (확장) | — |
| P4a | `propose_memo` write-tool + confirm 버튼 → `/메모 add` 호출 | Claude | no | 자동 제안 빈도 |
| P4b | `propose_weave_node` write-tool + confirm → weave_nodes insert | Claude | no | community 승격 동의 UX |
| P4c | `propose_subscription` write-tool — `/구독 add` 우선 채택 안 | Codex | no | — |
| P5a | `search_my_memos` tool (직접+자동 memo embeddings) | Claude | no | — |
| P5b | `search_weave_tree` tool (community visibility 노드) | Claude | no | — |
| P5c | `muelEmbeddings` → SDK `embed` 교체 | Codex | no | embedding 모델 (Gemini vs Cohere) |
| P6a | mention 답의 deferred + edit 점진 표시 | Claude | no | — |
| P6b | rate-limit 회피 (edit 5/5s) — 청크 크기/주기 | Codex | no | — |
| P7a-z | ADR-004 별도 | Claude/Codex | yes | — |
| P8a | `experimental_generateImage` — propose_image tool | Claude | no | 비용 한도 |
| P8b | voice transcribe — Discord voice 채널 hook | Codex | yes (transcript) | — |
| P9a | Claude lane 추가 (modelRegistry) | Codex | no | API key |
| P9b | Mistral / Cohere lane | Codex | no | — |
| P10 | `experimental_telemetry` → muel_ai_events 자동 hook | Codex | yes (schema 확장) | retention 정책 |

## (보강) 권장 라운드 순서 (Claude n턴 / Codex n턴)

라운드 알터네이팅 가정. 각 라운드 = 1 PR.

| 라운드 | 담당 | 작업 |
|---|---|---|
| 1 | Claude | P1a — `muel_user_memos.metadata jsonb` migration |
| 2 | Codex | P2a — `wrapLanguageModel` 래퍼 + modelRegistry 통합 |
| 3 | Claude | P1b — `/메모 add` 의 generateObject 자동 tagging |
| 4 | Codex | P10 — telemetry middleware → muel_ai_events |
| 5 | Claude | P5a — `search_my_memos` read-only tool |
| 6 | Codex | P2b — rate-limit middleware |
| 7 | Claude | P4a — `propose_memo` write-tool + confirm |
| 8 | Codex | P9a — Claude lane 추가 |
| 9 | Claude | P3a — multi-step 강화 (`prepareStep` + step N↑) |
| 10 | Codex | P5c — `muelEmbeddings` → SDK `embed` 교체 |
| 11+ | … | P4b, P6, P7 ADR-004, P8 |

각 라운드 *typecheck + small PR + 머지* 까지 1 턴.

## (보강) 사용자 결정 포인트 모음

다음 PR 들에 *사용자 입력* 필요:

1. **metadata schema** (P1a) — tags / kind / visibility 의 zod 필드.
2. **rate-limit 한도** (P2b) — 분당 / 일당 요청 수 사용자별.
3. **cache 정책** (P2c) — semantic cache TTL, hit threshold.
4. **multi-step 한도** (P3a) — 4 → N (5? 8? 12?).
5. **자동 제안 빈도** (P4a) — *매번 propose* 일 너무 많음, *trigger 조건* 결정.
6. **community 승격 UX** (P4b) — `/메모 add --share` 또는 별도 버튼.
7. **embedding 모델** (P5c) — Gemini-embedding-001 유지 vs Cohere / OpenAI.
8. **이미지 비용 한도** (P8a) — 일당 생성 횟수.
9. **provider rotation 정책** (P9) — random / cost-optimized / quality-optimized.
10. **telemetry retention** (P10) — muel_ai_events 적재 기간.

각 결정은 *PR 시작 전 사용자 확인* 또는 *PR 안에 default + 사용자가 매니페스트로 조정*.

## 변경 이력

- 2026-06-08: 초안. 사용자 결정 (ALL) + 현재 master 진행 상태 반영.
- 2026-06-08 (보강): 사용자 정정 (Claude n턴 / Codex n턴 = 라운드 알터네이팅 / 충돌 X). 의존성 그래프 + 현재 코드→P 매핑 + PR 단위 세분화 + 라운드 순서 + 사용자 결정 포인트 모음 추가.
