# ADR-004: Muel 의 사후적 지능 (Retrospective Intelligence)

**상태**: Accepted (2026-06-10) — 결정 락인 + RI-0 substrate 적용 + 첫 run 적재 완료
**대상**: muel-bot · muel-tree · Supabase · Cowork(Claude operator)
**관련**: ADR-001(BoW), ADR-002(Weave), ADR-003(AI SDK 확장), [[muel-proactive-speech-design]], [[weave-repositioning]]

## 0. 결정 락인 (2026-06-10)

1. **거주 형태 = cowork 스케줄 운영자만**(RI-6 in-bot 내재화는 **안 함**). Claude 가 기존 스케줄 task 로 산다.
2. **전달 = 현재 등록된 Discord 스케줄 재사용** — `muel-feedback-triage-daily`(09:04 KST)·`muel-feedback-sentinel`(2h). 새 채널/스케줄 안 만듦.
3. **루프는 끝까지 닫는다**(RI-3 의 user_memos ingest + Weave 교정 반영까지).
4. **에러율은 지금 첫 정식 리포트 대상** — 완료(run `e9d7be6a`, §5/§9 참조).
5. **역할 분담 없음** — "Codex 가 하는 건 Claude 도 하고, 그 역도 성립". 단일 사용자·다중 세션이 아니므로 분담 대신 **진행상황 공유**만 보장(= `muel_reflection_runs`/`_proposals` + 이 ADR 가 공유 상태).

---

## 1. 한 줄 정의

Muel 은 지금 **사전적(reflexive) 지능** 하나로만 돈다 — 멘션·라우터·리액션·프로액티브가 전부 *지금 이 턴 안에서* 끝나는 빠른 반사다. 이 ADR 은 그 위에 **사후적(reflective) 지능** 한 층을 얹는다: 턴이 끝난 뒤, 누적된 흔적(exhaust)을 읽고 *틀린 것·놓친 것·바뀌어야 할 것* 을 찾아 **교정 제안**을 만드는 느린 지능. 이 느린 지능의 몸이 **Claude** 다.

> 빠른 Muel(Gemini, in-loop)은 *말한다*. 느린 Muel(Claude, 사후)은 *돌아본다*.

---

## 2. 문제 — 흔적은 쌓이는데 아무도 읽지 않는다

라이브 데이터(2026-06-10, project `pqzmehtuwnxyspfhyucd`):

| 테이블 | 행 수 | 최근 | 소비자 |
|---|---:|---|---|
| `muel_ai_events` | 3,091 | 06-09 | **없음** |
| `muel_agent_actions` | 1,996 | 06-09 | **없음** |
| `weave_nodes` | 221 | 06-09 | muel-tree(읽기 시각화만) |
| `muel_memory_entries` | 191 | 06-08 | 회수(recall) 시 읽기 |
| `muel_feedback_signals` | **0** | — | **없음** (인프라만 있음) |
| `muel_pending_observations` | 3 | 06-09 | feedbackObserver(쓰기만) |
| `muel_user_memos` | **0** | — | **없음** (ingest 미완) |

여기서 나오는 신호:

