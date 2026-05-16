import { streamText } from 'ai';

async function test() {
  const result = streamText({
    model: {} as any,
    prompt: 'test'
  });
  
  // Inspect the properties of `result`
  const keys = Object.keys(result);
  console.log(keys);
}
test();
