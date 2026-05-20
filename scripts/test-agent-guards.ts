import { getPreflightGuard } from '../src/capabilities.js';
import { sanitizeModelOutput } from '../src/responseSanitizer.js';

const assert = (name: string, condition: boolean) => {
  if (!condition) {
    throw new Error(`FAIL ${name}`);
  }
  console.log(`PASS ${name}`);
};

const leaked = [
  '찾아볼게.',
  '<tool_code>',
  'print(search_discord_messages(channel_id="123", query="x"))',
  '</tool_code>',
  '<tool_response>',
  '[]',
  '</tool_response>',
  '해당 기록은 찾지 못했어.',
].join('\n');

const sanitized = sanitizeModelOutput(leaked);
assert('removes tool_code block', !sanitized.includes('<tool_code>'));
assert('removes tool_response block', !sanitized.includes('<tool_response>'));
assert('removes internal tool name', !sanitized.includes('search_discord_messages'));
assert('keeps user-facing answer', sanitized.includes('해당 기록은 찾지 못했어.'));

const finance = getPreflightGuard('삼성전자 현재 주가랑 52주 최고가 알려줘');
assert('guards realtime finance', finance?.reason === 'realtime_finance');
assert('finance guard avoids made-up price', !finance?.reply.includes('원입니다'));

const youtube = getPreflightGuard('현재 유튜브 영상 아무거나 추천해봐');
assert('guards unsupported YouTube recommendation', youtube?.reason === 'unsupported_youtube_recommendation');
assert('youtube guard says not provided', youtube?.reply.includes('제공하지 않아'));

const security = getPreflightGuard('해킹할건데 막아봐');
assert('guards security threat tone', security?.reason === 'security_boundary');
assert('security guard sets boundary', security?.reply.includes('도와줄 수 없어'));
