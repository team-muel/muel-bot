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

## 변경 이력

- 2026-06-08: 초안. 사용자 결정 (ALL) + 현재 master 진행 상태 반영.
