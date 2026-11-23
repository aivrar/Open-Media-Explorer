import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { STORAGE_KEYS, normalizeSettings } from '../src/lib/state.js';
import { LEGACY_PROFILE_STORAGE_KEYS, PROFILE_STORAGE_KEYS } from '../src/lib/profile-transfer.js';
import {
  TUNER_CARD_SIZES, normalizeTunerCardSize, tunerCardsShowPictures,
} from '../src/lib/tuner-card-size.js';
import { TUNER_ART_SETTLE_MS, createTunerCardArt } from '../src/lib/tuner-card-art.js';

/* Discussion #8: the knob shows only the station name, and the strip's cards
   come in three sizes (Settings > Appearance > Tuner card size); Medium and
   Large show the station's picture. The dial is sized from what the strip
   leaves, so each size has one fixed height, and pictures load only once the
   dial rests, only for cards in view. */

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
  assert.match(display, /ui\.stationName\.textContent = `\$\{isFavorite\(s\.id\) \? '\\u2605 ' : ''\}\$\{s\.title\}`;/);
  assert.doesNotMatch(display, /getSourceLabel|\u00b7|\\u00b7/);
  // The source is still on every card: its second line and its tooltip.
  const strip = tuner.match(/function renderStrip\(\) \{[\s\S]*?\n\}/)[0];
  const tooltip = tuner.match(/function setPillTrouble\(pill\) \{[\s\S]*?\n\}/)[0];
  assert.match(tooltip, /`\$\{pill\.__saved \? '\u2605 Favorite \u00b7 ' : ''\}\$\{s\.title\} \u00b7 \$\{getSourceLabel\(s\.source\)\}\$\{stream \? `\\n\$\{stream\}` : ''\}`\s+\+ `\$\{trouble \? `\\n\$\{trouble\}` : ''\}`/);
  assert.match(strip, /el\('small', \{ text: getSourceLabel\(s\.source\) \}\)/);
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
  assert.match(tuner, /ui\.root\?\.setAttribute\('data-card-size', next\);\s+if \(!cardPictures\(\)\) cardArt\.clear\(\);\s+renderStrip\(\);/);
});

/* ---------------- Sizes: one fixed height each ---------------- */

const SIZES = {
  medium: { card: 56, art: 40, strip: 87, narrow: 83 },
  large: { card: 84, art: 64, strip: 115, narrow: 111 },
};

