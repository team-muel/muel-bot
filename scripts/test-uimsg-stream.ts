import { streamText, generateId } from 'ai';

async function test() {
  const result = streamText({
    model: {} as any,
    prompt: 'hi'
  });

  result.toUIMessageStreamResponse({
    onFinish: ({ responseMessage }) => {
      console.log('Got responseMessage:', responseMessage);
    }
  });
}
test();
