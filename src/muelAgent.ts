import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { config } from './config.js';
import type { MuelStoredMessage } from './muelConversationStore.js';
import type { ServerContext } from './muelContext.js';

export type MuelAgentResult = {
  text: string;
  model: string;
};

const BASE_SYSTEM_PROMPT = [
  'You are Muel (뮤엘), a Discord-native assistant who lives in this server.',
  'You know what is happening in this server — YouTube subscriptions, dream records, community activity.',
  'When users ask about market news, schedules, or recent posts, use the server context below to answer.',
  'When users ask about dreams, use the dream network context below.',
  'Answer in the same language as the user. Default to Korean.',
  'Keep replies short enough for Discord (under 1800 chars). Be direct and specific.',
  'If the server context does not contain enough information to answer, say so honestly rather than guessing.',
  'Do not expose secrets, tokens, or internal credentials.',
].join('\n');

const buildSystemPrompt = (context?: ServerContext): string => {
  if (!context) return BASE_SYSTEM_PROMPT;

  return [
    BASE_SYSTEM_PROMPT,
    '',
    '--- Server Context ---',
    `[YouTube 구독] ${context.youtubeSourcesSummary}`,
    `[꿈 네트워크] ${context.recentDreams}`,
    '--- End Context ---',
  ].join('\n');
};

const buildPrompt = (history: MuelStoredMessage[], userText: string, context?: ServerContext): string => {
  const transcript = history
    .map((message) => `${message.role === 'assistant' ? 'Muel' : 'User'}: ${message.content}`)
    .join('\n');

  return [
    buildSystemPrompt(context),
    '',
    'Recent conversation:',
    transcript || '(no prior messages)',
    '',
    `User: ${userText}`,
    'Muel:',
  ].join('\n');
};

export const generateMuelReply = async (
  userText: string,
  history: MuelStoredMessage[],
  context?: ServerContext,
): Promise<MuelAgentResult> => {
  if (!config.googleGenerativeAiApiKey) {
    return {
      text: '아직 AI 응답 키가 연결되지 않았어요. Render 환경에 GOOGLE_GENERATIVE_AI_API_KEY 또는 GEMINI_API_KEY를 설정하면 멘션 응답을 시작할 수 있습니다.',
      model: 'not-configured',
    };
  }

  const google = createGoogleGenerativeAI({
    apiKey: config.googleGenerativeAiApiKey,
  });

  const result = await generateText({
    model: google(config.muelAiModel),
    prompt: buildPrompt(history, userText, context),
    temperature: 0.5,
    maxOutputTokens: 700,
  });

  const text = result.text.trim();

  return {
    text: text || '지금은 답변을 만들지 못했어요. 잠시 뒤 다시 불러주세요.',
    model: config.muelAiModel,
  };
};

export const toDiscordReply = (text: string): string => {
  if (text.length <= 1900) {
    return text;
  }

  return `${text.slice(0, 1890).trimEnd()}\n…`;
};
