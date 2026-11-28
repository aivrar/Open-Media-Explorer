import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FakeElement } from './helpers/fake-dom.js';
import { captureProfileStorage, restoreProfileStorageValues } from '../src/lib/profile-transfer.js';
import { clearCache, getState, initState, normalizeSettings, saveSettings, setMode, STORAGE_KEYS } from '../src/lib/state.js';
import { isTabShown, selectTopTab, syncTopTabs, TOP_TABS } from '../src/lib/top-tabs.js';
import { EXTRA_SETTINGS_STORAGE_KEY } from '../src/lib/profile-storage.js';
import { openProcessorAbout } from '../src/lib/settings.js';

test('appearance switches cover exactly the top tabs and Library is always shown', async () => {
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  const buttons = [...html.matchAll(/<button class="mode-btn[^"]*" data-mode="([^"]+)"[^>]*>([^<]+)<\/button>/g)];
  assert.deepEqual(buttons.map(([, id, label]) => [id, label]), Object.entries(TOP_TABS));
  assert.deepEqual(Object.keys(TOP_TABS), ['library', 'tuner', 'computer', 'now-playing', 'visualizer', 'about']);
  for (const path of ['../README.md', '../docs/wiki/02-using-the-application.md']) {
    const guide = await readFile(new URL(path, import.meta.url), 'utf8');
    const tabList = guide.match(/(?:The tabs are |^- )\*\*Library\*\*,\s+\*\*Tuner\*\*,[\s\S]*?\*\*About\*\*/m);
    assert.ok(tabList, path);
    const labels = Array.from(tabList[0].matchAll(/\*\*(.*?)\*\*/g), ([, label]) => label);
    assert.deepEqual(labels, Object.values(TOP_TABS), path);
  }

  const js = await readFile(new URL('../src/lib/settings.js', import.meta.url), 'utf8');
  const appearance = js.match(/<h3>Appearance<\/h3>[\s\S]*?<\/section>/)[0];
  assert.match(appearance, /<legend>Tabs shown<\/legend>/);
  const launch = appearance.match(/<select id="settings-default-mode"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...launch.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(([, id, label]) => [id, label]),
    [['library', 'Library'], ['tuner', 'Tuner'], ['computer', 'Computer']]);
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
  const [library, tuner, computer] = buttons;
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

  const shownComputer = normalizeSettings({ defaultMode: 'computer' });
  const hiddenComputer = normalizeSettings({ ...shownComputer, tabsShown: { computer: false } });
  assert.equal(syncTopTabs(shownComputer, buttons, shownComputer.defaultMode), 'computer');
  assert.equal(selectTopTab('computer', shownComputer, buttons), true);
  assert.equal(computer.getAttribute('aria-current'), 'page');
  assert.equal(syncTopTabs(hiddenComputer, buttons, 'computer'), 'library');
  assert.equal(computer.hidden, true);
  assert.equal(selectTopTab('computer', hiddenComputer, buttons), false);
});

test('the Settings link to About does nothing while About is hidden', (t) => {
  const state = getState();
  const previous = state.settings;
  t.after(() => { state.settings = previous; });
  state.settings = normalizeSettings({ tabsShown: { about: false } });
  const modal = { closest() { assert.fail('Settings should stay open'); } };
  openProcessorAbout(modal);
});

test('retired launch and current modes resolve to Library, and About still launches', (t) => {
  const state = getState();
  const previous = state.mode;
  t.after(() => setMode(previous));
  for (const mode of ['grid', 'discovery']) {
    const settings = normalizeSettings({ defaultMode: mode, tabsShown: { [mode]: false } });
    assert.equal(settings.defaultMode, 'library');
    assert.equal(Object.hasOwn(settings.tabsShown, mode), false);
    assert.equal(syncTopTabs(settings, [], mode), 'library');
    setMode(mode);
    assert.equal(state.mode, 'library');
  }
  assert.equal(normalizeSettings({ defaultMode: 'about' }).defaultMode, 'about');
});

test('tabs shown lives in settings and survives the profile handoff', async (t) => {
  class MemoryStorage {
    values = new Map([[STORAGE_KEYS.settings, '{"theme":"forest","defaultMode":"tuner","tabsShown":{"grid":false,"discovery":true}}']]);
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
  assert.equal(getState().settings.nowPlayingSurprise, true);
  saveSettings({ tabsShown: { tuner: false, computer: false } });
  saveSettings({ theme: 'dark', nowPlayingSurprise: false });
  assert.equal(getState().settings.tabsShown.tuner, false);
  const values = captureProfileStorage(storage);
  const legacy = JSON.parse(values[STORAGE_KEYS.settings]);
  assert.equal(Object.hasOwn(legacy.tabsShown, 'grid'), false);
  assert.equal(Object.hasOwn(legacy.tabsShown, 'discovery'), false);
  assert.equal(legacy.tabsShown.computer, false);
  assert.equal(Object.hasOwn(legacy, 'nowPlayingSurprise'), false);
  assert.deepEqual(JSON.parse(values[EXTRA_SETTINGS_STORAGE_KEY]), { nowPlayingSurprise: false });

  const fresh = new MemoryStorage();
  fresh.values.clear();
  assert.equal(restoreProfileStorageValues(values, fresh), true);
  useStorage(fresh);
  await initState();
  assert.equal(getState().settings.tabsShown.tuner, false);
  assert.equal(getState().settings.defaultMode, 'tuner');
  assert.equal(getState().settings.tabsShown.computer, false);
  assert.equal(getState().settings.nowPlayingSurprise, false);
  assert.equal(getState().settings.theme, 'dark');
  await clearCache();
  assert.equal(getState().settings.tabsShown.tuner, true);
  assert.equal(fresh.getItem(STORAGE_KEYS.settings), null);
  assert.equal(fresh.getItem(EXTRA_SETTINGS_STORAGE_KEY), null);
  assert.equal(getState().settings.nowPlayingSurprise, true);
});
