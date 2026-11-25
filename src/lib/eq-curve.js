export const EQ_BAND_COUNT = 10;
export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;
export const EQ_PREAMP_MIN_DB = -12;
export const EQ_PREAMP_MAX_DB = 6;

function clampDb(value, minimum = EQ_MIN_DB, maximum = EQ_MAX_DB) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(minimum, Math.min(maximum, number));
}

export const EQ_MIN_Q = 0.25;
export const EQ_MAX_Q = 8;
export const EQ_FILTER_Q = Math.SQRT2;
export const EQ_DEFAULT_Q = Object.freeze([1, ...Array(EQ_BAND_COUNT - 2).fill(EQ_FILTER_Q), 1]);

export function normalizeEqCurve(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const bands = Array.from({ length: EQ_BAND_COUNT }, (_, index) => clampDb(source.bands?.[index]));
  const presetId = typeof source.presetId === 'string' && source.presetId.trim()
    ? source.presetId.trim().slice(0, 128)
    : 'flat';
  return {
    ...source,
    preamp: clampDb(source.preamp, EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB),
    bands,
    q: EQ_DEFAULT_Q.map((fallback, index) => {
      const q = Number(source.q?.[index]);
      return q > 0 && Number.isFinite(q) ? Math.max(EQ_MIN_Q, Math.min(EQ_MAX_Q, q)) : fallback;
    }),
    presetId,
    bypassed: source.bypassed === true,
  };
}

export function cloneEqCurve(value) {
  return normalizeEqCurve(value);
}
