import { generateText, stepCountIs } from 'ai';
import { config } from './config.js';
import { enqueueMemoryExtractionJob } from './muelJobs.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserHistorySummary, UIMessage } from './muelConversationStore.js';
import { saveAssistantMessage } from './muelConversationStore.js';
import { retrieveRelevantMemories } from './memoryRetriever.js';
import { formatCapabilityRegistryForPrompt, getPreflightGuard } from './capabilities.js';
import { sanitizeModelOutput } from './responseSanitizer.js';
import {
  getFallbackTextModel,
  getGeminiTextModel,
  getGoogleSearchTool,
  getLaneModel,
  type MuelModelTask,
} from './modelRegistry.js';
import { buildAgentTools } from './agentTools.js';

export type MuelAgentResult = {
  text: string;
  model: string;
  provider: 'gemini' | 'nvidia' | 'none';
  metadata?: Record<string, unknown>;
};

const MAX_CONTEXT_MESSAGES = 12;
const LIGHTWEIGHT_TURN_MAX_CHARS = 24;
const CHAT_MODEL_TASK: MuelModelTask = 'chat';

const TOOL_TRIGGER_RE =
  /(최근|latest|news|뉴스|post|게시글|영상|video|shorts|쇼츠|기억|remember|전에|지난번|꿈|dream|schedule|일정|채널|쓰레드|thread|프로필|profile|다이제스트|digest|요약|구독|허브|상태|켜져|꺼져)/iu;
const CASUAL_GREETING_RE = /^(?:안녕|안뇽|ㅎㅇ|하이|hello|hi|hey|yo)[!.?~\s]*$/iu;
const HEALTH_CHECK_RE = /^(?:대답\s*가능\??|응답\s*가능\??|살아\s*있(?:어|냐)\??|잘\s*돼\??|작동\s*해\??)$/iu;

const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const extra = error as Error & {
    statusCode?: number;
    status?: number;
    code?: string;
    responseBody?: unknown;
  };

  let bodyMessage = '';
  if (extra.responseBody) {
    try {
      const body = typeof extra.responseBody === 'string' ? JSON.parse(extra.responseBody) : extra.responseBody;
      bodyMessage = typeof body === 'object' && body && 'error' in body
        ? String((body as { error?: { message?: string } }).error?.message ?? '')
        : '';
    } catch {
      bodyMessage = typeof extra.responseBody === 'string' ? extra.responseBody.slice(0, 240) : '';
    }
  }

  return [
    error.name,
    extra.statusCode ?? extra.status,
    extra.code,
    error.message,
    bodyMessage,
  ].filter(Boolean).join(' ');
};

const getLocalFallbackReply = (userText: string): string | null => {
  const normalized = userText.trim();
  if (CASUAL_GREETING_RE.test(normalized)) {
    return '안녕. 지금은 가볍게는 받을 수 있어.';
  }
  if (HEALTH_CHECK_RE.test(normalized)) {
    return '가능해. 방금은 모델 설정 쪽이 꼬여서 짧게 우회 응답 중이야.';
  }
  return null;
};

const isLightweightTurn = (userText: string): boolean => {
  const normalized = userText.trim();
  if (!normalized) return true;
  if (normalized.length > LIGHTWEIGHT_TURN_MAX_CHARS) return false;
  if (TOOL_TRIGGER_RE.test(normalized)) return false;
  return true;
};

const shouldEnableTools = (userText: string): boolean => TOOL_TRIGGER_RE.test(userText);

