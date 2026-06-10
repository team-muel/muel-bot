/**
 * Single source of truth for Muel embed accent colors.
 *
 * INFO is the violet used across user-facing info / help / menu cards
 * (메모 제안, 롤링페이퍼, /도감 등). These had drifted between 0x9b87f5 and
 * 0x8e7cff; unifying on a single constant keeps every neutral info card on the
 * same tone. Matches the helper-faction violet of the muel-tree BoW tokens.
 *
 * The semantic colors below are documented and centralized here for reuse;
 * BRAND (muel signature green) and the status colors keep their existing
 * meanings and values.
 */
export const MUEL_INFO_COLOR = 0x9b87f5;

export const MUEL_BRAND_COLOR = 0xa2e61d;
export const MUEL_SUCCESS_COLOR = 0x34c759;
export const MUEL_WARN_COLOR = 0xff3b30;
