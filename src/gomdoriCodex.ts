/**
 * Gomdori 도감 (Codex) — 직업 정본·구현 스펙 데이터.
 *
 * 이 모듈은 **게임 엔진/배정 코드와 완전히 분리된 순수 데이터**다. 엔진(roles.ts·
 * match-start 등)을 import 하지 않으며, 반대로 엔진도 이 파일에 의존하지 않는다.
 * 목적 두 가지:
 *   1) /도감 슬래시 명령이 인터랙티브하게 보여줄 소스(진영별 목록 + 자세히 보기).
 *   2) v2 구현 스펙의 단일 명세 — 각 항목의 `v2` 가 엔진이 구현해야 할 계약.
 *
 * 진영(faction)은 **논리 진영**(천사/악마/조력자/중립) — 엔진 DB faction(조력자는
 * 'demon'으로 저장) 과 다르다. 도감은 사람이 읽는 분류를 따른다.
 *
 * 정본 출처: vault `Universes/BoW/Characters/*` + 2021 컨트롤 F 통합 시트(GDrive).
 * v1/v2 필드 최신화: 2026-06-17 — 전 로스터 v2 핵심 엔진/테스트 기준 동기화.
 */

export type CodexFaction = "angel" | "demon" | "helper" | "neutral";

export interface CodexAbility {
  kind: "패시브" | "특수 패시브" | "능력" | "능력2";
  name: string;
  text: string;
}

export interface CodexEntry {
  /** 엔진 role id (도감 표시 전용 — 엔진 import 는 하지 않는다). */
  id: string;
  name: string;
  faction: CodexFaction;
  title: string; // 직업 타이틀 (탐정, 사이비 교주 등)
  slot?: string; // BoW 시트 슬롯
  summary: string; // 한 줄 요약 (목록 카드 본문)
  abilities: CodexAbility[]; // 정본 능력
  v1: string; // 현재(v1) 구현 현황
  v2: string; // v2 구현 스펙 — 엔진이 해야 할 일(계약)
  vault?: string; // vault 카드 경로
}

export const FACTION_LABEL: Record<CodexFaction, string> = {
  angel: "천사",
  demon: "악마",
  helper: "조력자",
  neutral: "중립",
};