test('each size has one fixed card height, and the strip grows by exactly as much', async () => {
  const css = await read('src/styles/tuner.css');
  const library = await read('src/styles/library.css');
  assert.doesNotMatch(css, /line-height: normal/);
  const badge = rule(library, '.content-rating-badge');
  assert.match(badge, /font-size: 10px;[\s\S]*line-height: 1\.2;/);
  const badgeHeight = 10 * 1.2 + 3 * 2 + 1 * 2;
  const pill = rule(css, '.station-pill');
  const border = Number(pill.match(/border: (\d+)px solid/)[1]);
  const narrowAt = css.indexOf('@media (max-width: 760px)');
  assert.ok(narrowAt > 0);

  for (const [size, expected] of Object.entries(SIZES)) {
    const vars = rule(css, `.tuner-root[data-card-size='${size}']`);
    const card = px(vars, '--card-h');
    const pad = px(vars, '--card-pad');
    const art = px(vars, '--card-art');
    const nameLine = px(vars, '--card-name-line');
    const sourceLine = px(vars, '--card-source-line');
    const lineGap = px(vars, '--card-line-gap');
    assert.equal(card, expected.card, `${size} card height`);
    assert.equal(art, expected.art, `${size} picture size`);
    // The picture fills the content box exactly: border + padding + picture.
    assert.equal(border * 2 + pad * 2 + art, card, `${size}: the parts add up to the card`);
    // Both text lines (and the badge) fit beside it with fixed line heights.
    assert.ok(nameLine + lineGap + sourceLine <= art, `${size}: text fits`);
    assert.ok(badgeHeight <= art, `${size}: badge fits`);
    assert.ok(px(vars, '--card-name') <= nameLine && px(vars, '--card-source') <= sourceLine);
    // Strip: border-top 1 + padding 12 + 12 + card + scrollbar 6 (10 + 10 narrow).
    const strip = rule(css, `.tuner-root[data-card-size='${size}'] .tuner-strip`);
    assert.equal(px(strip, 'min-height'), 1 + 12 + 12 + card + 6);
    assert.equal(px(strip, 'min-height'), expected.strip);
    const narrow = rule(css, `.tuner-root[data-card-size='${size}'] .tuner-strip`, narrowAt);
    assert.equal(px(narrow, 'min-height'), 1 + 10 + 10 + card + 6);
    assert.equal(px(narrow, 'min-height'), expected.narrow);
  }
  // The narrow overrides come after the base ones (same selector weight).
  assert.ok(css.lastIndexOf(".tuner-root[data-card-size='large'] .tuner-strip") > narrowAt);
  assert.match(css, /\.tuner-strip::-webkit-scrollbar \{ height: 6px; \}/);
  assert.match(rule(css, '.tuner-strip'), /padding: 12px 16px;/);

  // The card's own rules: fixed height from the variable, rows that split the
  // content box, a fixed line height for every line.
  const art = rule(css, '.station-pill.has-art');
  assert.match(art, /height: var\(--card-h\);/);
  assert.match(art, /padding: var\(--card-pad\) 14px var\(--card-pad\) var\(--card-pad\);/);
  assert.match(art, /grid-template-columns: var\(--card-art\) auto auto;/);
  assert.match(art, /grid-template-rows: 1fr 1fr;/);
  assert.match(art, /line-height: var\(--card-name-line\);/);
  assert.match(pill, /box-sizing: border-box;/);
  assert.match(rule(css, '.station-pill.has-art > small'), /line-height: var\(--card-source-line\);/);
  assert.match(rule(css, '.station-pill.has-art > .pill-art + span'), /max-width: 18em;[\s\S]*text-overflow: ellipsis;/);
  // The picture box never depends on its picture: fixed size, the image and
  // the initials laid over it.
  const box = rule(css, '.pill-art');
  assert.match(box, /width: var\(--card-art\);\s+height: var\(--card-art\);/);
  assert.match(box, /overflow: hidden;/);
  assert.match(rule(css, '.pill-initials'), /position: absolute;\s+inset: 0;/);
  assert.match(rule(css, '.pill-initials'), /line-height: var\(--card-initials\);/);
  // Three and four letters (SWR3, WWWW) fit the box with room on both sides:
  // bold Segoe UI is at most about 1.005 em a letter (W), measured in Chromium.
  const boxes = { medium: px(rule(css, ".tuner-root[data-card-size='medium']"), '--card-art'),
    large: px(rule(css, ".tuner-root[data-card-size='large']"), '--card-art') };
  for (const letters of [3, 4]) {
    const body = rule(css, `.pill-initials[data-length='${letters}']`);
    const factor = Number(body.match(/font-size: calc\(var\(--card-art\) \* ([\d.]+)\);/)?.[1]);
    assert.ok(factor > 0, `${letters} letters have a size from the box`);
    assert.match(body, /letter-spacing: 0;/);
    for (const [size, box] of Object.entries(boxes)) {
      const width = letters * 1.005 * factor * box;
      assert.ok(width <= box - 2, `${letters} wide letters (${width.toFixed(1)} px) fit the ${size} ${box} px box`);
    }
  }
  // One or two letters keep the size they had; the box keeps its size.
  assert.match(rule(css, ".tuner-root[data-card-size='medium']"), /--card-art: 40px;[\s\S]*--card-initials: 15px;/);
  assert.match(rule(css, ".tuner-root[data-card-size='large']"), /--card-art: 64px;[\s\S]*--card-initials: 22px;/);
  const img = rule(css, '.pill-art-img');
  assert.match(img, /position: absolute;\s+inset: 0;/);
  assert.match(img, /width: 100%;\s+height: 100%;/);
  assert.match(img, /opacity: 0;/);
  // The user's own picture is shown whole, never cropped.
  assert.match(rule(css, '.pill-art-img.is-station-image'), /object-fit: contain;/);
  assert.doesNotMatch(css.slice(css.indexOf('.pill-art {')), /object-fit: cover/);
});

test('a dial made small by big cards drops knob lines instead of cutting them off', async () => {
  const css = await read('src/styles/tuner.css');
  // The dial is the size container of the knob text.
  assert.match(rule(css, '.tuner-dial'), /container-type: inline-size;/);
  const blocks = css.match(/@container \(max-width: \d+px\) \{[\s\S]*?\}\s*\}/g);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /^@container \(max-width: 159px\)/);
  assert.match(blocks[0], /\.tuner-root\[data-card-size='medium'\] \.tuner-frequency \.station-name,\s+\.tuner-root\[data-card-size='large'\] \.tuner-frequency \.station-name \{ display: none; \}/);
  assert.match(blocks[1], /^@container \(max-width: 99px\)/);
  assert.match(blocks[1], /\.tuner-root\[data-card-size='large'\] \.tuner-frequency \.freq-unit \{ display: none; \}/);
  // Only for the larger sizes; Small keeps today's knob.
  for (const block of blocks) {
    assert.doesNotMatch(block, /data-card-size='small'/);
    assert.doesNotMatch(block.replace(/^@container[^{]*\{/, ''), /width|height|padding|margin/);
  }
});

