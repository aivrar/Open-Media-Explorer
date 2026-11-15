/**
 * Plain wording for an item whose details could not be looked up before play.
 *
 * An adapter that refuses at once (for example a source on hold, or one the
 * app no longer offers) attaches a plain `userMessage` to its error. The player shows
 * that text, set as text only, instead of the generic "No stream URL".
 * Errors without one return '' so the caller keeps its own wording.
 */

export const RESOLVE_MESSAGE_MAX = 240;

export function resolveFailureMessage(error) {
  const raw = error?.userMessage;
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length <= RESOLVE_MESSAGE_MAX) return text;
  return `${text.slice(0, RESOLVE_MESSAGE_MAX - 1).trimEnd()}…`;
}
