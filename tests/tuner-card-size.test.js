import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { STORAGE_KEYS, normalizeSettings } from '../src/lib/state.js';
import { LEGACY_PROFILE_STORAGE_KEYS, PROFILE_STORAGE_KEYS } from '../src/lib/profile-transfer.js';
import {
  TUNER_CARD_SIZES, normalizeTunerCardSize, tunerCardsShowPictures,
} from '../src/lib/tuner-card-size.js';
import { tunedScrollTop, stationListWindow, STATION_LIST_GAP, STATION_ROW_HEIGHTS } from '../src/modes/tuner-station-list.js';
import { TUNER_ART_SETTLE_MS, createTunerCardArt } from '../src/lib/tuner-card-art.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function rule(css, selector, from = 0) {
  const match = css.slice(from).match(new RegExp(`(?:^|\\n|\\})\\s*${escape(selector)} \\{([^}]*)\\}`));
  assert.ok(match, `no rule for ${selector}`);
  return match[1];
}
function px(body, property) {
  const match = body.match(new RegExp(`(?:^|[;\\s])${escape(property)}: (\\d+)px;`));
  assert.ok(match, `${property} is not a fixed px value`);
  return Number(match[1]);
}

/* ---------------- Feature A: the knob text ---------------- */

test('the knob shows the station name only, never its source', async () => {
  const tuner = await read('src/modes/tuner.js');
  const display = tuner.match(/function updateFrequencyDisplay\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(display, /ui\.stationName\.textContent = `\$\{isFavorite\(s\.id\) \? '\\u2605\\u00a0' : ''\}\$\{s\.title\}`;/);
  assert.doesNotMatch(display, /getSourceLabel|\u00b7|\\u00b7/);
  assert.match(tuner, /el\('small', \{ className: 'tuner-station-details' \}\)/);
  assert.match(tuner, /\[source, country, quality\]\.filter\(Boolean\)\.join\(' · '\)/);
});

/* ---------------- The setting and where it is stored ---------------- */

test('the card size setting defaults to Small and accepts only the three sizes', () => {
  assert.deepEqual([...TUNER_CARD_SIZES], ['small', 'medium', 'large']);
  assert.equal(normalizeSettings({}).tunerCardSize, 'small');
  assert.equal(normalizeSettings(undefined).tunerCardSize, 'small');
  assert.equal(normalizeSettings({ tunerCardSize: 'medium' }).tunerCardSize, 'medium');
  assert.equal(normalizeSettings({ tunerCardSize: 'large' }).tunerCardSize, 'large');
  for (const bad of ['huge', 'LARGE', '', null, 3, {}, ['large']]) {
    assert.equal(normalizeSettings({ tunerCardSize: bad }).tunerCardSize, 'small');
    assert.equal(normalizeTunerCardSize(bad), 'small');
  }
  assert.equal(tunerCardsShowPictures('small'), false);
  assert.equal(tunerCardsShowPictures(undefined), false);
  assert.equal(tunerCardsShowPictures('medium'), true);
  assert.equal(tunerCardsShowPictures('large'), true);
});

test('the size is stored inside the saved settings, never as a new profile key', async () => {
  // It travels inside worldmedia.settings.v1, a key every release knows.
  assert.equal(STORAGE_KEYS.settings, 'worldmedia.settings.v1');
  assert.ok(LEGACY_PROFILE_STORAGE_KEYS.includes(STORAGE_KEYS.settings));
  assert.ok(!Object.keys(STORAGE_KEYS).some((key) => /card/i.test(key)));
  assert.ok(!PROFILE_STORAGE_KEYS.some((key) => /card/i.test(key)));
  const runtime = await read('worldmedia_runtime.py');
  assert.doesNotMatch(runtime, /tuner|card-size|cardsize/i);
  // An older build keeps settings fields it does not know (0.1.8 and 0.1.9
  // normalise with the same spread), so a round trip there keeps the choice.
  const olderNormalize = (value) => ({ ...value, version: 1, theme: value.theme || 'system' });
  const saved = JSON.stringify(normalizeSettings({ tunerCardSize: 'large', theme: 'dark' }));
  const afterOlder = JSON.stringify(olderNormalize(JSON.parse(saved)));
  assert.equal(normalizeSettings(JSON.parse(afterOlder)).tunerCardSize, 'large');
  // The same rule here: unknown fields survive this build too.
  assert.equal(normalizeSettings({ somethingNewer: 7 }).somethingNewer, 7);
  const state = await read('src/lib/state.js');
  assert.match(state, /return \{\s+\.\.\.source,/);
});

test('Settings has the control under Appearance and applies it at once', async () => {
  const settings = await read('src/lib/settings.js');
  const appearance = settings.match(/<h3>Appearance<\/h3>[\s\S]*?<\/section>/)[0];
  assert.match(appearance, /<label for="settings-tuner-card-size">Tuner card size<\/label>/);
  assert.match(appearance, /<select id="settings-tuner-card-size" data-field="tunerCardSize">/);
  assert.match(settings, /cardSizeSel\.value = normalizeTunerCardSize\(state\.settings\.tunerCardSize\);/);
  assert.match(settings, /cardSizeSel\.addEventListener\('change', \(\) => saveSettings\(\{ tunerCardSize: cardSizeSel\.value \}\)\);/);
  const tuner = await read('src/modes/tuner.js');
  // The Tuner listens for the change; no restart, no reload of the stations.
  assert.match(tuner, /applyCardSize\(settings\.tunerCardSize\);/);
  assert.match(tuner, /ui\.root\?\.setAttribute\('data-card-size', next\);[\s\S]*?if \(!cardPictures\(\)\) cardArt\.clear\(\);/);
});

/* ---------------- Sizes: one fixed height each ---------------- */

test('each row size holds two name lines and one metadata line without resizing the stage', async () => {
  const css = await read('src/styles/tuner.css');
  const pill = rule(css, '.station-pill');
  assert.match(pill, /position: absolute;/);
  assert.match(pill, /width: 100%;\s*height: var\(--station-row-height\);/);
  assert.deepEqual(STATION_ROW_HEIGHTS, { small: 56, medium: 68, large: 84 });
  // Four pixels of vertical padding and one pixel of border on each side.
  assert.ok(STATION_ROW_HEIGHTS.small >= 10 + 2 * 15 + 12);
  for (const size of ['medium', 'large']) {
    const vars = rule(css, `.tuner-root[data-card-size='${size}']`);
    assert.ok(STATION_ROW_HEIGHTS[size] >= 10 + Math.max(
      px(vars, '--card-art'), 2 * px(vars, '--card-name-line') + px(vars, '--card-source-line'),
    ));
  }
  assert.match(rule(css, '.pill-art'), /width: var\(--card-art\);\s+height: var\(--card-art\);/);
  assert.match(rule(css, '.pill-initials'), /line-height: var\(--card-initials\);/);
  assert.match(rule(css, '.pill-art-img.is-station-image'), /object-fit: contain;/);
});

test('small rows stay text-only and artwork is limited to visible rows', async () => {
  const tuner = await read('src/modes/tuner.js');
  assert.match(tuner, /const picture = cardPictures\(\) \? cardArt\.box\(station\) : null;/);
  assert.match(tuner, /rect\.bottom > view\.top && rect\.top < view\.bottom/);
  assert.match(tuner, /onRender: \(\) => \{ if \(cardPictures\(\)\) cardArt\.commit\(\); \}/);
  assert.match(tuner, /function tearDown\(\) \{[\s\S]*?cardArt\.clear\(\);/);
});

/* ---------------- Pictures: few requests, no flicker ---------------- */

class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.attributes = new Map();
    this.children = [];
    this.parent = null;
    this.textContent = '';
    this.naturalWidth = 0;
    const node = this;
    this.style = { props: {}, setProperty(name, value) { this.props[name] = value; } };
    this.classList = {
      add(name) { const set = new Set(node.className.split(' ').filter(Boolean)); set.add(name); node.className = [...set].join(' '); },
      contains(name) { return node.className.split(' ').includes(name); },
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}
const doc = { createElement: (tag) => new Node(tag) };

const RELAY = (n) => `/api/v1/assets/station${String(n).padStart(12, '0')}`;
const stations = Array.from({ length: 100 }, (_, n) => ({
  id: `s${n}`, title: `Station ${n}`, source: 'radio-browser',
  // Half carry relay artwork already; the rest need the backend to resolve it.
  thumbnail: n % 2 ? RELAY(n) : '',
}));

/** A window onto the station list, centered on the dial selection. */
function harness({ loadImpl, resolveImpl, custom = () => '', visible = 3 } = {}) {
  const timers = [];
  const owners = new Map();
  let first = 0;
  const calls = { load: [], resolve: [] };
  const art = createTunerCardArt({
    doc,
    isInView: (box) => owners.get(box) >= first && owners.get(box) < first + 2 * visible + 1,
    load: (img, source, opts) => {
      calls.load.push({ img, source, opts });
      return loadImpl ? loadImpl(img, source, opts) : Promise.resolve().then(() => { img.naturalWidth = 64; });
    },
    resolve: (item, opts) => {
      calls.resolve.push({ item, opts });
      if (resolveImpl) return resolveImpl(item, opts);
      item.thumbnail = RELAY(Number(item.id.slice(1)));
      return Promise.resolve(item);
    },
    sourceFor: (item) => custom(item) || item.thumbnail || '',
    customSourceFor: custom,
    setTimer: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.live = false; },
  });
  const list = new Node('div');
  function render(at) {
    list.children = [];
    const boxes = [];
    const row = STATION_ROW_HEIGHTS.medium;
    const stride = row + STATION_LIST_GAP;
    const height = row + visible * 2 * stride;
    const total = stations.length * stride - STATION_LIST_GAP;
    const top = tunedScrollTop(at, 1, stride, height, total);
    first = top / stride;
    const { start, end } = stationListWindow(stations.length, row, height, top);
    for (let i = start; i < end; i += 1) {
      const pill = list.appendChild(new Node('div'));
      const box = pill.appendChild(art.box(stations[i]));
      owners.set(box, i);
      boxes.push(box);
    }
    art.commit();
    return boxes;
  }
  const fire = () => {
    const live = timers.filter((timer) => timer.live);
    for (const timer of live) { timer.live = false; timer.fn(); }
    return live.length;
  };
  return { art, render, fire, calls, timers, owners };
}
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const requests = (calls) => calls.load.length + calls.resolve.length;

test('a fast turn through 100 stations asks for nothing until the dial rests', async () => {
  for (const item of stations) item.thumbnail = Number(item.id.slice(1)) % 2 ? RELAY(Number(item.id.slice(1))) : '';
  const { art, render, fire, calls, timers } = harness();
  for (let step = 0; step < 100; step += 1) render(step % 100);
  // Every rebuild restarted the one wait; nothing has been asked for.
  assert.equal(requests(calls), 0);
  assert.equal(timers.filter((timer) => timer.live).length, 1);
  assert.equal(timers[0].ms, TUNER_ART_SETTLE_MS);
  assert.ok(TUNER_ART_SETTLE_MS >= 250 && TUNER_ART_SETTLE_MS <= 600);
  // Rested on station 99: only the cards in view (93..99 on screen) start.
  assert.equal(fire(), 1);
  await flush();
  const shown = new Set(calls.load.map(({ img }) => img.parent));
  assert.equal(art.stats.started, 7);
  assert.equal(calls.load.length, 7);
  assert.equal(calls.resolve.length, 3); // 94, 96 and 98 had no artwork yet
  assert.equal(shown.size, 7);
  for (const { opts } of calls.load) assert.ok(opts.signal instanceof AbortSignal);
});

test('a slow turn of 10 steps loads each card in view once', async () => {
  for (const item of stations) item.thumbnail = Number(item.id.slice(1)) % 2 ? RELAY(Number(item.id.slice(1))) : '';
  const { art, render, fire, calls } = harness();
  render(40);
  fire();
  await flush();
  assert.equal(art.stats.started, 7); // 37..43
  for (let step = 1; step <= 10; step += 1) {
    render(40 + step);
    fire();
    await flush();
  }
  // One new card comes into view per step.
  assert.equal(art.stats.started, 17);
  assert.equal(calls.load.length, 17);
  // Back over the same ten: everything is reused, nothing is asked again.
  for (let step = 9; step >= 0; step -= 1) {
    render(40 + step);
    fire();
    await flush();
  }
  assert.equal(calls.load.length, 17);
  assert.equal(art.stats.started, 17);
});

test('a loaded picture is moved into the rebuilt card, never reloaded or flashed', async () => {
  const { render, fire, calls, owners } = harness();
  const before = render(50);
  fire();
  await flush();
  const box = before.find((node) => owners.get(node) === 50);
  const img = box.children.find((child) => child.tagName === 'IMG');
  assert.ok(img.classList.contains('loaded'));
  const after = render(51);
  // The same box (with the same decoded image) is in the new card at once.
  assert.equal(after.find((node) => owners.get(node) === 50), box);
  assert.equal(box.children.find((child) => child.tagName === 'IMG'), img);
  assert.ok(img.classList.contains('loaded'));
  assert.equal(calls.load.filter((call) => call.img === img).length, 1);
});

test('a load in flight is not restarted while its card stays in the list window, and stops when it leaves', async () => {
  const pending = [];
  const { art, render, fire, calls } = harness({
    loadImpl: (img, source, { signal }) => new Promise((resolve, reject) => {
      pending.push({ img, resolve, signal });
      signal.addEventListener('abort', () => reject(Object.assign(new Error('stop'), { name: 'AbortError' })));
    }),
  });
  render(60);
  fire();
  await flush();
  assert.equal(calls.load.length, 7);
  const firstLoads = pending.slice(0, 7);
  for (let step = 61; step <= 62; step += 1) { render(step); fire(); await flush(); }
  assert.equal(firstLoads.filter(({ signal }) => signal.aborted).length, 0);
  render(63);
  fire();
  await flush();
  assert.equal(firstLoads[0].signal.aborted, true, 'station 57 left the rendered window');
  assert.ok(firstLoads.slice(1).every(({ signal }) => !signal.aborted));
  assert.equal(calls.load.filter(({ img }) => firstLoads.some((p) => p.img === img)).length, 7);
  assert.equal(calls.load.length, 10); // only 64, 65, 66 are new
  // Far away: every card in the old window leave it; their loads stop.
  render(95);
  assert.equal(pending.filter(({ signal }) => signal.aborted).length, 10);
  assert.equal(art.stats.stopped, 10);
  // Coming back starts them again, once.
  render(60);
  fire();
  await flush();
  assert.equal(calls.load.length, 17);
});

test('a picture that fails keeps the initials and is not asked for again', async () => {
  const { art, render, fire, calls, owners } = harness({
    loadImpl: () => Promise.reject(new Error('Artwork image could not load.')),
  });
  const boxes = render(20);
  fire();
  await flush();
  assert.equal(calls.load.length, 7);
  const box = boxes.find((node) => owners.get(node) === 20);
  assert.equal(box.className, 'pill-art');
  assert.equal(box.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(box.children.map((child) => child.className), ['pill-initials']);
  assert.equal(box.children[0].textContent, 'S2'); // "Station 20"
  assert.equal(box.children[0].getAttribute('data-length'), '2');
  assert.match(box.style.props['--ph-hue'], /^\d+$/);
  for (let step = 21; step <= 25; step += 1) { render(step); fire(); await flush(); }
  render(20);
  fire();
  await flush();
  // Only the five cards new to the view were tried; the failed ones were not retried.
  assert.equal(calls.load.length, 12);
  assert.equal(art.stats.started, 12);
});

test('the initials carry their letter count, and never more than four letters', () => {
  const { art } = harness();
  const initialsOf = (title) => art.box({ id: `t-${title}`, title }).children[0];
  for (const [title, text] of [['SWR3', 'SWR3'], ['BBC Radio 1', 'BBC'], ['France Info', 'FI'], ['X', 'X'], ['', '']]) {
    const node = initialsOf(title);
    assert.equal(node.textContent, text, title);
    assert.equal(node.getAttribute('data-length'), String(text.length), title);
  }
  // A sharp s and a ligature grow to five letters when upper-cased.
  const grown = initialsOf('ßﬃ');
  assert.equal(grown.textContent, 'SSFF');
  assert.equal(grown.getAttribute('data-length'), '4');
});

test('a station picture that fails falls back to the station\'s own artwork', async () => {
  const PICTURE = `station-image:${'a'.repeat(32)}:1`;
  let failedPicture = false;
  const { render, fire, calls, owners } = harness({
    custom: (item) => (item.id === 's30' && !failedPicture ? PICTURE : ''),
    loadImpl: (img, source) => {
      if (source === PICTURE) { failedPicture = true; return Promise.reject(new Error('bad picture')); }
      img.naturalWidth = 40;
      return Promise.resolve();
    },
    visible: 0,
  });
  stations[30].thumbnail = '';
  const boxes = render(30);
  fire();
  await flush();
  assert.deepEqual(calls.load.map(({ source }) => source), [PICTURE, RELAY(30)]);
  assert.equal(calls.resolve.length, 1);
  const imgs = boxes.find((node) => owners.get(node) === 30).children.filter((child) => child.tagName === 'IMG');
  assert.equal(imgs.length, 1);
  assert.ok(imgs[0].classList.contains('loaded'));
});

test('switching to Small or leaving the Tuner stops every load and the wait', async () => {
  const signals = [];
  const { art, render, fire, timers } = harness({
    loadImpl: (img, source, { signal }) => { signals.push(signal); return new Promise(() => {}); },
  });
  render(10);
  fire();
  await flush();
  render(11);
  assert.equal(timers.filter((timer) => timer.live).length, 1);
  art.clear();
  assert.equal(timers.filter((timer) => timer.live).length, 0);
  assert.equal(signals.length, 7);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(art.size, 0);
});

test('a new station picture in the folder redraws only the cards it changes', async () => {
  const PICTURE = `station-image:${'b'.repeat(32)}:1`;
  let pictureFor = '';
  const { art, render, fire, calls } = harness({ custom: (item) => (item.id === pictureFor ? PICTURE : '') });
  render(70);
  fire();
  await flush();
  assert.equal(art.stationImagesChanged(), false);
  pictureFor = 's71';
  assert.equal(art.stationImagesChanged(), true);
  render(70);
  fire();
  await flush();
  assert.equal(calls.load.length, 8);
  assert.equal(calls.load.at(-1).source, PICTURE);
});

test('the station name on the dial carries the whole name as its title, and none while loading', async () => {
  const tuner = await read('src/modes/tuner.js');
  const update = tuner.match(/function updateFrequencyDisplay\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(update, /ui\.stationName\.setAttribute\('title', s\.title \|\| ''\);/);
  assert.match(update, /'No station';\s+ui\.stationName\.removeAttribute\('title'\);/);
  assert.match(tuner, /ui\.stationName\.textContent = 'Loading\u2026';\s+ui\.stationName\.removeAttribute\('title'\);/);
});

