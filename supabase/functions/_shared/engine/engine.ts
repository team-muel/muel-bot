import type { ActiveAbility, Effect, MatchState, PlayerState } from "./types.ts";
import { ANGEL_ROLES, CORE_ROLES, isDemonKillerRole } from "./roles.ts";

const TAG_PROTECTED = "protected";
const TAG_DELAYED = "delayed";
export const TAG_SUSPECTED = "suspected"; // 의심 투표 최다 득표 → 그 밤 능력 사용 불가 (canon §3)

// 부정 효과(아서 해오름 판정의 토대): 이 타입의 효과를 *적용한* 시전자는 counters.tainted=1.
// 결백/타락 판정은 진영이 아니라 '부정 효과를 한 번이라도 적용한 적 있는가'로 가린다(vault 아서
// §해오름). 사용자 확정(2026-06-17):
//  - 루루 매료(Charm=투표 양도)는 가해가 아니라 양도 → 부정 효과 X(제외).
//  - 세이카 봉인(Silence)은 부정 효과 O(포함). '경우에 따라 타락'은 '봉인을 실제로 쓴 경우에만'
//    tainted 가 되는 자연스러운 조건부로 성립(안 쓰면 결백).
// Annihilate(아서 잔불 대검의 소멸)는 *의로운 심판*이라 시전자를 tainted 시키지 않는다 — 목록에서
// 제외(아서가 타락자를 소멸시켜도 아서 자신은 타락 판정 안 됨). Annihilate 는 잔불 대검 전용이라
// 제외해도 다른 직업에 영향 없음. 미확정 edge(현재 제외): ChangeFaction(파스아 강제전향).
const NEGATIVE_EFFECT_TYPES = new Set<Effect["type"]>([
  "Kill", "Corrupt", "Silence", "Nightmare", "Possess", "Haunt", "Nullify", "Rebrand", "Eclipse",
]);

// 세이카 흡수 출처 추적: '흡수 가능한 부여 효과'(대상에 디버프 카운터/태그를 남기는 부정 효과)
// 만 demonDebuffs 로 집계한다. Kill/Annihilate/Rebrand/Eclipse 같은 종결·변환계는 '받은 부여
// 효과'가 아니라 흡수 대상이 아니므로 제외. Absorb 가 이 집합이 만든 카운터를 모두 정화한다.
const ABSORBABLE_DEBUFF_TYPES = new Set<Effect["type"]>([
  "Silence", "Possess", "Nightmare", "Haunt", "Charm", "ModifyReceivedVote", "ModifyReceivedSuspicion",
]);

// 부정 효과 적용 여부 판정(아서 해오름의 토대). 타입 집합 + 부호 의존 분류 — 직업 하드코딩 없음.
// 사용자 확정(2026-06-17): 투표/의심 '행위' 자체는 부정효과 아님(이건 applyEffect 가 아니라 tally
// 경로라 애초에 여기 안 옴). 단 투표/의심을 *통해 가해*하는 효과는 부정효과 — 받는 표 증가
// (ModifyReceivedVote>0)·받는 의심 증가(ModifyReceivedSuspicion>0)·행사 투표가치 감소
// (ModifyVoteValue<0). 반대 부호(이득 방향)는 가해 아님.
function isNegativeApplication(effect: Effect): boolean {
  if (NEGATIVE_EFFECT_TYPES.has(effect.type)) return true;
  if (effect.type === "ModifyReceivedVote") return (effect.amount ?? 0) > 0;
  if (effect.type === "ModifyReceivedSuspicion") return (effect.amount ?? 0) > 0;
  if (effect.type === "ModifyVoteValue") return (effect.amount ?? 0) < 0;
  return false;
}

export type VoteActionInput = {
  actorUserId: string;
  targetUserId: string | null;
  actionType?: string;
};

export type VoteTallyResult = {
  tallies: Record<string, number>;
  skipped: number;
  candidateUserId: string | null;
  maxVotes: number;
  tie: boolean;
};

export type VerdictTallyResult = {
  approve: number;
  reject: number;
  skipped: number;
  approved: boolean;
};

export type WinConditionResult = {
  winner: "angels" | "demons" | "neutral" | null;
  aliveAngels: number;
  aliveDemons: number;
};

// 파스아(중립) 단독 승리 임계 — *생존* 교세가 ceil(인원/3) 이상 (최소 3).
// 2026-06-11 P0-C 튜닝(후속 ALL 지시): 기존 "누적 전향 고정 3"은 시뮬에서 중립승
// 35~70%(인원 단조 증가)로 지배적이었다. 후보 4안 비교(sim:balance --rule) 결과
// scale-alive(인원 비례 임계 + 생존 교세)가 16~34%로 유일하게 비지배 + 단조성
// 파괴 + "전향자 처형 = 교세 차감" 카운터플레이 성립. 8~9인=3, 10~12인=4.
// 측정 근거: docs/gomdori-gameplay-verification.md §6.
export function pasuaWinThreshold(totalPlayers: number): number {
  return Math.max(3, Math.ceil(totalPlayers / 3));
}

export function getRoleDefinition(roleId: string) {
  return CORE_ROLES.find((role) => role.id === roleId);
}

// 유효 멀티타깃 상한(정적 targetCount + 동적 성장). 팬텀 어둠이 내린 도시처럼 매 아침 +1 하는
// 능력을 직업 하드코딩 없이 표현한다. engine·match-action 이 같은 식으로 계산해 일관 적용.
export function effectiveTargetCount(ability: ActiveAbility, source: { counters?: Record<string, number> }, dayCount: number): number {
  let n = ability.targetCount ?? 1;
  if (ability.targetCountPerDay) n += ability.targetCountPerDay * Math.max(0, (dayCount ?? 1) - 1);
  if (ability.targetCountCounter) n += (source.counters?.[ability.targetCountCounter] ?? 0);
  return Math.max(1, n);
}

