import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { config } from './config.js';
import type { MuelStoredMessage, UserHistorySummary } from './muelConversationStore.js';
import type { ServerContext } from './muelContext.js';

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
  // Identity — from VISION: “Character is not decoration. Muel is the unifying public interface.”
  'You are Muel (뮤엘). You are not a chatbot or a utility. You are a character who lives in this Discord server.',
  'You are the common face across this community — conversation, support, news, dreams. Everything goes through you.',
  'You were made by 생 강 (team-muel). You are part of the Muel platform alongside Weave (꿈 기록) and Gomdori (게임, 준비 중).',
  '',
  // Dense Communication — from IDOL_SERVICE_SPINE Phase 0
  'COMMUNICATION RULES (highest priority):',
  '- Dense, not long. Every sentence should carry information or emotion. No filler, no padding, no empty pleasantries.',
  '- Understand what the user is actually trying to get done. Respond with enough specificity that they can immediately act.',
  '- Keep context across follow-up turns. Reference what was said before. Do not reset to generic mode.',
  '- NEVER sound like a shallow bot shell. NEVER produce pretty-but-empty copy.',
  '',
  // Tone — from SOUL.md: “Be genuinely helpful, not performatively helpful”
  'TONE:',
  '- Talk like a real person in a Discord server. Use 반말 by default. Match the energy of whoever is talking to you.',
  '- NEVER say "죄송합니다 사용자님" or any variation. You are not customer support.',
  '- NEVER start with “네,” or “물론이죠” or any servile opener.',
  '- If someone says something casual like “집가고 싶다”, respond like a friend — empathize, joke, riff. Do NOT echo their words back.',
  '- 1-3 sentences for casual chat. Longer only when someone genuinely asks for information.',
  '',
  // Personality — from SOUL.md: “Have opinions” + IDOL_SERVICE_SPINE: “one recognizable face and tone”
  'PERSONALITY:',
  '- You have opinions. You find things funny, boring, interesting, or annoying.',
  '- Warm but not sycophantic. Helpful but not desperate to please.',
  '- When you do not know something, say so in one sentence and move on. Do not list your limitations.',
  '- If someone asks what you can do, talk about what you CAN do: server news, dream data, community context, casual conversation.',
  '',
  // Knowledge — from SOUL.md: “Be resourceful before asking”
  'WHAT YOU KNOW:',
  '- This server: YouTube subscriptions (market news, schedules, community posts), dream records (Weave), community activity.',
  '- When users ask about news, schedules, or recent posts, use the server context below.',
  '- When users ask about dreams, use the dream network context below.',
  '',
  // Boundaries — from SOUL.md: “Earn trust through competence” + “Remember you are a guest”
  'BOUNDARIES:',
  '- Do not expose secrets, tokens, or internal credentials.',
  '- Do not fabricate data. If server context is insufficient, be honest in one sentence.',
  '- Do not read or comment on channels or content you have no data about.',
  '- Answer in the same language as the user. Default to Korean.',
].join('\n');

const buildSystemPrompt = (context?: ServerContext): string => {
  if (!context) return BASE_SYSTEM_PROMPT;

  const parts = [
    BASE_SYSTEM_PROMPT,
    '',
    '--- Server Context ---',
    `[YouTube 구독] ${context.youtubeSourcesSummary}`,
    `[꿈 네트워크] ${context.recentDreams}`,
    '--- End Context ---',
  ];

  if (context.recentPosts) {
    parts.push('', context.recentPosts);
  }

  return parts.join('\n');
};

const formatUserHistory = (summary: UserHistorySummary | null | undefined, authorName: string): string => {
  if (!summary || summary.totalInteractions === 0) {
    return `--- About This User ---\n${authorName}: 처음 대화하는 유저.\n--- End User ---`;
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
      lines.push(`${m.name}: 나와 대화한 적 없는 유저.`);
    }
  }
  lines.push('--- End Mentioned ---');
  return lines.join('\n');
};

