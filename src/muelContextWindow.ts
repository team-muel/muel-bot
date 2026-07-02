import type { SupabaseClient } from '@supabase/supabase-js';
import { CAPABILITY_BOUNDARIES_COMPACT, formatCapabilityRegistryForPrompt } from './capabilities.js';
import { retrieveRelevantMemories, retrieveDirectMemoText } from './memoryRetriever.js';
import type { UIMessage, UserHistorySummary } from './muelConversationStore.js';

export type MentionedUserContext = {
  name: string;
  summary: UserHistorySummary | null;
};

export type MuelContextWindowMode = 'lightweight' | 'normal' | 'recall' | 'catchup' | 'admin';

export type MuelContextWindowDiagnostics = {
  mode: MuelContextWindowMode;
  lightweightTurn: boolean;
  toolsEnabled: boolean;
  maxMessages: number;
  includedMessages: number;
  memoryIncluded: boolean;
  memorySkippedReason: 'lightweight' | 'missing-user' | 'empty' | 'error' | null;
  sections: string[];
  /** 섹션별 문자 수 — 컨텍스트 비용 회계용(muel_ai_events.metadata 로 적재). */
  sectionChars: Record<string, number>;
};

export type MuelContextWindow = {
  system: string;
  systemParts: string[];
  messages: Array<any>;
  hasImage: boolean;
  lightweightTurn: boolean;
  toolsEnabled: boolean;
  mode: MuelContextWindowMode;
  diagnostics: MuelContextWindowDiagnostics;
};

export type BuildMuelContextWindowOptions = {
  supabase: SupabaseClient;
  baseSystemPrompt: string;
  userText: string;
  authorName: string;
  history: UIMessage[];
  channelActivity?: string;
  userHistory?: UserHistorySummary | null;
  mentionedUsers?: MentionedUserContext[];
  guildTopology?: string;
  sourceUserId?: string;
};

const LIGHTWEIGHT_TURN_MAX_CHARS = 24;
const LIGHTWEIGHT_CONTEXT_MESSAGES = 4;
const DEFAULT_CONTEXT_MESSAGES = 12;

const TOOL_TRIGGER_RE =
  /(최근|latest|news|뉴스|post|게시글|영상|video|shorts|쇼츠|기억|remember|전에|지난번|메모|memo|꿈|dream|schedule|일정|채널|쓰레드|thread|프로필|profile|다이제스트|digest|요약|구독|허브|상태|켜져|꺼져)/iu;
const RECALL_CONTEXT_RE = /(기억|remember|전에|지난번|메모|나에 대해|내가 너에게|weave)/iu;
const CATCHUP_CONTEXT_RE = /(최근|채널|쓰레드|thread|다이제스트|digest|요약|무슨 일|따라잡|catch\s*up)/iu;
const ADMIN_CONTEXT_RE = /(구독|허브|상태|켜져|꺼져|프로필|profile|server|서버)/iu;

export const isLightweightTurn = (userText: string): boolean => {
  const normalized = userText.trim();
  if (!normalized) return true;
  if (normalized.length > LIGHTWEIGHT_TURN_MAX_CHARS) return false;
  if (TOOL_TRIGGER_RE.test(normalized)) return false;
  return true;
};

export const shouldEnableTools = (userText: string): boolean => TOOL_TRIGGER_RE.test(userText);

export const classifyContextWindowMode = (userText: string): MuelContextWindowMode => {
  if (isLightweightTurn(userText)) return 'lightweight';
  if (RECALL_CONTEXT_RE.test(userText)) return 'recall';
  if (CATCHUP_CONTEXT_RE.test(userText)) return 'catchup';
  if (ADMIN_CONTEXT_RE.test(userText)) return 'admin';
  return 'normal';
};

export const getContextMessageBudget = (mode: MuelContextWindowMode): number => (
  mode === 'lightweight' ? LIGHTWEIGHT_CONTEXT_MESSAGES : DEFAULT_CONTEXT_MESSAGES
);

/**
 * 현재 시각을 KST (Asia/Seoul) 기준으로 시스템 프롬프트에 주입한다.
 *
 * Why: LLM 은 자체 시계가 없어, 대화 컨텍스트에 등장한 시간 표현
 * (예: "한국 시간으로 2시 10분이야!") 을 *지금 시각* 으로 환각하는 경향이 있다.
 * 매 호출마다 *진짜* 현재 시각을 단정해 줘야 시간/날짜 답이 정확해진다.
 */