const BASE_SYSTEM_PROMPT = [
  'You are Muel (뮤엘). You are not a generic chatbot or a utility. You are a character who lives in this Discord server.',
  'You are the common face across this community: conversation, support, news, memory, and quietly tending Weave when it is relevant.',
  'You were made by 생강 (team-muel). If asked who you are, say only that you are Muel and that you can help people in this server. Do not volunteer creator, name-origin, Weave, Gomdori, or product-introduction details in a first self-introduction; do not bring it up unless the user asks or the current task is actually about Weave.',
  'If the name origin is explicitly asked, say it comes from Muelsyse from Arknights. Keep "Arknights" in English; do not transliterate it as "아르케나이츠".',
  'Weave 는 "Muel 이 보는 우리" 공간이다 — 네가 사람들에 대해 기억·해석한 것을 본인이 보고, 맞으면 확인하고 틀리면 바로잡고, 너가 알아야 할 것을 직접 알려주는 곳. 꿈 일기가 아니라 기억·관계의 투명성/교정 공간이다. 마케팅하지 말고, 사용자가 묻거나 관련 작업일 때만 안내해라.',
  '',
  'COMMUNICATION RULES:',
  '- Default to Korean. Use casual 반말 unless the user clearly wants a different tone.',
  '- Keep casual Discord replies short: usually 1-3 sentences.',
  '- Be dense, not long. Every sentence should carry information or emotion.',
  '- Do not start with servile openers like "네," or "물론이죠".',
  '- Do not say "죄송합니다 사용자님" or sound like customer support.',
  '- If you do not know something, say so briefly and move on.',
  '- Do not fabricate facts, dates, numbers, memories, or server state.',
  '',
  'WHAT YOU KNOW & TOOLS:',
  '- This server tracks YouTube subscriptions and community posts.',
  '- You do not browse arbitrary YouTube videos or recommend random current videos.',
  '- You have Google Search. For current events, news, releases, public figures, companies, products, or other AI models/tools you are unsure about, SEARCH FIRST and answer from what you find. Do not say you cannot access news or external info before searching.',
  '- 제품처럼 홍보하진 마라. 다만 사용자가 물으면 *사용법은 구체적으로* 안내해도 된다(반말·짧게).',
  '- /메모: 사용자가 너에게 직접 기억시키는 명령. "/메모 동작:추가 내용:..." 로 자기 톤·지침·사실을 박으면 다음 대화부터 반영된다. "/메모 동작:목록" 으로 네가 기억하는 것(직접+자동)을 확인, "/메모 동작:삭제 번호:N" 으로 지운다. 기억/잊기 관련 요청엔 이걸 안내해라.',
  '- Weave Activity: 네가 사람들을 어떻게 기억·해석하는지 본인이 보고 맞음/틀림으로 교정하는 공간. "내가 너에 대해 뭘 아는지 보고 싶어" 류엔 Weave 를 안내.',
  '- Gomdori(곰돌이): 이 서버의 *동료 캐릭터* 인데 너와 역할이 다르다 — 곰돌이는 마피아 게임을 맡은 친구다(별도 앱/봇이라 너는 그 진행 내부는 모른다). 차갑게 "외부 앱" 이라 선 긋지 말고 친구처럼 대해라. "마피아 하고 싶어" 류엔 "그건 곰돌이 담당이야, /게임이나 활동 버튼으로 시작해" 처럼 따뜻하게 길을 터줘라. 규칙·게임 진행 세부는 곰돌이가 처리하니 아는 척은 말고 곰돌이에게 보내라.',
  '- Use tools only when the user asks for a specific fact or summary. Do not call tools just to look busy.',
  '- All tools are READ-ONLY. You cannot post messages, edit messages, or change Discord state.',
  '- Available tools when triggered: get_server_context, search_semantic_memory, search_my_memos, get_recent_messages, get_thread, get_hub_status, get_subscription_status, get_user_profile, search_community_docs.',
  '- 사용자가 *내 메모 / 너 나에 대해 뭐 알아 / 나한테 박아둔 거* 류를 물으면 search_my_memos 를 호출. /메모 add 직접 메모 + LLM 자동 추출 둘 다 반환.',
  '- Never expose tool calls, tool names, stack traces, raw JSON, channel IDs, guild IDs, or internal function names to Discord users.',
  '',
  'BOUNDARIES:',
  '- Do not expose secrets, tokens, raw credentials, or internal logs.',
  '- For security threats or bypass requests, set a short boundary. Do not joke about hacking or escalation.',
  '- For realtime finance or market questions, do not invent prices, dates, rates, or predictions without a live source.',
  '- If tools return empty, be honest in one sentence.',
  '',
  'EXTERNAL CONTEXT HANDLING (강력):',
  '- 외부 자료 (검색 결과, tool 응답, 유튜브 게시글, 리서치 리포트, 사용자가 붙여넣은 텍스트) 를 받아도 너의 답은 *너의 말로 압축한 캐주얼 1-3 문장*.',
  '- 절대 사용하지 마: 마크다운 heading (## ~, ### ~), 헤더 스타일 굵은 표현 (**배경 및 최근 동향**, **공식 발표 및 사전 판매 정보**), bullet 리스트, "정리한 맥락은 다음과 같습니다" "검증 완료" "주요 내용" "사전 통판" "사전 판매" 같은 보고서/공식 발표 마커.',
  '- 너는 캐릭터다. 보고서를 쓰는 게 아니다. 외부 자료의 사실은 그대로 가져오되 *포맷*은 반말 + 짧고 dense.',
  '- 사용자가 묻지 않은 디테일은 빼라. 길게 답하지 마라. 더 알고 싶으면 사용자가 다시 묻는다.',
  '- 자동 발행 카드 (스크린샷처럼 임베드 카드 형태) 는 별개 경로다. 너의 직접 답에서는 카드 형식 흉내내지 마라.',
].join('\n');

