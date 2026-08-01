/**
 * Appearance themes shared by Settings and the state layer.
 *
 * Theme ids are persisted, so keep existing ids stable. Native caption updates
 * are best-effort: ordinary browser previews simply do not expose pywebview.
 */

export const THEME_OPTIONS = Object.freeze([
  Object.freeze({ id: 'system', label: 'System', mode: 'system' }),
  Object.freeze({ id: 'dark', label: 'Dark · Teal', mode: 'dark' }),
  Object.freeze({ id: 'light', label: 'Light', mode: 'light' }),
  Object.freeze({ id: 'midnight', label: 'Midnight · Blue', mode: 'dark' }),
  Object.freeze({ id: 'forest', label: 'Forest · Green', mode: 'dark' }),
  Object.freeze({ id: 'ember', label: 'Ember · Orange', mode: 'dark' }),
  Object.freeze({ id: 'amethyst', label: 'Amethyst · Violet', mode: 'dark' }),
]);

export const THEME_IDS = Object.freeze(THEME_OPTIONS.map(({ id }) => id));
const THEME_ID_SET = new Set(THEME_IDS);

export function normalizeTheme(value) {
  return THEME_ID_SET.has(value) ? value : 'system';
}

let activeTheme = 'system';
let bridgeReadyListenerBound = false;
let systemThemeListenerBound = false;

function sendNativeTheme(theme) {
  const api = globalThis.window?.pywebview?.api;
  if (typeof api?.set_theme !== 'function') return false;
  Promise.resolve(api.set_theme(theme)).catch(() => {
    // Native caption theming is cosmetic. The web theme remains authoritative.
  });
  return true;
}

function bindNativeThemeBridge() {
  const host = globalThis.window;
  if (!host?.addEventListener) return;

  if (!bridgeReadyListenerBound) {
    bridgeReadyListenerBound = true;
    host.addEventListener('pywebviewready', () => sendNativeTheme(activeTheme), { once: true });
  }

  if (!systemThemeListenerBound && typeof host.matchMedia === 'function') {
    systemThemeListenerBound = true;
    const preference = host.matchMedia('(prefers-color-scheme: dark)');
    preference.addEventListener?.('change', () => sendNativeTheme(activeTheme));
  }
}

/** Apply one normalized theme immediately and mirror it to the native caption. */
export function applyTheme(theme, root = globalThis.document?.documentElement) {
  activeTheme = normalizeTheme(theme);
  if (root) {
    if (activeTheme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', activeTheme);
  }
  bindNativeThemeBridge();
  sendNativeTheme(activeTheme);
  return activeTheme;
}
