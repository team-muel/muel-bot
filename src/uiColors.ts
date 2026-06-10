/**
 * Single source of truth for Muel embed accent colors.
 *
 * BRAND is Muel's signature green and the canonical tone for Muel's own
 * first-party UI — system / status / memory / help / game cards (per the
 * RenderTone 'muel' policy in rendering/types.ts). The memo, propose-memo,
 * rolling-paper and /도감 codex cards all use it so Muel's surfaces stay on a
 * single tone. (An earlier ad-hoc violet — 0x9b87f5 / 0x8e7cff — on some of
 * those cards was never part of the tone policy and is removed.)
 *
 * The status colors keep their existing meanings and values.
 */
export const MUEL_BRAND_COLOR = 0xa2e61d;
export const MUEL_SUCCESS_COLOR = 0x34c759;
export const MUEL_WARN_COLOR = 0xff3b30;
