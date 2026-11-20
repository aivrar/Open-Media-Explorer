/**
 * The one Visualizer the app may have mounted (one renderer, one WebGL
 * context). Whoever mounts one (the Visualizer tab, the Tuner's background)
 * claims the slot first; a claim by another owner releases the one holding
 * it (its destroy runs, its context goes) before the new one is made.
 */

let holder = null; // { owner, release }

/** Claim the slot for `owner`; `release` destroys that owner's mount. Returns
 *  the function to call when the owner lets go itself. */
export function claimVisualizer(owner, release) {
  if (holder && holder.owner !== owner) {
    const previous = holder;
    holder = null;
    try { previous.release(); } catch (error) { console.error('visualizer release failed:', error); }
  }
  const mine = { owner, release };
  holder = mine;
  return () => { if (holder === mine) holder = null; };
}

/** Who holds the slot now (null: nobody). */
export function visualizerHolder() { return holder ? holder.owner : null; }
