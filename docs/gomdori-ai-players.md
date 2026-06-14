# ADR-005 — Gomdori AI 용병 플레이어 (ChatGPT · Gemini · Claude)

상태: 제안 / 단계적 구현 중 (Increment 1)
작성: 2026-06-15
관련: [[gomdori-mafia-design]], [[gomdori-completion-roadmap]], `modelRegistry.ts`, `jobWorker.ts`

## 1. 배경 / 문제

게임은 원본 기준 **최소 8명**(`GOMDORI_RULES.playerCount.min`)이 모여야 시작된다. 사람이
부족할 때 판이 서지 않는다. 개선안: 사람이 부족한 마지막 몇 자리를 **AI 용병**으로 채운다.

요구(사용자 확정):

- 호스트가 로비에서 "참가자 데려오기"로 **최대 3개**의 AI를 영입.
- 각 AI는 **ChatGPT / Gemini / Claude 중 서로 다른 모델**이 랜덤으로 배정된다(매 게임 셔플,
  영입 순서대로 채움 → "순차적으로 랜덤").
- AI는 **모델 자체가 참가자**다. 무대 토큰의 **프로필 아이콘이 곧 모델 정체**(브랜드 마크),
  그 아래 모델명("ChatGPT" 등)이 적힌다. 즉 정체는 처음부터 공개.
- AI는 인원수에 포함되어 시작 인원을 채운다(용병).
- LLM 프로바이더는 **MindLogic 게이트웨이**(이미 Muel이 사용 중)로 일원화한다.

## 2. 결정

### 2.1 표현 — clean primitive (이름 패턴 해킹 금지)

`mafia.match_players`에 두 컬럼 추가:

- `is_ai boolean not null default false`
- `ai_provider text`  — `'chatgpt' | 'gemini' | 'claude'` (사람은 null)

봇은 **고정된 3개의 `mafia.users`** 행(슬롯)을 재사용한다(FK 충족용). 모델 정체는
**매치별로** `match_players`에 실린다: `display_name`(모델명), `ai_provider`(키),
`is_ai=true`, `ready=true`. 아바타는 클라이언트가 `ai_provider`로 브랜드 마크를 렌더하므로
호스팅이 필요 없다(`avatar_url`은 null).

`match_players_visible` 뷰는 `is_ai`, `ai_provider`를 **무조건 노출**한다(정체 공개가 설계 의도).
직업/진영 노출 규칙(본인/종료/악마회로)은 기존 그대로.

### 2.2 구동 — AI는 "헤드리스 클라이언트"

별도 검증 로직을 복제하지 않는다. muel-bot 워커가 봇 유저용 **gameJwt를 발급**해 사람과
**똑같은 엣지함수**(`match-ready`, `match-select-role`, `match-action`, `match-chat`)를 호출한다.
엔진 입장에선 AI와 사람이 구분되지 않는다 — 그냥 LLM이 결정하는 클라이언트. 불법 액션은
엔진 검증이 막는다. (동등한 관계 + 검증 단일화)

게임 진행 자체는 기존 `phase-advance`(pg_cron) 그대로. 워커는 페이즈 타임아웃 전에
AI의 행동만 채워 넣는다. AI가 행동하지 않아도(워커 정지 등) 게임은 타임아웃으로 진행된다
— **AI 미동작 = 기권**, 안전한 열화(graceful degradation).

### 2.3 프로바이더 페르소나 (MindLogic)

MindLogic 게이트웨이(`factchat-cloud.mindlogic.ai/v1/gateway`)는 OpenAI 호환이며 모델 id
문자열로 라우팅한다. 페르소나 → 모델 id는 **env 설정 가능**, 기본값:

| 페르소나 | env | 기본 모델 id |
|---|---|---|
| Claude | `GOMDORI_AI_MODEL_CLAUDE` | `claude-sonnet` (기준 모델) |
| Gemini | `GOMDORI_AI_MODEL_GEMINI` | `gemini-2.5-flash` |
| ChatGPT | `GOMDORI_AI_MODEL_CHATGPT` | (미정 — `.env`로 확정 필요, 폴백 `MINDLOGIC_MODEL`) |

전략 프롬프트는 **공유**(직업 규칙·현재 상태·합법 액션 목록을 주입). 페르소나는 모델 선택과
표시 라벨만 바꾼다. 모델 호출 실패 시 `MINDLOGIC_MODEL`로 폴백.