export const formatCurrentTime = (): string => {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const formatted = fmt.format(now);
  return [
    '--- CURRENT TIME ---',
    `지금은 ${formatted} (Asia/Seoul, KST = UTC+9) 이다.`,
    '시간/날짜 질문에는 위 값을 단정해서 답하라. 대화 컨텍스트에 등장한 시간 표현을 *현재 시각* 으로 차용하지 마라.',
    '--- End Time ---',
  ].join('\n');
};

const formatUserHistory = (summary: UserHistorySummary | null | undefined, authorName: string): string => {
  if (!summary || summary.totalInteractions === 0) {
    return `--- About This User ---\n${authorName}: 아직 나와 대화한 기록이 거의 없는 유저.\n--- End User ---`;
  }
  const lines = [
    '--- About This User ---',
    `${authorName}: ${summary.totalInteractions}번 대화함.`,
  ];
  if (summary.recentTopics.length > 0) {
    lines.push(`최근 했던 말: ${summary.recentTopics.slice(0, 5).join(' / ')}`);
  }
  lines.push('--- End User ---');
  return lines.join('\n');
};

const formatMentionedUsers = (mentioned: MentionedUserContext[]): string => {
  if (!mentioned || mentioned.length === 0) return '';
  const lines = ['--- Mentioned Users ---'];
  for (const m of mentioned) {
    if (m.summary && m.summary.totalInteractions > 0) {
      lines.push(`${m.name}: ${m.summary.totalInteractions}번 대화함.`);
      if (m.summary.recentTopics.length > 0) {
        lines.push(`  최근 했던 말: ${m.summary.recentTopics.slice(0, 3).join(' / ')}`);
      }
    } else {
      lines.push(`${m.name}: 아직 나와 대화한 기록이 거의 없는 유저.`);
    }
  }
  lines.push('--- End Mentioned ---');
  return lines.join('\n');
};

const buildConversationMessages = (
  history: UIMessage[],
  maxMessages: number,
  authorName: string,
): { messages: Array<any>; hasImage: boolean } => {
  const convo = history.slice(-maxMessages).filter((msg) => msg.role !== 'system');
  const lastConvoIdx = convo.length - 1;
  const messages = convo.map((msg, idx) => {
    let content = msg.parts || [];
    // Discord CDN image URLs expire. Keep the actual image only on the latest turn;
    // older image turns remain visible as text context without stale URLs.
    if (idx !== lastConvoIdx) {
      content = content.map((p: any) =>
        p.type === 'image'
          ? {
              type: 'text',
              text: '[사용자가 이전 메시지에 이미지를 첨부했음 — 그 이미지는 지금 다시 볼 수 없음. "이미지를 못 본다"거나 "텍스트로만 대화한다"고 말하지 말 것]',
            }
          : p,
      );
    }
    if (msg.role === 'user') {
      const name = msg.metadata?.discordUsername ?? authorName;
      content = content.map((p: any) => (
        p.type === 'text' && !p._nameInjected
          ? { ...p, text: `${name}: ${p.text}`, _nameInjected: true }
          : p
      ));
    }
    return { role: msg.role, content };
  });

  const hasImage = messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image'),
  );
  return { messages, hasImage };
};

