import { streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const mockModel = createOpenAICompatible({ name: 'test', baseURL: 'http://localhost', apiKey: 'test' })('test');

async function test() {
  const result = streamText({
    model: mockModel,
    prompt: 'hi',
    onFinish: (event) => {
      console.log('onFinish event keys:', Object.keys(event));
    }
  });
  
  try {
    await result.text;
  } catch (e) {
    // ignore
  }
}
test();