### 2.4 전 직업 범용 의사결정 (직업별 하드코딩 금지)

워커는 직업마다 코드를 두지 않는다. 매 페이즈마다:

1. 그 AI가 **합법적으로 볼 수 있는 상태**를 요약(자기 직업/진영, 생존자 목록, 공개+자기
   private 이벤트, 악마 회로 동료/채팅).
2. 그 직업의 **허용 액션 목록 + 합법 대상 후보**를 계산(roles 매니페스트 + 엔진 규칙 재사용).
3. LLM에 "액션 택1 + 대상 택1(또는 스킵)"을 **구조화 출력**으로 요청.
4. 결과를 검증된 엣지함수로 제출. 애매/실패 시 안전 기본값(스킵 또는 임의 합법 대상).

이렇게 하면 새 직업이 추가돼도 워커는 그대로 동작한다.

## 3. 인터페이스

### 3.1 새 엣지함수

- `match-invite-ai` (host, lobby): 미사용 프로바이더 중 랜덤 1 + 미사용 봇 슬롯 1 선택 →
  `match_players` upsert(`is_ai=true`, `ai_provider`, `display_name`=모델명, `ready=true`).
  제한: AI ≤ 3, 총원 ≤ 12. 이벤트 `player_joined`(public, `isAi:true`).
- `match-remove-ai` (host, lobby): 대상 AI 행 삭제 + 이벤트.

### 3.2 시작 게이팅

`match-start`는 이미 전 `match_players`를 인원으로 센다(8~12). AI는 `ready=true`라 준비
체크를 막지 않는다 → 사람 5 + AI 3 = 8로 시작 가능. **별도 변경 불필요.**

### 3.3 클라이언트(muel-tree)

- `PlayerSummary`에 `isAi`, `aiProvider` 추가(뷰→매핑).
- `LobbyPhase`: 호스트 전용 "참가자 데려오기"(AI<3일 때) + 각 AI "내보내기".
- `PlayerToken`/`GameStage`: `isAi`면 아바타 대신 **프로바이더 브랜드 마크** + 라벨.
- `game/page.tsx`: 로비 presence 고스트 필터에 **`|| p.isAi` 예외**(AI는 Discord 참가자
  목록에 없으므로 필터되면 안 됨).

## 4. 단계적 롤아웃 (increment)

- **Increment 1 (이 ADR과 함께):** 데이터 모델 + 영입/제거 + 로비 UI + 모델 브랜드 토큰.
  AI가 용병으로 "보이고 인원에 포함"된다. (아직 플레이는 안 함 = 매 페이즈 기권)
  - muel-bot PR: 마이그레이션 + 2 엣지함수 + `game.ts`.
  - muel-tree PR: api + 로비 + 토큰 + presence 예외.
- **Increment 2 (다음 PR, 브레인):** muel-bot 의사결정 워커 — gameJwt 발급, 전 직업 범용
  합법 액션, MindLogic 페르소나, `role_assign` 변종 선택 + 모든 행동 페이즈. **라이브
  매치로만 검증 가능** → fullgame-sim + 실게임 관측으로 튜닝.
- **Increment 3 (폴리시):** 악마 회로 채팅 참여, 페르소나 화법, 종료 화면, 밸런스 튜닝.

## 5. 리스크 / 대응

- **AI 미동작으로 인한 밸런스 왜곡**(항상 기권): Increment 1 단계의 알려진 한계. Increment 2가
  해소. 그 전까지는 "용병이 자리만 채운다"로 정직하게 노출.
- **MindLogic 모델 id 불확실(ChatGPT)**: env 설정 + 폴백으로 흡수. 확정 시 `.env`만 교체.
- **봇 gameJwt 발급**: 엣지함수와 동일한 `GAME_JWT_SECRET`으로 서명(워커가 보유). 짧은 만료.
- **유령 정리 필터**: AI는 presence에 없음 → 클라이언트 필터에 예외 처리(위 3.3).
- **마이그레이션 라이브 적용**: 추가 전용(additive) 컬럼 + 뷰 재생성이라 안전. 머지 후
  `apply_migration`(supabase-ops 프로토콜)으로 적용.
