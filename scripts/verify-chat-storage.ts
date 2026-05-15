import 'dotenv/config';
import { getSupabaseClient } from '../src/supabase.js';
import { prepareChatTurn, saveAssistantMessage } from '../src/muelConversationStore.js';
import { generateText, streamText, tool } from 'ai';
import { z } from 'zod';
import * as crypto from 'crypto';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { config } from '../src/config.js';

async function verify() {
  const supabase = getSupabaseClient();
  const testChannelId = 'test-channel-id-' + Date.now();
  const testMessageId = 'test-msg-' + Date.now();

  console.log('1. Verify prepareChatTurn ...');
  const res = await prepareChatTurn(supabase, {
    source: 'discord',
    sourceChannelId: testChannelId,
    sourceThreadId: testChannelId,
    userMessageId: testMessageId,
    userParts: [{ type: 'text', text: 'Hello Muel, test me' }],
    metadata: {
      discordGuildId: 'test-guild',
      discordChannelId: testChannelId,
      discordMessageId: testMessageId,
      discordUserId: 'test-user',
    }
  });

  if (!res.chatId) throw new Error('No chatId returned');
  if (res.messages.length !== 1) throw new Error(`Expected 1 message, got ${res.messages.length}`);
  
  const userMsg = res.messages[0];
  if (userMsg.id !== testMessageId) throw new Error('Message ID mismatch');
  if (userMsg.role !== 'user') throw new Error('Role mismatch');
  if (!Array.isArray(userMsg.parts) || userMsg.parts[0].text !== 'Hello Muel, test me') {
    throw new Error('Parts schema mismatch');
  }

  console.log('✔ prepareChatTurn passed.');

  // Test 2: AI streamText onFinish logic isolation
  console.log('2. Verify assistant onFinish ...');
  const assistantMsgId = 'assistant-msg-' + Date.now();
  
  await saveAssistantMessage(supabase, res.chatId, assistantMsgId, [
    { type: 'text', text: 'Im dummy assistant' },
    { type: 'tool-call', toolCallId: 'call_123', toolName: 'dummy_tool', args: { a: 1 } }
  ], { role: 'assistant', provider: 'test' });

  // verify we can fetch it
  const { data: fetchAssistant } = await supabase.from('muel_messages_v2').select('*').eq('id', assistantMsgId).single();
  if (!fetchAssistant) throw new Error('Assistant message not saved');
  
  if (fetchAssistant.parts[1].type !== 'tool-call') throw new Error('Tool call not saved correctly');
  if (fetchAssistant.role !== 'assistant') throw new Error('Role is incorrect');

  console.log('✔ assistant onFinish parts jsonb storage passed.');

  console.log('3. Verify unique constraint ...');
  // running it again should not fail
  const res2 = await prepareChatTurn(supabase, {
    source: 'discord',
    sourceChannelId: testChannelId,
    sourceThreadId: testChannelId,
    userMessageId: testMessageId + '-2',
    userParts: [{ type: 'text', text: 'Second message' }],
    metadata: {}
  });

  if (res2.chatId !== res.chatId) throw new Error('Chat ID changed for same thread!');
  if (res2.messages.length !== 3) throw new Error(`Expected 3 messages (user, assistant, user), got ${res2.messages.length}`);

  console.log('✔ unique constraint passed.');

  console.log('All tests passed safely!');
}

verify().catch((err) => {
  console.error('Test failed', err);
  process.exit(1);
});
