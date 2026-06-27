/**
 * 카운터/태그 이름 레지스트리 — engine PlayerState.counters / tags 의 단일 출처.
 *
 * `counters: Record<string, number>` 와 `tags: string[]` 는 자유 문자열이라
 * Effect.type/Faction/MatchState.phase 같은 유니온 타입 안전성이 없다. 생산자
 * (roles.ts 효과 정의: `tag`/`key`/`counter`/`from`/`to` 필드)와 소비자(engine.ts
 * applyEffect·resolve* 의 `counters.X`/`tags.includes("X")`)가 *같은 철자*를 써야
 * 하는데, 한 글자만 어긋나면 조용한 no-op 버그(능력이 안 먹는데 에러도 없음).
 *
 * 이 레지스트리 + tests/gomdori/counter-tag-registry.test.ts 가드가 양쪽 이름을
 * 한 곳으로 고정한다(canon-engine-fidelity 와 같은 "단일 출처 + 구조 가드" 패턴):
 *  - 생산자(CORE_ROLES) 가 쓰는 모든 이름 ⊆ 레지스트리
 *  - 소비자(engine.ts) 가 읽는 모든 리터럴 이름 ⊆ 레지스트리
 * 어느 한쪽에만 있는 오타는 다른 쪽 집합에 없으므로 테스트가 잡아낸다.
 *
 * 새 카운터/태그 추가 시: 여기에 등록 → 가드 통과. 미등록 이름을 쓰면 테스트 실패.
 * 플레이어 id 등이 접미되는 동적 이름은 DYNAMIC_COUNTER_TAG_PREFIXES 로.
 */
export const COUNTER_TAG_NAMES = [
  // --- 투표/의심 수치 ---
  "voteValueMod",
  "voteWeightBonus",
  "voteCountBonus",
  "voteBias",
  "suspicionBias",
  "countBonus",
  "deadCountBonus",
  "dayTargetBonus",
  "pendantTargetBonus",
  "sonataVote",
  "resolveBonus",
  "unoHonor",
  "wineVotePenalty",

  // --- 처치/보호/탈락 ---
  "annihilated",
  "shield",
  "shieldFromGain",
  "nightmare",
  "nightmarePending",
  "corpsePending",
  "branded",
  "haunted",
  "demonRevealIn",
  "dawnDeathsCredited",
  "satanicRealmNotified",

  // --- 제어/상태(라운드성·지속) ---
  "charmed",
  "charmCount",
  "possessed",
  "silencedNights",
  "silencePending",
  "silencedPermanent",
  "delayPending",
  "nullifyNext",
  "disguised",
  "eclipse",
  "detainedThisNight",
  "tookDemonEffectThisNight",
  "demonDebuffs",
  "absorbedDebuffs",
  "romazWardenBlocked",
  "brokenSelf",
  "brokenAge",
  "selfRecovered",
  "deepsleep",
  "deepsleepCount",

  // --- 충전/게이지/쿨다운/사용횟수 ---
  "willCount",
  "resistCount",
  "roarBonus",
  "moonGauge",
  "futureCharge",
  "emberCharge",
  "emberTargets",
  "raidCharge",
  "missionCharge",
  "sealCap",
  "nightmareUses",
  "hypocrisySealReady",
  "convertCooldown",
  "callingCooldown",
  "callingPending",
  "sonataFired",
  "starlitNext",
  "extendNight",
  "clue",
  "soul",
  "doom",
  "persecuteBias",
  "dreamMorning",
  "tainted",

  // --- 태그(string[] 플래그) ---
  "dawnrise",
  "dessert",
  "cookie",
  "pudding",
  "remembered",
  "suspicionImmune",
  "infiltrated",
  "hypocrisy",
  "hypocrisySeal",
  "observedByRainer",
  "clawed",
  "romazSuspect",
  "wonhan",
  "pendant",
  "moonlit",
  "noticeSuppressed",
  "everShattered",
  "manifestMemory",
  "mephistoBrand",
  "clueWarrant",
  "convictionBlocked",
  "seikaMark",
] as const;

export type CounterTagName = (typeof COUNTER_TAG_NAMES)[number];

/**
 * 동적 이름 접두사 — 뒤에 플레이어/능력 id 가 붙는다.
 *  - used_<abilityId>      : maxUses 사용 횟수(used_pasua_convert 등)
 *  - soulCarrier_<userId>  : 엘런 자아 이전 대상 표식
 *  - rapportLink_<userId>  : 로잔느 라포르 결속 표식
 */
export const DYNAMIC_COUNTER_TAG_PREFIXES = [
  "used_",
  "soulCarrier_",
  "rapportLink_",
] as const;

const KNOWN = new Set<string>(COUNTER_TAG_NAMES);

/** 이름이 레지스트리(정적) 또는 동적 접두사 집합에 속하는지. */
export function isKnownCounterTag(name: string): boolean {
  if (KNOWN.has(name)) return true;
  return DYNAMIC_COUNTER_TAG_PREFIXES.some((p) => name.startsWith(p));
}
