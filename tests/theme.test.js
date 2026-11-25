import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  THEME_IDS,
  THEME_OPTIONS,
  applyTheme,
  normalizeTheme,
} from '../src/lib/themes.js';
import { normalizeSettings } from '../src/lib/state.js';


function fakeRoot() {
  const attrs = new Map();
  return {
    attrs,
    setAttribute(name, value) { attrs.set(name, value); },
    removeAttribute(name) { attrs.delete(name); },
  };
}


test('theme catalog is stable, unique, and accepted by settings migration', () => {
  assert.deepEqual(THEME_IDS, [
    'system', 'dark', 'light', 'midnight', 'forest', 'ember', 'amethyst',
  ]);
  assert.equal(new Set(THEME_IDS).size, THEME_IDS.length);
  assert.equal(THEME_OPTIONS.length, THEME_IDS.length);
  for (const id of THEME_IDS) {
    assert.equal(normalizeTheme(id), id);
    assert.equal(normalizeSettings({ theme: id }).theme, id);
  }
  assert.equal(normalizeTheme('neon'), 'system');
  assert.equal(normalizeSettings({ theme: 'neon' }).theme, 'system');
});


test('theme application updates the root immediately and system removes the override', () => {
  const root = fakeRoot();
  assert.equal(applyTheme('forest', root), 'forest');
  assert.equal(root.attrs.get('data-theme'), 'forest');

  assert.equal(applyTheme('system', root), 'system');
  assert.equal(root.attrs.has('data-theme'), false);

  assert.equal(applyTheme('invalid', root), 'system');
  assert.equal(root.attrs.has('data-theme'), false);
});


test('every color theme defines a complete CSS palette and System has a light override', async () => {
  const css = await readFile(new URL('../src/styles/base.css', import.meta.url), 'utf8');
  for (const id of THEME_IDS.filter((theme) => !['system', 'dark'].includes(theme))) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`:root\\[data-theme='${escaped}'\\]\\s*\\{([^}]*)\\}`, 's'));
    assert.ok(match, `${id} selector is missing`);
    const block = match[1];
    for (const variable of [
      '--bg:', '--bg-elev-1:', '--bg-elev-2:', '--bg-elev-3:',
      '--border:', '--text:', '--text-dim:', '--text-mute:',
      '--accent:', '--accent-soft:', '--accent-strong:', '--accent-deep:',
      '--accent-contrast:', '--chrome:',
    ]) {
      assert.ok(block.includes(variable), `${id} is missing ${variable}`);
    }
  }
  assert.match(css, /@media \(prefers-color-scheme: light\)/);
  assert.match(css, /:root:not\(\[data-theme\]\)/);
});


function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test('the seek and volume controls stand out from the player bar in the light palettes (3:1)', async () => {
  const css = await readFile(new URL('../src/styles/base.css', import.meta.url), 'utf8');
  const token = (block, name) => block.match(new RegExp(`${name}: (#[0-9a-f]{6});`))?.[1];
  const light = css.match(/:root\[data-theme='light'\]\s*\{([^}]*)\}/s)[1];
  const system = css.match(/@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{([^}]*)\}/s)[1];
  for (const block of [light, system]) {
    assert.match(block, /--slider-track: var\(--text-mute\);/);
    const track = token(block, '--text-mute');
    assert.ok(contrast(track, token(block, '--chrome')) >= 3, `track ${track} on the player bar`);
  }
  // The dark palettes keep their track: only the light ones set the token.
  assert.equal(css.match(/--slider-track:/g).length, 2);
  for (const pseudo of ['::-webkit-slider-runnable-track', '::-moz-range-track']) {
    assert.ok(!css.includes('#player-volume' + pseudo));
    const rule = css.match(new RegExp(`\\.player-seek${pseudo} \\{([^}]*)\\}`))[1];
    assert.match(rule, /background: var\(--slider-track, var\(--bg-elev-3\)\);/);
    assert.match(rule, /height: 4px;/);
  }
  assert.match(css, /\.player-volume > \.volume-stepper:not\(:focus-within\) \{\s*border-color: var\(--slider-track, var\(--border\)\);/);
});


test('native theme bridge receives only the normalized persisted theme', async () => {
  const previousWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    pywebview: { api: { set_theme(theme) { calls.push(theme); return Promise.resolve({ ok: true }); } } },
    addEventListener() {},
    matchMedia() { return { addEventListener() {} }; },
  };
  try {
    const isolated = await import(`../src/lib/themes.js?bridge=${Date.now()}`);
    isolated.applyTheme('ember', fakeRoot());
    isolated.applyTheme('not-a-theme', fakeRoot());
    await Promise.resolve();
    assert.deepEqual(calls, ['ember', 'system']);
  } finally {
    globalThis.window = previousWindow;
  }
});
