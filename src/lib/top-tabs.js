export const TOP_TABS = Object.freeze({
  library: 'Library',
  tuner: 'Tuner',
  grid: 'Grid',
  discovery: 'Discovery',
  'now-playing': 'Now Playing',
  visualizer: 'Visualizer',
  about: 'About',
});

export function isTabShown(mode, settings) {
  return Object.hasOwn(TOP_TABS, mode)
    && (mode === 'library' || settings?.tabsShown?.[mode] !== false);
}

export function normalizeTabsShown(tabsShown) {
  return Object.fromEntries(
    Object.keys(TOP_TABS).map((mode) => [mode, isTabShown(mode, { tabsShown })]),
  );
}

export function selectTopTab(mode, settings, buttons) {
  if (!isTabShown(mode, settings)) return false;
  for (const button of buttons) {
    const active = button.dataset.mode === mode;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  return true;
}

export function syncTopTabs(settings, buttons, mode) {
  for (const button of buttons) button.hidden = !isTabShown(button.dataset.mode, settings);
  return isTabShown(mode, settings) ? mode : 'library';
}
