import { convertToModelMessages, type UIMessage } from 'ai';

const dummyMessage: UIMessage = {
  id: 'test',
  role: 'assistant',
  content: 'Hello', 
  toolInvocations: [
    { state: 'call', toolCallId: '123', toolName: 'test', args: { a: 1 } }
  ]
};

async function test() {
  try {
    const models = await convertToModelMessages([dummyMessage]);
    console.log(JSON.stringify(models, null, 2));
  } catch (err) {
    console.error(err);
  }
}
test();
