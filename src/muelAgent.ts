import { generateText, stepCountIs } from 'ai';
import { config } from './config.js';
import { enqueueMemoryExtractionJob } from './muelJobs.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserHistorySummary, UIMessage } from './muelConversationStore.js';
import { saveAssistantMessage } from './muelConversationStore.js';
import { getPreflightGuard } from './capabilities.js';
import { sanitizeModelOutput } from './responseSanitizer.js';
import { splitForDiscord } from './rendering/discordText.js';
import { DISCORD_LIMITS } from './rendering/discordLimits.js';
import {
  getFallbackTextModel,
  getGeminiTextModel,
  getGoogleSearchTool,
  getLaneModel,
  type MuelModelTask,
} from './modelRegistry.js';
import { buildAgentTools } from './agentTools.js';
import {
  buildMuelContextWindow,
  type MentionedUserContext,
} from './muelContextWindow.js';

export type MuelAgentResult = {
  text: string;
  model: string;
  provider: 'gemini' | 'nvidia' | 'mindlogic' | 'none';
  metadata?: Record<string, unknown>;
};

const CHAT_MODEL_TASK: MuelModelTask = 'chat';

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
  '',
  'WHO IS BEING TALKED ABOUT (중요):',
  '- 채널 로그의 "이름: 내용" 에서 앞의 이름은 *그 말을 한 사람* 일 뿐이다. 그 줄이 딴 사람 이름이나 "너/니/걔" 를 말하면, 화제의 대상은 말한 사람이 아니다. 화자와 화제를 헷갈리지 마라.',
  '- 대상이 누구인지 확실하지 않으면 이름·핸들을 붙이지 마라. 남의 핸들에 근거 없이 상태·계획 ("○○이 군대 간다" 같은) 을 부여하지 마라.',
  '- 사람들끼리 주고받는 말 (특히 농담·놀림) 을 너에게 온 사실 질문처럼 받지 마라. "○○한테 직접 물어봐 / 그 정보는 없어" 식 반사 응답 금지 — 확실치 않으면 끼어들지 말고, 낄 거면 같은 톤으로 가볍게.',
].join('\n');

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

  const contextWindow = await buildMuelContextWindow({
    supabase,
    baseSystemPrompt: BASE_SYSTEM_PROMPT,
    userText,
    authorName,
    history,
    channelActivity,
    userHistory,
    mentionedUsers,
    guildTopology,
    sourceUserId,
  });
  const {
    system,
    messages,
    hasImage,
    lightweightTurn,
    toolsEnabled,
    diagnostics: contextDiagnostics,
  } = contextWindow;

  const tools = buildAgentTools({
    supabase,
    currentChannelId,
    currentGuildId: guildId,
    relevantUserIds,
    currentUserId: sourceUserId ?? null,
  });

  const activeTools = toolsEnabled ? tools : {};
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
    provider: 'gemini' | 'nvidia' | 'mindlogic',
    modelName: string,
    modelTools: Record<string, any>,
  ): Promise<MuelAgentResult> => {
    const { text, usage } = await generateText({
      model: aiModel,
      maxRetries: 1,
      system,
      messages,
      tools: modelTools,
      stopWhen: stepCountIs(MULTI_STEP_LIMIT),
      // 단계별 prompt 조정: 후반 step (tool 결과 정리 시) 에 *압축 + 보고서 톤 금지* 강조.
      // @ts-ignore AI SDK v6 prepareStep typing 이 일부 모델 wrapper 와 안 맞아 정성적 cast.
      prepareStep: async ({ stepNumber }: { stepNumber: number }) => {
        if (stepNumber < LATE_STEP_THRESHOLD) return undefined;
        return {
          system: [
            system,
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
        contextWindow: contextDiagnostics,
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
        const agentTools: Record<string, any> = toolsEnabled ? { ...tools } : {};
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

/**
 * Split a model reply into Discord-sendable chunks. Unlike the old truncating
 * variant, this DROPS NOTHING and never cuts inside a URL — long replies are
 * carried across multiple messages / a thread by the caller. Always returns at
 * least one chunk.
 */
export const toDiscordReplyChunks = (text: string): string[] => {
  const sanitized = sanitizeModelOutput(text) || '응답을 정리하는 중 문제가 생겼어. 다시 짧게 물어봐줘.';
  const chunks = splitForDiscord(sanitized, DISCORD_LIMITS.content);
  return chunks.length > 0 ? chunks : [sanitized];
};

/** Back-compat single-string reply (first chunk only). Prefer the chunked API. */
export const toDiscordReply = (text: string): string => toDiscordReplyChunks(text)[0]!;