export function resolveNightActions(state: MatchState): { newState: MatchState; events: unknown[] } {
  const newState: MatchState = JSON.parse(JSON.stringify(state));
  const events: unknown[] = [];

  const sortedActions = [...newState.actionStack].sort((a, b) => a.priority - b.priority);
  newState.actionStack = [];

  // 소명(하브레터스): 보호가 실제 공격을 막았을 때 시전자에게 줄 보상 예약(targetUserId → 시전자/카운터).
  const saveRewards: Record<string, { source: string; counter: string; amount: number }> = {};

  // GAME-2: voteBias/suspicionBias are per-round boosts (romaz). Clear last
  // round's leftover before applying this night's effects so suspecting the same
  // target on consecutive nights cannot accumulate an unbeatable bias.
  for (const userId in newState.players) {
    const counters = newState.players[userId].counters;
    if (counters) {
      counters.voteBias = 0;
      counters.suspicionBias = 0;
      counters.charmed = 0; // 매료(루루)도 라운드 한정 — 직전 라운드 잔여 제거.
      counters.possessed = 0; // 빙의(말렌)도 라운드 한정.
      // 연속 포교 제한(파스아): 포교한 밤에 1 로 세팅 → 다음 밤 submission 을 match-action
      // 이 거부. 매 밤 1 씩 감소시켜 한 밤 건너 다시 가능하게 한다(리셋 아닌 카운트다운).
      if (counters.convertCooldown) counters.convertCooldown = Math.max(0, counters.convertCooldown - 1);
      // 악몽 지연 (vault canon 팬텀): 지정한 그 밤(N)이 아니라 *다음* 밤(N+1)이 와야
      // 대상이 '악몽' 상태가 되고, 그 다음 아침(D N+2)에 탈락한다. 지정 시점엔
      // nightmarePending 만 세우고, 다음 밤 시작(여기)에서 nightmare 로 옮긴다.
      if (counters.nightmarePending && counters.nightmarePending > 0) {
        counters.nightmare = (counters.nightmare ?? 0) + counters.nightmarePending;
        counters.nightmarePending = 0;
      }
      // 마비 지연 봉인(말렌 빙의의 '다음 밤 봉인'): 지정 밤(N)에 silencePending 예약 → 다음 밤(N+1)
      // 시작인 여기에서 silencedNights 로 옮겨 그 밤 행동을 막는다(악몽 지연과 같은 패턴, 재사용).
      // 우노 명예 실추(DelaySilence)도 같은 예약 경로를 공유한다.
      if (counters.silencePending && counters.silencePending > 0) {
        counters.silencedNights = (counters.silencedNights ?? 0) + counters.silencePending;
        counters.silencePending = 0;
      }
      // 신출귀몰(말렌): 이전 밤에 수거한 혼령 표식을 다음 밤 시체로 소환한다. 시체는 현재
      // 악마팀 deadCountBonus 로 표현된다.
      if (counters.corpsePending && counters.corpsePending > 0) {
        counters.deadCountBonus = (counters.deadCountBonus ?? 0) + counters.corpsePending;
        events.push({ type: "corpse_summoned", payload: { user_id: userId, amount: counters.corpsePending } });
        counters.corpsePending = 0;
      }
      // 세이카 '자신만 아플 거야' 악마팀 공개 카운트다운: 흡수 소멸(demonRevealIn=2) 후 매 밤
      // 시작에 1 씩 감소, 0 이 되는 밤(=소멸 이틀 후)에 악마팀 전원 공개 이벤트를 방출한다.
      if (counters.demonRevealIn && counters.demonRevealIn > 0) {
        counters.demonRevealIn -= 1;
        if (counters.demonRevealIn === 0) {
          const demons = Object.values(newState.players)
            .filter((p) => p.actualFaction === "demon")
            .map((p) => p.userId);
          events.push({ type: "demons_revealed", payload: { demons, by: userId } });
        }
      }
    }
    // 해오름(dawnrise) 만료: 1_DAY 태그 — 적용된 밤(N) → 다음 낮(N) 투표(위용)까지 유지되고,
    // 다음 밤(N+1) 시작인 여기에서 만료된다. 그 밤 재지정 시 아래 action 루프가 다시 부여.
    const pl = newState.players[userId];
    if (pl.tags.includes("dawnrise")) pl.tags = pl.tags.filter((t) => t !== "dawnrise");
    // 가인 약간의 위선(DelayAction) 지연 승격: 지정 밤(N)에 delayPending 예약 → 다음 밤(N+1)
    // 시작인 여기에서 TAG_DELAYED 로 옮겨 대상의 그 밤 능력 발동을 한 밤 미룬다(소멸 아닌 연기).
    if (pl.counters?.delayPending && pl.counters.delayPending > 0) {
      pl.counters.delayPending = 0;
      if (!pl.tags.includes(TAG_DELAYED)) pl.tags.push(TAG_DELAYED);
    }
  }

  for (const action of sortedActions) {
    const sourcePlayer = newState.players[action.sourceUserId];
    const targetPlayer = action.targetUserId ? newState.players[action.targetUserId] : null;

    if (!sourcePlayer?.alive) continue;

    if (sourcePlayer.tags.includes(TAG_SUSPECTED)) {
      events.push({ type: "action_blocked_suspected", userId: sourcePlayer.userId });
      continue;
    }

    // 봉인(세이카 초신성·팬텀 어둠이 내린 도시): 그 밤 능력 발동 불가. 봉인 액션이 priority 1
    // (가장 먼저)이라 대상의 능력보다 앞서 silencedNights 가 세팅된다. 밤 종료 시 0으로 리셋.
    // silencedPermanent(세이카 재적용): 매 밤 지속 — 리셋되지 않아 영구 봉인.
    if ((sourcePlayer.counters?.silencedNights ?? 0) > 0 || (sourcePlayer.counters?.silencedPermanent ?? 0) > 0) {
      events.push({ type: "action_blocked_silenced", userId: sourcePlayer.userId });
      continue;
    }

    // 무효(로건 네 안에 없는 것): 표식이 있으면 *가장 가까운* 능력 발동을 소멸시키고 소비.
    // 봉인과 달리 지속(리셋 X) — 대상이 다음에 능력을 쓰는 밤까지 기다렸다 무효화한다.
    if ((sourcePlayer.counters?.nullifyNext ?? 0) > 0) {
      sourcePlayer.counters.nullifyNext -= 1;
      events.push({ type: "action_nullified", userId: sourcePlayer.userId });
      continue;
    }

    const roleDef = getRoleDefinition(sourcePlayer.currentRole);
    if (!roleDef) continue;

    const ability = roleDef.actions.night?.find((candidate) => candidate.id === action.actionType);
    if (!ability) continue;

    if (sourcePlayer.tags.includes(TAG_DELAYED)) {
      sourcePlayer.tags = sourcePlayer.tags.filter((tag) => tag !== TAG_DELAYED);
      events.push({ type: "action_delayed", userId: sourcePlayer.userId });
      continue;
    }

    // 짝숫날 발동 금지(베스토 누명씌우기 canon "짝숫날 발동 불가"). 선언형 게이트 —
    // dayCount 가 짝수면 능력 자체를 패스(통지만, 카운터·횟수 소비 X).
    if (ability.evenDayBlocked && newState.dayCount % 2 === 0) {
      events.push({ type: "action_blocked_even_day", userId: sourcePlayer.userId });
      continue;
    }

    // maxUses 강제 — 1회성 능력(부활 등)의 사용 횟수를 counters.used_<id> 로 영속 기록.
    // 미강제 시 미즐렛/헬렌 부활이 매 밤 반복돼 게임이 수렴하지 않는 교착 엔진이 된다
    // (docs/gomdori-gameplay-verification.md P0-B). used_* 는 지속 카운터 — 라운드 리셋 X.
    if (ability.maxUses != null) {
      const usedKey = `used_${ability.id}`;
      if ((sourcePlayer.counters[usedKey] ?? 0) >= ability.maxUses) {
        events.push({ type: "action_blocked_exhausted", userId: sourcePlayer.userId });
        continue;
      }
      sourcePlayer.counters[usedKey] = (sourcePlayer.counters[usedKey] ?? 0) + 1;
    }

    // 카운터 게이트(루나 달 게이지): 충전이 임계 미만이면 발동 차단. consume 면 발동 후 소비.
    if (ability.requiresCounter) {
      const { key, min, consume, consumeAmount } = ability.requiresCounter;
      if ((sourcePlayer.counters[key] ?? 0) < min) {
        events.push({ type: "action_blocked_no_charge", userId: sourcePlayer.userId, key });
        continue;
      }
      // consumeAmount: 누적 충전을 그만큼만 차감(아서 잔불 대검). 없으면 기존 consume=전량 소비.
      if (consumeAmount != null) {
        sourcePlayer.counters[key] = Math.max(0, (sourcePlayer.counters[key] ?? 0) - consumeAmount);
      } else if (consume) {
        sourcePlayer.counters[key] = 0;
      }
    }

    for (const effect of ability.effects) {
      // All: 전원 대상(대악마 압도적 존재감·우노 용맹함). 생존자 전체에 적용(source 포함 여부는
      // 효과 의미에 맡김 — 봉인/투표가치 등은 전원 의도). 단일 타깃 해소와 분리.
      if (effect.target === "All") {
        for (const other of Object.values(newState.players)) {
          if (other.alive) applyEffect(newState, sourcePlayer, other, effect, events);
        }
        continue;
      }
      // AllOthers: source 제외 생존자 전체 — 악마 "전원" 능력은 자신 제외(혼자 투표·처치).
      if (effect.target === "AllOthers") {
        for (const other of Object.values(newState.players)) {
          if (other.alive && other.userId !== sourcePlayer.userId) {
            applyEffect(newState, sourcePlayer, other, effect, events);
          }
        }
        continue;
      }

      // "Target" 효과: 멀티타깃(아서 잔불이 꺼지기 전에=3명)이면 targetUserIds 의 각 대상에,
      // 아니면 단일 targetUserId 에 적용. 단일/멀티를 한 경로로 통일(하위호환).
      if (effect.target === "Target") {
        const maxN = effectiveTargetCount(ability, sourcePlayer, newState.dayCount);
        const ids = (maxN > 1 && action.targetUserIds && action.targetUserIds.length)
          ? action.targetUserIds.slice(0, maxN)
          : (action.targetUserId ? [action.targetUserId] : []);
        for (const tid of ids) {
          const t = newState.players[tid];
          if (!t) continue;
          if (!t.alive && ability.targetType !== "SINGLE_DEAD") continue;
          applyEffect(newState, sourcePlayer, t, effect, events);
        }
        continue;
      }

      let target: PlayerState | null = null;
      if (effect.target === "self") target = sourcePlayer;
      // substrate: "내가 투표/의심한 대상"으로 해소(루나 달빛·엘런 박해 등 단일 토대).
      if (effect.target === "VoteTarget" && sourcePlayer.lastVoteTarget) target = newState.players[sourcePlayer.lastVoteTarget] ?? null;
      if (effect.target === "SuspectTarget" && sourcePlayer.lastSuspectTarget) target = newState.players[sourcePlayer.lastSuspectTarget] ?? null;

      if (!target) continue;
      if (!target.alive && ability.targetType !== "SINGLE_DEAD") continue;

      applyEffect(newState, sourcePlayer, target, effect, events);
    }

    // 발동 성공 후 카운터 세팅(ADR-006 S3, 선언형) — 파스아 연속 포교 쿨다운 등. 봉인/지목/
    // 사망으로 막혔으면 위에서 continue 돼 여기 못 옴(연속 포교 불가, canon §파스아).
    if (ability.onFireSetCounter) {
      sourcePlayer.counters[ability.onFireSetCounter.key] = ability.onFireSetCounter.value;
    }
    // 소명 예약(하브레터스): onSaveGrantSelf 를 가진 보호 능력이 대상에 걸렸으면, 그 대상이
    // 이 밤 실제 공격을 막았을 때(아래 death 해소의 attack_prevented) 시전자에게 보상한다.
    if (ability.onSaveGrantSelf && targetPlayer) {
      saveRewards[targetPlayer.userId] = { source: sourcePlayer.userId, ...ability.onSaveGrantSelf };
    }
  }

  for (const userId in newState.players) {
    const player = newState.players[userId];

    if (player.markedForDeath) {
      if (player.currentRole === "arthur") {
        // 여명의 기사(패시브): 아서는 어떤 효과로도 밤에 탈락하지 않는다(소멸 annihilate 포함).
        // 단 '결백한 천사팀 3명+ 탈락 시 동반 탈락'은 아침(phase-advance)에서 별도 처리.
        // 타락(currentRole='corrupted')하면 더 이상 아서가 아니므로 면역 상실.
        player.markedForDeath = false;
        if (player.counters?.annihilated) player.counters.annihilated = 0;
        player.tags = player.tags.filter((tag) => tag !== TAG_PROTECTED);
        events.push({ type: "arthur_immune", payload: { user_id: player.userId } });
      } else if (player.tags.includes(TAG_PROTECTED)) {
        player.markedForDeath = false;
        player.tags = player.tags.filter((tag) => tag !== TAG_PROTECTED);
        events.push({ type: "attack_prevented", userId: player.userId });
        // 소명(하브레터스): 이 보호가 실제 살해를 막았으므로 시전자에게 보상(투표가치 +3 등).
        const rw = saveRewards[player.userId];
        if (rw && newState.players[rw.source]) {
          newState.players[rw.source].counters[rw.counter] = (newState.players[rw.source].counters[rw.counter] ?? 0) + rw.amount;
          events.push({ type: "oath_fulfilled", payload: { user_id: rw.source, counter: rw.counter, amount: rw.amount } });
        }
      } else if ((player.counters?.shield ?? 0) > 0) {
        // 보호막(가인 등): 밤 살해 1회 무효 + 소비. 처형 차단은 phase-advance에서 처리한다.
        player.counters.shield -= 1;
        player.markedForDeath = false;
        events.push({ type: "shield_blocked", userId: player.userId });
      } else {
        player.alive = false;
        player.markedForDeath = false;
        events.push({ type: "player_died", payload: { user_id: player.userId } });
        // 약간의 위선(가인) 전환: '위선' 표식이 걸린 대상이 밤에 탈락하면(악마 살해 경로) 가인의
        // 다음 위선이 *탈락 효과*로 변한다(hypocrisyKillReady). canon "대상이 악마에 의해 탈락하면
        // 다음 위선이 대상을 탈락시키는 효과로 변경". 출처 특정 없이 생존 가인에게 부여(보통 1명).
        if (player.tags.includes("hypocrisy")) {
          for (const g of Object.values(newState.players)) {
            if (g.alive && g.currentRole === "gain") g.counters.hypocrisyKillReady = 1;
          }
          player.tags = player.tags.filter((t) => t !== "hypocrisy"); // 표식 1회 소비(영구 재발동 방지)
        }
        // 잠입 수사(도르단) 불심검문: 관찰('infiltrated' 표식) 대상이 그 밤 탈락하면 도르단은
        // 그 밤 받은 부정 효과(상태이상)를 모두 무시 — retroactive 정화(canon "그 밤 모든 부정 효과
        // 무시"). 처치 면역은 범위 밖(상태 효과 한정). 표식 1회 소비.
        if (player.tags.includes("infiltrated")) {
          for (const d of Object.values(newState.players)) {
            if (d.alive && d.currentRole === "dordan") {
              for (const k of ["voteBias", "suspicionBias", "charmed", "possessed", "silencedNights", "nightmare", "silencedPermanent", "persecuteBias", "haunted"]) {
                if (d.counters[k]) d.counters[k] = 0;
              }
              d.tags = d.tags.filter((t) => t !== TAG_SUSPECTED && t !== TAG_DELAYED);
              events.push({ type: "stakeout_triggered", payload: { user_id: d.userId } });
            }
          }
          player.tags = player.tags.filter((t) => t !== "infiltrated");
        }
      }
    }

    player.tags = player.tags.filter((tag) => tag !== TAG_PROTECTED && tag !== TAG_DELAYED && tag !== TAG_SUSPECTED);
    // 봉인은 같은 밤 한정 — 종료 시 해제.
    if (player.counters?.silencedNights) player.counters.silencedNights = 0;
  }

  // 여명의 기사(패시브): 결백한(tainted 0) 천사팀의 누적 탈락을 반영. 탈락 1명당 아서 '잔불 대검'
  // 충전 +1(델타만 가산해 중복 방지). 누적 3명+ 이면 아서도 탈락(동반). 투표 탈락은 phase-advance
  // 가 같은 헬퍼를 호출해 반영한다(아래 applyDawnbreakerPassive).
  applyDawnbreakerPassive(newState.players, events);

  // 부서진 펜던트(로건 패시브): 악마팀(처치자)에게 지워지지 않는 '펜던트' 표식을 부여하고,
  // 셋 이상 적용되면 로건의 지정 대상 +2(pendantTargetBonus). 매 밤 해소 시 갱신한다.
  applyLogenPendant(newState.players, events);

  // 팬텀 아침 처리: ① 어둠이 내린 도시 봉인 가능 수 '매 아침 +1'(sealCap, 지속). ② 그 밤 아무도
  // 봉인하지 않았으면(어둠이 내린 도시 미발동) 악몽 사용 횟수 +2 충전(상한 5) — 봉인 대신 악몽을
  // 비축하는 템포 선택. sortedActions 로 이 밤 phantom_seal 제출 여부 판정(직업 하드코딩 최소).
  const sealedBy = new Set(sortedActions.filter((a) => a.actionType === "phantom_seal").map((a) => a.sourceUserId));
  for (const p of Object.values(newState.players)) {
    if (p.alive && p.currentRole === "phantom") {
      p.counters.sealCap = (p.counters.sealCap ?? 0) + 1;
      if (!sealedBy.has(p.userId)) {
        p.counters.nightmareUses = Math.min(5, (p.counters.nightmareUses ?? 0) + 2);
      }
    }
  }

  // 베스토 아침 처리: 히든 포지션 미발동(미공격) 밤마다 강화 스택 +1(상한 2, vault canon "미발동 시
  // 점점 강해짐 — 최대 2회 강화, 발동 시 중첩 초기화"). 발동(besto_hidden) 시 onFireSetCounter
  // hiddenStack=0 으로 소비된다. hiddenMark 표식 보유 대상이 그 밤 탈락하면 추가 +1 — 누명씌우기로
  // 처형/탈락을 유도하면 강화로 환원되는 canon "이 효과로 탈락 시 강화 +1".
  const firedHidden = new Set(sortedActions.filter((a) => a.actionType === "besto_hidden").map((a) => a.sourceUserId));
  const diedHiddenMarked = new Set<string>();
  for (const ev of events) {
    const e = ev as { type?: string; payload?: { user_id?: string } };
    if (e.type === "player_died" && e.payload?.user_id) {
      const dp = newState.players[e.payload.user_id];
      if (dp && dp.tags.includes("hiddenMark")) diedHiddenMarked.add(dp.userId);
    }
  }
  for (const p of Object.values(newState.players)) {
    if (!p.alive || p.currentRole !== "besto") continue;
    if (!firedHidden.has(p.userId)) {
      p.counters.hiddenStack = Math.min(2, (p.counters.hiddenStack ?? 0) + 1);
    }
    if (diedHiddenMarked.size > 0) {
      p.counters.hiddenStack = Math.min(2, (p.counters.hiddenStack ?? 0) + diedHiddenMarked.size);
      events.push({ type: "frameup_credited", payload: { user_id: p.userId, deaths: Array.from(diedHiddenMarked) } });
    }
  }
  // hiddenMark 표식은 사망/소비 후 정리 — 일회용(canon "이 효과로 탈락" 한 번 trigger 후 만료).
  for (const uid of diedHiddenMarked) {
    const dp = newState.players[uid];
    if (dp) dp.tags = dp.tags.filter((t) => t !== "hiddenMark");
  }

  // 밤 탈락 후크(ADR-006 S3, 선언형): 살아있는 직업의 RoleDefinition.deathHook 을 제네릭
  // 적용한다 — 직업 분기 없음. 말렌 혼/시체(perDeath soul + convert→deadCountBonus),
  // 도르단 단서(perDeath clue). 다단계(혼령 방출 격상 등)는 후속.
  const deathsThisRound = events.filter((e) => (e as { type?: string }).type === "player_died").length;
  if (deathsThisRound > 0) {
    for (const p of Object.values(newState.players)) {
      if (!p.alive) continue;
      const hook = getRoleDefinition(p.currentRole)?.deathHook;
      if (!hook) continue;
      p.counters[hook.perDeath.counter] =
        (p.counters[hook.perDeath.counter] ?? 0) + deathsThisRound * hook.perDeath.amount;
      if (hook.convert) {
        const { from, threshold, to, amount } = hook.convert;
        while ((p.counters[from] ?? 0) >= threshold) {
          p.counters[from] -= threshold;
          p.counters[to] = (p.counters[to] ?? 0) + amount;
          events.push({ type: "death_hook_convert", payload: { user_id: p.userId, from, to } });
        }
      }
      events.push({
        type: "death_hook",
        payload: { user_id: p.userId, counter: hook.perDeath.counter, value: p.counters[hook.perDeath.counter] },
      });
    }

    // 침착한 탐정(도르단): 누군가 탈락한 밤, 도르단이 직전 투표로 '범인'이라 지목한 대상이
    // 그 밤 지정한 대상을 도르단에게 알려준다. VoteTarget substrate 를 재사용한다.
    for (const dordan of Object.values(newState.players)) {
      if (!dordan.alive || dordan.currentRole !== "dordan" || !dordan.lastVoteTarget) continue;
      const culpritActions = sortedActions.filter((a) => a.sourceUserId === dordan.lastVoteTarget);
      const targetIds = Array.from(new Set(culpritActions.flatMap((a) => {
        if (a.targetUserIds?.length) return a.targetUserIds;
        return a.targetUserId ? [a.targetUserId] : [];
      })));
      if (targetIds.length === 0) continue;
      events.push({
        type: "culprit_target_revealed",
        payload: { user_id: dordan.userId, culprit_user_id: dordan.lastVoteTarget, target_user_ids: targetIds },
      });
    }
  }

  return { newState, events };
}

