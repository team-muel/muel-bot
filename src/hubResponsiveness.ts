import type { MuelRouterIntent } from './muelRouter.js';

/**
 * Surface-cue guards for the hub auto-response gate.
 *
 * The router prompt assumes each message is addressed to Muel, but in a hub
 * channel it runs on EVERY message — including peer-to-peer banter it was never
 * meant to see. On such input it still forces one of its labels and can pick a
 * responsive intent (cs_help / news_query / memory_query / meta) with high
 * confidence (observed 2026-06-27: peer teasing "김범수가 군대를 간다고? 니 군대
 * 절대 안됨" classified `meta` @0.9 → Muel barged in and answered about the wrong
 * person). The RESPONSIVE_INTENTS + confidence gate can't catch this because the
 * router is confidently wrong.
 *
 * These guards require a real surface cue in the text before a responsive intent
 * is allowed to fire, so confident false-positives on peer chatter are dropped.
 * Deterministic and conservative: when unsure, stay quiet. An explicit @mention
 * bypasses this entirely (that path is handled by mentionHandler).
 */

// news_query — a bare link/video share gets this label but should only engage
// when the text actually reads as a question/request.
export const looksLikeNewsQuestion = (text: string): boolean => {
  if (/[?？]/.test(text)) return true;
  return /(뭐|무슨|어때|어떤|추천|있어|있나|알려|찾아|봤|뉴스|소식|영상|업로드|recommend|news)/i.test(text);
};

// meta = "about Muel itself" — require the text to actually reference Muel.
const MUEL_REFERENCE_RE = /(뮤엘|무엘|muel|봇|누가\s*만들|뭐\s*하는|뭐\s*할|할\s*수\s*있|무슨\s*기능|정체|도움말|너\s*뭐|니\s*뭐)/i;
// memory_query — require a reference to the past.
const MEMORY_REFERENCE_RE = /(전에|지난번|저번|그때|아까|예전|기억|말했|얘기했|remember)/i;
// cs_help — require a help / feature cue.
const HELP_REFERENCE_RE = /(어떻게|어케|방법|도와|도움|알려|켜|꺼|등록|취소|설정|메모|구독|허브|게임|곰돌|도감|weave|위브|리서치|딥리서치)/i;

/**
 * Does `text` carry a surface cue that plausibly makes it FOR Muel under
 * `intent`? Only the responsive intents are checked; anything else is already
 * dropped by the RESPONSIVE_INTENTS gate, so this returns true for them.
 */
export const intentHasSurfaceCue = (intent: MuelRouterIntent, text: string): boolean => {
  switch (intent) {
    case 'news_query':
      return looksLikeNewsQuestion(text);
    case 'meta':
      return MUEL_REFERENCE_RE.test(text);
    case 'memory_query':
      return MEMORY_REFERENCE_RE.test(text) || MUEL_REFERENCE_RE.test(text);
    case 'cs_help':
      return HELP_REFERENCE_RE.test(text) || MUEL_REFERENCE_RE.test(text);
    default:
      return true;
  }
};
