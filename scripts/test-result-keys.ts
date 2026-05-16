import { streamText } from 'ai';

async function test() {
  const result = streamText({
    model: {} as any,
    prompt: 'test'
  });
  
  console.log('Result keys:', Object.keys(result));
}
test();
