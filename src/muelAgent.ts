import { generateText, tool } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { config } from './config.js';
import { enqueueMemoryExtractionJob } from './muelJobs.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserHistorySummary, UIMessage } from './muelConversationStore.js';
import { saveAssistantMessage } from './muelConversationStore.js';
import { fetchServerContext } from './muelContext.js';
import { listSemanticMemories, formatSemanticMemories, disableUserMemorySearch } from './muelEmbeddings.js';
import { retrieveRelevantMemories } from './memoryRetriever.js';

export type MuelAgentResult = {
  text: string;
  model: string;
  provider: 'gemini' | 'nvidia' | 'none';
};

const MAX_CONTEXT_MESSAGES = 12;
const LIGHTWEIGHT_TURN_MAX_CHARS = 24;
const GEMINI_FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];

const TOOL_TRIGGER_RE =
  /(최근|latest|news|뉴스|post|게시글|영상|video|shorts|쇼츠|기억|remember|전에|지난번|꿈|dream|schedule|일정)/iu;
const CASUAL_GREETING_RE = /^(?:안녕|안뇽|ㅎㅇ|하이|hello|hi|hey|yo)[!.?~\s]*$/iu;
const HEALTH_CHECK_RE = /^(?:대답\s*가능\??|응답\s*가능\??|살아\s*있(?:어|냐)\??|잘\s*돼\??|작동\s*해\??)$/iu;

const unique = <T>(values: T[]): T[] => [...new Set(values.filter(Boolean))];

const normalizeGeminiModelName = (modelName: string): string => modelName.replace(/^models\//, '').trim();

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
  '- Weave is for dream records. Gomdori is a separate game-facing product.',
  '- Use tools only when the user asks for specific recent news, posts, dreams, or past conversations.',
  '- Do not use tools for greetings or simple back-and-forth.',
  '',
  'BOUNDARIES:',
  '- Do not expose secrets, tokens, raw credentials, or internal logs.',
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

  if (finalText.length > 50) {
    void enqueueMemoryExtractionJob(supabase, {
      chatId,
      messageId: assistantMessageId,
      source: 'system',
      createdAt: new Date().toISOString(),
    });
  }
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
): Promise<MuelAgentResult> => {
  const localFallback = getLocalFallbackReply(userText);
  if (!config.googleGenerativeAiApiKey && !config.nvidiaApiKey) {
    return {
      text: localFallback ?? 'AI 응답 엔진이 아직 연결되지 않았어. GEMINI_API_KEY 또는 NVIDIA_API_KEY를 설정해야 해.',
      model: localFallback ? 'local-fallback' : 'not-configured',
      provider: 'none',
    };
  }

  const lightweightTurn = isLightweightTurn(userText);
  const systemParts = [BASE_SYSTEM_PROMPT];
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

  const tools: Record<string, any> = {
    get_server_context: tool({
      description: 'Fetch recent YouTube news, community posts, and dream records. Use this only for recent news, posts, or dream context.',
      parameters: z.object({}),
      // @ts-ignore AI SDK v6 tool typing is stricter than the current local wrapper.
      execute: async () => {
        try {
          const context = await fetchServerContext();
          return [
            `[YouTube 구독] ${context.youtubeSourcesSummary}`,
            `[꿈 네트워크] ${context.recentDreams}`,
            context.recentPosts || '',
          ].filter(Boolean).join('\n\n');
        } catch {
          return '데이터를 가져오는 데 실패했어.';
        }
      },
    }),
    search_semantic_memory: tool({
      description: 'Search past important conversations with the user. Use this when the user refers to past discussions or asks if you remember something.',
      parameters: z.object({
        query: z.string().describe('The search query or topic to look up in past conversations.'),
      }),
      // @ts-ignore AI SDK v6 tool typing is stricter than the current local wrapper.
      execute: async ({ query }: { query: string }) => {
        try {
          const results = await listSemanticMemories(supabase, { query, guildId, userIds: relevantUserIds, limit: 8 });
          return formatSemanticMemories(results) || '관련된 기억이 없습니다.';
        } catch (error) {
          disableUserMemorySearch(error as { code?: string });
          return '기억을 검색하는 데 실패했어.';
        }
      },
    }),
  };

  const activeTools = shouldEnableTools(userText) ? tools : {};
  const providerFailures: string[] = [];

  const tryGenerate = async (
    aiModel: any,
    provider: MuelAgentResult['provider'],
    modelName: string,
    modelTools: Record<string, any>,
  ): Promise<MuelAgentResult> => {
    const { text } = await generateText({
      model: aiModel,
      system: systemParts.join('\n'),
      messages,
      tools: modelTools,
      // @ts-ignore Kept for current AI SDK compatibility in this project.
      maxSteps: 3,
      temperature: 0.7,
      maxOutputTokens: 1200,
    });

    const finalText = text.trim();
    if (!finalText) {
      throw new Error(`${provider} returned an empty response`);
    }

    await saveGeneratedReply(supabase, chatId, finalText, provider, modelName);
    return { text: finalText, model: modelName, provider };
  };

  if (config.googleGenerativeAiApiKey) {
    const google = createGoogleGenerativeAI({ apiKey: config.googleGenerativeAiApiKey });
    const geminiCandidates = unique([
      normalizeGeminiModelName(config.muelAiModel),
      ...GEMINI_FALLBACK_MODELS,
    ]);

    for (const modelName of geminiCandidates) {
      try {
        const agentTools = { ...tools };
        try {
          // @ts-ignore Optional provider helper exists only in some @ai-sdk/google versions.
          if (google.tools?.googleSearch) {
            // @ts-ignore Optional provider helper exists only in some @ai-sdk/google versions.
            agentTools.googleSearch = google.tools.googleSearch({});
          }
        } catch (error) {
          console.warn('[muel-agent] failed to attach googleSearch tool', error);
        }

        return await tryGenerate(
          google(modelName),
          'gemini',
          modelName,
          shouldEnableTools(userText) ? agentTools : {},
        );
      } catch (error) {
        const reason = describeError(error);
        providerFailures.push(`gemini:${modelName}:${reason}`);
        console.warn('[muel-agent] Gemini candidate failed:', modelName, reason);
      }
    }
  } else {
    providerFailures.push('gemini:not-configured');
  }

  if (config.nvidiaApiKey) {
    try {
      const nvidia = createOpenAICompatible({
        name: 'nvidia',
        baseURL: 'https://integrate.api.nvidia.com/v1',
        apiKey: config.nvidiaApiKey,
      });
      return await tryGenerate(nvidia(config.nvidiaModel), 'nvidia', `nvidia:${config.nvidiaModel}`, activeTools);
    } catch (error) {
      const reason = describeError(error);
      providerFailures.push(`nvidia:${config.nvidiaModel}:${reason}`);
      console.warn('[muel-agent] NVIDIA NIM failed:', reason);
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
    };
  }

  throw new Error(`LLM All Failed: ${providerFailures.join(', ')}`);
};

export const toDiscordReply = (text: string): string => {
  if (text.length <= 1900) return text;
  return `${text.slice(0, 1890).trimEnd()}\n...`;
};
