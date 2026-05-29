/**
 * Best-effort JSON repair for generateObject (ai@6 `experimental_repairText`).
 *
 * gemini-2.5-flash intermittently wraps structured output in ```json fences or
 * adds prose, which surfaces as AI_NoObjectGeneratedError ("response did not
 * match schema"). This strips fences and extracts the outermost JSON value so
 * the SDK can re-validate it. Returns null when nothing JSON-like is present
 * (the original error then stands).
 */
export const repairJsonText = async ({ text }: { text: string }): Promise<string | null> => {
  if (!text) return null;
  let t = text.trim();

  // Unwrap a ```json ... ``` (or bare ``` ... ```) fence if present.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();

  // Find the outermost JSON object/array and slice to its matching close.
  const objStart = t.indexOf('{');
  const arrStart = t.indexOf('[');
  let start = -1;
  if (objStart === -1) start = arrStart;
  else if (arrStart === -1) start = objStart;
  else start = Math.min(objStart, arrStart);
  if (start === -1) return null;

  const close = t[start] === '{' ? '}' : ']';
  const end = t.lastIndexOf(close);
  if (end <= start) return null;

  return t.slice(start, end + 1);
};