// 위용(아서 패시브): '셋 이상 벨 수 있게 되면'(잔불 대검 충전 emberCharge ≥ 3) 발동 — 해오름
// (dawnrise) 적용된 결백한(tainted 0) 살아있는 천사팀 1명당 아서의 행사 투표가치 +3(누적).
function prowessVoteBonus(actor: PlayerState, players: Record<string, PlayerState>): number {
  if (actor.currentRole !== "arthur") return 0;
  if ((actor.counters?.emberCharge ?? 0) < 3) return 0;
  let n = 0;
  for (const p of Object.values(players)) {
    if (p.alive && p.actualFaction === "angel" && (p.counters?.tainted ?? 0) === 0 && p.tags.includes("dawnrise")) n++;
  }
  return n * 3;
}

// 두 번째 자아(베스토 패시브): 행사 투표가치 절대값 고정 — 사탄의 마(-1) 누적과 무관.
//   하베스토(disguised=0): 3 + 2*hiddenStack(미발동 강화) — 최대 3+4=7(강화 2스택까지).
//   솔(disguised=1): 1 (고정).
// 베스토가 아니면 null 을 돌려 tally 가 기본 식(base + 보너스)을 쓰게 한다. 베스토면 절대값
// override — 모든 보너스/패널티 무시(canon "투표가치 X 고정").
function bestoSelfVoteValue(actor: PlayerState): number | null {
  if (actor.currentRole !== "besto") return null;
  const sol = (actor.counters?.disguised ?? 0) > 0;
  if (sol) return 1;
  return 3 + 2 * Math.max(0, Math.min(2, actor.counters?.hiddenStack ?? 0));
}

