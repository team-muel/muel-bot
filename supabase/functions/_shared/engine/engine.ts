import type { Effect, MatchState, PlayerState } from "./types.ts";
import { ANGEL_ROLES, CORE_ROLES, isDemonKillerRole } from "./roles.ts";

const TAG_PROTECTED = "protected";
const TAG_DELAYED = "delayed";
export const TAG_SUSPECTED = "suspected"; // 의심 투표 최다 득표 → 그 밤 능력 사용 불가 (canon §3)

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

export function resolveNightActions(state: MatchState): { newState: MatchState; events: unknown[] } {
  const newState: MatchState = JSON.parse(JSON.stringify(state));
  const events: unknown[] = [];

  const sortedActions = [...newState.actionStack].sort((a, b) => a.priority - b.priority);
  newState.actionStack = [];

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
      const { key, min, consume } = ability.requiresCounter;
      if ((sourcePlayer.counters[key] ?? 0) < min) {
        events.push({ type: "action_blocked_no_charge", userId: sourcePlayer.userId, key });
        continue;
      }
      if (consume) sourcePlayer.counters[key] = 0;
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

      let target: PlayerState | null = null;
      if (effect.target === "self") target = sourcePlayer;
      if (effect.target === "Target" && targetPlayer) target = targetPlayer;
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
  }

  for (const userId in newState.players) {
    const player = newState.players[userId];

    if (player.markedForDeath) {
      if (player.tags.includes(TAG_PROTECTED)) {
        player.markedForDeath = false;
        player.tags = player.tags.filter((tag) => tag !== TAG_PROTECTED);
        events.push({ type: "attack_prevented", userId: player.userId });
      } else if ((player.counters?.shield ?? 0) > 0) {
        // 보호막(가인 등): 밤 살해 1회 무효 + 소비. 처형 차단은 phase-advance에서 처리한다.
        player.counters.shield -= 1;
        player.markedForDeath = false;
        events.push({ type: "shield_blocked", userId: player.userId });
      } else {
        player.alive = false;
        player.markedForDeath = false;
        events.push({ type: "player_died", payload: { user_id: player.userId } });
      }
    }

    player.tags = player.tags.filter((tag) => tag !== TAG_PROTECTED && tag !== TAG_DELAYED && tag !== TAG_SUSPECTED);
    // 봉인은 같은 밤 한정 — 종료 시 해제.
    if (player.counters?.silencedNights) player.counters.silencedNights = 0;
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
  }

  return { newState, events };
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

    // 루루 매료 양도분(counters.voteWeightBonus)을 행사 가치에 합산.
    const voteValue = Math.max(0, (actor.baseVoteValue || 1) + (actor.bonusVoteValue || 0) + (actor.counters?.voteWeightBonus ?? 0));
    if (voteValue === 0) {
      skipped += 1;
      continue;
    }

    tallies[action.targetUserId] = (tallies[action.targetUserId] || 0) + voteValue;
  }

  // 받는-표 가산 (로마즈 용의자 +투표가치). counters.voteBias 보유 생존자에 가산.
  for (const p of Object.values(players)) {
    const bias = p.counters?.voteBias ?? 0;
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

    const voteValue = Math.max(0, (actor.baseVoteValue || 1) + (actor.bonusVoteValue || 0));
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

function applyEffect(
  _state: MatchState,
  _source: PlayerState,
  target: PlayerState,
  effect: Effect,
  events: unknown[],
) {
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
    case "ModifyReceivedVote":
      target.counters.voteBias = (target.counters.voteBias ?? 0) + (effect.amount ?? 0);
      events.push({ type: "vote_bias_applied", payload: { user_id: target.userId, amount: effect.amount ?? 0 } });
      break;
    case "ModifyReceivedSuspicion":
      target.counters.suspicionBias = (target.counters.suspicionBias ?? 0) + (effect.amount ?? 0);
      events.push({ type: "suspicion_bias_applied", payload: { user_id: target.userId, amount: effect.amount ?? 0 } });
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
      for (const key of ["voteBias", "suspicionBias", "charmed", "possessed", "silencedNights", "nightmare", "silencedPermanent"]) {
        if (target.counters[key]) target.counters[key] = 0;
      }
      target.tags = target.tags.filter((t) => t !== TAG_SUSPECTED && t !== TAG_DELAYED);
      events.push({ type: "cleansed", payload: { user_id: target.userId } });
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
      // 빙의(말렌): 대상 그 밤 행동 봉인 + 그 라운드 악마팀으로 카운트(possessed).
      target.counters.silencedNights = (target.counters.silencedNights ?? 0) + 1;
      target.counters.possessed = 1;
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
      // 악몽(팬텀): 지연 탈락 표식 누적. 밤 보호(Protect, 1_NIGHT)는 밤 종료 시 사라지므로
      // 막지 못한다 — 아침 해소(resolveNightmares)에서 탈락. 누적 2 = 영면(후속 단계).
      target.counters.nightmare = (target.counters.nightmare ?? 0) + 1;
      events.push({ type: "nightmare_marked", payload: { user_id: target.userId, level: target.counters.nightmare } });
      // 영면(v2): 악몽 2회 누적이면 그 밤 즉시 처리(밤 보호 무시는 아침 악몽 해소와 동일하게
      // markedForDeath 로 — 보호/수면이 막을 수 있으나 누적 악몽의 무게를 반영).
      if (target.counters.nightmare >= 2) {
        target.markedForDeath = true;
        events.push({ type: "deep_sleep", payload: { user_id: target.userId } });
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
  }
}
