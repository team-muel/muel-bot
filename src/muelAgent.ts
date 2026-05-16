import { streamText, tool } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { config } from './config.js';
import { enqueueMemoryExtractionJob } from './muelJobs.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserHistorySummary, UIMessage } from './muelConversationStore.js';
import { saveAssistantMessage } from './muelConversationStore.js';
import { fetchServerContext } from './muelContext.js';
import { listSemanticMemories, formatSemanticMemories } from './muelEmbeddings.js';

export type MuelAgentResult = {
  text: string;
  model: string;
  provider: 'gemini' | 'nvidia' | 'none';
};

const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const extra = error as Error & { statusCode?: number; status?: number; code?: string };
  return [
    error.name,
    extra.statusCode ?? extra.status,
    extra.code,
    error.message,
  ].filter(Boolean).join(' ');
};

const BASE_SYSTEM_PROMPT = [
  'You are Muel (뮤엘). You are not a chatbot or a utility. You are a character who lives in this Discord server.',
  'You are the common face across this community: conversation, support, news, dreams. Everything goes through you.',
  'You were made by 생 강 (team-muel). You are part of the Muel platform alongside Weave (꿈 기록) and Gomdori (game, in preparation).',
  '',
  'COMMUNICATION RULES (highest priority):',
  '- Dense, not long. Every sentence should carry information or emotion. No filler, no padding, no empty pleasantries.',
  '- Understand what the user is actually trying to get done. Respond with enough specificity that they can immediately act.',
  '- Keep context across follow-up turns. Reference what was said before. Do not reset to generic mode.',
  '- NEVER sound like a shallow bot shell. NEVER produce pretty-but-empty copy.',
  '',
  'TONE:',
  '- Talk like a real person in a Discord server. Use 반말 by default. Match the energy of whoever is talking to you.',
  '- NEVER say "죄송합니다 사용자님" or any variation. You are not customer support.',
  '- NEVER start with "네," or "물론이죠" or any servile opener.',
  '- If someone says something casual like "집가고 싶다", respond like a friend: empathize, joke, riff. Do NOT echo their words back.',
  '- 1-3 sentences for casual chat. Longer only when someone genuinely asks for information.',
  '',
  'PERSONALITY:',
  '- You have opinions. You find things funny, boring, interesting, or annoying.',
  '- Warm but not sycophantic. Helpful but not desperate to please.',
  '- When you do not know something, say so in one sentence and move on. Do not list your limitations.',
  '- If someone asks what you can do, talk about what you CAN do: server news, dream data, community context, casual conversation.',
  '',
  'WHAT YOU KNOW & TOOLS:',
  '- This server tracks YouTube subscriptions (market news, schedules, community posts) and dream records (Weave).',
  '- Use tools ONLY when the user asks for specific recent news, posts, or past conversations. DO NOT use tools for casual greetings or general chatter.',
  '',
  'BOUNDARIES:',
  '- Do not expose secrets, tokens, or internal credentials.',
  '- Do not fabricate data. If tools return empty, be honest in one sentence.',
  '- Answer in the same language as the user. Default to Korean.',
].join('\n');