export function tallyEliminationVotes(
  actions: VoteActionInput[],
  players: Record<string, PlayerState>,
): VoteTallyResult {
  const tallies: Record<string, number> = {};
  let skipped = 0;

  for (const action of actions) {
    const actor = players[action.actorUserId];
    if (!actor?.alive) continue;

    // 매료(루루): 매료된 자는 자기 처형 투표를 행사할 수 없다(권한이 루루에게 양도됨).
    if ((actor.counters?.charmed ?? 0) > 0) {
      skipped += 1;
      continue;
    }

    if (!action.targetUserId) {
      skipped += 1;
      continue;
    }

    const target = players[action.targetUserId];
    if (!target?.alive) {
      skipped += 1;
      continue;
    }

    // 베스토 두 번째 자아 고정값(있으면 모든 보너스/패널티 무시 — canon "투표가치 X 고정").
    // 없으면 기본: base + 보너스 + 루루 매료 양도분 + 사탄의 마 감소분 + 아서 위용을 합산.
    const bestoOverride = bestoSelfVoteValue(actor);
    const voteValue = bestoOverride != null
      ? Math.max(0, bestoOverride)
      : Math.max(0, (actor.baseVoteValue || 1) + (actor.bonusVoteValue || 0) + (actor.counters?.voteWeightBonus ?? 0) + (actor.counters?.voteValueMod ?? 0) + prowessVoteBonus(actor, players));
    if (voteValue === 0) {
      skipped += 1;
      continue;
    }

    tallies[action.targetUserId] = (tallies[action.targetUserId] || 0) + voteValue;
  }

  // 받는-표 가산: 라운드성 voteBias(로마즈) + 지속 persecuteBias(엘런 박해 누진)를 합산.
  for (const p of Object.values(players)) {
    const bias = (p.counters?.voteBias ?? 0) + (p.counters?.persecuteBias ?? 0);
    if (p.alive && bias > 0) tallies[p.userId] = (tallies[p.userId] || 0) + bias;
  }

  let candidateUserId: string | null = null;
  let maxVotes = 0;
  let tie = false;

  for (const [targetUserId, votes] of Object.entries(tallies)) {
    if (votes > maxVotes) {
      candidateUserId = targetUserId;
      maxVotes = votes;
      tie = false;
    } else if (votes === maxVotes) {
      tie = true;
    }
  }

  return {
    tallies,
    skipped,
    candidateUserId: tie ? null : candidateUserId,
    maxVotes,
    tie,
  };
}

// 밤 의심 투표 집계 (canon §3·§12). 의심가치 = max(0, 1 + suspicionValue) (기본 1).
// 최다 1인 → candidate, 동률/무표 → null(부결, canon §4).
export function tallySuspicionVotes(
  actions: VoteActionInput[],
  players: Record<string, PlayerState>,
): VoteTallyResult {
  const tallies: Record<string, number> = {};
  let skipped = 0;

  for (const action of actions) {
    const actor = players[action.actorUserId];
    if (!actor?.alive) continue;

    if (!action.targetUserId) {
      skipped += 1;
      continue;
    }

    const target = players[action.targetUserId];
    if (!target?.alive) {
      skipped += 1;
      continue;
    }

    const weight = Math.max(0, 1 + (actor.suspicionValue || 0));
    if (weight === 0) {
      skipped += 1;
      continue;
    }

    tallies[action.targetUserId] = (tallies[action.targetUserId] || 0) + weight;
  }

  // 받는-의심 가산 (로마즈 용의자 +의심가치). counters.suspicionBias 보유 생존자에 가산.
  for (const p of Object.values(players)) {
    const bias = p.counters?.suspicionBias ?? 0;
    if (p.alive && bias > 0) tallies[p.userId] = (tallies[p.userId] || 0) + bias;
  }

  let candidateUserId: string | null = null;
  let maxVotes = 0;
  let tie = false;

  for (const [targetUserId, votes] of Object.entries(tallies)) {
    if (votes > maxVotes) {
      candidateUserId = targetUserId;
      maxVotes = votes;
      tie = false;
    } else if (votes === maxVotes) {
      tie = true;
    }
  }

  return {
    tallies,
    skipped,
    candidateUserId: tie ? null : candidateUserId,
    maxVotes,
    tie,
  };
}

