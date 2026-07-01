import { DISCORD_LIMITS } from './discordLimits.js';

/**
 * Index at or before `max` where `text` can be cut WITHOUT slicing through a
 * contiguous non-whitespace run (e.g. a URL). Prefers a newline, then a space;
 * if neither sits near the boundary it backs up to the start of the token that
 * straddles `max`, so a link never gets split in half.
 */
export const safeBreakIndex = (text: string, max: number): number => {
  if (text.length <= max) return text.length;
  const floor = Math.floor(max * 0.25);
  const nl = text.lastIndexOf('\n', max);
  if (nl > floor) return nl;
  const sp = text.lastIndexOf(' ', max);
  if (sp > floor) return sp;
  // No usable whitespace near the boundary — back up to the start of the token
  // crossing `max` so we don't cut inside it (URL-safe).
  let i = max;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i -= 1;
  return i > 0 ? i : max; // single token longer than max: unavoidable hard cut
};

/**
 * Split `input` into Discord-sendable chunks, each <= `maxLength`, breaking on
 * whitespace/URL boundaries so links stay intact. Returns [] for empty input.
 * Nothing is dropped — the full text is preserved across the returned chunks.
 */
export const splitForDiscord = (
  input: string | null | undefined,
  maxLength: number = DISCORD_LIMITS.content,
): string[] => {
  const text = String(input ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!text) return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    const at = safeBreakIndex(rest, maxLength);
    const head = rest.slice(0, at).trim();
    chunks.push(head.length > 0 ? head : rest.slice(0, maxLength));
    rest = rest.slice(head.length > 0 ? at : maxLength).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
};