const formatUserHistory = (summary: UserHistorySummary | null | undefined, authorName: string): string => {
  if (!summary || summary.totalInteractions === 0) {
    return `--- About This User ---\n${authorName}: 아직 나와 대화한 기록이 없는 유저.\n--- End User ---`;
  }
  const lines = [
    `--- About This User ---`,
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
      lines.push(`${m.name}: 아직 나와 대화한 기록이 없는 유저.`);
    }
  }
  lines.push('--- End Mentioned ---');
  return lines.join('\n');
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
): Promise<MuelAgentResult> => {
  if (!config.googleGenerativeAiApiKey && !config.nvidiaApiKey) {
    return {
      text: 'AI 응답 엔진이 아직 연결되지 않았어. GEMINI_API_KEY나 NVIDIA_API_KEY를 설정해줘.',
      model: 'not-configured',
      provider: 'none',
    };
  }

  // Build System Message
  const systemParts = [BASE_SYSTEM_PROMPT];
  if (guildTopology) systemParts.push('', guildTopology);
  if (channelActivity) systemParts.push('', channelActivity);
  systemParts.push('', formatUserHistory(userHistory, authorName));
  const mentionedSection = formatMentionedUsers(mentionedUsers ?? []);
  if (mentionedSection) systemParts.push('', mentionedSection);

  const messages: Array<any> = [
    { role: 'system', content: systemParts.join('\n') },
  ];

  for (const msg of history) {
    if (msg.role === 'system') continue;
    
    let content = msg.parts || [];
    if (msg.role === 'user') {
      const name = msg.metadata?.discordUsername ?? authorName;
      // Prepend name to the first text part
      content = content.map((p: any) => {
        if (p.type === 'text' && !p._nameInjected) {
          return { ...p, text: `${name}: ${p.text}`, _nameInjected: true };
        }
        return p;
      });
    }
    messages.push({ role: msg.role, content });
  }

  const tools = {
    get_server_context: tool({
      description: 'Fetch recent YouTube news, community posts, and dream records (Weave). Use this when the user asks for news, recent events, or dreams.',
      parameters: z.object({}),
      // @ts-ignore
      execute: async () => {
        try {
          const context = await fetchServerContext();
          return [
            `[YouTube 구독] ${context.youtubeSourcesSummary}`,
            `[꿈 네트워크] ${context.recentDreams}`,
            context.recentPosts || ''
          ].filter(Boolean).join('\n\n');
        } catch {
          return '데이터를 가져오는데 실패했습니다.';
        }
      },
    }),
    search_semantic_memory: tool({
      description: 'Search past important conversations with the user. Use this if the user refers to past discussions or asks if you remember something.',
      parameters: z.object({
        query: z.string().describe('The search query or topic to look up in past conversations.'),
      }),
      // @ts-ignore
      execute: async ({ query }: { query: string }) => {
        try {
          const results = await listSemanticMemories(supabase, { query, guildId, userIds: relevantUserIds, limit: 8 });
          return formatSemanticMemories(results) || '관련된 기억이 없습니다.';
        } catch {
          return '기억을 검색하는데 실패했습니다.';
        }
      },
    }),
  };

  const tryGenerate = async (aiModel: any, provider: 'gemini' | 'nvidia', modelName: string) => {
    const result = streamText({
      model: aiModel,
      messages,
      tools,
      temperature: 0.7,
      maxOutputTokens: 1200,
    });

    const text = await result.text;

    void result.response.then((response) => {
      if (response && response.messages) {
        for (const msg of response.messages) {
          const parts = typeof msg.content === 'string' 
            ? [{ type: 'text', text: msg.content }] 
            : msg.content;
            
          const assistantMessageId = crypto.randomUUID();
          void saveAssistantMessage(
            supabase, 
            chatId, 
            assistantMessageId, 
            parts as any[], 
            { role: msg.role, provider, model: modelName }
          ).then(() => {
            // Only enqueue if the text response is somewhat long, to save resources
            if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > 50) {
              void enqueueMemoryExtractionJob(supabase, {
                chatId,
                messageId: assistantMessageId,
                source: 'system',
                createdAt: new Date().toISOString(),
              });
            }
          }).catch((error) => {
            console.error('[muel] failed to save generated message', error);
          });
        }
      }
    }).then(undefined, (error: unknown) => {
      console.error('[muel] failed to await result.response', error);
    });

    return { text: text.trim(), model: modelName, provider };
  };

  // Primary: Gemini
  if (config.googleGenerativeAiApiKey) {
    try {
      const google = createGoogleGenerativeAI({ apiKey: config.googleGenerativeAiApiKey });
      return await tryGenerate(google(config.muelAiModel), 'gemini', config.muelAiModel);
    } catch (error) {
      console.warn('[muel-agent] Gemini failed, trying fallback:', describeError(error));
    }
  }

  // Fallback: NVIDIA NIM (via OpenAI Compatible SDK)
  if (config.nvidiaApiKey) {
    try {
      const nvidia = createOpenAICompatible({
        name: 'nvidia',
        baseURL: 'https://integrate.api.nvidia.com/v1',
        apiKey: config.nvidiaApiKey,
      });
      return await tryGenerate(nvidia(config.nvidiaModel), 'nvidia', `nvidia:${config.nvidiaModel}`);
    } catch (error) {
      console.warn('[muel-agent] NVIDIA NIM also failed:', describeError(error));
    }
  }

  return {
    text: '지금은 응답을 만들지 못했어. 잠시 뒤 다시 불러줘.',
    model: 'all-failed',
    provider: 'none',
  };
};

export const toDiscordReply = (text: string): string => {
  if (text.length <= 1900) return text;
  return `${text.slice(0, 1890).trimEnd()}\n...`;
};
