/**
 * Size of the station cards in the Tuner's strip (Settings > Appearance).
 *
 * "small" is the original text-only card and the default. "medium" and
 * "large" have bigger text and the station's picture (tuner-card-art.js).
 *
 * The choice lives in the settings object as `tunerCardSize`, inside the
 * one saved settings value (worldmedia.settings.v1). It is not a new profile
 * key: every release since 0.1.0 keeps settings fields it does not know
 * (state.js normalizeSettings spreads the saved object), so going back to an
 * older build and returning keeps the choice. A missing or unknown value
 * means "small".
 */

export const TUNER_CARD_SMALL = 'small';
export const TUNER_CARD_MEDIUM = 'medium';
export const TUNER_CARD_LARGE = 'large';
export const TUNER_CARD_SIZES = Object.freeze([TUNER_CARD_SMALL, TUNER_CARD_MEDIUM, TUNER_CARD_LARGE]);

export const TUNER_CARD_SIZE_LABELS = Object.freeze({
  [TUNER_CARD_SMALL]: 'Small',
  [TUNER_CARD_MEDIUM]: 'Medium',
  [TUNER_CARD_LARGE]: 'Large',
});

export function normalizeTunerCardSize(value) {
  return TUNER_CARD_SIZES.includes(value) ? value : TUNER_CARD_SMALL;
}

/** Medium and large cards show the station's picture; small cards never do. */
export function tunerCardsShowPictures(size) {
  return normalizeTunerCardSize(size) !== TUNER_CARD_SMALL;
}