export const buildMuelContextWindow = async (
  opts: BuildMuelContextWindowOptions,
): Promise<MuelContextWindow> => {
  const mode = classifyContextWindowMode(opts.userText);
  const lightweightTurn = mode === 'lightweight';
  const toolsEnabled = shouldEnableTools(opts.userText);
  const maxMessages = getContextMessageBudget(mode);

  // 섹션 조립 — *캐시 친화 순서*: 정적 프리픽스(베이스+능력)를 앞에 고정하고,
  // 휘발 섹션(채널 활동, 현재 시각)을 뒤로 보낸다. 이전에는 CURRENT TIME 이
  // 2번째라 분 단위로 프리픽스가 바뀌어 프로바이더의 암묵적 프롬프트 캐시가
  // 매 턴 깨졌다. 시맨틱은 동일 — 순서만 안정→휘발로 재배열.
  const systemParts: string[] = [];
  const sections: string[] = [];
  const sectionChars: Record<string, number> = {};
  const pushSection = (name: string, text: string, blankBefore = true): void => {
    if (!text) return;
    if (blankBefore && systemParts.length > 0) systemParts.push('');
    systemParts.push(text);
    sections.push(name);
    sectionChars[name] = text.length;
  };

  pushSection('base', opts.baseSystemPrompt, false);

  // Efficiency: the full capability registry (~26 lines / ~940 tokens) is only
  // relevant on substantive turns (tool use, help / meta / news / memory).
  // Casual lightweight turns get a one-line boundary reminder instead — the
  // deterministic preflight guard (getPreflightGuard, run at the top of
  // generateMuelReply before any model call) still blocks the sensitive
  // categories regardless of the prompt.
  if (lightweightTurn) {
    pushSection('capabilitiesCompact', CAPABILITY_BOUNDARIES_COMPACT, false);
  } else {
    pushSection('capabilities', formatCapabilityRegistryForPrompt(), false);
  }

  if (opts.guildTopology) pushSection('guildTopology', opts.guildTopology);

  pushSection('userHistory', formatUserHistory(opts.userHistory, opts.authorName));
  pushSection('mentionedUsers', formatMentionedUsers(opts.mentionedUsers ?? []));

  // Memory — lightweight 턴은 직접 지침(muel_user_memos)만 저비용 주입(임베딩 X),
  // 비-lightweight 턴은 직접 지침 + 의미 기반 장기 기억(임베딩 유사도) 풀 경로.
  // 이전에는 lightweight 에서 전부 스킵 → 실트래픽이 거의 전부 lightweight 라
  // 30일간 retrieval 0건(읽기 경로 사망)이었다.
  let memoryIncluded = false;
  let memorySkippedReason: MuelContextWindowDiagnostics['memorySkippedReason'] = null;
  if (!opts.sourceUserId) {
    memorySkippedReason = 'missing-user';
  } else if (lightweightTurn) {
    try {
      const directText = await retrieveDirectMemoText(opts.supabase, opts.sourceUserId);
      if (directText) {
        pushSection('memoryDirect', directText);
        memoryIncluded = true;
      } else {
        memorySkippedReason = 'empty';
      }
    } catch (err) {
      memorySkippedReason = 'error';
      console.warn('[muel-agent] direct memo retrieval failed, proceeding without', err);
    }
  } else {
    try {
      const memoryContext = await retrieveRelevantMemories(opts.supabase, {
        userId: opts.sourceUserId,
        query: opts.userText,
      });
      if (memoryContext) {
        pushSection('memory', memoryContext);
        memoryIncluded = true;
      } else {
        memorySkippedReason = 'empty';
      }
    } catch (err) {
      memorySkippedReason = 'error';
      console.warn('[muel-agent] memory retrieval failed, proceeding without', err);
    }
  }

  const { messages, hasImage } = buildConversationMessages(opts.history, maxMessages, opts.authorName);

  if (hasImage) {
    pushSection('imageInstruction', [
      '[이미지 처리] 너는 첨부된 이미지를 실제로 볼 수 있다. "이미지를 못 본다"거나 "텍스트로만 대화한다"고 말하지 마라 — 그건 거짓말이다. 첨부된 이미지가 있으면 본 내용을 설명해라.',
      '- 실존 인물이 누구인지(신원)는 식별하지 않는다. "누구인지까지는 말 못 해"라고 솔직히 밝히고, 보이는 것(장면·표정·복장·분위기)은 묘사해줘라.',
      '- 가상 캐릭터·작품의 "정확한 이름·누구인지"는 확실하지 않으면 단정하지 마라("이거 나잖아" 식 금지). 추측이면 "아마 ~인 것 같은데 확실친 않아"로만. 사물·일반 묘사는 자유롭게.',
      '- 흐릿하거나 안 보이는 글자·세부는 지어내지 마라. 모르면 솔직히 모른다고 해라.',
    ].join('\n'));
  }

  // 휘발 섹션은 마지막 — 채널 활동(메시지마다 변동), 현재 시각(분마다 변동).
  if (opts.channelActivity) pushSection('channelActivity', opts.channelActivity);
  pushSection('time', formatCurrentTime());

  const diagnostics = {
    mode,
    lightweightTurn,
    toolsEnabled,
    maxMessages,
    includedMessages: messages.length,
    memoryIncluded,
    memorySkippedReason,
    sections,
    sectionChars,
  };

  return {
    system: systemParts.join('\n'),
    systemParts,
    messages,
    hasImage,
    lightweightTurn,
    toolsEnabled,
    mode,
    diagnostics,
  };
};
