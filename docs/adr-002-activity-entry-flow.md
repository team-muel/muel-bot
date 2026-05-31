# ADR-002: Gomdori Activity 진입 흐름 (instance 바인딩 + 명시 CREATE/JOIN)

**상태**: Accepted (2026-05-31)
**대상**: muel-tree · muel-bot(Edge Functions) · Supabase
**관련**: `adr-001-bow-activity-architecture.md`, muel-bot#26, muel-tree#7

## 배경

진입로가 "Activity 안에서 채널에 자동 바인딩 → 즉시 resolve→create→join" 하나뿐이었다. 결과:

- 사용자가 **방을 만들/참가하는 결정 지점이 없음**. Activity를 열면 곧장 로비로 떨어짐.
- Discord 1st-party Activity(Chess in the Park 등)의 **CREATE / JOIN 랜딩 → 같이 모이기** 경험이 없음.
- 매치 키가 `context_id`(voice channel) → 같은 채널에서 다시 열면 충돌 여지.

사용자 피드백: "유저가 Game Start까지 닿는 흐름부터가 구현이 안 되어 있다 — 적어도 Chess Activity처럼 실행→모으기→같이 플레이 형태여야."

## 결정

### 1. 매치 키 = Discord Activity `instance_id` (채널 폴백)

같은 보이스 채널에서 Activity를 띄운 참가자는 같은 `instance_id`를 공유한다 → "이 Activity 인스턴스 = 한 매치". `mafia.matches.instance_id` 컬럼 + 활성 부분 인덱스. `match-create`는 instance로 기존 매치 탐색(없으면 channel 폴백) 후 저장, `match-resolve`는 instance 우선 + `discordChannelId` 폴백(구 클라이언트 하위호환).

### 2. 명시적 CREATE / JOIN 랜딩 (Chess 동형)

부팅(auth) 후 자동 합류하지 않고 `resolveMatch(instance, channel)`만 수행 → `landing` 상태. 랜딩에서:

- **게임 만들기**(항상) → `createMatch(instanceId)` → join → 로비(host).
- **참가하기**(인스턴스에 매치 있을 때) → 로비면 join, 진행 중이면 바로 입장(재합류).

자동 합류(랜딩 없이 바로 로비)도 후보였으나, 사용자가 "명시 화면"을 선택. 의도적 모임 경험 + 다중 게임/오작동 진입 방지.

### 3. 모임(gathering) 모델

각 참가자가 같은 인스턴스의 매치에 **명시 JOIN** → `match_players` upsert → 기존 page.tsx의 Realtime 구독이 로비 로스터를 실시간 갱신. (Phase: SDK `getInstanceConnectedParticipants` + `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE`로 *JOIN 이전* 인스턴스 참가자까지 인지하는 로스터는 후속 — muel-tree#TBD.)

## 흐름 (목표 상태)

```
/게임 → Activity launch (discordsays.com iframe, proxy 경유)
  → auth-exchange (gameJwt)
  → resolveMatch(instance_id)
  → [CREATE/JOIN 랜딩]
       만들기 → match-create(instance) → join → 로비(host)
       참가   → match-join → 로비
  → Ready (비방장) / 게임 시작 (방장, 5~12명·전원 ready)
  → match-start → role_assign → 첫 밤(silent) → ...
```

## 트레이드오프

- instance_id는 Activity 세션 단위라 채널보다 정확하지만, Activity 밖(웹 직접 진입)에는 없음 → 웹 게스트/룸코드 경로는 별도(후순위, ADR-001의 Phase 1-2 룸코드와 연결).
- 명시 JOIN은 한 번의 클릭을 요구하지만, SDK participant 자동 인지(후속)로 "들어와 있는 사람"을 먼저 보여주면 마찰이 준다.

## 거부된 대안

- **자동 합류(랜딩 없음)**: 결정 지점·모임 경험 부재로 사용자가 거부.
- **채널 키 유지**: 재실행 충돌 + Discord 의도 단위 불일치.

## 구현 상태 (2026-05-31)

- muel-bot#26 (merged 시 prod): `instance_id` migration(적용 완료) + match-create/resolve(배포 완료).
- muel-tree#7: CREATE/JOIN 랜딩 + instanceId 전달.
- 후속: SDK 인스턴스 참가자 실시간 로스터(PR3), 웹 게스트/룸코드(옵션), 라이브 5인 QA.