export const GOMDORI_CODEX: CodexEntry[] = [
  // ===== 천사 =====
  {
    id: "romaz", name: "로마즈", faction: "angel", title: "용의자 색출 경찰", slot: "천사-2",
    summary: "매일 밤 용의자를 지목해 다음 투표에서 그 대상의 무게를 키운다.",
    abilities: [
      { kind: "능력", name: "용의자 색출", text: "대상에게 +5 투표가치 / +10 의심가치를 받는-표로 가산. 다음 집계에 반영." },
    ],
    v1: "구현됨. romaz_suspect → ModifyReceivedVote(+5)/ModifyReceivedSuspicion(+10). 라운드별 voteBias/suspicionBias 로 초기화(연속 누적 방지).",
    v2: "다단계: 조사장/신념 등 후속 시트 능력. 현 v1 시그니처 유지.",
    vault: "Universes/BoW/Characters/로마즈.md",
  },
  {
    id: "rainer", name: "라이너", faction: "angel", title: "백호의 소환자", slot: "천사-13",
    summary: "수호신 백호를 불러 천사팀 카운트를 늘려 마을을 지킨다.",
    abilities: [
      { kind: "패시브", name: "백호", text: "백호 소환 시 천사팀 카운트 +3(생존 무관, 지속). 소환 이후 악마는 모든 천사 제거 외 승리 경로 없음." },
    ],
    v1: "구현됨. rainer_summon — 1회 self 소환 액션으로 countBonus +3 / deadCountBonus +3 획득. 배정 자동 주입이 아니라 능동 소환으로 처리하며 maxUses 1로 재사용을 차단한다.",
    v2: "백호 소환의 canon +3 생존/사후 카운트가 라이브. 거친 포효 등 추가 시트 능력은 별도 확장 대상.",
    vault: "Universes/BoW/Characters/라이너.md",
  },
  {
    id: "dordan", name: "도르단", faction: "angel", title: "탐정", slot: "천사-3",
    summary: "매일 밤 한 명의 정체를 조사한다. 단서를 모으면 사건의 전말로 발전.",
    abilities: [
      { kind: "패시브", name: "침착한 탐정", text: "누군가 탈락하면 투표 대상을 '범인'으로 지목. 범인이 그날 밤 지정하는 대상이 도르단에게 알려짐." },
      { kind: "능력", name: "단서 수집 / 사건의 전말", text: "대상의 능력 발동 확인 + 단서. 단서 (5-탈락자)개 → '사건의 전말'로 변경(악마면 전원 통지+아침 생략+판결)." },
      { kind: "능력2", name: "잠입 수사", text: "대상을 밤 동안 관찰. 탈락/탈락시키면 '불심검문' 발동, 그 밤 도르단은 모든 부정 효과 무시." },
    ],
    v1: "구현됨. police_investigate(악마/천사 판정) + 침착한 탐정 단서(death-hook: 탈락자 1명당 단서 +1) + culprit_target_revealed(탈락 발생 밤, 도르단의 투표 대상이 지정한 대상 private 통지). 단서 3개부터 정밀 조사(정확한 직업 통지) + 사건의 전말(정밀 조사로 악마 처치자 식별 시 matches.engine_state.caseClosed → phase-advance 가 아침 생략·그 악마 강제 판결). dordan_infiltrate 는 관찰 대상이 그 밤 탈락하면 stakeout_triggered 로 도르단 부정효과를 정화한다.",
    v2: "단서 카운터(탈락자 수 연동), 범인 지정 대상 통지, 사건의 전말(전원 통지·아침 생략·판결 강제), 잠입 수사(관찰→불심검문→부정효과 무시)까지 핵심 라이브.",
    vault: "Universes/BoW/Characters/도르단.md",
  },
  {
    id: "habreterus", name: "하브레터스", faction: "angel", title: "치료자(의사의 소명)", slot: "천사-4",
    summary: "생명의 언약으로 한 명을 치료. 악마에게 존재가 알려진 채 활동한다.",
    abilities: [
      { kind: "패시브", name: "임종 선언", text: "치료 실패로 탈락한 날 투표가치 -1 + '소명'(천사팀 카운트 +1, 부정효과 제거, 3일 쿨다운)." },
      { kind: "능력", name: "생명의 언약", text: "대상 치료. 성공 시 투표가치 +3, 소명 대기 -1일." },
      { kind: "능력2", name: "삶이 있는 곳으로", text: "게임 시작 시 악마에게 하브레터스 존재 통지. 매 밤 서로 추리 — 악마 성공→다음 아침 탈락(치료 무시), 하브레터스 성공→악마 효과 면역." },
    ],
    v1: "구현됨. doctor_heal(1_NIGHT 보호) — 생명의 언약 + 소명(onSaveGrantSelf: 그 밤 실제 공격을 막으면 시전자 투표가치 +3). habreterus_deduce 는 악마 처치자 적중 시 하브레터스의 그 밤 부정효과를 정화하고 deduce_hit/deduce_miss 를 통지한다.",
    v2: "치료 성공 보상과 하브레터스 측 상호추리 면역은 라이브. 소명 3일 쿨다운과 악마측 역추리 탈락은 별도 서브시스템 확장 대상.",
    vault: "Universes/BoW/Characters/하브레터스.md",
  },
  {
    id: "mizlet", name: "미즐렛", faction: "angel", title: "행복을 파는 가게", slot: "천사-15",
    summary: "디저트와 와인으로 사람을 살리는 가게. 게임이 어두워지면 다수를 부활시킨다.",
    abilities: [
      { kind: "패시브", name: "행복을 파는 가게", text: "탈락자가 생존자보다 많아지면 두 명을 지목해 복귀 + 미즐렛 탈락. 소멸·부활불가 무시. 1회." },
      { kind: "능력", name: "디저트 선물", text: "쿠키(탈락해도 그 밤 능력 발동)/푸딩(무시불가 버프, 탈락 시점 밤으로 조정)." },
      { kind: "능력2", name: "고급 와인", text: "디저트 받은 대상은 부정효과 제거+미즐렛과 대화. 미제공 대상은 자기 부정효과 사라지고 투표가치 -1." },
    ],
    v1: "구현됨. mizlet_revive(탈락자 부활, 1회) + mizlet_dessert(생존자 보호+디저트 태그) + 다수복귀 패시브(탈락자>생존자 시 가장 최근 탈락 2명 복귀[소멸·부활불가 무시] + 미즐렛 탈락, 1회, phase-advance night_resolve). mizlet_wine 은 전원 정화 + 디저트 미제공자 voteValueMod -1로 라이브.",
    v2: "부활, 디저트 버프, 다수 복귀 패시브, 고급 와인 정화/페널티까지 핵심 라이브. 미즐렛과 디저트 대상 대화 연결은 별도 확장 대상.",
    vault: "Universes/BoW/Characters/미즐렛.md",
  },
  {
    id: "helen", name: "헬렌", faction: "angel", title: "황금빛 수면", slot: "천사-17",
    summary: "추억·수면·부활의 천사. 죽음을 보류한다.",
    abilities: [
      { kind: "패시브", name: "행복 쉼터", text: "시작 시 전원에게 헬렌 존재 통지. 황금빛 수면 적용자는 투표가치 모두 소모해 헬렌과 접선·영혼 기억. 기억된 플레이어는 탈락 후에도 수면 발동 가능." },
      { kind: "능력", name: "황금빛 수면", text: "대상 수면(부정효과 무효+행동 불가). 깨어나면 지정대상·투표가치 +1. 연속 같은 대상 불가." },
      { kind: "능력2", name: "자유로운 새", text: "다음 아침 탈락자들이 생존 행동 가능. 처형/탈락자에게 수면 부여. 지속 '추억을 간직하는 법'(수면으로 깨면 복귀)." },
    ],
    v1: "구현됨. helen_revive(탈락자 부활, SINGLE_DEAD Heal·1회) + helen_sleep(생존자 황금빛 수면 — Sleep: 죽음보호+행동봉인+부정효과 무효) + helen_freebird(탈락자 추가 복귀, 1회).",
    v2: "수면 보호/봉인/정화, 부활, 자유로운 새 추가 복귀까지 핵심 라이브. 추억 기반 지속 복귀 연계는 별도 확장 대상.",
    vault: "Universes/BoW/Characters/헬렌.md",
  },
  {
    id: "uno", name: "우노", faction: "angel", title: "명예의 군인", slot: "천사-6",
    summary: "군인의 사명과 명예. 살아있는 한 천사팀 카운트를 더한다.",
    abilities: [
      { kind: "패시브", name: "군인의 사명", text: "악마 효과 1회 제거(투쟁 2회로 충전)." },
      { kind: "능력", name: "투쟁", text: "대상 소속 카운트 +1 + '군인의 사명' 부여. 발동/생존 시 우노 '명예'(천사팀 카운트·투표가치 +10)." },
      { kind: "능력2", name: "용맹함", text: "전원 투쟁 발동. 우노 투표 대상은 사망 기록+소속 공개. 천사면 '명예 실추'(밤 행동 불가). 1회." },
    ],
    v1: "구현됨. 명예 countBonus +1 + 투표가치 +10(배정 — 사탄의 마 -1 을 뚫는 천사 표 경로) + uno_struggle(투쟁: GrantCount + missionCharge 1, 2스택이면 악마 효과 1회 제거) + uno_valor(용맹함 1회: 자기 Cleanse + 전원 투쟁/missionCharge + 투표대상 소속 공개/처형 + 천사 살해 시 우노 다음 밤 봉인).",
    v2: "군인의 사명, 투쟁, 용맹함 전원 효과, 소속 공개, 명예 실추까지 핵심 라이브.",
    vault: "Universes/BoW/Characters/우노.md",
  },
  {
    id: "arthur", name: "아서", faction: "angel", title: "여명의 기사", slot: "천사-14",
    summary: "결백한 천사를 지키고 타락한 자를 소멸시키는 해의 기사. 루나의 거울 짝.",
    abilities: [
      { kind: "패시브", name: "여명의 기사", text: "어떤 효과로도 탈락하지 않음. 단 결백한 천사팀 3명+ 탈락 시 함께 탈락. 탈락자 1명당 아침 토론 +1분 + '잔불 대검' +1." },
      { kind: "능력", name: "잔불이 꺼지기 전에", text: "대상에게 '해오름' 하루(조사 시 결백/타락만 통지). '잔불 대검' 1회 충전. 3인 지정." },
      { kind: "능력2", name: "잔불 대검", text: "결백자에게 하루 무적. 타락자에게 '폭열'(다음 잔불 대검에 베이면 소멸). 0회 제한·충전." },
    ],
    v1: "구현됨(2026-06-17 정정 — 행위 기반). 결백/타락은 *진영이 아니라* counters.tainted(부정 효과를 한 번이라도 적용한 적 있는가)로 판정(vault §해오름). arthur_judge=잔불이 꺼지기 전에(Verdict 결백/타락 통지 + 해오름 태그 + emberCharge +1). arthur_emberblade=잔불 대검(requiresCounter emberCharge 1 소비: 결백=Protect skipIfTainted / 타락=Annihilate onlyIfTainted, branded→annihilated 2단). 새 프리미티브: Verdict + onlyIfTargetCounter/skipIfTargetCounter. ※구버전 onlyFactions 진영 게이트는 캐논 위반이라 폐기.",
    v2: "구현됨(2026-06-17). 여명의 기사 패시브 = 아서 밤 효과 면역(arthur_immune) + 결백한(tainted 0) 천사팀 누적 3명+ 탈락 시 동반 탈락(dawnbreaker_fallen) + 결백 천사 탈락 1명당 잔불 대검 +1 충전(applyDawnbreakerPassive). 위용 = 충전≥3 시 해오름(dawnrise) 적용된 결백 천사 1명당 아서 투표가치 +3(prowessVoteBonus, tally 통합). 잔불이 꺼지기 전에 = 3명 지정(targetCount:3, 멀티타깃). 세이카 봉인=부정효과 포함, 루루 양도=제외(Annihilate 도 제외 — 의로운 심판). 해오름 1일 만료·멀티타깃 영속화(result.targetUserIds)+제네릭 다중선택 UI(maxTargets)·투표/의심 가해 taint(부호 기반) 모두 라이브. 4게이트 통과. 남은 후속: 멀티타깃 무대 다중 하이라이트(패널엔 표시됨)·라이브 매치 스모크.",
    vault: "Universes/BoW/Characters/아서.md",
  },
  {
    id: "seika", name: "세이카", faction: "angel", title: "초신성·등대", slot: "천사-12",
    summary: "초신성·등대·별빛의 천사. 자매 세야카(악마-12)와 별빛으로 대화한다.",
    abilities: [
      { kind: "패시브", name: "별이 떠오른 밤", text: "초신성 폭발 다음 밤은 의심 생략 + 밤 대화 1분 증가." },
      { kind: "능력", name: "초신성", text: "그 밤 대상이 받는 부여 효과 모두 제거 + 능력 발동 불가. 같은 대상 재적용 시 폭발→영구 능력 봉인+세이카에게 직업 통지(셀레스트:희망)." },
      { kind: "능력2", name: "자신만 아플 거야", text: "전원 부여 효과를 세이카에게. 악마팀 효과 3개+ 받으면 소멸, 이틀 후 악마팀 공개. 1회." },
    ],
    v1: "구현됨. seika_supernova — 초신성(Cleanse 부정효과 제거 + Silence 봉인, priority 1; seikaMark 재적용 시 silencedPermanent 영구 봉인) + 별이 떠오른 밤(onFireSetCounter starlitNext → phase-advance 가 다음 밤 의심 투표 생략). 새 이펙트 Cleanse 도입.",
    v2: "자신만 아플 거야(seika_absorb)는 전원 정화, 악마팀 출처 효과 3개+ 흡수 시 세이카 소멸, 이틀 후 악마팀 공개 카운트다운까지 라이브.",
    vault: "Universes/BoW/Characters/세이카.md",
  },
  {
    id: "luru", name: "루루", faction: "angel", title: "연주자", slot: "천사-30",
    summary: "선율로 사람을 매료시키는 연주자. 투표 권한을 양도받는다.",
    abilities: [
      { kind: "패시브", name: "아름다운 영혼을 위한 소나타", text: "매료 3명+ 달성 시 즉시 연주(매료 제거). 연주는 하루 지속, 전원 투표가치·지정 대상 +1. 연주 마치기 전 탈락 안 함." },
      { kind: "능력", name: "영혼을 만지는 음색", text: "대상 매료 — 투표 권한이 루루에게 양도. 능력 발동으로 해제." },
      { kind: "능력2", name: "악보 교체", text: "투표를 몇 명에게든 행사. 무투(다음 아침 투표 2회)/자투(투표가치 +(1+매료), 반론 다인 등판) 등 악보 변경." },
    ],
    v1: "구현됨. luru_charm(매료 + charmCount 게이지 + 투표권 양도 voteWeightBonus) + luru_sonata(매료 3 누적 시: 전원 Cleanse + 자기 무적, requiresCounter·소비) + luru_score(악보 교체 자투: 자기 투표가치 +1, 1회).",
    v2: "매료, 소나타, 악보 교체 자투 코어까지 라이브. 무투/다중 투표/반론 등판형 악보 재설계는 별도 확장 대상.",
    vault: "Universes/BoW/Characters/루루.md",
  },

  // ===== 악마 =====
  {
    id: "demon", name: "대악마", faction: "demon", title: "만악의 근원", slot: "악마-1",
    summary: "사탄·메피스토 모티프. 악마 진영의 1번 슬롯. 낙인으로 직업을 재배정한다.",
    abilities: [
      { kind: "패시브", name: "사탄의 마", text: "능력 성공 시 전원 투표가치 -1. 천사팀 전체 0이 되면 모든 조사·취급이 악마로 판정." },
      { kind: "특수 패시브", name: "메피스토의 낙인", text: "투표 대상에게 통지. 대악마가 직업 삭제+새 천사 직업 배정 즉시 발동. 자기 직업 모르면 효과 주고받기 불가." },
      { kind: "능력", name: "만악의 근원 / 감시", text: "대상 탈락 + 낙인 적용자 존재 시 감시 추가." },
      { kind: "능력2", name: "압도적인 존재감", text: "전원 지정대상이 낙인 적용자로 변경. 공포로 다음 밤까지 횟수제한·중첩 효과 손실(조력자 예외). 1회." },
    ],
    v1: "구현됨. demon_kill(처치 + 사탄의 마: 자신 제외 전원 투표가치 -1, 악마 투표 독점) + daeakma_brand(낙인: Rebrand) + daeakma_dominion(압도적 존재감 1회: 전원 봉인, Silence AllOthers). 가인 있으면 보호막 1. 사탄의 마 전역 판정(생존 천사팀 전원 투표가치 0 → 모든 조사 '악마', match-action-core)도 라이브. 전역 '취급'(승리·효과 전반) 확장은 후속.",
    v2: "메피스토 낙인(직업 삭제→비밀 재배정) + 사탄의 마(전원 투표가치 -1, 천사팀 0 시 전역 악마 판정) + 압도적 존재감(전원 능력 봉인 1회).",
    vault: "Universes/BoW/Characters/대악마.md",
  },
  {
    id: "phantom", name: "팬텀", faction: "demon", title: "침묵의 밤", slot: "악마-2",
    summary: "악몽과 일식의 악마. 밤을 연장하고 직업을 봉인한다.",
    abilities: [
      { kind: "패시브", name: "침묵의 밤", text: "밤 종료 시 밤 연장 가능(대화 +1분, 생존 천사팀 카운트 +1). 팬텀-조력자는 접선 불가하나 서로 정체·직업 통지." },
      { kind: "특수 패시브", name: "어둠이 내린 도시", text: "매 밤 두 명 지목해 직업 봉인(능력 사용 불가). 아침마다 지목 +1. 연속 동일 불가. 무지목 시 '악몽' 2회 충전." },
      { kind: "능력", name: "악몽", text: "대상은 밤이 오면 '악몽', 연속이면 '영면'. 악몽→아침 탈락. 영면→즉시 처리 가능. 5회 제한." },
      { kind: "능력2", name: "일식", text: "다음 아침을 밤으로 변경, 대신 아침이 오면 팬텀 소멸. 1회." },
    ],
    v1: "구현됨. phantom_nightmare(지정 밤→다음 밤 악몽→다음 아침 탈락, 5회 제한), 재지정 영면(deepsleep) + phantom_reap 일괄 처치, phantom_seal(동적 다중 봉인: 2+sealCap, 아침마다 성장, 무지목 시 악몽 +2), phantom_silentnight(밤 연장+천사 카운트 보상), phantom_eclipse(아침→밤 전환+자기 소멸).",
    v2: "어둠이 내린 도시, 악몽/영면/영면 발동, 침묵의 밤, 일식까지 핵심 라이브.",
    vault: "Universes/BoW/Characters/팬텀.md",
  },
  {
    id: "malen", name: "말렌", faction: "demon", title: "강령술사", slot: "악마-7",
    summary: "악령 마야와 함께하는 강령술사. 빙의시키고 시체를 부린다.",
    abilities: [
      { kind: "패시브", name: "악령 마야", text: "매 밤 한 명에게 빙의 — 빙의 대상은 밤 행동 불가 + 악마팀 카운트. 마야가 말렌에게 빙의하면 그 밤 모든 효과 무시." },
      { kind: "특수 패시브", name: "악담", text: "탈락자 발생 시 '혼' 생성. 혼 2개→시체 변환(투표·의심·능력 발동 보조). 시체 1구당 혼령 방출 대상 +1." },
      { kind: "능력", name: "혼령 방출", text: "지목 대상 무차별 공격. 1회→'혼령' 표식+마비, 2회→영에게 잠식(생존 미취급, 투표가치 조공)." },
      { kind: "능력2", name: "신출귀몰", text: "혼령 표식 수거→다음 밤 시체 소환. 1회 제한." },
    ],
    v1: "구현됨. malen_release(혼령 방출 다단계 Haunt: 1회차 혼령 표식, 2회차 잠식=탈락+투표가치 조공[말렌 voteWeightBonus +1]) + malen_possess(그 밤 행동봉인+악마팀 카운트 전환+다음 밤 마비 예약) + SoulCounter death-hook(밤 탈락자 1명당 혼 +1, 혼 2개→시체 1구 = 악마팀 deadCountBonus +1) + malen_elusive(신출귀몰 1회: 혼령 표식 수거→다음 밤 corpsePending 이 deadCountBonus 로 승격).",
    v2: "빙의, 마비, 혼/시체 카운터, 혼령 방출 다단계, 신출귀몰 시체 소환까지 핵심 라이브.",
    vault: "Universes/BoW/Characters/말렌.md",
  },
  {
    id: "besto", name: "베스토", faction: "demon", title: "히든 포지션", slot: "악마-14",
    summary: "밤마다 모습을 바꾸는 변신 악마. 언급으로 탈락시킨다.",
    abilities: [
      { kind: "패시브", name: "두 번째 자아", text: "밤마다 자아 변경 — 솔(천사 판정·투표가치 1 고정·의심 미지목) / 하베스토(악마 판정·투표가치 3 고정)." },
      { kind: "특수 패시브", name: "배후", text: "조력자와 영혼 교체 — 베스토·조력자 대상 능력 효과는 모두 반대로 통지(투표·의심 제외)." },
      { kind: "능력", name: "히든 포지션", text: "미발동 시 강화(최대 2회). 다음 아침 토론 중 효과발동자가 언급한 대상 탈락(최대 1+강화). 2회 제한." },
      { kind: "능력2", name: "누명씌우기", text: "대상이 히든 포지션 효과를 받음. 이 효과 탈락 시 강화 +1. 짝숫날 발동 불가." },
    ],
    v1: "구현됨. besto_hidden(히든 포지션: 처치) + besto_shift(두 번째 자아 = 밤마다 솔/하베스토 판정 전환, Disguise) — 핵심 시그니처 완비. 히든 강화 스택·멘션킬(아침 토론 언급 기반 = 텍스트 파싱)·배후(효과 반전)는 후속.",
    v2: "두 번째 자아(밤마다 솔/하베스토 판정 전환) + 히든 포지션(언급 기반 탈락 + 강화 스택) + 배후(조력자 효과 반전). 새 이펙트: AltSelf/MentionKill.",
    vault: "Universes/BoW/Characters/베스토.md",
  },

  // ===== 조력자 =====
  {
    id: "gain", name: "가인", faction: "helper", title: "진실을 가리는 암흑", slot: "조력자-1",
    summary: "악마를 살해·처형 1회로부터 보호하는 조력자. 조사 시 천사로 보인다.",
    abilities: [
      { kind: "패시브", name: "진실을 가리는 암흑", text: "악마와 접선·대화. 악마가 처형·탈락할 때 없던 일로 판정. 두 번째 밤 종료 시 패시브 삭제." },
      { kind: "능력", name: "약간의 위선", text: "대상 직업 통지 + 적용 효과를 다음 밤으로 연기. 대상이 악마에 탈락하면 연기 무효+다음 위선이 탈락 효과로 변경. 조사." },
      { kind: "능력2", name: "급습", text: "대상의 통지 삭제 + 급습 1회 충전. 다음 아침까지 악마와 대화. 1회 제한." },
    ],
    v1: "구현됨. 배정 시 악마에 보호막 1(밤 살해·처형 1회 무효) + 조사 시 천사로 보임(처치자 아님) + gain_hypocrisy(대상 진영 통지, 효과 다음 밤 연기, 위선 대상이 밤에 탈락하면 다음 위선이 처치로 전환).",
    v2: "약간의 위선의 정찰·연기·처치 전환 코어와 보호막은 라이브. 급습(통지 삭제)과 2일 후 패시브 만료는 별도 확장 대상.",
    vault: "Universes/BoW/Characters/가인.md",
  },
  {
    id: "luna", name: "루나", faction: "helper", title: "달의 사제", slot: "조력자-5",
    summary: "천사를 악마로 만드는 달의 사제. 아서(천사-14)의 거울 짝.",
    abilities: [
      { kind: "패시브", name: "달빛이 비치는 우물", text: "루나가 투표·의심한 대상에 '달빛'. 달의 힘 100% 충전 시 효과 발동+달빛 소멸." },
      { kind: "능력", name: "고요한 적막", text: "달빛 대상 1명당 달의 힘 +10%(악마 +30%). 100% 시 해가 저문다(토론 생략·증가 투표가치 마이너스 판정) / 달이 차오른다 선택." },
      { kind: "능력2", name: "공포 속에 밀어 넣다", text: "대상에게 '달빛 저주'. 달의 힘 가득 차면 대상은 직업 잃고 악마팀. 1회 제한." },
    ],
    v1: "구현됨. luna_moonlight(고요한 적막 — 투표/의심 대상에 달빛 태그, 천사/중립 +1, 악마 +3 비례 충전) + luna_corrupt(공포 — moonGauge 10 이상 시 천사→악마팀 타락, 1회 제한) + luna_dawn(해가 저문다 v2, 1회: state.modifiers.dawnRule=1 → 다음 처형/찬반 투표에서 능력으로 증가한 voteValueMod>0 와 prowess 부호 반전, phase-advance verdict 종료 시 소비) + luna_moonrise(달이 차오른다 v2, priority 2: state.modifiers.moonriseRule=1 → 같은 밤 악마 Kill 이 moonlit 대상에 발동하면 모든 달빛 대상 cascade markedForDeath, 그 밤 종료 시 해제). 셋(corrupt/dawn/moonrise) 모두 moonGauge 100% 소비 — 같은 풀에서 하나만 선택.",
    v2: "달빛 비례 충전·공포 타락(1회)·해가 저문다 능력보너스 부호 반전·달이 차오른다 cascade 까지 핵심 라이브.",
    vault: "Universes/BoW/Characters/루나.md",
  },
  {
    id: "logen", name: "로건", faction: "helper", title: "부서진 펜던트", slot: "조력자-10",
    summary: "게임 시작 시 악마와 접선. 능력을 소멸시키는 조력자.",
    abilities: [
      { kind: "패시브", name: "부서진 펜던트", text: "시작 시 악마 접선. 악마팀에 '부서진 펜던트'(지워지지 않음). 셋 이상 적용 시 로건 지정 대상 +2, 횟수 제한 사라짐." },
      { kind: "능력", name: "네 안에 없는 것", text: "대상에게 '가장 가까운 밤에 발동시키는 능력 효과가 소멸한다' 통지 + '펜던트' 적용. 이미 적용 대상이면 펜던트를 부숨." },
    ],
    v1: "구현됨. logen_nullify — 네 안에 없는 것(대상의 *다음* 능력 효과 소멸, 지속·발동 시 소비). 부서진 펜던트는 악마 처치자에게 영구 태그를 부여하고 3명 이상이면 로건 지정 대상 +2(pendantTargetBonus).",
    v2: "네 안에 없는 것과 부서진 펜던트 지정 대상 보너스까지 핵심 라이브.",
    vault: "Universes/BoW/Characters/로건.md",
  },
  {
    id: "ellen", name: "엘런", faction: "helper", title: "박해자", slot: "조력자-13",
    summary: "투표가치를 조작하는 박해자. 자아 해체 메커닉.",
    abilities: [
      { kind: "패시브", name: "박해자 / 해체된 퍼즐", text: "홀수날 투표 대상은 투표가 진행될 때마다 투표가치 +1. 자아 망가진 동안 투표·의심·능력 가치 상실. 자아 되찾으면 박해자 효과 변경(얻은 투표가치만큼 그날 아침 자신을 투표한 것으로)." },
      { kind: "능력", name: "비치지 않는 자아", text: "(시트 후속 다단계 — v2 정리 대상)." },
    ],
    v1: "구현됨. ellen_persecute — 박해(NONE 타깃, substrate VoteTarget: 직전 투표 대상 받는-투표가치 +3, 홀수날 한정 oddDayOnly 게이트). persecuteBias 가 지속 누적되어 같은 대상 재박해 시 +3/+6/+9로 tally에 반영된다.",
    v2: "박해 누진 코어는 라이브. 해체된 퍼즐 상태 전환은 별도 확장 대상.",
    vault: "Universes/BoW/Characters/엘런.md",
  },

  // ===== 중립 =====
  {
    id: "pasua", name: "파스아", faction: "neutral", title: "사이비 교주", slot: "중립(특수-4)",
    summary: "포교로 천사·조력자를 교세로 흡수. 누적 3명 전향 시 단독 즉시 승리.",
    abilities: [
      { kind: "패시브", name: "구원자", text: "시작 전 파스아 존재를 전원 통지. 생존자 중 파스아 팀이 절반 이상이면 즉시 승리." },
      { kind: "능력", name: "포교", text: "대상 포교(악마·중립 불가). 전향자는 기존 승리조건 삭제+파스아 승리 부여. 연속 발동 불가." },
      { kind: "능력2", name: "신앙", text: "대상 탈락(악마는 탈락 안 함)." },
    ],
    v1: "구현됨. pasua_convert → 천사·가인 전향(currentRole=converted, 중립). 누적 3명+파스아 생존 시 checkWinCondition 우선 중립 승리. pasua_faith(신앙) → 대상 탈락(Kill, 악마 면역 immuneFactions). 연속 포교 제한(convertCooldown).",
    v2: "승리 임계는 생존 교세 기준 max(3, ceil(인원/3))로 라이브 튜닝 완료. 신앙·연속 포교 제한도 v2 반영 완료.",
    vault: "Universes/BoW/Characters/파스아.md",
  },
];

export function codexByFaction(faction: CodexFaction): CodexEntry[] {
  return GOMDORI_CODEX.filter((e) => e.faction === faction);
}

export function codexById(id: string): CodexEntry | undefined {
  return GOMDORI_CODEX.find((e) => e.id === id);
}
