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