export function tallyVerdictVotes(actions: VoteActionInput[], players: Record<string, PlayerState>): VerdictTallyResult {
  let approve = 0;
  let reject = 0;
  let skipped = 0;

  for (const action of actions) {
    const actor = players[action.actorUserId];
    if (!actor?.alive) continue;

    const bestoOverride = bestoSelfVoteValue(actor);
    const voteValue = bestoOverride != null
      ? Math.max(0, bestoOverride)
      : Math.max(0, (actor.baseVoteValue || 1) + (actor.bonusVoteValue || 0) + (actor.counters?.voteValueMod ?? 0) + prowessVoteBonus(actor, players));
    if (voteValue === 0) {
      skipped += 1;
      continue;
    }

    if (action.actionType === "verdict_approve") {
      approve += voteValue;
    } else if (action.actionType === "verdict_reject") {
      reject += voteValue;
    } else {
      skipped += 1;
    }
  }

  return {
    approve,
    reject,
    skipped,
    approved: approve > reject,
  };
}

// 카운트 기반 승리 판정 (canon §1·§10).
// 천사 승리 = 살아있는 악마 0 (탈락/처형). 악마 승리 = 악마팀 카운트 >= 천사팀 카운트.
// 기본 카운트: 생존자 = 1, 사망자 = 0. counters.countBonus(생존 가산, 예: 수호병 +1)
// 와 counters.deadCountBonus(사망 무관 지속, 예: 라이너 백호 +3) 가 팀 카운트에 반영된다.
// 능력이 카운트를 건드리지 않으면(counters 비어있음) 결과는 생존 패리티와 동일 — 회귀 0.
// 악몽 해소(아침). 악몽 표식(counters.nightmare >= 1)을 가진 생존자를 탈락시킨다.
// 밤 능력 해소와 분리된 "아침" 단계라 1_NIGHT 보호로 막히지 않는다(canon 악몽). 부활
// (Heal)로 되살린 뒤에는 표식이 0 이어야 재탈락하지 않으므로, 탈락 처리 시 표식을 소비한다.
export function resolveNightmares(players: Record<string, PlayerState>): unknown[] {
  const events: unknown[] = [];
  for (const player of Object.values(players)) {
    if (player.alive && (player.counters?.nightmare ?? 0) >= 1) {
      player.alive = false;
      player.counters.nightmare = 0;
      events.push({ type: "nightmare_death", payload: { user_id: player.userId } });
    }
  }
  return events;
}

// 팀 카운트 집계 — checkWinCondition / checkTimeoutWinner 공용 단일 출처.
export type TeamCounts = {
  aliveAngels: number;
  aliveDemons: number;
  angelCount: number;
  demonCount: number;
  pasuaAlive: boolean;
  pasuaFlock: number;
};

export function countTeams(players: Record<string, PlayerState>): TeamCounts {
  let aliveAngels = 0;
  let aliveDemons = 0;
  let angelCount = 0;
  let demonCount = 0;

  // 파스아 교세 — *생존* 전향자 수와 파스아 생존 여부 (P0-C 튜닝: 전향자가 처형/
  // 살해되면 교세에서 빠진다 — 카운터플레이). 전향자는 currentRole 이 'converted',
  // 파스아 본인은 'pasua'. 둘 다 중립이라 천사/악마 버킷엔 잡히지 않는다(bucket=null).
  let pasuaAlive = false;
  let pasuaFlock = 0;
  for (const player of Object.values(players)) {
    if (player.currentRole === "pasua" && player.alive) pasuaAlive = true;
    if (player.currentRole === "converted" && player.alive) pasuaFlock += 1;
  }

  for (const player of Object.values(players)) {
    // 빙의(말렌): 그 라운드 악마팀으로 카운트.
    const possessed = (player.counters?.possessed ?? 0) > 0;
    const faction = possessed ? "demon" : (player.treatedAsFaction || player.actualFaction);
    const bucket =
      faction === "demon" || faction === "helper"
        ? "demon"
        : faction === "angel"
          ? "angel"
          : null;
    if (!bucket) continue;

    if (player.alive) {
      const weight = 1 + (player.counters?.countBonus ?? 0);
      if (bucket === "demon") {
        aliveDemons += 1;
        demonCount += weight;
      } else {
        aliveAngels += 1;
        angelCount += weight;
      }
    } else {
      const deadWeight = player.counters?.deadCountBonus ?? 0;
      if (deadWeight) {
        if (bucket === "demon") demonCount += deadWeight;
        else angelCount += deadWeight;
      }
    }
  }

  return { aliveAngels, aliveDemons, angelCount, demonCount, pasuaAlive, pasuaFlock };
}

export function checkWinCondition(players: Record<string, PlayerState>): WinConditionResult {
  const { aliveAngels, aliveDemons, angelCount, demonCount, pasuaAlive, pasuaFlock } =
    countTeams(players);

  // 파스아 단독 승리는 "즉시 승리"(canon 구원자 패시브) — 천사/악마 판정보다 우선.
  // 파스아 생존 + *생존* 교세가 인원 비례 임계(pasuaWinThreshold) 이상이면 중립 승리.
  const totalPlayers = Object.keys(players).length;
  let winner: "angels" | "demons" | "neutral" | null = null;
  if (pasuaAlive && pasuaFlock >= pasuaWinThreshold(totalPlayers)) {
    winner = "neutral";
  } else if (aliveDemons === 0) {
    winner = "angels";
  } else if (demonCount >= angelCount) {
    winner = "demons";
  }

  return { winner, aliveAngels, aliveDemons };
}

// 최대 일수 도달 시 강제 종착 (M2-5 교착 안전망 — gomdori-rules.gameLength.maxDays).
// 우세 판정: 팀 카운트 비교. 동률은 악마 — canon §30 "충돌 시 악마 유리"(마을이 기한 내
// 악마 제거에 실패한 상태). 중립은 임계 미달이면 후보가 아니다(달성 시 이미 즉시 승리).
export function checkTimeoutWinner(players: Record<string, PlayerState>): {
  winner: "angels" | "demons";
  angelCount: number;
  demonCount: number;
  aliveAngels: number;
  aliveDemons: number;
} {
  const { aliveAngels, aliveDemons, angelCount, demonCount } = countTeams(players);
  return {
    winner: angelCount > demonCount ? "angels" : "demons",
    angelCount,
    demonCount,
    aliveAngels,
    aliveDemons,
  };
}

// 여명의 기사(아서 패시브): 결백한(tainted 0) 천사팀의 누적 탈락 수에 따라 — 탈락 1명당 아서
// '잔불 대검' 충전 +1(델타만 가산, 중복 방지) + 누적 3명 이상이면 아서 동반 탈락. 밤(엔진)·낮
// 투표(phase-advance) 양쪽 탈락 모두에서 같은 헬퍼를 호출해 일관 반영한다. 아서가 타락
// (currentRole='corrupted')하면 패시브 상실(arthur 미발견 → no-op).
export function applyDawnbreakerPassive(players: Record<string, PlayerState>, events: unknown[]): void {
  const arthur = Object.values(players).find((p) => p.currentRole === "arthur");
  if (!arthur) return;
  arthur.counters = arthur.counters ?? {};
  let deadInnocentAngels = 0;
  for (const p of Object.values(players)) {
    if (p.currentRole === "arthur") continue; // 아서 자신은 제외.
    if (!p.alive && p.actualFaction === "angel" && (p.counters?.tainted ?? 0) === 0) deadInnocentAngels++;
  }
  const credited = arthur.counters.dawnDeathsCredited ?? 0;
  if (deadInnocentAngels > credited) {
    arthur.counters.emberCharge = (arthur.counters.emberCharge ?? 0) + (deadInnocentAngels - credited);
    arthur.counters.dawnDeathsCredited = deadInnocentAngels;
  }
  if (arthur.alive && deadInnocentAngels >= 3) {
    arthur.alive = false;
    arthur.markedForDeath = false;
    events.push({ type: "dawnbreaker_fallen", payload: { user_id: arthur.userId, dead_innocent_angels: deadInnocentAngels } });
  }
}

