/**
 * Ownership state for the two-element global player.
 *
 * A generation is captured by each event binding. Switching or stopping
 * invalidates every earlier generation, so late audio/video events cannot
 * mutate the visible state for the new source.
 */
export function createPlaybackState() {
  let activeElement = null;
  let generation = 0;

  return {
    activate(element) {
      if (!element) throw new TypeError('active media element is required');
      generation += 1;
      activeElement = element;
      return generation;
    },

    invalidate() {
      generation += 1;
      activeElement = null;
      return generation;
    },

    owns(element, candidateGeneration) {
      return activeElement === element && generation === candidateGeneration;
    },

    get activeElement() { return activeElement; },
    get generation() { return generation; },
  };
}
