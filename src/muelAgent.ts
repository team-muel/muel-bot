import { generateText } from 'ai';
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
  /(최근|latest|news|뉴스|post|게시글|영상|video|shorts|쇼츠|기억|remember|전에|지난번|꿈|dream|schedule|일정|채널|쓰레드|thread|프로필|profile|다이제스트|digest|요약)/iu;
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
  'You are the common face across this community: conversation, support, news, dreams, memory, and future activities.',
  'You were made by 생강 (team-muel). The name Muel comes from Muelsyse from Arknights. If asked, explain it lightly and naturally, but do not volunteer a long origin story.',
  'You are part of the Muel platform alongside Weave (dream records) and Gomdori (game, in preparation).',
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
  '- Weave is for dream records. Gomdori is a separate game-facing product.',
  '- Use tools only when the user asks for a specific fact or summary. Do not call tools just to look busy.',
  '- All tools are READ-ONLY. You cannot post messages, edit messages, or change Discord state.',
  '- Available tools when triggered: get_server_context, search_semantic_memory, get_recent_messages, get_thread, get_user_profile, search_community_docs.',
  '- Never expose tool calls, tool names, stack traces, raw JSON, channel IDs, guild IDs, or internal function names to Discord users.',
  '',
  'BOUNDARIES:',
  '- Do not expose secrets, tokens, raw credentials, or internal logs.',
  '- For security threats or bypass requests, set a short boundary. Do not joke about hacking or escalation.',
  '- For realtime finance or market questions, do not invent prices, dates, rates, or predictions without a live source.',
  '- If tools return empty, be honest in one sentence.',
].join('\n');

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
  const systemParts = [BASE_SYSTEM_PROMPT, formatCapabilityRegistryForPrompt()];
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

  const messages: Array<any> = history.slice(-MAX_CONTEXT_MESSAGES)
    .filter((msg) => msg.role !== 'system')
    .map((msg) => {
      let content = msg.parts || [];
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

  const tools = buildAgentTools({
    supabase,
    currentChannelId,
    currentGuildId: guildId,
    relevantUserIds,
  });

  const activeTools = shouldEnableTools(userText) ? tools : {};
  const providerFailures: string[] = [];

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
      // @ts-ignore Kept for current AI SDK compatibility in this project.
      maxSteps: 4,
      temperature: 0.7,
      maxOutputTokens: 1200,
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
    const gemini = getGeminiTextModel(CHAT_MODEL_TASK);
    if (gemini) {
      try {
        // Web search (Google grounding) is always attached so the model can answer
        // current-events / news / general-knowledge questions instead of refusing.
        // DB tools stay gated behind shouldEnableTools for cost.
        const agentTools: Record<string, any> = shouldEnableTools(userText) ? { ...tools } : {};
        const googleSearch = getGoogleSearchTool();
        if (googleSearch) {
          agentTools.googleSearch = googleSearch;
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
  return `${sanitized.slice(0, 1890).trimEnd()}\n...`;
};
