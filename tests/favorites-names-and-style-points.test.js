import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FX_LABELS, FX_TABLE, fxCatalog } from '../src/visualizer/fx-catalog.js';
import { americanText } from '../src/visualizer/spelling.js';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css, selector) {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `a rule for ${selector}`);
  return css.slice(at + selector.length + 2, css.indexOf('}', at));
}

const px = (declarations, property) => {
  const match = declarations.match(new RegExp(`(?:^|[;\\s])${property}:\\s*([0-9.]+)px`));
  assert.ok(match, `${property} in ${declarations}`);
  return Number(match[1]);
};

test('a long favorite name takes a second line on the saved-items cards, then ends in an ellipsis', async () => {
  const css = await read('src/styles/library.css');
  const title = rule(css, '.library-root.is-personal-view .card-title');
  for (const part of ['display: -webkit-box', '-webkit-box-orient: vertical', '-webkit-line-clamp: 2', 'line-clamp: 2',
    'white-space: normal', 'overflow: hidden', 'overflow-wrap: anywhere']) {
    assert.ok(title.includes(part), part);
  }
  assert.doesNotMatch(title, /nowrap/);
  // Two lines of the title and the meta line fit the card's picture height,
  // so a card with a long name is no taller than one without.
  const base = rule(css, '.card-title');
  const lineHeight = px(base, 'line-height');
  const body = rule(css, '.library-root.is-personal-view .card-body');
  assert.match(body, /padding: 8px 44px 8px 12px/);
  const thumb = rule(css, '.library-root.is-personal-view .card-thumb');
  const cardHeight = px(thumb, 'height') + 2 * 8; // 8 px margin above and below the picture
  assert.ok(8 + 2 * lineHeight + 4 + 16 + 8 <= cardHeight, 'two title lines, the gap, one meta line and the padding');
});

test('every card in a row has the same height and its content stays centred; nothing runs under the buttons', async () => {
  const css = await read('src/styles/library.css');
  // The grid stretches each card to the row's height (no align-items set).
  assert.doesNotMatch(rule(css, '.library-root.is-personal-view .cards-grid'), /align-items/);
  assert.doesNotMatch(rule(css, '.cards-grid'), /align-items/);
  // The card's content fills the stretched card, so it stays centred on the
  // buttons, which are centred on the card.
  const open = rule(css, '.library-root.is-personal-view .card-open');
  assert.ok(open.includes('flex: 1 1 auto') && open.includes('align-items: center'));
  assert.match(rule(css, '.library-root.is-personal-view .card-star'), /top: 50%/);
  assert.match(rule(css, '.card-order'), /top: 50%/);
  assert.match(rule(css, '.card-category'), /top: 50%/);
  // The body's right padding keeps the wrapped name clear of the star, the
  // category button and the move buttons, whichever the card has.
  assert.match(css, /\.library-root\.is-personal-view \.card\.has-order-controls \.card-body \{ padding-right: 100px; \}/);
  assert.match(css, /\.library-root\.is-personal-view \.card\.has-category-control \.card-body \{ padding-right: 70px; \}/);
  assert.match(css, /\.library-root\.is-personal-view \.card\.has-category-control\.has-order-controls \.card-body \{ padding-right: 126px; \}/);
});

test('the whole name is the card tooltip', async () => {
  const render = await read('src/modes/library/render.js');
  const card = render.slice(render.indexOf('function renderCard('), render.indexOf("const thumb = el('div', { className: 'card-thumb' });"));
  assert.match(card, /className: 'card-open',[\s\S]*'aria-label': `Open \$\{item\.title \|\| 'Untitled'\} from \$\{sourceLabel\}`,[\s\S]*title: item\.title \|\| 'Untitled',/);
  assert.match(render, /className: 'card-title',\n\s+text: item\.title \|\| 'Untitled',\n\s+attrs: \{ title: item\.title \|\| 'Untitled' \},/);
});

test('with technical details on, the source status label goes under the count and a long source name keeps the room', async () => {
  const css = await read('src/styles/library.css');
  const at = css.indexOf('@media (min-width: 981px) {\n  :root[data-tech-details="on"] .source-item:has(> .source-health) {');
  assert.ok(at >= 0, 'only in the wide layout and only with technical details on');
  const block = css.slice(at, css.indexOf('\n}\n', at));
  const row = rule(block, ':root[data-tech-details="on"] .source-item:has(> .source-health)');
  for (const part of ['display: grid', 'grid-template-columns: minmax(0, 1fr) auto', 'grid-template-areas: "name count" "name health"']) {
    assert.ok(row.includes(part), part);
  }
  const count = rule(block, ':root[data-tech-details="on"] .source-item:has(> .source-health) > .source-count');
  const health = rule(block, ':root[data-tech-details="on"] .source-item:has(> .source-health) > .source-health');
  assert.match(health, /grid-area: health/);
  assert.match(health, /width: auto/);
  // The row keeps its height: padding, the count line and the label line fit in it.
  const minHeight = px(rule(css, '.source-item'), 'min-height');
  assert.ok(2 * px(row, 'padding-block') + px(count, 'line-height') + px(health, 'line-height') <= minHeight);
  // The label still says the same and its hover text is kept.
  const render = await read('src/modes/library/render.js');
  assert.match(render, /healthSpan\.textContent = health\.text;/);
});