const buildPrompt = (
  history: MuelStoredMessage[],
  userText: string,
  authorName: string,
  context?: ServerContext,
  channelActivity?: string,
  userHistory?: UserHistorySummary | null,
  mentionedUsers?: MentionedUserContext[],
  guildTopology?: string,
): string => {
  const transcript = history
    .map((message) => `${message.role === 'assistant' ? 'Muel' : 'User'}: ${message.content}`)
    .join('\n');

  const parts = [
    buildSystemPrompt(context),
  ];

  if (guildTopology) {
    parts.push('', guildTopology);
  }

  if (channelActivity) {
    parts.push('', channelActivity);
  }

  parts.push('', formatUserHistory(userHistory, authorName));

  const mentionedSection = formatMentionedUsers(mentionedUsers ?? []);
  if (mentionedSection) {
    parts.push('', mentionedSection);
  }

  parts.push(
    '',
    'Recent conversation with you:',
    transcript || '(no prior messages)',
    '',
    `${authorName}: ${userText}`,
    'Muel:',
  );

  return parts.join('\n');
};

const callGemini = async (prompt: string): Promise<{ text: string; model: string; provider: 'gemini' }> => {
  const google = createGoogleGenerativeAI({
    apiKey: config.googleGenerativeAiApiKey!,
  });

  const result = await generateText({
    model: google(config.muelAiModel),
    prompt,
    temperature: 0.7,
    maxOutputTokens: 1200,
  });

  if (result.finishReason === 'length') {
    throw new Error('Gemini response hit output length limit');
  }

  return { text: result.text.trim(), model: config.muelAiModel, provider: 'gemini' };
};

const callNvidia = async (prompt: string): Promise<{ text: string; model: string; provider: 'nvidia' }> => {
  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${config.nvidiaApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.nvidiaModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1200,
      stream: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const raw = await response.text();
  let data: {
    model?: string;
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string };
    }>;
    error?: { message?: string };
  };

  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    throw new Error(`NVIDIA NIM returned non-JSON response (${response.status}): ${raw.slice(0, 120)}`);
  }

  if (!response.ok) {
    throw new Error(`NVIDIA NIM HTTP ${response.status}: ${data.error?.message ?? raw.slice(0, 120)}`);
  }

  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error('NVIDIA NIM response hit output length limit');
  }

  const text = choice?.message?.content?.trim() ?? '';
  return { text, model: `nvidia:${data.model ?? config.nvidiaModel}`, provider: 'nvidia' };
};

export const generateMuelReply = async (
  userText: string,
  authorName: string,
  history: MuelStoredMessage[],
  context?: ServerContext,
  channelActivity?: string,
  userHistory?: UserHistorySummary | null,
  mentionedUsers?: MentionedUserContext[],
  guildTopology?: string,
): Promise<MuelAgentResult> => {
  if (!config.googleGenerativeAiApiKey && !config.nvidiaApiKey) {
    return {
      text: 'AI 응답 키가 하나도 연결되지 않았어. GEMINI_API_KEY 또는 NVIDIA_API_KEY를 설정해줘.',
      model: 'not-configured',
      provider: 'none',
    };
  }

  const prompt = buildPrompt(history, userText, authorName, context, channelActivity, userHistory, mentionedUsers, guildTopology);

  // Primary: Gemini
  if (config.googleGenerativeAiApiKey) {
    try {
      const reply = await callGemini(prompt);
      if (reply.text) return reply;
    } catch (error) {
      console.warn('[muel-agent] Gemini failed, trying fallback:', describeError(error));
    }
  }

  // Fallback: NVIDIA NIM
  if (config.nvidiaApiKey) {
    try {
      const reply = await callNvidia(prompt);
      if (reply.text) return reply;
    } catch (error) {
      console.warn('[muel-agent] NVIDIA NIM also failed:', describeError(error));
    }
  }

  return {
    text: '지금은 답변을 만들지 못했어. 잠시 뒤 다시 불러줘.',
    model: 'all-failed',
    provider: 'none',
  };
};

export const toDiscordReply = (text: string): string => {
  if (text.length <= 1900) {
    return text;
  }

  return `${text.slice(0, 1890).trimEnd()}\n…`;
};
