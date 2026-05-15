import { streamText } from 'ai';

async function main() {
  streamText({
    model: {} as any,
    prompt: 'hi',
    onFinish: (event) => {
      const a = event.text;
      const b = event.response;
      const c = event.toolCalls;
      const d = event.toolResults;
      const e = event.responseMessages;
    }
  })
}
