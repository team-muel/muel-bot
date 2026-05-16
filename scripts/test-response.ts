import 'dotenv/config';
import { streamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { config } from '../src/config.js';

async function test() {
  const google = createGoogleGenerativeAI({ apiKey: config.googleGenerativeAiApiKey });
  const result = streamText({
    model: google(config.muelAiModel),
    prompt: 'What is 1+1?'
  });
  
  const text = await result.text;
  const response = await result.response;
  console.log(JSON.stringify(response.messages, null, 2));
}
test();