// 부서진 펜던트(로건 패시브): 게임 진행 중 악마팀(처치자 풀)에게 지워지지 않는 '펜던트' 표식을
// 부여한다. 표식이 셋 이상이면 로건의 능력 지정 대상 +2(pendantTargetBonus, logen_nullify 가
// targetCountCounter 로 읽음). 횟수 제한 해제는 logen_nullify 가 본디 무제한이라 추가 효과 없음.
// 표식은 '지워지거나 빼앗기지 않음'(canon) — 한 번 붙으면 유지, 매 밤 해소 시 임계만 재평가.
export function applyLogenPendant(players: Record<string, PlayerState>, events: unknown[]): void {
  const logen = Object.values(players).find((p) => p.currentRole === "logen");
  if (!logen) return;
  logen.counters = logen.counters ?? {};
  for (const p of Object.values(players)) {
    if (isDemonKillerRole(p.currentRole) && !p.tags.includes("pendant")) {
      p.tags.push("pendant");
      events.push({ type: "pendant_applied", payload: { user_id: p.userId } });
    }
  }
  const pendantCount = Object.values(players).filter((p) => p.tags.includes("pendant")).length;
  logen.counters.pendantTargetBonus = pendantCount >= 3 ? 2 : 0;
}

function applyEffect(
  _state: MatchState,
  _source: PlayerState,
  target: PlayerState,
  effect: Effect,
  events: unknown[],
) {
  // 진영 게이트(레거시): 대상 진영이 onlyFactions 에 없으면 이 효과를 건너뛴다.
  if (effect.onlyFactions && !effect.onlyFactions.includes(target.actualFaction)) {
    return;
  }
  // 행위-기반 게이트(아서 잔불 대검 결백/타락): 대상의 누적 카운터로 분기. 진영이 아니라
  // 행위 이력(tainted)으로 결백(skipIfTargetCounter)/타락(onlyIfTargetCounter)을 가른다.
  if (effect.onlyIfTargetCounter && (target.counters?.[effect.onlyIfTargetCounter.key] ?? 0) < effect.onlyIfTargetCounter.min) {
    return;
  }
  if (effect.skipIfTargetCounter && (target.counters?.[effect.skipIfTargetCounter.key] ?? 0) >= effect.skipIfTargetCounter.min) {
    return;
  }
  // 시전자 카운터 게이트(가인 위선 전환): 시전자 상태로 분기(평시 연기 / 전환후 처치).
  if (effect.onlyIfSourceCounter && (_source.counters?.[effect.onlyIfSourceCounter.key] ?? 0) < effect.onlyIfSourceCounter.min) {
    return;
  }
  if (effect.skipIfSourceCounter && (_source.counters?.[effect.skipIfSourceCounter.key] ?? 0) >= effect.skipIfSourceCounter.min) {
    return;
  }
  // 태그 게이트(미즐렛 고급 와인 디저트 유/무): 대상 태그로 분기.
  if (effect.onlyIfTargetTag && !target.tags.includes(effect.onlyIfTargetTag)) {
    return;
  }
  if (effect.skipIfTargetTag && target.tags.includes(effect.skipIfTargetTag)) {
    return;
  }
  // 홀수날 게이트(엘런 박해자): 짝수날이면 이 효과를 건너뛴다(canon 홀수날 한정).
  if (effect.oddDayOnly && (_state.dayCount % 2 === 0)) {
    return;
  }
  // 군인의 사명(우노): 투쟁 2회로 충전된 대상은 악마가 가하는 부정 효과 1회를 제거한다.
  if (_source.actualFaction === "demon" && isNegativeApplication(effect) && (target.counters?.missionCharge ?? 0) >= 2) {
    target.counters.missionCharge = Math.max(0, (target.counters.missionCharge ?? 0) - 2);
    events.push({ type: "mission_blocked", payload: { user_id: target.userId, by: _source.userId, effect: effect.type } });
    return;
  }
  // 해오름 판정 토대: 게이트를 통과해 실제로 부정 효과를 적용하는 시전자를 '타락'으로 표식한다.
  // (진영 무관 — 부정 효과를 쓴 천사도 tainted 가 된다. vault 아서 §해오름.)
  if (isNegativeApplication(effect)) {
    _source.counters.tainted = 1;
    // 세이카 흡수 출처 추적(provenance): 악마팀(actualFaction='demon', 처치자+악마측 조력자
    // 포함)이 가한 '흡수 가능한 부여 효과'를 대상의 demonDebuffs 로 누적한다(지속 — 라운드
    // 리셋 X). 세이카 Absorb 가 이 카운터로 '악마팀 효과 3개+' 를 출처 정확히 판정한다.
    if (_source.actualFaction === "demon" && ABSORBABLE_DEBUFF_TYPES.has(effect.type)) {
      target.counters.demonDebuffs = (target.counters.demonDebuffs ?? 0) + 1;
    }
  }
  switch (effect.type) {
    case "Kill":
      // 면역 진영(파스아 신앙: 악마 면역). 대상 지정은 허용하되 탈락만 무효 — 방어가
      // 아니라 결과 무효라 attack_prevented 로 통지하고 markedForDeath 를 세우지 않는다.
      if (effect.immuneFactions?.includes(target.actualFaction)) {
        events.push({ type: "attack_prevented", payload: { user_id: target.userId } });
        break;
      }
      target.markedForDeath = true;
      break;
    case "Heal":
      // 소멸(아서 단죄)된 대상은 부활 불가(counters.annihilated).
      if (!target.alive && !(target.counters?.annihilated)) {
        target.alive = true;
        events.push({ type: "player_revived", payload: { user_id: target.userId } });
      }
      break;
    case "Annihilate":
      // 단죄(아서 잔불 대검): 첫 적용은 폭열(branded 표식), 폭열된 대상에 재적용하면 소멸
      // — 탈락 + 부활 불가(annihilated). 결백/타락 판정 다단계는 후속.
      if ((target.counters?.branded ?? 0) > 0) {
        target.markedForDeath = true;
        target.counters.annihilated = 1;
        events.push({ type: "annihilated", payload: { user_id: target.userId } });
      } else {
        target.counters.branded = 1;
        events.push({ type: "branded", payload: { user_id: target.userId } });
      }
      break;
    case "Haunt":
      // 혼령 방출(말렌 다단계): 1회차 → 혼령 표식(haunted, 지속). 2회차(표식 보유) → 영에게
      // 잠식: 탈락 + 대상의 투표가치를 말렌에게 조공(source.voteWeightBonus +1). 표식 소비.
      // 마비는 silencePending 으로 다음 밤 봉인을 예약한다.
      if ((target.counters?.haunted ?? 0) > 0) {
        target.markedForDeath = true;
        target.counters.haunted = 0;
        _source.counters.voteWeightBonus = (_source.counters.voteWeightBonus ?? 0) + 1;
        events.push({ type: "haunt_consumed", payload: { user_id: target.userId } });
      } else {
        target.counters.haunted = 1;
        events.push({ type: "haunted", payload: { user_id: target.userId } });
      }
      break;
    case "Sleep":
      // 황금빛 수면(헬렌): 대상을 수면 — 죽음 보호(밤 살해 무효) + 그 밤 행동 봉인 +
      // 받은 부정효과 무효(Cleanse 복합). 깨어나면 평소대로. 보호는 1밤(TAG_PROTECTED).
      target.tags.push(TAG_PROTECTED);
      target.counters.silencedNights = (target.counters.silencedNights ?? 0) + 1;
      for (const key of ["voteBias", "suspicionBias", "charmed", "possessed", "nightmare"]) {
        if (target.counters[key]) target.counters[key] = 0;
      }
      events.push({ type: "slept", payload: { user_id: target.userId } });
      break;
    case "Protect":
      target.tags.push(TAG_PROTECTED);
      break;
    case "AddTag":
      if (effect.tag) target.tags.push(effect.tag);
      break;
    case "RemoveTag":
      if (effect.tag) {
        target.tags = target.tags.filter((tag) => tag !== effect.tag);
      }
      break;
    case "ModifyReceivedVote": {
      // tag 지정 시 그 카운터에 지속 누적(엘런 박해 누진 = persecuteBias, 라운드 리셋 X). 미지정 시
      // voteBias(라운드성, 로마즈). tally 가 voteBias + persecuteBias 둘 다 받는-표에 합산.
      const rvKey = effect.tag ?? "voteBias";
      target.counters[rvKey] = (target.counters[rvKey] ?? 0) + (effect.amount ?? 0);
      events.push({ type: "vote_bias_applied", payload: { user_id: target.userId, amount: effect.amount ?? 0, counter: rvKey } });
      break;
    }
    case "ModifyReceivedSuspicion":
      target.counters.suspicionBias = (target.counters.suspicionBias ?? 0) + (effect.amount ?? 0);
      events.push({ type: "suspicion_bias_applied", payload: { user_id: target.userId, amount: effect.amount ?? 0 } });
      break;
    case "ModifyVoteValue":
      // 사탄의 마(대악마): 대상의 *행사* 투표가치를 amount 만큼 조정(음수=감소, 지속).
      // tally(처형/판결)에서 voteValueMod 로 합산. 라운드 리셋 X(누적).
      target.counters.voteValueMod = (target.counters.voteValueMod ?? 0) + (effect.amount ?? 0);
      events.push({ type: "vote_value_modified", payload: { user_id: target.userId, amount: effect.amount ?? 0 } });
      break;
    case "ChangeFaction":
      // 포교(파스아): 천사 + 조력자(가인)만 전향 가능. 악마(currentRole 'demon')·이미
      // 중립(파스아/전향자)은 불가. 가인은 DB faction 이 'demon' 이지만 currentRole 이
      // 'gain' 이므로 전향 대상 — actualFaction 이 아니라 currentRole 로 차단한다.
      // 카운트 보존: actualFaction 을 neutral 로 바꿔 천사/악마 버킷에서 빠지게 하고,
      // currentRole='converted' 로 교세에 합류. phase-advance 가 engine_state.currentFaction
      // 으로 영속화한다.
      if (
        !isDemonKillerRole(target.currentRole) &&
        target.currentRole !== "pasua" &&
        target.currentRole !== "converted" &&
        target.actualFaction !== "neutral"
      ) {
        target.actualFaction = "neutral";
        target.currentRole = "converted";
        events.push({ type: "faction_changed", payload: { user_id: target.userId, new_faction: "neutral" } });
      }
      break;
    case "Silence":
      // 봉인: 대상의 그 밤 능력 발동을 막는다(세이카 초신성·팬텀 어둠이 내린 도시·로건 무력화).
      // 봉인 액션이 priority 1 이라 대상 능력보다 먼저 처리됨. 밤 종료 시 자동 해제.
      // effect.tag(마크 키): 같은 대상 재적용 시 영구 봉인(세이카 초신성 재폭발). 마크는
      // Cleanse 대상이 아니라(지속) 누적 — 첫 적용은 표식+1밤 봉인, 재적용은 영구.
      if (effect.tag) {
        if ((target.counters[effect.tag] ?? 0) > 0) {
          target.counters.silencedPermanent = 1;
          events.push({ type: "silenced_permanent", payload: { user_id: target.userId } });
        } else {
          target.counters[effect.tag] = 1;
          target.counters.silencedNights = (target.counters.silencedNights ?? 0) + 1;
          events.push({ type: "silenced", payload: { user_id: target.userId } });
        }
      } else {
        target.counters.silencedNights = (target.counters.silencedNights ?? 0) + 1;
        events.push({ type: "silenced", payload: { user_id: target.userId } });
      }
      break;
    case "Cleanse": {
      // 부정효과 제거(세이카 초신성·우노 사명·미즐렛 와인): 대상에게 걸린 라운드성/지연
      // 부정 효과를 모두 씻어낸다. 지속 자석(countBonus/deadCountBonus/shield/voteWeightBonus)
      // 과 세이카 마크는 건드리지 않는다 — '받은 부여 효과'만 대상.
      for (const key of ["voteBias", "suspicionBias", "charmed", "possessed", "silencedNights", "nightmare", "silencedPermanent", "persecuteBias"]) {
        if (target.counters[key]) target.counters[key] = 0;
      }
      target.tags = target.tags.filter((t) => t !== TAG_SUSPECTED && t !== TAG_DELAYED);
      events.push({ type: "cleansed", payload: { user_id: target.userId } });
      break;
    }
    case "DelaySilence": {
      // 명예 실추(우노 용맹함): *다음* 밤 봉인을 예약(silencePending, 말렌 마비와 경로 공유 →
      // priority 1 아니어도 안전). selfPenalty 면 게이트(onlyFactions)는 대상(VoteTarget)으로
      // 평가하되 봉인은 *시전자*(우노)에게 — "천사 투표 대상을 처형하면(동료 살해) 우노 자신이
      // 명예 실추" 의 자기 처벌. selfPenalty 없으면 대상에 건다(범용).
      const ds = effect.selfPenalty ? _source : target;
      ds.counters.silencePending = (ds.counters.silencePending ?? 0) + 1;
      events.push({ type: "honor_disgraced", payload: { user_id: ds.userId } });
      break;
    }
    case "DelayAction":
      // 약간의 위선(가인): 대상의 *다음* 능력 발동을 한 밤 연기(소멸이 아니라 미룸). delayPending
      // 예약 → 다음 밤 시작에 TAG_DELAYED 로 승격(resolveNightActions 리셋 루프). 지속 카운터라
      // 라운드 리셋 대상이 아니다(예약은 다음 밤에 한 번 소비). 대상이 밤에 탈락하면 아래
      // death hook 이 가인의 다음 위선을 처치 효과로 전환한다.
      target.counters.delayPending = (target.counters.delayPending ?? 0) + 1;
      events.push({ type: "hypocrisy_delayed", payload: { user_id: target.userId } });
      break;
    case "RevealRole":
      // 소속/직업 통지(우노 용맹함의 '소속 공개', 가인 위선 정찰 등). 시전자에게 대상의 진영·
      // 직업을 통지하는 정보 효과 — 상태 변경 없음(이벤트만). recipient 는 phase-advance 가
      // private 으로 시전자에게 전달한다(소속 공개는 우노 투표 대상 한정 정찰).
      events.push({ type: "role_revealed", payload: { user_id: target.userId, faction: target.actualFaction, role: target.currentRole } });
      break;
    case "Absorb": {
      // 자신만 아플 거야(세이카, target:"All"): 대상의 받은 부여 효과를 세이카(source)가 대신
      // 받아낸다 — 대상은 모든 디버프를 정화(Cleanse 동일 키)한다. 단 소멸 임계(악마팀 효과 3+)
      // 는 출처가 악마팀인 효과만(demonDebuffs, provenance 추적) 누적해 정확히 판정한다 — 천사·
      // 중립이 가한 디버프는 정화하되 소멸 카운트엔 넣지 않는다. 자기 자신은 흡수 대상 제외.
      // 누적 3+ → 세이카 소멸(markedForDeath + annihilated 부활 불가) + 악마팀 공개(demonRevealIn=2).
      if (target.userId === _source.userId) break;
      const demonOrigin = target.counters.demonDebuffs ?? 0;
      for (const key of ["voteBias", "suspicionBias", "charmed", "possessed", "silencedNights", "nightmare", "silencedPermanent", "persecuteBias", "haunted", "demonDebuffs"]) {
        if (target.counters[key]) target.counters[key] = 0;
      }
      target.tags = target.tags.filter((t) => t !== TAG_SUSPECTED && t !== TAG_DELAYED);
      if (demonOrigin > 0) {
        _source.counters.absorbedDebuffs = (_source.counters.absorbedDebuffs ?? 0) + demonOrigin;
        events.push({ type: "absorbed", payload: { user_id: target.userId, by: _source.userId, amount: demonOrigin } });
      }
      if ((_source.counters.absorbedDebuffs ?? 0) >= 3 && !_source.counters.demonRevealIn) {
        _source.markedForDeath = true;
        _source.counters.annihilated = 1;
        _source.counters.demonRevealIn = 2;
        events.push({ type: "seika_overload", payload: { user_id: _source.userId } });
      }
      break;
    }
    case "GrantCount": {
      // 소속 카운트 +amount(지속). 기본은 countBonus(생존 가산, 우노 투쟁). effect.tag 로
      // 카운터를 지정하면 그쪽에 가산 — 라이너 백호는 deadCountBonus(생존 무관 지속).
      const countKey = effect.tag ?? "countBonus";
      target.counters[countKey] = (target.counters[countKey] ?? 0) + (effect.amount ?? 1);
      events.push({ type: "count_granted", payload: { user_id: target.userId, amount: effect.amount ?? 1, counter: countKey } });
      break;
    }
    case "Charge": {
      // 비례 충전(루나 고요한 적막): 해소된 대상(VoteTarget/SuspectTarget)을 기준으로 시전자의
      // counters[tag] 를 올린다. 대상이 악마면 demonAmount(canon 달빛 +10%/악마 +30%). 대상 자체는
      // 변경하지 않는다 — 충전의 '기준'일 뿐. moonGauge 100% = 10(천사 10명분/악마 ~4명분).
      const chargeKey = effect.tag ?? "moonGauge";
      const amt = target.actualFaction === "demon" ? (effect.demonAmount ?? effect.amount ?? 0) : (effect.amount ?? 0);
      _source.counters[chargeKey] = (_source.counters[chargeKey] ?? 0) + amt;
      events.push({ type: "charged", payload: { user_id: _source.userId, counter: chargeKey, amount: amt } });
      break;
    }
    case "Deduce": {
      // 상호추리(하브레터스 삶이 있는 곳으로): 대상이 악마팀 처치자면 '적중' — 시전자의 그 밤
      // 부정 효과를 정화(악마 효과 면역 근사). 빗나가면 통지만. 악마측 역추리(하브 탈락)는 후속.
      if (isDemonKillerRole(target.currentRole)) {
        for (const k of ["voteBias", "suspicionBias", "charmed", "possessed", "silencedNights", "nightmare", "silencedPermanent", "persecuteBias", "haunted"]) {
          if (_source.counters[k]) _source.counters[k] = 0;
        }
        events.push({ type: "deduce_hit", payload: { user_id: _source.userId, target: target.userId } });
      } else {
        events.push({ type: "deduce_miss", payload: { user_id: _source.userId, target: target.userId } });
      }
      break;
    }
    case "SummonCorpse": {
      // 신출귀몰(말렌): 혼령 방출 1회차가 남긴 haunted 표식을 수거한다. 실제 시체 소환은
      // 다음 밤 시작에 corpsePending → deadCountBonus 로 승격되어 "다음 밤 시체 소환" 타이밍을 지킨다.
      const haunted = target.counters?.haunted ?? 0;
      if (haunted > 0) {
        target.counters.haunted = 0;
        _source.counters.corpsePending = (_source.counters.corpsePending ?? 0) + haunted;
        events.push({ type: "corpse_gathered", payload: { user_id: target.userId, by: _source.userId, amount: haunted } });
      }
      break;
    }
    case "Charm":
      // 매료(루루): 대상의 다음 처형 투표 무력화(charmed, 라운드 한정) + 투표 권한을
      // 루루(source)에게 양도(voteWeightBonus +1, 지속).
      target.counters.charmed = 1;
      _source.counters.voteWeightBonus = (_source.counters.voteWeightBonus ?? 0) + 1;
      _source.counters.charmCount = (_source.counters.charmCount ?? 0) + 1; // 소나타(루루) 게이지.
      events.push({ type: "charmed", payload: { user_id: target.userId, by: _source.userId } });
      break;
    case "Nullify":
      // 무효(로건): 대상의 *다음* 능력 발동을 소멸시키는 표식(지속, 발동 시 소비). 봉인과 달리
      // 라운드 리셋되지 않아 대상이 능력을 쓸 때까지 기다린다(resolveNightActions 무효 체크).
      target.counters.nullifyNext = (target.counters.nullifyNext ?? 0) + 1;
      events.push({ type: "nullify_marked", payload: { user_id: target.userId } });
      break;
    case "Possess":
      // 빙의(말렌): 대상 그 밤 행동 봉인 + 그 라운드 악마팀으로 카운트(possessed) + 마비(다음 밤도
      // 봉인 = silencePending → 다음 밤 silencedNights). 2밤 봉쇄로 강령술사의 장악을 표현(canon 마비).
      target.counters.silencedNights = (target.counters.silencedNights ?? 0) + 1;
      target.counters.possessed = 1;
      target.counters.silencePending = (target.counters.silencePending ?? 0) + 1;
      events.push({ type: "possessed", payload: { user_id: target.userId } });
      break;
    case "Disguise":
      // 변신(베스토): self 토글. 0=하베스토(악마 판정) / 1=솔(조사 시 천사로 회피).
      target.counters.disguised = (target.counters?.disguised ?? 0) > 0 ? 0 : 1;
      events.push({ type: "disguise_toggled", payload: { user_id: target.userId, disguised: target.counters.disguised } });
      break;
    case "Rebrand":
      // 메피스토 낙인(대악마): 대상의 직업 삭제 → 임의의 천사 직업으로 비밀 재배정.
      // currentRole 만 바꾼다(원직업은 originalRole 에 남아 게임 종료 시 함께 공개, canon §9).
      if (ANGEL_ROLES.length > 0) {
        const next = ANGEL_ROLES[Math.floor(Math.random() * ANGEL_ROLES.length)];
        target.currentRole = next;
        events.push({ type: "rebranded", payload: { user_id: target.userId } });
      }
      break;
    case "Eclipse":
      // 일식(팬텀): self 표식. phase-advance 가 다음 아침을 밤으로 바꾸고 팬텀을 소멸시킨다.
      target.counters.eclipse = 1;
      events.push({ type: "eclipse_cast", payload: { user_id: target.userId } });
      break;
    case "Nightmare":
      // 악몽(팬텀, vault canon — 2단계 지연): 지정한 그 밤(N) 에 표식만 예약 → 다음 밤(N+1)
      // 시작 시 nightmarePending → nightmare 로 이동 → 그 다음 아침(D N+2)에 탈락(resolveNightmares).
      // 이미 '악몽' 상태에서 재지정 = '영면': 즉시 죽이지 않고 풀(deepsleep)에 누적한다. 팬텀이
      // phantom_reap 으로 원할 때(낮 포함) 일괄 처치. 영면이 살아있는 동안 팬텀의 악몽 지정 가능
      // 수 +1(source.deepsleepCount — phantom_nightmare 의 targetCountCounter).
      if ((target.counters.nightmare ?? 0) >= 1 || (target.counters.deepsleep ?? 0) >= 1) {
        if ((target.counters.deepsleep ?? 0) === 0) {
          target.counters.deepsleep = 1;
          _source.counters.deepsleepCount = (_source.counters.deepsleepCount ?? 0) + 1;
        }
        target.counters.nightmare = 0;
        target.counters.nightmarePending = 0;
        events.push({ type: "deepsleep_marked", payload: { user_id: target.userId } });
      } else {
        target.counters.nightmarePending = (target.counters.nightmarePending ?? 0) + 1;
        events.push({ type: "nightmare_marked", payload: { user_id: target.userId, level: 1 } });
      }
      break;
    case "Corrupt":
      // 타락(루나): 천사를 악마팀으로. 천사만 — 악마(처치자)·조력자·중립·이미 타락은 불가.
      // actualFaction='demon' 으로 악마 카운트에 합류, currentRole='corrupted'(능력 없음).
      // phase-advance 가 engine_state.currentFaction 으로 영속화한다.
      if (
        target.actualFaction === "angel" &&
        !isDemonKillerRole(target.currentRole) &&
        target.currentRole !== "corrupted"
      ) {
        target.actualFaction = "demon";
        target.currentRole = "corrupted";
        events.push({ type: "faction_changed", payload: { user_id: target.userId, new_faction: "demon" } });
      }
      break;
    case "Verdict": {
      // 해오름 판정(아서 잔불이 꺼지기 전에): 대상이 부정 효과를 한 번이라도 적용한 적 있으면
      // '타락', 아니면 '결백'으로 시전자(아서)에게 통지. 진영 무관 — counters.tainted 로만 가린다.
      const verdict = (target.counters?.tainted ?? 0) > 0 ? "tainted" : "innocent";
      events.push({ type: "verdict_revealed", payload: { user_id: target.userId, by: _source.userId, verdict } });
      break;
    }
  }
}
