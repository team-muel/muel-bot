const TOOL_BLOCK_RE =
  /<tool_(?:code|response|call|result)>[\s\S]*?<\/tool_(?:code|response|call|result)>/gi;
const FENCED_INTERNAL_BLOCK_RE = /```(?:json|text|ts|tsx|js|javascript|python|py)?\s*[\s\S]*?```/gi;
const STACK_TRACE_LINE_RE = /^\s*at\s+[\w.<anonymous>]+\s+\([^)]*\)\s*$/gm;
const INTERNAL_LINE_RE =
  /^\s*(?:Error|TypeError|ReferenceError|SyntaxError):.*(?:Supabase|Discord|muel_|search_discord|tool|stack|function|channel_id|guild_id).*$/gim;

/**
 * 인라인 함수 호출 형태의 tool 호출 syntax (2026-06-09 추가).
 *
 * 재발 시나리오: Gemini credits 고갈 → mindlogic gateway 폴백.
 * mindlogic 의 OpenAI 호환 모델이 *Gemini native googleSearch 같은 tool* 을 못 알고
 * Python/JS 함수 호출 *문자열*을 응답으로 emit:
 *   `tools.webSearch(query='...')`
 *   `default_api.search_semantic_memory(query='...')`
 *   `print(get_recent_messages())`
 * → 사용자에게 그대로 노출되던 버그. 패턴 매칭으로 제거.
 *
 * 다중 함수 호출이 한 줄에 여러 개 있을 수 있으므로 global. 함수명 prefix 패턴 보수적:
 *   tools | functions | default_api | tool | Tool (대문자) | api | print
 */
const INLINE_TOOL_CALL_RE =
  /\b(?:tools|functions|default_api|api|print)\.?\s*\w*\s*\(\s*[^)]*\)/g;

// `tools.webSearch` 같은 prefix 가 *답 전체*인지(= 사실 답 X) 빠르게 판정.
const ONLY_TOOL_CALLS_RE =
  /^\s*(?:\b(?:tools|functions|default_api|api|print)\.?\s*\w*\s*\(\s*[^)]*\)\s*\.?\s*)+\s*$/i;

const looksInternal = (block: string): boolean =>
  /<tool_|tool_(?:code|response|call|result)|search_discord|muel_|supabase|channel_id|guild_id|stack|^\s*at\s+/im.test(block);

/**
 * 모델 응답에서 *유저에게 보여서는 안 되는* 내부 텍스트를 제거.
 *
 * 처리:
 * - <tool_*> XML 블록 (Anthropic 형식).
 * - 내부 신호가 섞인 fenced code 블록.
 * - stack trace / 내부 에러 라인.
 * - **인라인 tool call 함수 syntax** (`tools.webSearch(query='...')` 등) — mindlogic
 *   fallback 시 모델이 텍스트로 emit 하는 패턴.
 *
 * 결과가 빈 문자열이면 호출자에서 *local fallback reply* 로 대체. 빈 답이 그대로
 * 사용자에게 가지 않도록 muelAgent 가 throw → fallback path.
 */
export const sanitizeModelOutput = (text: string): string => {
  // 답 전체가 tool call syntax 인 경우 — 의미 있는 답이 아니다. 빈 문자열로 escalate.
  if (ONLY_TOOL_CALLS_RE.test(text.trim())) return '';

  const withoutToolBlocks = text.replace(TOOL_BLOCK_RE, '');
  const withoutInternalFences = withoutToolBlocks.replace(FENCED_INTERNAL_BLOCK_RE, (block) =>
    looksInternal(block) ? '' : block,
  );
  const withoutInlineToolCalls = withoutInternalFences.replace(INLINE_TOOL_CALL_RE, '');
  return withoutInlineToolCalls
    .replace(STACK_TRACE_LINE_RE, '')
    .replace(INTERNAL_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
