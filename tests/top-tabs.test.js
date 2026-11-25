import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement } from './helpers/fake-dom.js';
import { captureProfileStorage, restoreProfileStorageValues } from '../src/lib/profile-transfer.js';
import { clearCache, getState, initState, normalizeSettings, saveSettings, STORAGE_KEYS } from '../src/lib/state.js';
import { isTabShown, selectTopTab, syncTopTabs, TOP_TABS } from '../src/lib/top-tabs.js';
import { openProcessorAbout } from '../src/lib/settings.js';

test('appearance switches cover exactly the top tabs and Library is always shown', async () => {
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  const buttons = [...html.matchAll(/<button class="mode-btn[^"]*" data-mode="([^"]+)"[^>]*>([^<]+)<\/button>/g)];
  assert.deepEqual(Object.fromEntries(buttons.map(([, id, label]) => [id, label])), TOP_TABS);

  const js = await readFile(new URL('../src/lib/settings.js', import.meta.url), 'utf8');
  const appearance = js.match(/<h3>Appearance<\/h3>[\s\S]*?<\/section>/)[0];
  assert.match(appearance, /<legend>Tabs shown<\/legend>/);
  assert.match(appearance, /Object\.entries\(TOP_TABS\)\.map/);
  assert.match(appearance, /data-show-tab=.*mode === 'library' \? ' disabled'/);

  const defaults = normalizeSettings({}).tabsShown;
  assert.ok(Object.values(defaults).every(Boolean));
  const settings = normalizeSettings({ tabsShown: { library: false, tuner: false, about: 0, settings: false } });
  assert.equal(settings.tabsShown.library, true);
  assert.equal(settings.tabsShown.tuner, false);
  assert.equal(settings.tabsShown.about, true);
  assert.equal(isTabShown('settings', settings), false);
});

test('a hidden tab is skipped at launch, rejects selection and falls back to Library when open', () => {
  const buttons = Object.keys(TOP_TABS).map((mode) => {
    const button = new FakeElement(mode, 'button');
    button.dataset.mode = mode;
    return button;
  });
  const [library, tuner] = buttons;
  const shown = normalizeSettings({ defaultMode: 'tuner' });
  const hidden = normalizeSettings({ ...shown, tabsShown: { tuner: false } });
  assert.equal(syncTopTabs(shown, buttons, shown.defaultMode), 'tuner');
  assert.equal(selectTopTab('tuner', shown, buttons), true);
  assert.equal(tuner.getAttribute('aria-current'), 'page');

  const fallback = syncTopTabs(hidden, buttons, 'tuner');
  assert.equal(tuner.hidden, true);
  assert.equal(library.hidden, false);
  assert.equal(syncTopTabs(hidden, buttons, hidden.defaultMode), 'library');
  assert.equal(selectTopTab('tuner', hidden, buttons), false);
  assert.equal(selectTopTab(fallback, hidden, buttons), true);
  assert.equal(library.getAttribute('aria-current'), 'page');
  assert.equal(tuner.getAttribute('aria-current'), null);
  assert.equal(syncTopTabs(shown, buttons, 'library'), 'library');
  assert.equal(tuner.hidden, false);
  assert.equal(library.getAttribute('aria-current'), 'page');
});

test('the Settings link to About does nothing while About is hidden', (t) => {
  const state = getState();
  const previous = state.settings;
  t.after(() => { state.settings = previous; });
  state.settings = normalizeSettings({ tabsShown: { about: false } });
  const modal = { closest() { assert.fail('Settings should stay open'); } };
  openProcessorAbout(modal);
});

test('tabs shown lives in settings and survives the profile handoff', async (t) => {
  class MemoryStorage {
    values = new Map([[STORAGE_KEYS.settings, '{"theme":"forest","defaultMode":"tuner"}']]);
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, String(value)); }
    removeItem(key) { this.values.delete(key); }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousSettings = getState().settings;
  t.after(() => {
    getState().settings = previousSettings;
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  const useStorage = (storage) => Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

  const storage = new MemoryStorage();
  useStorage(storage);
  await initState();
  assert.equal(getState().settings.tabsShown.tuner, true);
  saveSettings({ tabsShown: { tuner: false, grid: false } });
  saveSettings({ theme: 'dark' });
  assert.equal(getState().settings.tabsShown.tuner, false);
  const values = captureProfileStorage(storage);
  assert.equal(JSON.parse(values[STORAGE_KEYS.settings]).tabsShown.grid, false);

  const fresh = new MemoryStorage();
  fresh.values.clear();
  assert.equal(restoreProfileStorageValues(values, fresh), true);
  useStorage(fresh);
  await initState();
  assert.equal(getState().settings.tabsShown.tuner, false);
  assert.equal(getState().settings.defaultMode, 'tuner');
  assert.equal(getState().settings.theme, 'dark');
  await clearCache();
  assert.equal(getState().settings.tabsShown.tuner, true);
  assert.equal(fresh.getItem(STORAGE_KEYS.settings), null);
});
