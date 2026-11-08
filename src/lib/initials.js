/**
 * Initials shown on a coloured square when an item has no artwork, so a list
 * of saved stations can be scanned by eye instead of being rows of grey icons.
 */

const WORD = /[\p{L}\p{N}]+/gu;
const STOP_WORDS = new Set(['the', 'a', 'an', 'la', 'le', 'el', 'die', 'der', 'das']);

/** "France Info" → "FI", "BBC Radio 1" → "BBC", "SWR3" → "SWR3", "" → "". */
export function artworkInitials(title) {
  const words = String(title || '').match(WORD) || [];
  if (!words.length) return '';
  const first = words[0];
  // A short all-caps first word is already an abbreviation (BBC, NHK, WDR4).
  if (first.length <= 4 && first.length >= 2 && first === first.toUpperCase() && /\p{Lu}/u.test(first)) {
    return first;
  }
  const meaningful = words.length > 1 ? words.filter((w) => !STOP_WORDS.has(w.toLowerCase())) : words;
  const picked = meaningful.length ? meaningful : words;
  if (picked.length === 1) return [...picked[0]].slice(0, 2).join('').toUpperCase();
  return (([...picked[0]][0] || '') + ([...picked[1]][0] || '')).toUpperCase();
}

/** A stable hue (0–359) per title, so the same station keeps its colour. */
export function initialsHue(text) {
  let hash = 2166136261;
  for (const ch of String(text || '')) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}