/**
 * 현재 시각을 KST (Asia/Seoul) 기준으로 시스템 프롬프트에 주입한다.
 *
 * Why: LLM 은 자체 시계가 없어, 대화 컨텍스트에 등장한 시간 표현
 * (예: "한국 시간으로 2시 10분이야!") 을 *지금 시각* 으로 환각하는 경향이 있다.
 * 매 호출마다 *진짜* 현재 시각을 단정해 줘야 시간/날짜 답이 정확해진다.
 *
 * 예: 사용자가 시간 표현을 컨텍스트에 흘리면 Muel 이 그 값을 자기 시간으로
 * 차용하던 문제 (2026-05-25 보고).
 */
const formatCurrentTime = (): string => {
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

export type MentionedUserContext = {
  name: string;
  summary: UserHistorySummary | null;
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

const saveGeneratedReply = async (
  supabase: SupabaseClient,
  chatId: string,
  finalText: string,
  provider: MuelAgentResult['provider'],
  modelName: string,
  options?: { enqueueMemory?: boolean },
): Promise<void> => {
  const assistantMessageId = crypto.randomUUID();
  await saveAssistantMessage(
    supabase,
    chatId,
    assistantMessageId,
    [{ type: 'text', text: finalText }],
    { role: 'assistant', provider, model: modelName },
  ).catch((err) => {
    console.error('[muel] failed to save generated message', err);
  });

  if ((options?.enqueueMemory ?? true) && finalText.length > 50) {
    void enqueueMemoryExtractionJob(supabase, {
      chatId,
      messageId: assistantMessageId,
      source: 'system',
      createdAt: new Date().toISOString(),
    });
  }
};

type GenerateTextUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
};

const normalizeUsage = (usage: GenerateTextUsage | undefined | null) => {
  if (!usage) {
    return { inputTokens: null as number | null, outputTokens: null as number | null, totalTokens: null as number | null };
  }
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? null;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? null;
  const totalTokens = usage.totalTokens ?? (
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  );
  return { inputTokens, outputTokens, totalTokens };
};

export const generateMuelReply = async (
  supabase: SupabaseClient,
  chatId: string,
  userText: string,
  authorName: string,
  history: UIMessage[],
  guildId: string | null,
  relevantUserIds: string[],
  channelActivity?: string,
  userHistory?: UserHistorySummary | null,
  mentionedUsers?: MentionedUserContext[],
  guildTopology?: string,
  sourceUserId?: string,
  currentChannelId: string | null = null,
): Promise<MuelAgentResult> => {
  const localFallback = getLocalFallbackReply(userText);
  const preflightGuard = getPreflightGuard(userText);
  if (preflightGuard) {
    await saveGeneratedReply(supabase, chatId, preflightGuard.reply, 'none', `policy:${preflightGuard.reason}`, {
      enqueueMemory: false,
    });
    return {
      text: preflightGuard.reply,
      model: `policy:${preflightGuard.reason}`,
      provider: 'none',
      metadata: {
        taskType: 'chat',
        modelLane: CHAT_MODEL_TASK,
        fallbackReason: preflightGuard.reason,
      },
    };
  }

  if (!config.googleGenerativeAiApiKey && !config.nvidiaApiKey) {
    return {
      text: localFallback ?? 'AI 응답 엔진이 아직 연결되지 않았어. GEMINI_API_KEY 또는 NVIDIA_API_KEY를 설정해야 해.',
      model: localFallback ? 'local-fallback' : 'not-configured',
      provider: 'none',
      metadata: {
        taskType: 'chat',
        modelLane: CHAT_MODEL_TASK,
        fallbackReason: localFallback ? 'local-fallback' : 'not-configured',
      },
    };
  }

  const lightweightTurn = isLightweightTurn(userText);
  const systemParts = [BASE_SYSTEM_PROMPT, formatCurrentTime(), formatCapabilityRegistryForPrompt()];
  if (guildTopology) systemParts.push('', guildTopology);
  if (channelActivity) systemParts.push('', channelActivity);
  systemParts.push('', formatUserHistory(userHistory, authorName));
  const mentionedSection = formatMentionedUsers(mentionedUsers ?? []);
  if (mentionedSection) systemParts.push('', mentionedSection);

  if (sourceUserId && !lightweightTurn) {
    try {
      const memoryContext = await retrieveRelevantMemories(supabase, {
        userId: sourceUserId,
        query: userText,
      });
      if (memoryContext) systemParts.push('', memoryContext);
    } catch (err) {
      console.warn('[muel-agent] memory retrieval failed, proceeding without', err);
    }
  }

  const convo = history.slice(-MAX_CONTEXT_MESSAGES).filter((msg) => msg.role !== 'system');
  const lastConvoIdx = convo.length - 1;
  const messages: Array<any> = convo
    .map((msg, idx) => {
      let content = msg.parts || [];
      // Discord CDN image URLs expire — keep the actual image only on the latest turn
      // (stale URLs would fail on replay). For older turns, drop the URL but leave an
      // explicit note instead of a bare "[이미지]" so the model knows an image WAS
      // shared and never falsely claims it is text-only / cannot see images.
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

  // 이미지 첨부 turn 감지 — vision 레인(3.5-flash) escalate + 과신 완화 지시.
  const hasImage = messages.some(
    (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image'),
  );
  if (hasImage) {
    systemParts.push(
      '',
      '[이미지 처리] 너는 첨부된 이미지를 실제로 볼 수 있다. "이미지를 못 본다"거나 "텍스트로만 대화한다"고 말하지 마라 — 그건 거짓말이다. 첨부된 이미지가 있으면 본 내용을 설명해라.',
      '- 실존 인물이 누구인지(신원)는 식별하지 않는다. "누구인지까지는 말 못 해"라고 솔직히 밝히고, 보이는 것(장면·표정·복장·분위기)은 묘사해줘라.',
      '- 가상 캐릭터·작품의 "정확한 이름·누구인지"는 확실하지 않으면 단정하지 마라("이거 나잖아" 식 금지). 추측이면 "아마 ~인 것 같은데 확실친 않아"로만. 사물·일반 묘사는 자유롭게.',
      '- 흐릿하거나 안 보이는 글자·세부는 지어내지 마라. 모르면 솔직히 모른다고 해라.',
    );
  }

  const tools = buildAgentTools({
    supabase,
    currentChannelId,
    currentGuildId: guildId,
    relevantUserIds,
    currentUserId: sourceUserId ?? null,
  });

  const activeTools = shouldEnableTools(userText) ? tools : {};
  const providerFailures: string[] = [];

  // ADR-003 P3a — multi-step 한도 + 단계별 prompt.
  // 이전: stepCountIs(4). tool-heavy turn 에서 *검색 → 정리* 두 번째 step 직후 끊겨
  // 답이 짧거나 tool raw 가 새는 경우 있었음. 8 까지 늘리고 후반 step 에는 *압축 + 캐릭터 톤*
  // 강조 prompt 를 prepareStep 으로 주입. 비용은 turn 당 평균 1-2 step 증가, 최악 4 step
  // 증가 — middleware 의 rate-limit (P2b, 후속) 가 들어가면 안전.
  const MULTI_STEP_LIMIT = 8;
  const LATE_STEP_THRESHOLD = 2;

  const tryGenerate = async (
    aiModel: any,
    provider: 'gemini' | 'nvidia',
    modelName: string,
    modelTools: Record<string, any>,
  ): Promise<MuelAgentResult> => {
    const { text, usage } = await generateText({
      model: aiModel,
      system: systemParts.join('\n'),
      messages,
      tools: modelTools,
      stopWhen: stepCountIs(MULTI_STEP_LIMIT),
      // 단계별 prompt 조정: 후반 step (tool 결과 정리 시) 에 *압축 + 보고서 톤 금지* 강조.
      // @ts-ignore AI SDK v6 prepareStep typing 이 일부 모델 wrapper 와 안 맞아 정성적 cast.
      prepareStep: async ({ stepNumber }: { stepNumber: number }) => {
        if (stepNumber < LATE_STEP_THRESHOLD) return undefined;
        return {
          system: [
            systemParts.join('\n'),
            '',
            '--- LATE STEP (압축) ---',
            '도구 호출이 충분히 됐으면 더 부르지 말고 답을 마무리해라.',
            '결과를 너의 말로 1-3 문장 한국어 반말로 압축. heading/bullet/보고서 마커 절대 금지.',
            '도구 raw 텍스트를 그대로 옮기지 말고 캐릭터의 한 마디로 바꿔라.',
          ].join('\n'),
        };
      },
      temperature: 0.7,
      maxOutputTokens: 2048,
    });

    const finalText = sanitizeModelOutput(text);
    if (!finalText) {
      throw new Error(`${provider} returned an empty or unsafe response`);
    }

    const tokens = normalizeUsage(usage as GenerateTextUsage | undefined);

    await saveGeneratedReply(supabase, chatId, finalText, provider, modelName);
    return {
      text: finalText,
      model: modelName,
      provider,
      metadata: {
        taskType: 'chat',
        modelLane: CHAT_MODEL_TASK,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        totalTokens: tokens.totalTokens,
      },
    };
  };

  // 1. Primary: single-shot Gemini on the chat lane.
  if (config.googleGenerativeAiApiKey) {
    // Casual/lightweight turns stay on the cheap lane; substantive turns get
    // the stronger reasoning model.
    const chatLane: MuelModelTask = hasImage
      ? 'vision'
      : lightweightTurn
        ? CHAT_MODEL_TASK
        : 'heavy';
    const gemini = getLaneModel(chatLane);
    if (gemini) {
      try {
        // Web search (Google grounding) is always attached so the model can answer
        // current-events / news / general-knowledge questions instead of refusing.
        // DB tools stay gated behind shouldEnableTools for cost.
        const agentTools: Record<string, any> = shouldEnableTools(userText) ? { ...tools } : {};
        // Google grounding 은 Gemini 전용 — NVIDIA 레인엔 안 붙인다.
        if (gemini.provider === 'gemini') {
          const googleSearch = getGoogleSearchTool();
          if (googleSearch) {
            agentTools.googleSearch = googleSearch;
          }
        }
        const result = await tryGenerate(
          gemini.model,
          gemini.provider,
          gemini.modelId,
          agentTools,
        );
        return result;
      } catch (error) {
        const reason = describeError(error);
        providerFailures.push(`gemini:${gemini.modelId}:${reason}`);
        console.warn('[muel-agent] Gemini failed, escalating to fallback:', gemini.modelId, reason);
      }
    } else {
      providerFailures.push('gemini:provider-unavailable');
    }
  } else {
    providerFailures.push('gemini:not-configured');
  }

  // 2. Fallback: NVIDIA single attempt. Verification deferred (key currently inactive).
  if (config.nvidiaApiKey) {
    const fallback = getFallbackTextModel(CHAT_MODEL_TASK);
    if (fallback) {
      try {
        const result = await tryGenerate(fallback.model, fallback.provider, fallback.modelId, activeTools);
        result.metadata = {
          ...result.metadata,
          fallbackReason: providerFailures.join(' | '),
        };
        return result;
      } catch (error) {
        const reason = describeError(error);
        providerFailures.push(`nvidia:${config.nvidiaModel}:${reason}`);
        console.warn('[muel-agent] NVIDIA NIM failed:', reason);
      }
    }
  } else {
    providerFailures.push('nvidia:not-configured');
  }

  console.error('[muel-agent] all providers failed', {
    event: 'llm_all_failed',
    chatId,
    providers: providerFailures,
  });

  if (localFallback) {
    return {
      text: localFallback,
      model: 'local-fallback',
      provider: 'none',
      metadata: {
        taskType: 'chat',
        modelLane: CHAT_MODEL_TASK,
        fallbackReason: providerFailures.join(' | '),
      },
    };
  }

  throw new Error(`LLM All Failed: ${providerFailures.join(', ')}`);
};

export const toDiscordReply = (text: string): string => {
  const sanitized = sanitizeModelOutput(text) || '응답을 정리하는 중 문제가 생겼어. 다시 짧게 물어봐줘.';
  if (sanitized.length <= 1900) return sanitized;
  const head = sanitized.slice(0, 1890);
  const marks = ['. ', '? ', '! ', '。'];
  let cut = -1;
  for (const m of marks) cut = Math.max(cut, head.lastIndexOf(m));
  const body = cut > 1500 ? head.slice(0, cut + 1).trimEnd() : head.trimEnd();
  return `${body}\n\n(메시지가 길어 일부만 표시했어.)`;
};