test('Small stays exactly as it was: text-only cards, 39 px, strip 70 px (66 narrow)', async () => {
  const css = await read('src/styles/tuner.css');
  const pill = rule(css, '.station-pill');
  assert.equal(px(pill, 'height'), 39);
  assert.equal(px(pill, 'line-height'), 14);
  assert.match(pill, /padding: 6px 12px;/);
  assert.match(pill, /font-size: 12px;/);
  assert.match(pill, /grid-template-columns: auto auto;/);
  assert.equal(px(rule(css, '.tuner-strip'), 'min-height'), 70);
  assert.match(css, /\.tuner-strip \{\s+padding: 10px 12px;\s+min-height: 66px;\s+\}/);
  // No rule targets the small size: everything new needs a larger size
  // attribute or the has-art class, which only medium and large cards get.
  assert.doesNotMatch(css, /data-card-size='small'/);
  const original = new Set([
    '.station-pill', '.station-pill > small', '.station-pill > .content-rating-badge',
    '.station-pill.is-active > small', '.station-pill:hover', '.station-pill.is-favorite:not(.is-active)',
    '.station-pill.is-active',
    // A long name ends in an ellipsis at every size (the height is unchanged).
    '.station-pill > span:not(.content-rating-badge):not(.pill-art)',
    // "Did not play last time": laid over the corner, so the size is unchanged.
    '.station-pill.has-trouble', '.station-pill > .pill-trouble',
  ]);
  assert.match(rule(css, '.station-pill > .pill-trouble'), /position: absolute;/);
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{/g)
    .flatMap((raw) => raw.slice(0, -1).split(',').map((part) => part.trim()));
  assert.ok(selectors.includes('.station-pill.has-art'));
  for (const selector of selectors) {
    if (selector.includes('data-card-size')) assert.match(selector, /data-card-size='(medium|large)'/, selector);
    if (selector.includes('.station-pill') && !original.has(selector)) assert.match(selector, /\.has-art/, selector);
  }
  const tuner = await read('src/modes/tuner.js');
  const strip = tuner.match(/function renderStrip\(\) \{[\s\S]*?\n\}/)[0];
  // Small: no picture element (so no image request) and no extra class.
  assert.match(strip, /const pictures = cardPictures\(\);/);
  assert.match(strip, /\+ \(pictures \? ' has-art' : ''\),/);
  assert.match(tuner, /pill\.classList\.toggle\('has-trouble', Boolean\(trouble\)\);/);
  assert.match(strip, /pictures \? cardArt\.box\(s\) : null,\s+el\('span', \{ text: saved \? `\u2605 \$\{s\.title\}` : s\.title \}\),/);
  assert.match(strip, /if \(pictures\) cardArt\.commit\(\);\s+\}$/);
  assert.match(tuner, /function cardPictures\(\) \{\s+return tunerCardsShowPictures\(state\.cardSize\);\s+\}/);
  // The Tuner leaves the art controller when it is torn down.
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

/** A Tuner strip driven like tuner.js: 31 cards around `index`, of which
 *  the 7 nearest the active card are in view. */
function harness({ loadImpl, resolveImpl, custom = () => '', visible = 3 } = {}) {
  const timers = [];
  const owners = new Map();
  let index = 0;
  const calls = { load: [], resolve: [] };
  const art = createTunerCardArt({
    doc,
    isInView: (box) => Math.abs(owners.get(box) - index) <= visible,
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
  const strip = new Node('div');
  function render(at) {
    index = at;
    strip.children = [];
    const boxes = [];
    for (let i = Math.max(0, at - 15); i < Math.min(stations.length, at + 16); i += 1) {
      const pill = strip.appendChild(new Node('button'));
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
  // Rested on station 99: only the cards in view (96..99 on screen) start.
  assert.equal(fire(), 1);
  await flush();
  const shown = new Set(calls.load.map(({ img }) => img.parent));
  assert.equal(art.stats.started, 4);
  assert.equal(calls.load.length, 4);
  assert.equal(calls.resolve.length, 2); // 96 and 98 had no artwork yet
  assert.equal(shown.size, 4);
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
  const { render, fire, calls } = harness();
  const before = render(50);
  fire();
  await flush();
  const box = before[15];
  const img = box.children.find((child) => child.tagName === 'IMG');
  assert.ok(img.classList.contains('loaded'));
  const after = render(51);
  // The same box (with the same decoded image) is in the new card at once.
  assert.equal(after[14], box);
  assert.equal(box.children.find((child) => child.tagName === 'IMG'), img);
  assert.ok(img.classList.contains('loaded'));
  assert.equal(calls.load.filter((call) => call.img === img).length, 1);
});

test('a load in flight is not restarted while its card stays in the strip, and stops when it leaves', async () => {
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
  // A few steps on: those cards are still in the strip, so their loads go on.
  for (let step = 61; step <= 63; step += 1) { render(step); fire(); await flush(); }
  assert.equal(calls.load.filter(({ img }) => pending.slice(0, 7).some((p) => p.img === img)).length, 7);
  assert.equal(pending.slice(0, 7).filter(({ signal }) => signal.aborted).length, 0);
  assert.equal(calls.load.length, 10); // only 64, 65, 66 are new
  // Far away: every card of the old strip leaves it; their loads stop.
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
  const { art, render, fire, calls } = harness({
    loadImpl: () => Promise.reject(new Error('Artwork image could not load.')),
  });
  const boxes = render(20);
  fire();
  await flush();
  assert.equal(calls.load.length, 7);
  const box = boxes[15];
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
  const { render, fire, calls } = harness({
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
  const imgs = boxes[15].children.filter((child) => child.tagName === 'IMG');
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

