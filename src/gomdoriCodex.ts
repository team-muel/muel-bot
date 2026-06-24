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
  /** 엔진 action_type — 있으면 인게임에서 이 능력으로 직접 발동된다(능력) / 패시브의 야간 발동 표시. */
  actionType?: string;
  /** 구현 충실도(로컬 캐논 대비): live=캐논대로 / partial=핵심만 / planned=예정. */
  status?: "live" | "partial" | "planned";
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
      { kind: "능력", name: "용의자 색출", text: "대상에게 +5 투표가치 / +10 의심가치를 받는 표로 가산합니다. 다음 집계에 반영됩니다.", actionType: "romaz_suspect", status: "live" },
    ],
    v1: "구현됨. romaz_suspect → ModifyReceivedVote(+5)/ModifyReceivedSuspicion(+10). 라운드별 voteBias/suspicionBias 로 초기화(연속 누적 방지).",
    v2: "다단계: 조사장/신념 등 후속 시트 능력. 현 v1 시그니처 유지.",
    vault: "Universes/BoW/Characters/로마즈.md",
  },
  {
    id: "rainer", name: "라이너", faction: "angel", title: "백호의 소환자", slot: "천사-13",
    summary: "수호신 백호를 불러 천사팀 카운트를 늘려 마을을 지킨다.",
    abilities: [
      { kind: "패시브", name: "수호신 백호", text: "백호 소환 시 천사팀 카운트 +3을 얻고, 탈락 뒤에도 사후 지속 +3을 남깁니다. 1회성입니다.", actionType: "rainer_summon", status: "live" },
      { kind: "능력", name: "강한 의지", text: "대상을 관찰하고 강한 의지 +1을 얻습니다(같은 대상 연속 지목 불가). 관찰 대상이 그 밤 탈락하면 강한 의지 +2가 추가됩니다.", actionType: "rainer_resolve", status: "live" },
      { kind: "능력2", name: "그날의 저항", text: "백호 한 마리를 추가 소환합니다 — 천사팀 카운트 +1 + 강한 의지 +1. 1회성이며 첫 밤에는 발동되지 않습니다.", actionType: "rainer_resistance", status: "live" },
    ],
    v1: "구현됨. rainer_summon — 1회 self 소환 액션으로 countBonus +3 / deadCountBonus +3 획득. rainer_resolve(강한 의지 v2): SINGLE_ALIVE, noConsecutiveTarget(같은 대상 연속 지목 불가). AddTag observedByRainer + self willCount +1. 관찰 대상이 그 밤 탈락하면 engine 후처리가 라이너 willCount +2 (canon '대상 탈락 시 강한 의지 +2') + rainer_will_surge 이벤트, 표식 1회 소비. rainer_resistance(그날의 저항 v2, 1회): SELF — deadCountBonus +1 + willCount +1 (백호 한 마리 추가 소환 근사 + 강한 의지 +1).",
    v2: "백호 소환·강한 의지(관찰+사망 +2)·그날의 저항(1회) 코어 라이브. 거친 포효(willCount 2 자동 발동 → 멀티타깃 markedForDeath + voteValueMod 3 게이트 소멸)·그날의 저항의 카운트 -1 / 정확한 백호 1밤 임시 메커닉은 후속.",
    vault: "Universes/BoW/Characters/라이너.md",
  },
  {
    id: "dordan", name: "도르단", faction: "angel", title: "탐정", slot: "천사-3",
    summary: "매일 밤 한 명의 정체를 조사한다. 단서를 모으면 사건의 전말로 발전.",
    abilities: [
      { kind: "패시브", name: "침착한 탐정", text: "누군가 탈락하면 투표 대상을 범인으로 지목하고, 범인이 그날 밤 지정한 대상이 도르단에게 비공개로 알려집니다.", status: "live" },
      { kind: "능력", name: "단서 수집 / 사건의 전말", text: "단서 3개 이상에서 정밀 조사로 악마를 정확히 식별하면 사건의 전말이 발동 — 다음 아침을 생략하고 그 악마를 곧장 판결대에 세웁니다.", actionType: "police_investigate", status: "live" },
      { kind: "능력2", name: "잠입 수사", text: "대상을 밤 동안 관찰합니다. 탈락과 연결되면 불심검문이 발동해 그 밤 부정 효과를 무시합니다.", actionType: "dordan_infiltrate", status: "live" },
    ],
    v1: "구현됨. police_investigate(악마/천사 판정) + 침착한 탐정 단서(death-hook: 탈락자 1명당 단서 +1) + culprit_target_revealed(탈락 발생 밤, 도르단의 투표 대상이 지정한 대상 private 통지). 단서 3개부터 정밀 조사(정확한 직업 통지) + 사건의 전말(정밀 조사로 악마 처치자 식별 시 matches.engine_state.caseClosed → phase-advance 가 아침 생략·그 악마 강제 판결). dordan_infiltrate 는 관찰 대상이 그 밤 탈락하면 stakeout_triggered 로 도르단 부정효과를 정화한다.",
    v2: "단서 카운터(탈락자 수 연동), 범인 지정 대상 통지, 사건의 전말(전원 통지·아침 생략·판결 강제), 잠입 수사(관찰→불심검문→부정효과 무시)까지 핵심 라이브.",
    vault: "Universes/BoW/Characters/도르단.md",
  },
  {
    id: "habreterus", name: "하브레터스", faction: "angel", title: "치료자(의사의 소명)", slot: "천사-4",
    summary: "생명의 언약으로 한 명을 치료. 악마에게 존재가 알려진 채 활동한다.",
    abilities: [
      { kind: "패시브", name: "임종 선언", text: "그 라운드 누군가 탈락하면 하브레터스의 투표가치가 -1, 천사팀 카운트가 +1, 부정 효과가 모두 씻기고 소명 3일 쿨다운에 들어갑니다. 생명의 언약 성공 시 쿨다운이 추가로 -1 단축됩니다.", status: "live" },
      { kind: "능력", name: "생명의 언약", text: "대상을 치료합니다. 그 밤 실제 공격을 막아내면(소명) 하브레터스의 투표가치가 +3 오르고 소명 대기가 -1일 단축됩니다.", actionType: "doctor_heal", status: "live" },
      { kind: "능력2", name: "삶이 있는 곳으로", text: "악마라 의심되는 대상을 지목합니다. 적중하면(악마 처치자) 그 밤 받은 부정 효과를 모두 무시합니다. 악마측은 대악마의 역추리로 하브레터스를 적중시키면 치료를 무시하고 다음 처치로 탈락시킵니다.", actionType: "habreterus_deduce", status: "live" },
    ],
    v1: "구현됨. doctor_heal(1_NIGHT 보호) — 생명의 언약 + 소명(onSaveGrantSelf: 그 밤 실제 공격을 막으면 시전자 투표가치 +3). habreterus_deduce(하브 측 상호추리) + demon_deduce(악마 측 역추리 v2, 대악마 전용): 대악마가 하브 정체 적중 시 Annihilate(annihilated=1) — engine death loop 의 PROTECTED 게이트를 우회해 치료(Protect) 효과 무시 처치. 임종 선언(v2 deathHook): 그 라운드 탈락자 1명당 callingPending +1 → engine 후처리가 cooldown==0 일 때만 소명 발동(voteValueMod -1 + countBonus +1 + 부정효과 정화 + callingCooldown=3). 생명의 언약 성공 시 saveRewards 분기에서 callingCooldown 추가 -1 (canon '성공 시 소명 대기 -1일').",
    v2: "임종 선언 + 소명 3일 쿨다운 + 양방향 상호추리(악마 측 역추리 = 하브 Annihilate 치료 무시)까지 핵심 라이브.",
    vault: "Universes/BoW/Characters/하브레터스.md",
  },
  {
    id: "mizlet", name: "미즐렛", faction: "angel", title: "행복을 파는 가게", slot: "천사-15",
    summary: "디저트와 와인으로 사람을 살리는 가게. 게임이 어두워지면 다수를 부활시킨다.",
    abilities: [
      { kind: "패시브", name: "행복을 파는 가게", text: "탈락자가 생존자보다 많아지면 가장 최근 탈락 2명을 복귀(소멸·부활불가 무시)시키고 미즐렛은 탈락합니다. 1회성 역전 패시브입니다.", status: "live" },
      { kind: "능력", name: "디저트 선물(부활)", text: "탈락한 한 명을 디저트로 되살립니다. 1회성입니다.", actionType: "mizlet_revive", status: "live" },
      { kind: "능력", name: "디저트 선물", text: "대상에게 디저트(보호 + remembered 풍 다과회 회로)를 부여하고 미즐렛과의 채팅 회로를 엽니다(현재 backend 이벤트 신호).", actionType: "mizlet_dessert", status: "live" },
      { kind: "능력2", name: "고급 와인", text: "전원의 부정 효과를 제거하고 디저트 보유자 전원과 와인 회식 채팅을 엽니다. 디저트를 받지 못한 대상은 투표가치 -1. 1회성입니다.", actionType: "mizlet_wine", status: "live" },
    ],
    v1: "구현됨. mizlet_revive(탈락자 부활, 1회) + mizlet_dessert(생존자 보호+디저트 태그 + dessert_received 이벤트 = 미즐렛-대상 채팅 회로 신호) + 다수복귀 패시브(탈락자>생존자 시 가장 최근 탈락 2명 복귀[소멸·부활불가 무시] + 미즐렛 탈락, 1회, phase-advance night_resolve). mizlet_wine 은 전원 정화 + 디저트 미제공자 voteValueMod -1 + 디저트 보유 생존자 전원에 dessert_chat_open 이벤트(와인 회식 일괄 채팅 hook).",
    v2: "부활, 디저트 버프, 다수 복귀 패시브, 고급 와인 정화/페널티, 디저트/와인 채팅 회로 이벤트 hook 까지 핵심 라이브. 실제 채팅 회로 plumbing 은 Discord 인프라 후속.",
    vault: "Universes/BoW/Characters/미즐렛.md",
  },
  {
    id: "helen", name: "헬렌", faction: "angel", title: "황금빛 수면", slot: "천사-17",
    summary: "추억·수면·부활의 천사. 죽음을 보류한다.",
    abilities: [
      { kind: "패시브", name: "행복 쉼터 / 추억을 간직하는 법", text: "황금빛 수면을 받은 자는 영혼이 기억되어 탈락 후에도 다시 수면을 받을 수 있으며, 그때 발동되면 부활합니다. 소멸(annihilated)은 부활 불가입니다.", status: "live" },
      { kind: "능력", name: "황금빛 수면(부활)", text: "한 번 잠들었던 추억된 탈락자를 다시 재워 부활시킵니다. 1회성입니다.", actionType: "helen_revive", status: "live" },
      { kind: "능력", name: "황금빛 수면", text: "대상을 수면 상태로 만들어 부정 효과·죽음을 막고 영혼을 기억시킵니다. 한 번 기억된 자는 탈락 후에도 다시 잠들어 부활할 수 있습니다.", actionType: "helen_sleep", status: "live" },
      { kind: "능력2", name: "자유로운 새", text: "탈락자 한 명을 추가로 되살립니다. 1회성입니다.", actionType: "helen_freebird", status: "live" },
    ],
    v1: "구현됨. helen_revive(탈락자 부활, SINGLE_DEAD Heal·1회) + helen_sleep(v2: 생존자 황금빛 수면 — Sleep + AddTag remembered). allowRememberedDead 플래그로 탈락+remembered 대상도 helen_sleep 으로 재지정 가능. Sleep case 가 dead+remembered 면 부활(alive=true) 후 평소 수면 적용 — 추억을 간직하는 법(canon 수면으로 깨면 복귀). annihilated 는 부활 불가 게이트. helen_freebird(탈락자 추가 복귀, 1회).",
    v2: "수면 보호/봉인/정화, 부활, 자유로운 새 추가 복귀, 추억(remembered) 기반 탈락 후 재수면+자동 부활까지 핵심 라이브. 투표가치 모두 소모의 동적 매핑은 후속(현재는 표식만).",
    vault: "Universes/BoW/Characters/헬렌.md",
  },
  {
    id: "uno", name: "우노", faction: "angel", title: "명예의 군인", slot: "천사-6",
    summary: "군인의 사명과 명예. 살아있는 한 천사팀 카운트를 더한다.",
    abilities: [
      { kind: "패시브", name: "군인의 사명", text: "투쟁 2회로 충전된 대상은 악마 효과 1회를 제거합니다.", status: "live" },
      { kind: "능력", name: "투쟁", text: "대상 소속 카운트 +1과 사명 충전 +1을 부여합니다. 우노는 명예로 천사팀 카운트 +1과 투표가치 +10을 갖습니다 — 이 투표가치는 사탄의 마(-1)를 뚫고 살아남아, 악마가 투표를 독점해도 우노만은 표를 행사할 수 있습니다.", actionType: "uno_struggle", status: "live" },
      { kind: "능력2", name: "용맹함", text: "자신을 정화하고 전원에게 투쟁을 발동합니다. 우노가 투표한 대상은 사망 기록과 소속이 공개·처형되고, 천사를 죽이면 우노가 다음 밤 봉인됩니다. 1회성입니다.", actionType: "uno_valor", status: "live" },
    ],
    v1: "구현됨. 명예 countBonus +1 + 투표가치 +10(배정 — 사탄의 마 -1 을 뚫는 천사 표 경로) + uno_struggle(투쟁: GrantCount + missionCharge 1, 2스택이면 악마 효과 1회 제거) + uno_valor(용맹함 1회: 자기 Cleanse + 전원 투쟁/missionCharge + 투표대상 소속 공개/처형 + 천사 살해 시 우노 다음 밤 봉인).",
    v2: "군인의 사명, 투쟁, 용맹함 전원 효과, 소속 공개, 명예 실추까지 핵심 라이브.",
    vault: "Universes/BoW/Characters/우노.md",
  },
  {
    id: "arthur", name: "아서", faction: "angel", title: "여명의 기사", slot: "천사-14",
    summary: "결백한 천사를 지키고 타락한 자를 소멸시키는 해의 기사. 루나의 거울 짝.",
    abilities: [
      { kind: "패시브", name: "여명의 기사", text: "어떤 효과로도 밤에 탈락하지 않습니다. 단 결백한 천사팀이 3명 이상 탈락하면 다음 아침 함께 탈락합니다. 결백 천사 탈락 1명당 잔불 대검 +1 충전, 충전 3 이상이면 위용(해오름 결백 천사 1명당 투표가치 +3)이 켜집니다.", status: "live" },
      { kind: "능력", name: "잔불이 꺼지기 전에", text: "대상(최대 3명)에게 해오름을 부여해 결백/타락을 식별하고, 잔불 대검을 1 충전합니다.", actionType: "arthur_judge", status: "live" },
      { kind: "능력2", name: "잔불 대검", text: "충전을 1 써서 한 명을 벱니다. 부정 효과를 쓴 적 있는 '타락자'에게는 폭열(다시 베면 소멸, 부활 불가), 그렇지 않은 '결백자'에게는 하루 무적. 결백/타락은 진영이 아니라 행위 이력으로 가립니다.", actionType: "arthur_emberblade", status: "live" },
    ],
    v1: "구현됨(2026-06-17 정정 — 행위 기반). 결백/타락은 *진영이 아니라* counters.tainted(부정 효과를 한 번이라도 적용한 적 있는가)로 판정(vault §해오름). arthur_judge=잔불이 꺼지기 전에(Verdict 결백/타락 통지 + 해오름 태그 + emberCharge +1). arthur_emberblade=잔불 대검(requiresCounter emberCharge 1 소비: 결백=Protect skipIfTainted / 타락=Annihilate onlyIfTainted, branded→annihilated 2단). 새 프리미티브: Verdict + onlyIfTargetCounter/skipIfTargetCounter. ※구버전 onlyFactions 진영 게이트는 캐논 위반이라 폐기.",
    v2: "구현됨(2026-06-17). 여명의 기사 패시브 = 아서 밤 효과 면역(arthur_immune) + 결백한(tainted 0) 천사팀 누적 3명+ 탈락 시 동반 탈락(dawnbreaker_fallen) + 결백 천사 탈락 1명당 잔불 대검 +1 충전(applyDawnbreakerPassive). 위용 = 충전≥3 시 해오름(dawnrise) 적용된 결백 천사 1명당 아서 투표가치 +3(prowessVoteBonus, tally 통합). 잔불이 꺼지기 전에 = 3명 지정(targetCount:3, 멀티타깃). 세이카 봉인=부정효과 포함, 루루 양도=제외(Annihilate 도 제외 — 의로운 심판). 해오름 1일 만료·멀티타깃 영속화(result.targetUserIds)+제네릭 다중선택 UI(maxTargets)·투표/의심 가해 taint(부호 기반) 모두 라이브. 4게이트 통과. 남은 후속: 멀티타깃 무대 다중 하이라이트(패널엔 표시됨)·라이브 매치 스모크.",
    vault: "Universes/BoW/Characters/아서.md",
  },
  {
    id: "seika", name: "세이카", faction: "angel", title: "초신성·등대", slot: "천사-12",
    summary: "초신성·등대·별빛의 천사. 자매 세야카(악마-12)와 별빛으로 대화한다.",
    abilities: [
      { kind: "패시브", name: "별이 떠오른 밤", text: "초신성을 터뜨린 다음 밤은 의심 투표를 생략하고 곧장 밤으로 넘어갑니다.", status: "live" },
      { kind: "능력", name: "초신성", text: "대상이 받는 부여 효과를 제거하고 그 밤 능력을 봉인합니다. 반복 적용 시 영구 봉인으로 커집니다.", actionType: "seika_supernova", status: "live" },
      { kind: "능력2", name: "자신만 아플 거야", text: "전원에게 걸린 부여 효과를 모두 씻어냅니다(전원 정화, 1회). 악마팀 효과를 흡수하면 소멸과 악마팀 공개 카운트다운이 함께 걸립니다.", actionType: "seika_absorb", status: "live" },
    ],
    v1: "구현됨. seika_supernova — 초신성(Cleanse 부정효과 제거 + Silence 봉인, priority 1; seikaMark 재적용 시 silencedPermanent 영구 봉인) + 별이 떠오른 밤(onFireSetCounter starlitNext → phase-advance 가 다음 밤 의심 투표 생략). 새 이펙트 Cleanse 도입.",
    v2: "자신만 아플 거야(seika_absorb)는 전원 정화, 악마팀 출처 효과 3개+ 흡수 시 세이카 소멸, 이틀 후 악마팀 공개 카운트다운까지 라이브.",
    vault: "Universes/BoW/Characters/세이카.md",
  },
  {
    id: "luru", name: "루루", faction: "angel", title: "연주자", slot: "천사-30",
    summary: "선율로 사람을 매료시키는 연주자. 투표 권한을 양도받는다.",
    abilities: [
      { kind: "패시브", name: "아름다운 영혼을 위한 소나타", text: "매료 3명 이상이면 즉시 연주가 시작되어 전원을 정화하고, 그 밤 루루를 무적으로 만듭니다.", actionType: "luru_sonata", status: "live" },
      { kind: "능력", name: "영혼을 만지는 음색", text: "대상을 매료해 처형 투표 권한을 루루에게 양도시킵니다.", actionType: "luru_charm", status: "live" },
      { kind: "능력2", name: "악보 교체 (자투)", text: "자투 악보로 자신의 투표가치를 +1 올립니다. 1회성입니다.", actionType: "luru_score", status: "live" },
      { kind: "능력2", name: "악보 교체 (무투)", text: "무투 악보로 다음 아침의 처형·찬반 투표를 2배 행사합니다. 1회성입니다.", actionType: "luru_mute", status: "live" },
    ],
    v1: "구현됨. luru_charm(매료 + charmCount 게이지 + 투표권 양도 voteWeightBonus) + luru_sonata(매료 3 누적 시: 전원 Cleanse + 자기 무적, requiresCounter·소비) + luru_score(악보 교체 자투, 1회: 자기 투표가치 +1) + luru_mute(악보 교체 무투 v2, 1회: 자기 voteCountBonus +1 → 다음 처형·찬반 투표 2배, phase-advance 가 vote 단계 종료 시 소비).",
    v2: "매료, 소나타, 악보 자투(+1), 악보 무투(투표 2배)까지 핵심 라이브. 자투 매료 비례 강화·다중 대상 투표·반론 등판은 후속(투표 시스템 재설계 필요).",
    vault: "Universes/BoW/Characters/루루.md",
  },

  // ===== 악마 =====
  {
    id: "demon", name: "대악마", faction: "demon", title: "만악의 근원", slot: "악마-1",
    summary: "사탄·메피스토 모티프. 악마 진영의 1번 슬롯. 낙인으로 직업을 재배정한다.",
    abilities: [
      { kind: "패시브", name: "사탄의 마", text: "처치 성공 시 자신을 제외한 전원의 투표가치가 -1 내려갑니다(악마 투표 독점 — 마을은 표로 악마를 처형할 수 없습니다). 생존 천사팀 전체의 투표가치가 0 이하로 떨어지면 모든 조사·취급 효과가 '악마' 로 판정되어 카운트와 승리 판정에도 자동 반영됩니다(살아있는 대악마가 영역을 유지하는 동안).", status: "live" },
      { kind: "특수 패시브", name: "메피스토의 낙인", text: "투표 대상에게 낙인을 통지하고, 대악마가 직업 삭제와 새 천사 직업 배정을 일으킵니다.", actionType: "daeakma_brand", status: "live" },
      { kind: "능력", name: "만악의 근원 / 감시", text: "대상을 탈락시키고, 낙인 적용자가 있으면 감시가 추가됩니다.", actionType: "demon_kill", status: "partial" },
      { kind: "능력2", name: "압도적인 존재감", text: "자신을 제외한 전원을 압도해 그 밤 능력을 봉인합니다. 1회성입니다.", actionType: "daeakma_dominion", status: "live" },
      { kind: "능력2", name: "역추리 (삶이 있는 곳으로)", text: "하브레터스로 의심되는 대상을 지목합니다. 적중하면 그 밤 치료 효과를 무시하고 다음 처치로 하브레터스를 탈락시킵니다.", actionType: "demon_deduce", status: "live" },
    ],
    v1: "구현됨. demon_kill(처치 + 사탄의 마: 자신 제외 전원 투표가치 -1, 악마 투표 독점) + daeakma_brand(낙인: Rebrand) + daeakma_dominion(압도적 존재감 1회: 전원 봉인, Silence AllOthers). 가인 있으면 보호막 1. 사탄의 마 전역 판정(생존 천사팀 전원 투표가치 0 → 모든 조사 '악마', match-action-core) + 전역 취급 v2(engine.applySatanicRealm: 천사팀 전원 vote 0 ≤ 시 treatedAsFaction='demon' 플립, satanic_realm_treated 이벤트, phase-advance 가 영속화). countTeams 가 treatedAsFaction 우선이라 승리 판정·기타 취급 효과에 자동 반영.",
    v2: "메피스토 낙인, 사탄의 마(투표 -1 + 전원 0 시 전역 악마 취급·승리 판정 자동 반영), 압도적 존재감 모두 핵심 라이브.",
    vault: "Universes/BoW/Characters/대악마.md",
  },
  {
    id: "phantom", name: "팬텀", faction: "demon", title: "침묵의 밤", slot: "악마-2",
    summary: "악몽과 일식의 악마. 밤을 연장하고 직업을 봉인한다.",
    abilities: [
      { kind: "패시브", name: "침묵의 밤", text: "밤 종료 시 능력 사용 가능 밤을 한 번 더 열고, 생존 천사팀 카운트를 +1 보상합니다. 팬텀과 조력자는 접선할 수 없지만 서로의 정체와 직업은 통지됩니다.", actionType: "phantom_silentnight", status: "live" },
      { kind: "특수 패시브", name: "어둠이 내린 도시", text: "매 밤 직업 봉인 대상을 늘려갑니다. 전날 같은 대상은 연속 봉인할 수 없고, 무지목 시 악몽 충전으로 전환됩니다.", actionType: "phantom_seal", status: "live" },
      { kind: "능력", name: "악몽", text: "대상을 악몽에 빠뜨리고, 연속되면 영면으로 격상합니다. 악몽은 아침 탈락으로 이어집니다.", actionType: "phantom_nightmare", status: "live" },
      { kind: "능력2", name: "영면 발동", text: "쌓아둔 영면 대상을 한꺼번에 탈락시킵니다.", actionType: "phantom_reap", status: "live" },
      { kind: "능력2", name: "일식", text: "다음 아침을 밤으로 변경합니다. 대신 아침이 오면 팬텀은 소멸합니다. 1회성입니다.", actionType: "phantom_eclipse", status: "live" },
    ],
    v1: "구현됨. phantom_nightmare(지정 밤→다음 밤 악몽→다음 아침 탈락, 5회 제한), 재지정 영면(deepsleep) + phantom_reap 일괄 처치, phantom_seal(동적 다중 봉인: 2+sealCap, 아침마다 성장, 무지목 시 악몽 +2), phantom_silentnight(밤 연장+천사 카운트 보상), phantom_eclipse(아침→밤 전환+자기 소멸).",
    v2: "어둠이 내린 도시, 악몽/영면/영면 발동, 침묵의 밤, 일식까지 핵심 라이브.",
    vault: "Universes/BoW/Characters/팬텀.md",
  },
  {
    id: "malen", name: "말렌", faction: "demon", title: "강령술사", slot: "악마-7",
    summary: "악령 마야와 함께하는 강령술사. 빙의시키고 시체를 부린다.",
    abilities: [
      { kind: "패시브", name: "악령 마야", text: "매 밤 한 명에게 빙의해 그 밤 행동을 막고, 다음 밤 마비를 남기며 악마팀 카운트로 셉니다. 마야가 말렌에게 빙의하면 그 밤 모든 효과를 무시합니다.", actionType: "malen_possess", status: "live" },
      { kind: "특수 패시브", name: "악담", text: "탈락자가 생기면 혼을 생성하고, 혼이 2개 쌓이면 시체와 악마팀 카운트로 바뀝니다.", status: "live" },
      { kind: "능력", name: "혼령 방출", text: "1회차에는 혼령 표식을 남기고, 표식이 있는 대상을 다시 방출하면 영에게 잠식되어 탈락 + 그 투표가치가 말렌에게 조공됩니다.", actionType: "malen_release", status: "live" },
      { kind: "능력2", name: "신출귀몰", text: "혼령 표식을 수거해 다음 밤 시체를 소환합니다. 1회성입니다.", actionType: "malen_elusive", status: "live" },
    ],
    v1: "구현됨. malen_release(혼령 방출 다단계 Haunt: 1회차 혼령 표식, 2회차 잠식=탈락+투표가치 조공[말렌 voteWeightBonus +1]) + malen_possess(그 밤 행동봉인+악마팀 카운트 전환+다음 밤 마비 예약) + SoulCounter death-hook(밤 탈락자 1명당 혼 +1, 혼 2개→시체 1구 = 악마팀 deadCountBonus +1) + malen_elusive(신출귀몰 1회: 혼령 표식 수거→다음 밤 corpsePending 이 deadCountBonus 로 승격).",
    v2: "빙의, 마비, 혼/시체 카운터, 혼령 방출 다단계, 신출귀몰 시체 소환까지 핵심 라이브.",
    vault: "Universes/BoW/Characters/말렌.md",
  },
  {
    id: "besto", name: "베스토", faction: "demon", title: "히든 포지션", slot: "악마-14",
    summary: "밤마다 모습을 바꾸는 변신 악마. 언급으로 탈락시킨다.",
    abilities: [
      { kind: "패시브", name: "두 번째 자아", text: "밤마다 솔과 하베스토 판정을 바꿉니다. 조사, 투표가치, 의심 지목 조건을 흔듭니다.", actionType: "besto_shift", status: "live" },
      { kind: "특수 패시브", name: "배후", text: "조력자와 영혼을 교체해 베스토·조력자 대상 능력 효과가 반대로 통지됩니다.", status: "planned" },
      { kind: "능력", name: "히든 포지션", text: "미발동 시 강화되고, 다음 아침 토론 중 효과발동자가 언급한 대상을 탈락시킵니다.", actionType: "besto_hidden", status: "partial" },
      { kind: "능력2", name: "누명씌우기", text: "대상이 히든 포지션 효과를 받게 합니다. 이 효과로 탈락이 발생하면 강화됩니다.", status: "planned" },
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
      { kind: "패시브", name: "진실을 가리는 암흑", text: "악마와 접선·대화하고, 악마가 처형 또는 탈락할 때 1회 없던 일로 만듭니다. 두 번째 밤 종료 시 보호막이 자동 만료됩니다(가인 생존 여부 무관).", status: "live" },
      { kind: "능력", name: "약간의 위선", text: "매일 밤 한 명의 정체(진영)를 알아내 악마팀에 정찰 정보를 주고, 대상의 다음 능력을 한 밤 연기합니다. 위선 대상이 밤에 탈락하면 다음 위선은 처치로 전환됩니다.", actionType: "gain_hypocrisy", status: "live" },
      { kind: "능력2", name: "급습", text: "대상의 통지를 한 라운드 차단하고 가인의 급습을 1 충전합니다. 다음 아침까지 악마와 대화하는 채팅 회로는 후속이며 현재는 이벤트 신호만 발사됩니다. 1회성입니다.", actionType: "gain_raid", status: "live" },
    ],
    v1: "구현됨. 배정 시 악마에 보호막 1(밤 살해·처형 1회 무효, shieldFromGain 마커 동시 세팅) + 조사 시 천사로 보임(처치자 아님) + gain_hypocrisy(대상 진영 통지, 효과 다음 밤 연기, 위선 대상이 밤에 탈락하면 다음 위선이 처치로 전환) + gain_raid(급습 v2, 1회: AddTag noticeSuppressed[그 밤 한정] + onFireSetCounter raidCharge=1 + raid_initiated 이벤트). 두 번째 밤 종료 시(dayCount===2) shieldFromGain 보유 demon 의 보호막 자동 만료(canon '두 번째 밤 종료 시 패시브 삭제') — 가인 생존 여부와 무관.",
    v2: "약간의 위선의 정찰·연기·처치 전환, 보호막 1회 + 두 번째 밤 만료, 급습 통지 삭제+raidCharge 충전까지 핵심 라이브. 다음 아침까지 악마와 대화(채팅 회로)는 Discord 인프라 후속.",
    vault: "Universes/BoW/Characters/가인.md",
  },
  {
    id: "luna", name: "루나", faction: "helper", title: "달의 사제", slot: "조력자-5",
    summary: "천사를 악마로 만드는 달의 사제. 아서(천사-14)의 거울 짝.",
    abilities: [
      { kind: "패시브", name: "달빛이 비치는 우물", text: "루나가 투표·의심한 대상에게 달빛을 남기고, 달의 힘이 10 이상 차면 셋 중 하나(공포·해가 저문다·달이 차오른다) 효과를 발동합니다.", status: "live" },
      { kind: "능력", name: "고요한 적막", text: "달빛 대상 수에 따라 달의 힘을 충전합니다(천사·중립 +1, 악마 +3). 100% 달성 시 셋 중 하나로 분기 발동합니다.", actionType: "luna_moonlight", status: "live" },
      { kind: "능력2", name: "공포 속에 밀어 넣다", text: "대상에게 달빛 저주를 남깁니다. 달의 힘이 가득 차면 대상은 직업을 잃고 악마팀이 됩니다. 1회 제한입니다.", actionType: "luna_corrupt", status: "live" },
      { kind: "능력2", name: "해가 저문다", text: "다음 처형/찬반 투표에서 능력으로 증가한 투표가치(우노 명예·아서 위용 등)를 마이너스로 판정합니다. 1회 제한이며 달의 힘 10을 소비합니다.", actionType: "luna_dawn", status: "live" },
      { kind: "능력2", name: "달이 차오른다", text: "이번 밤 한정 — 악마의 처치가 달빛 대상에 발동하면 모든 달빛 대상에 같은 효과로 cascade됩니다. 1회 제한이며 달의 힘 10을 소비합니다.", actionType: "luna_moonrise", status: "live" },
    ],
    v1: "구현됨. luna_moonlight(고요한 적막 — 투표/의심 대상에 달빛 태그, 천사/중립 +1, 악마 +3 비례 충전) + luna_corrupt(공포 — moonGauge 10 이상 시 천사→악마팀 타락, 1회 제한) + luna_dawn(해가 저문다 v2, 1회: state.modifiers.dawnRule=1 → 다음 처형/찬반 투표에서 능력으로 증가한 voteValueMod>0 와 prowess 부호 반전, phase-advance verdict 종료 시 소비) + luna_moonrise(달이 차오른다 v2, priority 2: state.modifiers.moonriseRule=1 → 같은 밤 악마 Kill 이 moonlit 대상에 발동하면 모든 달빛 대상 cascade markedForDeath, 그 밤 종료 시 해제). 셋(corrupt/dawn/moonrise) 모두 moonGauge 100% 소비 — 같은 풀에서 하나만 선택.",
    v2: "달빛 비례 충전·공포 타락(1회)·해가 저문다 능력보너스 부호 반전·달이 차오른다 cascade 까지 핵심 라이브.",
    vault: "Universes/BoW/Characters/루나.md",
  },
  {
    id: "logen", name: "로건", faction: "helper", title: "부서진 펜던트", slot: "조력자-10",
    summary: "게임 시작 시 악마와 접선. 능력을 소멸시키는 조력자.",
    abilities: [
      { kind: "패시브", name: "부서진 펜던트", text: "시작 시 악마와 접선합니다. 악마팀에 지워지지 않는 펜던트 효과를 남기고, 펜던트가 3개 이상 쌓이면 대상 수 보너스를 얻습니다.", status: "live" },
      { kind: "능력", name: "네 안에 없는 것", text: "대상의 가장 가까운 밤 능력 효과가 소멸한다는 통지와 펜던트를 적용합니다.", actionType: "logen_nullify", status: "live" },
    ],
    v1: "구현됨. logen_nullify — 네 안에 없는 것(대상의 *다음* 능력 효과 소멸, 지속·발동 시 소비). 부서진 펜던트는 악마 처치자에게 영구 태그를 부여하고 3명 이상이면 로건 지정 대상 +2(pendantTargetBonus).",
    v2: "네 안에 없는 것과 부서진 펜던트 지정 대상 보너스까지 핵심 라이브.",
    vault: "Universes/BoW/Characters/로건.md",
  },
  {
    id: "ellen", name: "엘런", faction: "helper", title: "박해자", slot: "조력자-13",
    summary: "투표가치를 조작하는 박해자. 자아 해체 메커닉.",
    abilities: [
      { kind: "패시브", name: "박해자 / 해체된 퍼즐", text: "홀수날에만, 엘런이 직전에 투표한 대상의 받는-투표가치를 올려 처형대로 밀어냅니다. 같은 대상을 다시 박해하면 +3/+6/+9로 누진됩니다. 해체된 퍼즐 후 자아 회복 시 자해 박해로 영구 전환됩니다.", actionType: "ellen_persecute", status: "live" },
      { kind: "능력", name: "비치지 않는 자아 (해체된 퍼즐)", text: "자아를 망가뜨려 2밤 동안 투표·의심·능력 가치를 모두 상실합니다. 그 다음 밤 자동 회복(selfRecovered)되며, 회복 후 박해는 자해 누진으로 영구 전환됩니다. 1회 제한입니다.", actionType: "ellen_shatter", status: "live" },
    ],
    v1: "구현됨. ellen_persecute — 박해(NONE 타깃, substrate VoteTarget: 직전 투표 대상 받는-투표가치 +3, 홀수날 한정 oddDayOnly 게이트). persecuteBias 가 지속 누적되어 같은 대상 재박해 시 +3/+6/+9로 tally에 반영된다. ellen_shatter(v2, 1회): 자아 해체 — brokenSelf=1 세팅. engine 이 2밤 동안 brokenSelf 유지(brokenAge 0→1) 후 selfRecovered=1 영구 전환. broken 상태 = 투표·의심 가치 0(tally skip), 능력 발동 차단(action_blocked_broken_self). selfRecovered 상태 = ellen_persecute 변경효과 — VoteTarget 분기 skipIfSourceCounter, self 분기 onlyIfSourceCounter 로 자해 박해(+3 누진 근사 — canon '얻은 투표가치만큼 자신 투표' 의 동적 매핑은 후속).",
    v2: "박해 누진, 해체된 퍼즐 2밤 가치 상실 + 자동 회복, 회복 후 자해 박해 영구 전환까지 핵심 라이브. 비치지 않는 자아 다단계와 동적 자해 amount(받은 voteValueMod 비례)는 후속.",
    vault: "Universes/BoW/Characters/엘런.md",
  },

  // ===== 중립 =====
  {
    id: "pasua", name: "파스아", faction: "neutral", title: "사이비 교주", slot: "중립(특수-4)",
    summary: "포교로 천사·조력자를 교세로 흡수. 누적 3명 전향 시 단독 즉시 승리.",
    abilities: [
      { kind: "패시브", name: "구원자", text: "시작 전 파스아 존재를 전원에게 통지합니다. 생존 교세가 max(3, ceil(인원/3)) 이상이면 즉시 승리합니다.", status: "live" },
      { kind: "능력", name: "포교", text: "대상을 포교합니다. 악마와 중립은 포교할 수 없고, 전향자는 파스아 승리를 따릅니다.", actionType: "pasua_convert", status: "live" },
      { kind: "능력2", name: "신앙", text: "대상을 탈락시킵니다. 악마는 탈락하지 않습니다.", actionType: "pasua_faith", status: "live" },
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