test('the Psychedelia Studio link and "What this means" use the app link color', async () => {
  const about = await read('src/styles/about.css');
  assert.equal(rule(about, '.about-section p a').trim(), 'color: var(--accent);');
  assert.match(rule(about, '.about-source-meta a'), /color: var\(--accent\)/);
  const credits = await read('src/modes/about-credits.js');
  assert.match(credits, /const intro = el\('p'\);[\s\S]*link\(PSYCHEDELIA_URL, origin\)/);
  assert.match(credits, /el\('section', 'about-section about-credits'\)/);
  const base = await read('src/styles/base.css');
  assert.equal(rule(base, '.modal-body .description a').trim(), 'color: var(--accent);');
  assert.match(base, /\.tool-disclosure a \{ color: var\(--accent\); \}/);
  const settings = await read('src/lib/settings.js');
  assert.match(settings, /<div class="modal-body">/);
  assert.match(settings, /<span class="description" id="settings-processor-use-hint">\$\{PROCESSOR_USE_HINT\}\n\s+<a href="#about-processor-use" data-act="processor-about">What this means<\/a><\/span>/);
});

test('the local port line in Settings has the size and color of the other descriptions', async () => {
  const base = await read('src/styles/base.css');
  const row = rule(base, '.row .description');
  const own = rule(base, '.modal-body p.description');
  assert.equal(px(own, 'font-size'), px(row, 'font-size'));
  assert.match(own, /color: var\(--text-dim\)/);
  assert.match(base, /\.modal-body p\.description\[data-state="error"\] \{ color: var\(--danger\); \}/);
  const settings = await read('src/lib/settings.js');
  assert.match(settings, /<p id="settings-server-port-status" class="description" data-server-port-status/);
  assert.match(settings, /serverPortStatus\.dataset\.state = 'error';/);
});

test('Heat Haze is named for what it draws, and every effect name fits on one line of the list', async () => {
  const vendor = await read('src/visualizer/vendor/psychedelia/engine/post-fx-library.js');
  // The app pins the pass to its first mode, which is heat haze only.
  assert.equal(FX_TABLE.heat_haze.ranges.mode, 0);
  assert.match(vendor, /name: 'heat_haze', label: 'Heat Haze & Caustic Light'[\s\S]*?mode: sel\('Effect', \['Heat Haze', 'Caustic Light', 'Both'\], 2\)/);
  assert.deepEqual({ ...FX_LABELS }, { heat_haze: 'Heat Haze' });
  const library = {
    list: () => [
      { name: 'heat_haze', label: 'Heat Haze & Caustic Light', category: 'Distort' },
      { name: 'watercolor', label: 'Watercolour', category: 'Colour' },
    ],
  };
  const catalog = fxCatalog(library);
  assert.equal(catalog.find((fx) => fx.id === 'heat_haze').label, 'Heat Haze');
  const watercolor = catalog.find((fx) => fx.id === 'watercolor');
  if (watercolor) assert.equal(watercolor.label, 'Watercolor');
  // Every offered effect's shown name is at most as long as "Chromatic
  // Aberration", which fits one line of a column of the list.
  const offered = [...vendor.matchAll(/name: '([a-z0-9_]+)', label: '([^']+)'/g)]
    .filter(([, name]) => FX_TABLE[name]);
  assert.ok(offered.length >= 30, `found ${offered.length} offered effects`);
  for (const [, name, label] of offered) {
    const shown = FX_LABELS[name] || americanText(label);
    assert.ok(shown.length <= 'Chromatic Aberration'.length, `${shown} fits one line`);
  }
});

test('the Visualizer panel is nearly opaque, so bright overlays do not show through behind its text', async () => {
  const css = await read('src/visualizer/visualizer.css');
  const panel = rule(css, '.viz-panel');
  const match = panel.match(/background: rgba\(12, 13, 17, ([0-9.]+)\);/);
  assert.ok(match, 'the same dark panel color');
  assert.ok(Number(match[1]) >= 0.98 && Number(match[1]) < 1, `opacity ${match[1]}`);
});

test('an empty star on a Favorites or My Playlists card takes the text color, a full one the accent', async () => {
  const css = await readFile(new URL('../src/styles/library.css', import.meta.url), 'utf8');
  // These cards draw the star without the dark square, so a white star would
  // not show on a light theme's card.
  assert.match(css, /\.library-root\.is-personal-view \.card-star:not\(\.is-fav\) \{ color: var\(--text\); \}/);
  assert.match(css, /\.card-star\.is-fav \{ color: var\(--accent\); \}/);
});
