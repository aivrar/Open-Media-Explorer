export const PERSONAL_TYPES = [['radio', 'Radio'], ['tv', 'TV'], ['audio', 'Audio'], ['video', 'Video']];
const typeIds = PERSONAL_TYPES.map(([id]) => id);

/** Read a legacy single value or a selection array in toolbar order. An empty array means All. */
export function normalizePersonalTypes(value) {
  const selected = Array.isArray(value) ? value : [value];
  return typeIds.filter((id) => selected.includes(id));
}

export function togglePersonalType(current, clicked) {
  if (clicked === '') return [];
  const selected = normalizePersonalTypes(current);
  return selected.includes(clicked)
    ? selected.filter((id) => id !== clicked)
    : normalizePersonalTypes([...selected, clicked]);
}

/** Labels for a selection that narrows the list. */
export function personalTypeFilterLabels(value) {
  const selected = normalizePersonalTypes(value);
  if (selected.length === PERSONAL_TYPES.length) return [];
  return PERSONAL_TYPES.filter(([id]) => selected.includes(id)).map(([, label]) => label);
}
