/**
 * The app's text is in American spelling. Names that come from Psychedelia
 * as they are (effect names and groups, the looks of a scene's colour-scheme
 * list) are shown through americanText, so "Watercolour" reads
 * "Watercolor". Only what is shown: ids, saved values and the names used to
 * look a preset up stay as they are.
 */

/** British spelling -> American, whole words (lower case; a capital first
 *  letter or all capitals are kept). */
export const AMERICAN_SPELLING = Object.freeze([
  ['watercolours', 'watercolors'], ['watercolour', 'watercolor'],
  ['colouring', 'coloring'], ['coloured', 'colored'], ['colours', 'colors'], ['colour', 'color'],
  ['favourites', 'favorites'], ['favourite', 'favorite'],
  ['centred', 'centered'], ['centres', 'centers'], ['centre', 'center'],
  ['greyed', 'grayed'], ['greys', 'grays'], ['grey', 'gray'],
  ['licences', 'licenses'], ['licence', 'license'],
]);

const TABLE = new Map(AMERICAN_SPELLING);
const WORDS = new RegExp(`\\b(${AMERICAN_SPELLING.map(([british]) => british).join('|')})\\b`, 'gi');

/** `text` with the British spellings above in American spelling. */
export function americanText(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(WORDS, (word) => {
    const american = TABLE.get(word.toLowerCase());
    if (!american) return word;
    if (word === word.toUpperCase()) return american.toUpperCase();
    if (word[0] === word[0].toUpperCase()) return american[0].toUpperCase() + american.slice(1);
    return american;
  });
}
