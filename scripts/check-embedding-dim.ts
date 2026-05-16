import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { embed } from 'ai';

const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
if (!key) { console.error('No API key'); process.exit(1); }

const google = createGoogleGenerativeAI({ apiKey: key });
const model = google.textEmbeddingModel('gemini-embedding-001');

const { embedding } = await embed({ model, value: 'User prefers AI capabilities to remain invisible in UX.' });
console.log(`gemini-embedding-001 actual dimension: ${embedding.length}`);
