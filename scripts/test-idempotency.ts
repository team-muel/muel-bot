import 'dotenv/config';
import crypto from 'node:crypto';
import { getSupabaseClient } from '../src/supabase.js';
import { prepareChatTurn } from '../src/muelConversationStore.js';

async function runTests() {
  const supabase = getSupabaseClient();
  const externalId = `test_discord_msg_${Date.now()}`;
  
  console.log('Testing First Call...');
  const firstId = crypto.randomUUID();
  const res1 = await prepareChatTurn(supabase, {
    source: 'discord',
    sourceChannelId: 'test_channel',
    sourceThreadId: 'test_channel',
    userMessageId: firstId,
    userParts: [{ type: 'text', text: 'Hello' }],
    metadata: { externalMessageId: externalId }
  });
  
  const msg1 = res1.messages.find(m => m.metadata?.externalMessageId === externalId);
  if (!msg1) throw new Error('First call did not return the message');
  if (msg1.id !== firstId) throw new Error('First call message ID mismatch');
  console.log('✅ First call success. Inserted message:', msg1.id);

  console.log('Testing Duplicate Call...');
  const secondId = crypto.randomUUID();
  const res2 = await prepareChatTurn(supabase, {
    source: 'discord',
    sourceChannelId: 'test_channel',
    sourceThreadId: 'test_channel',
    userMessageId: secondId, // completely new UUID
    userParts: [{ type: 'text', text: 'Hello' }],
    metadata: { externalMessageId: externalId }
  });
  
  const msg2 = res2.messages.find(m => m.metadata?.externalMessageId === externalId);
  if (!msg2) throw new Error('Second call did not return the message');
  
  // The ID should be the FIRST ID, because the second insert was ignored!
  if (msg2.id === secondId) throw new Error('Idempotency failed: Second insert went through instead of skipping');
  if (msg2.id !== firstId) throw new Error('Idempotency failed: Returned a completely different ID');
  
  // Check the total count to ensure no duplicate row was created
  const duplicates = res2.messages.filter(m => m.metadata?.externalMessageId === externalId);
  if (duplicates.length > 1) throw new Error('Idempotency failed: Multiple rows returned for the same external message');
  
  console.log('✅ Duplicate call success. Existing message reused:', msg2.id);
  console.log('\nAll Idempotency tests passed!');
}

runTests().catch(console.error);
