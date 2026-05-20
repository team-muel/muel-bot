const TOOL_BLOCK_RE =
  /<tool_(?:code|response|call|result)>[\s\S]*?<\/tool_(?:code|response|call|result)>/gi;
const FENCED_INTERNAL_BLOCK_RE = /```(?:json|text|ts|tsx|js|javascript|python|py)?\s*[\s\S]*?```/gi;
const STACK_TRACE_LINE_RE = /^\s*at\s+[\w.<anonymous>]+\s+\([^)]*\)\s*$/gm;
const INTERNAL_LINE_RE =
  /^\s*(?:Error|TypeError|ReferenceError|SyntaxError):.*(?:Supabase|Discord|muel_|search_discord|tool|stack|function|channel_id|guild_id).*$/gim;

const looksInternal = (block: string): boolean =>
  /<tool_|tool_(?:code|response|call|result)|search_discord|muel_|supabase|channel_id|guild_id|stack|^\s*at\s+/im.test(block);

export const sanitizeModelOutput = (text: string): string => {
  const withoutToolBlocks = text.replace(TOOL_BLOCK_RE, '');
  const withoutInternalFences = withoutToolBlocks.replace(FENCED_INTERNAL_BLOCK_RE, (block) =>
    looksInternal(block) ? '' : block,
  );
  return withoutInternalFences
    .replace(STACK_TRACE_LINE_RE, '')
    .replace(INTERNAL_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
