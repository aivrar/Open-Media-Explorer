/**
 * Developer measurement switches, read once when the tab mounts:
 * localStorage["worldmedia.viz.tryHeld"] = "1" offers held scenes for manual testing.
 * localStorage["worldmedia.viz.devFlags"] = "noStructure,noColorTravel,noWarpDissolve"
 * disables any of those features independently. Add "debug" to expose dissolve counters.
 * Reload the tab to apply changes.
 */
export function readVisualizerDevFlags(win) {
  let tryHeld = false;
  let flags = [];
  try {
    const storage = win?.localStorage;
    tryHeld = storage?.getItem('worldmedia.viz.tryHeld') === '1';
    flags = (storage?.getItem('worldmedia.viz.devFlags') || '').split(',').map((flag) => flag.trim());
  } catch (_) { /* Storage can be blocked. */ }
  return {
    tryHeld,
    structure: !flags.includes('noStructure'),
    colorTravel: !flags.includes('noColorTravel'),
    warpDissolve: !flags.includes('noWarpDissolve'),
    debug: flags.includes('debug'),
  };
}