- **AI 호출 에러율 ~45%** — `ai_events` status: success 1,699 / error 1,377 / fallback 15. (Gemini 크레딧 고갈기 #95~#104 로 상당 부분 복구됐지만, *이 추세를 자동으로 보는 눈이 없다.*) 가장 큰 소비처는 `router`(1,736) — 바로 news_query 반사 문제가 사는 곳.
- **agent_actions: denied 1,573 / responded 141** — "기본은 침묵" 가드레일이 잘 작동 중. 하지만 *어떤 denied 가 사실은 말했어야 했는지* 판정하는 눈이 없다.
- **feedbackObserver(#87/#88)는 신호를 적재만** 한다. `recordFeedbackSignal` → `muel_feedback_signals` → **그 다음이 없다.** 주석엔 "스케줄된 트리아지가 클러스터링/처리"라 쓰여 있지만 트리아지는 존재하지 않는다.
- **propose_memo(#101)·Weave 교정 루프**는 만들어졌지만 `user_memos`=0, feedback confirmed/disputed=0 — 프로덕션에서 한 번도 닫힌 적 없다.

즉 muel-bot 의 최근 PR 흐름(피드백 관찰 → propose_memo → proactive → 메모리 회복탄력성)은 전부 **"신호를 만들고 적재하는" 생산자 측**을 지었다. **소비자 측 = 사후적 지능**은 통째로 비어 있다. 이게 이번 설계의 빈칸이다.

---

## 3. 두 지능의 분리 (왜 Claude 인가)

| | 사전적 Muel | 사후적 Muel |
|---|---|---|
| 몸 | Gemini/MindLogic (modelRegistry lanes) | **Claude (Opus, cowork/agent)** |
| 시점 | 턴 안 (ms~초) | 턴 밖 (분~일, 스케줄) |
| 입력 | 지금 메시지 + 회수된 메모리 | 누적 exhaust (events/actions/signals/memory) |
| 출력 | 사용자에게 *발화* | 사람에게 *교정 제안* (제안→확인) |
| 실패 비용 | 즉시 사용자 체감 | 낮음 (오프라인, 게이트됨) |
| 책임 | 봇이 자동 | **사람이 클릭으로 승인** |

분리의 핵심은 **책임 구조**다. 빠른 Muel 은 자동으로 말하고 가끔 틀린다. 느린 Muel 은 *틀린 것을 모아 보여주되 스스로 고치지 않는다* — 모든 교정은 사람 승인 뒤에만 들어간다. ADR-003 의 "제안 → 클릭" 2단계 철학과 동일선상이며, "Because I can, but with accountability" 필터를 아키텍처로 박은 것이다.

Claude 가 적임인 이유: (1) 이미 cowork 에서 muel-bot repo + Supabase MCP + Slack/Discord 에 손이 닿는다 — *별도 봇 모듈 없이 지금 운영 가능*. (2) 느리고 비싸도 되는 분석 작업에 맞는 모델. (3) 교정을 PR/카드로 내는 행위 자체가 감사 가능(auditable).

---

## 4. 기질(substrate) — "Reflection Run"

사후적 지능의 단위 동작 = **reflection run**. 한 번의 run 은:

```
window(시간/건수) 의 exhaust 읽기
  → 패턴/실패모드 군집화
  → 구조화된 findings (무엇이·얼마나·근거)
  → 교정 제안 (memory merge / prompt edit / threshold tweak / triage)
  → 사람 승인 게이트 (Discord 카드 or PR or Slack)
  → 승인분만 반영, run 자체를 muel_reflection_runs 에 적재 (자기도 감사 대상)
```

핵심 원칙:
- **읽기 광역 · 쓰기 0(직접)**: run 은 어떤 프로덕션 테이블도 직접 수정하지 않는다. 산출물은 *제안*뿐.
- **멱등·재현**: run 은 window 로 정의 → 같은 window 재실행 가능, 결과 비교 가능.
- **자기 적재**: reflection run 도 exhaust 를 남긴다(무엇을 봤고 무엇을 제안했는지). 사후적 지능도 사후 감사 대상.

---

## 5. 작업 티켓 (RI-0 ~ RI-6)

의존성 순서. tier = 비용/효과.

### Tier 1 — 기질 + 첫 소비자

**RI-0 — Reflection substrate ✅ 적용 완료 (2026-06-10)**
- migration `ri0_reflection_substrate`: `muel_reflection_runs`(kind, window, status, summary, findings jsonb), `muel_reflection_proposals`(run_id, type, title, payload, decision, decided_by/at). 둘 다 RLS on + 정책 없음 = service_role 전용(weave_nodes 패턴).
- 읽기 전용 분석 뷰: `v_ai_health`(day×task success/error/fallback/error_pct), `v_action_outcomes`(day×trigger×status), `v_memory_health`(status×confidence_bucket×age). **3개 모두 `security_invoker=on`** (security_definer_view 어드바이저 ERROR 회피 — supabase-ops 교훈).
- 산출: Claude 가 SQL 한 방으로 "지난 N일 Muel 상태"를 뽑고, 모든 run·제안이 자기 적재된다.

**RI-1 — Feedback triage 소비자 (feedbackObserver 가 약속한 빈칸)**
- `muel_feedback_signals` 를 채널/유저/패턴으로 군집 → 실패모드 분류(오정보 / 톤 / 정체성 환각 / 반사 오발화 / 욕설대응).
- 신호가 0 인 지금은 **이중 트랙**: (a) 명시 신호(reaction/abuse) + (b) `agent_actions.responded` 표본을 Claude 가 직접 채점("이 답은 말할 가치가 있었나?"). 신호가 안 쌓이는 게 *진짜 무피드백*인지 *관찰기 미탐지*인지부터 가린다.
- 산출: triage 다이제스트 + 패턴별 교정 후보.

### Tier 2 — 자기 점검 + 메모리 위생

**RI-2 — 발화 자기 점검 (news_query 반사 직결)**
- `agent_actions`(trigger=allowlist_channel/mention) + 해당 답변 본문 표본을 Claude 가 grade.
- 알려진 결함 정조준: router 가 YouTube *링크 공유*를 `news_query` 로 오분류해 반사 발화(=[[muel-proactive-speech-design]] PA-0). run 이 이 오발화 빈도를 수치로 만들고 → RI-4 로 threshold/prompt 교정 제안.
- 산출: "이번 주 Muel 이 말 안 했어야 했는데 말한 N건 / 말했어야 했는데 침묵한 M건".

**RI-3 — 메모리 위생·통합 + 열린 루프 닫기**
- `muel_memory_entries` 반성: 모순쌍, stale(오래+저신뢰), 중복 → merge/강등 제안. 191건 규모면 1 run 에 전수 가능.
- **Weave 교정 루프 닫기**: confirmed→confidence+, disputed→강등 이 실제로 회수에 반영되는지 검증(현재 프로덕션 0건이라 미검증).
- **user_memos → memory_entries ingest 루프 닫기**: propose_memo/Weave "알려주기"가 적재한 `user_memos` 를 embedding 붙여 회수 가능한 memory 로 승격. (현재 끊긴 마지막 고리.)

### Tier 3 — 교정 반영 채널 + 운영

**RI-4 — Persona/prompt drift 교정 제안**
- RI-1·RI-2 findings → 구체 코드 제안: feedbackSignals 정규식 확장, router `responsiveConfidenceMin` 조정, 시스템 프롬프트 문구 수정, 부정 이모지 셋 보강.
- 반영 경로 = **PR**(muel-bot-fix-pr 스킬 그대로). Claude 가 브랜치→edit→typecheck→PR. 사람 머지 전엔 아무것도 안 바뀜.

**RI-5 — 전달 표면 (결정: 기존 Discord 스케줄)**
- **확정**: 새 surface 안 만들고 기존 `muel-feedback-triage-daily`(09:04, 풀 다이제스트)·`muel-feedback-sentinel`(2h, 임계 경보)에 RI 범위를 흡수. 두 task 모두 운영 비공개 Discord 웹훅으로 발송(민감정보 제외, 집계·추세만).
- 변경: daily task 가 (1) 산출을 `muel_reflection_runs`/`_proposals` 에도 적재(공유 상태), (2) 부정 피드백+비용 위에 **RI-2 발화 자기점검 + RI-3 메모리/열린루프 상태**를 추가.
- **자동 PR 금지 유지**: 무인 스케줄 task 는 리포트·제안 적재까지만. 교정 PR(RI-4)은 *유사 attended cowork 세션*에서 사람이 보는 자리에서만(=accountability).

**RI-6 — in-bot 내재화: 안 함 (결정 §0-1).** reflection 은 Claude(cowork 운영자)에만 산다. 비용 통제는 window/표본/토큰 상한 + 일·주 스케줄로.

```
RI-0 ✅ (substrate)
 ├─ RI-1 (triage 소비자)   ← feedbackObserver 의 빈칸
 ├─ RI-2 (발화 자기점검)    ← news_query 반사 정조준
 └─ RI-3 (메모리 위생)      ← Weave/user_memos 루프 닫기
        ↓ findings (→ muel_reflection_runs/_proposals, 공유 상태)
     RI-4 (교정 PR, attended) → RI-5 (기존 Discord 스케줄로 전달)
```

---

## 6. 가드레일·책임 구조

- **직접 쓰기 금지**: reflection run 은 프로덕션 테이블/프롬프트/임계값을 *절대* 자동 수정하지 않는다. 100% 제안.
- **승인 단위**: 교정 1건 = 카드/PR 1개 = 클릭 1번. 묶음 자동승인 없음(=ADR-003 "Yes만 누름" 피로 회피).
- **run 비용 한도**: window·표본 상한 + run 당 토큰 상한. 스케줄은 일/주 단위(턴 단위 아님).
- **자기 감사**: 모든 run·제안·결정이 `muel_reflection_runs`/`_proposals` 에 남는다.
- **읽기 권한 최소화**: 분석 뷰는 비개인 지표/owner-scoped 만(weave-repositioning 프라이버시 정책 준수). 민감정보는 memoryWorker 의 금지 규칙과 동일하게 findings 에서 배제.

---

## 7. 결정 완료 (§0 참조) — 남은 실행 순서

결정 포인트는 §0 에서 모두 락인. 남은 *실행*만:
- **다음**: daily SKILL.md 격상 적용(RI-2/RI-3 흡수 + substrate 적재) — 이 세션에서 진행.
- **그다음**: RI-3 루프 닫기 — `user_memos`→`memory_entries` ingest 경로(현재 0건이라 propose_memo/Weave "알려주기"가 회수까지 안 감) + Weave confirmed/disputed→confidence 반영 검증.
- **검증 보류**: 첫 run(§9)의 제안 #1(크레딧 폴백 커버리지)을 attended 세션에서 코드 확인 → 필요 시 RI-4 PR.

## 8. 한 문장 요약

muel-bot 은 5,000건 넘는 흔적을 남기면서 아무도 안 읽고 있었다. **사후적 지능 = 그 흔적을 읽어 교정을 *제안*하는 느린 Claude 층**이며, 직접 쓰지 않고 사람 승인으로만 반영된다 — 빠른 Muel 의 자동성과 균형을 맞추는 책임 구조다.

## 9. 첫 run 기록 (run `e9d7be6a`, kind=ai_health, 2026-06-10)

사후적 지능의 가치를 첫 run 이 바로 보여줌: **순진한 읽기는 "전체 에러율 45% — 위험"** 이었으나, 구조화된 판독은 이를 교정한다.
- 그 45% 의 대부분은 router 의 `AI_NoObjectGeneratedError`(누적 1,046) = generateObject 스키마 불일치. **06-09 배포된 `z.string` transform 완화가 이를 멈춤**(06-09 03:50 이후 0건). NoObject 추세: 06-06 182 → 06-07 62 → 06-08 128 → 06-09 55(배포 전) → 이후 0.
- 06-09 의 *살아있는* 에러는 스키마가 아니라 **`AI_RetryError` 73 = Gemini 선불 크레딧 고갈**이며, `fallback` 이 아니라 `error` 로 적재됨.
- **열린 질문(제안 #1)**: MindLogic 폴백(#95/#97)이 router 레인의 크레딧 에러를 회수하는가? 회수하면 왜 telemetry 가 error 로 분류하는가? → 사용자 무응답 가능성 + 대시보드 착시. attended 세션에서 코드 확인 대상.
- 제안 #2: NoObject 완화 효과를 06-16 재측정해 0 유지 시 종결. 제안 #3: summary(17%)/extract(22%)/chat(27%) error_class 분해.

교훈: 빠른 Muel 의 "수정했다"(PR #98~#104)와 *실제로 멈췄다*는 다르다. 사후적 지능은 머지가 아니라 **추세로 확인**한다.
