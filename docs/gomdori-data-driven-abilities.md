# ADR-006 — Gomdori 능력 데이터구동(일괄 적용) 아키텍처

상태: 제안 / 단계 구현
작성: 2026-06-15
관련: [[gomdori-ability]] 스킬, `_shared/engine/{types,roles,engine}.ts`, `match-action-core.ts`

## 1. 목표 (사용자)

능력을 한 개씩 손코딩하지 않는다. **능력을 데이터로 선언하면 엔진·검증·UI·상태가 그걸
일괄로 소비**하는 구조가 목표. "현재 게임 액션"이라는 별도 층이 소멸하고, 원본 능력표가
곧 실행 가능한 단일 출처가 된다. 충실도 = verbatim(원문), rainer(+1)·pasua(scale)
수치만 튜닝 유지.

## 2. 현재 상태 — 토대는 이미 데이터구동

엔진은 이미 선언형이다:

- `RoleDefinition.actions.night[]` = `ActiveAbility { id, targetType, priority, effects: Effect[], maxUses?, requiresCounter? }`.
- `Effect` = 타입 프리미티브 유니온(Kill/Heal/Protect/Silence/Corrupt/Possess/Nightmare/Charm/GrantCount/Cleanse/Rebrand/Disguise/Eclipse/Nullify/Sleep/ModifyReceivedVote·Suspicion/ChangeFaction/AddTag…) + target(self/Target/All/VoteTarget/SuspectTarget) + amount/duration/immuneFactions/tag.
- `resolveNightActions` = 제네릭 루프: priority 정렬 → 봉인/무효/maxUses/requiresCounter 게이트 → `applyEffect`(타입별 디스패치). **직업 분기 없음.**

즉 **능력 추가/변경 = roles.ts 의 effects[] 편집(데이터)** 이고 엔진이 자동 적용한다.
이것이 "일괄"의 핵심 메커니즘이며 이미 작동한다.

## 3. 남은 하드코딩 (제거 대상)

1. **검증 중복** — `match-action-core.ts` 의 `NIGHT_ACTIONS_BY_ROLE`/`SELF_ACTIONS`/
   `REVIVE_ACTIONS`/`KILL_LIKE`/`NO_SELF_TARGET` 는 CORE_ROLES 정보의 손유지 복제.
   → **CORE_ROLES 에서 도출**(단일 출처)하면 능력을 roles.ts 한 곳에만 정의해도 검증이 따라온다.
2. **엔진 잔여 role 하드코드** — `resolveNightActions` 의 말렌 혼/시체, 도르단 단서,
   파스아 쿨다운은 `currentRole==="malen"` 식 분기. → 선언형 **death-hook/cooldown**
   프리미티브로 일반화하면 "완전 데이터구동" 달성.
3. **대상 제한** — 파스아 포교(처치자·중립 불가)·루나 타락(천사만)은 *역할집합* 규칙이라
   faction 필터로 표현 불가. 엔진 applyEffect 가 이미 이중 가드하므로, match-action 의
   사전 거부는 선언형 `targetFilter`(roleSet 기반)로 옮길 수 있다(후속).
4. **크로스레포 동기화** — muel-tree 매니페스트(표시)와 roles.ts(엔진)는 모노레포가
   아니라 명시 sync. 능력 표시 단일화(원본 능력표 + status 배지)는 이미 적용(PR #109/#110).

## 4. 일괄 적용 엔드포인트

- **단일 출처 = CORE_ROLES**(엔진). match-action 검증·phase-advance priority 는 여기서 도출.
- 능력을 늘리려면 effects[] 를 채운다(데이터). 기존 프리미티브로 표현되면 즉시 live.
- 새 메커닉은 **프리미티브를 1회 추가**(types.ts 유니온 + applyEffect case)하면 그걸 쓰는
  모든 능력이 일괄로 따라온다.
- 직업별 패시브/후크(혼·단서·쿨다운)는 **선언형 hook 레지스트리**로(직업 분기 제거).
- UI 는 원본 능력표(status: live/partial/planned)가 단일 표시. live = effects[] 가 그 원본을
  충실히 구현한 능력.

## 5. 롤아웃 (각 단계 test:gomdori 등가성 게이트)

`test:gomdori`(phase1·w4·w6·codex·v2-abilities·fullgame-sim)가 **등가성 오라클**이다 —
리팩터가 기존 동작을 바꾸지 않았음을 보장.

- **S1 (이 ADR과 함께): 검증 도출.** match-action-core 의 액션 목록/self/revive/self-제외를
  CORE_ROLES 에서 도출. 동작 불변, 중복 제거. 계약 테스트를 단일 출처(roles.ts) 기준으로 갱신.
- **S2: 대상 제한 선언화.** ActiveAbility 에 `targetFilter`(excludeSelf/roleSet) 추가, 파스아·
  루나 사전검증을 데이터로. 
- **S3: 엔진 후크 일반화.** death-hook(말렌 혼·도르단 단서)·cooldown(파스아)을 선언형으로 →
  resolveNightActions 직업 분기 0.
- **S4: 일괄 effects 채우기.** 기존 프리미티브로 표현 가능한 partial/planned 능력의 effects[]
  를 채워 일괄 live. 새 프리미티브 필요분은 프리미티브 추가 후 일괄.

## 6. 비고

- 라이브·밸런스 검증 엔진이므로 각 단계는 sim 통과가 머지 조건.
- "verbatim"이라도 rainer +1·pasua scale 은 튜닝 유지(무한게임/지배 방지, gomdori-gameplay-verification).
- 배포: [[gomdori-deploy-autonomy]] — 머지 후 마이그레이션·엣지 재배포 자율.
