import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

import { SOURCES, SOURCE_IDS, loadAdapter } from '../src/lib/sources.js';
import { getState, setShowExplicitContent } from '../src/lib/state.js';
import { searchOne, browseLiveOne } from '../src/lib/search.js';

const root = new URL('../', import.meta.url);
const read = (relative) => readFile(new URL(relative, root), 'utf8');

const EXPECTED_IDS = Object.freeze([
  'radio-browser', 'iptv-org', 'internet-archive', 'nasa', 'wikimedia', 'librivox',
  'media-ccc', 'library-of-congress', 'gpodder', 'peertube', 'owncast',
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
  };
}

function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4));
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function cssBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'));
  assert.ok(match, `missing CSS block ${selector}`);
  return match[1];
}

function cssVariable(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  assert.ok(match, `missing --${name}`);
  return match[1].toLowerCase();
}

test('the source registry is one immutable eleven-entry authority with one lazy adapter each', async () => {
  assert.deepEqual(SOURCE_IDS, EXPECTED_IDS);
  assert.equal(new Set(SOURCE_IDS).size, 11);
  assert.equal(Object.isFrozen(SOURCES), true);
  assert.equal(Object.isFrozen(SOURCE_IDS), true);

  for (const source of SOURCES) {
    assert.equal(Object.isFrozen(source), true, `${source.id} metadata must be immutable`);
    assert.equal(Object.isFrozen(source.types), true);
    assert.equal(Object.isFrozen(source.capabilities), true);
    assert.match(source.homepage, /^https:\/\//);
    assert.ok(source.description.length >= 24);
    assert.ok(source.rightsNote.length >= 24);
    assert.ok(source.types.length > 0);
    assert.ok(source.capabilities.length >= 3);
    const adapter = await loadAdapter(source.id);
    assert.equal(adapter.id, source.id);
  }
});

test('Settings, About, Library, live modes, Discovery, and the production harness consume the registry', async () => {
  const files = Object.fromEntries(await Promise.all([
    'src/lib/settings.js',
    'src/modes/about.js',
    'src/modes/library/sidebar.js',
    'src/modes/tuner.js',
    'src/modes/grid.js',
    'src/modes/discovery.js',
    'src/test-adapter.html',
  ].map(async (name) => [name, await read(name)])));

  assert.match(files['src/lib/settings.js'], /SOURCES\.map\(\(s\)/);
  assert.match(files['src/lib/settings.js'], /source\.description/);
  assert.match(files['src/modes/about.js'], /SOURCES\.map/);
  assert.match(files['src/modes/about.js'], /s\.rightsNote/);
  assert.match(files['src/modes/library/sidebar.js'], /items:\s*SOURCES\.map/);
  for (const name of ['src/modes/tuner.js', 'src/modes/grid.js']) {
    assert.match(files[name], /function liveSources\(\)/);
    assert.match(files[name], /source\.capabilities\.some/);
    assert.match(files[name], /contentAwareLiveSourceIds/);
    assert.match(files[name], /enabledSignature/);
  }
  assert.match(files['src/modes/discovery.js'], /SOURCES\.filter/);
  assert.match(files['src/test-adapter.html'], /SOURCES/);
  assert.match(files['src/test-adapter.html'], /loadAdapter/);

  const productionJs = (await readdir(new URL('src/', root), { recursive: true }))
    .filter((name) => name.endsWith('.js'));
  const productionEntries = await Promise.all(productionJs.map(async (name) => [
    name.replaceAll('\\', '/'),
    await read(`src/${name.replaceAll('\\', '/')}`),
  ]));
  const combined = productionEntries.map(([, text]) => text).join('\n');
  assert.doesNotMatch(combined, /SOURCES_INFO|function\s+dotColor/);
  assert.doesNotMatch(combined, /\[['"]radio-browser['"],\s*['"]iptv-org['"],\s*['"]internet-archive/,
    'no production mode may retain the former six-source array');

  const setterCallers = productionEntries
    .filter(([name]) => name !== 'lib/state.js')
    .filter(([, text]) => /setShowExplicitContent\s*\(/.test(text))
    .map(([name]) => name);
  assert.deepEqual(setterCallers, ['lib/settings.js']);
});

test('central policy overrides caller options and IPTV reveals cached ratings without a refetch', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  let requests = 0;
  globalThis.localStorage = memoryStorage();
  globalThis.fetch = async (input) => {
    requests += 1;
    const url = String(input);
    if (url.endsWith('/streams.json')) return json([
      { channel: 'safe.us', title: 'Safe Music', url: 'https://safe.example/live.m3u8' },
      { channel: 'explicit.us', title: 'Marked Music', url: 'https://marked.example/live.m3u8' },
    ]);
    if (url.endsWith('/channels.json')) return json([
      { id: 'safe.us', name: 'Safe Music', country: 'US', languages: ['eng'], categories: ['music'], is_nsfw: false },
      { id: 'explicit.us', name: 'Marked Music', country: 'US', languages: ['eng'], categories: ['music'], is_nsfw: true },
    ]);
    if (url.endsWith('/logos.json')) return json([]);
    throw new Error(`unexpected IPTV request ${url}`);
  };

  try {
    setShowExplicitContent(false);
    const hidden = await searchOne('iptv-org', 'music', {
      showExplicitContent: true,
      throwOnError: true,
    });
    assert.deepEqual(hidden.map((item) => item.content_rating), ['not-explicit']);
    assert.equal(requests, 3);

    setShowExplicitContent(true);
    const shown = await searchOne('iptv-org', 'music', {
      showExplicitContent: false,
      throwOnError: true,
    });
    assert.deepEqual(shown.map((item) => item.content_rating).sort(), ['explicit', 'not-explicit']);
    assert.equal(requests, 3, 'the reversible preference must reuse the joined IPTV cache');

    const live = await browseLiveOne('iptv-org', {
      type: 'tv', country: 'US', tag: 'music', showExplicitContent: false,
    });
    assert.equal(live.length, 2, 'persisted preference also overrides live-mode caller options');
    assert.equal(requests, 3);
  } finally {
    setShowExplicitContent(false);
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  }
  assert.equal(getState().settings.showExplicitContent, false);
});

test('all source colors are unique and clear the 3:1 non-text contrast gate in dark and light palettes', async () => {
  const css = await read('src/styles/base.css');
  const dark = cssBlock(css, ':root');
  const light = cssBlock(css, ":root[data-theme='light']");
  const darkSurface = cssVariable(dark, 'bg-elev-1');
  const lightSurface = cssVariable(light, 'bg-elev-1');
  const darkColors = [];
  const lightColors = [];
  for (const id of EXPECTED_IDS) {
    const name = `source-${id}`;
    const darkColor = cssVariable(dark, name);
    const lightColor = cssVariable(light, name);
    darkColors.push(darkColor);
    lightColors.push(lightColor);
    assert.ok(contrast(darkColor, darkSurface) >= 3, `${id} dark mark lacks contrast`);
    assert.ok(contrast(lightColor, lightSurface) >= 3, `${id} light mark lacks contrast`);
  }
  assert.equal(new Set(darkColors).size, 11);
  assert.equal(new Set(lightColors).size, 11);
  assert.match(css, /Source hues are decorative identifiers only/);
});

test('minimum-width/player/detail layout and keyboard/status contracts remain connected', async () => {
  const [base, library, sidebar, shell] = await Promise.all([
    read('src/styles/base.css'),
    read('src/styles/library.css'),
    read('src/modes/library/sidebar.js'),
    read('src/modes/library/shell.js'),
  ]);
  assert.match(base, /#app\.has-player\s*\{[\s\S]*?minmax\(0, 1fr\) var\(--player-h\)/);
  assert.match(base, /@media \(max-width: 1000px\)/);
  assert.match(base, /@media \(max-width: 560px\)/);
  assert.match(library, /\.library-root\s*\{[\s\S]*?height:\s*100%/);
  assert.match(library, /\.source-list\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(library, /@media \(max-width: 980px\)/);
  assert.match(library, /\.results-status\s*\{[\s\S]*?block-size:\s*26px/);
  assert.match(library, /\.results-status\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(library, /\.source-item \.source-count\s*\{[\s\S]*?flex:\s*0 0 4ch/);
  assert.match(library, /\.source-item \.source-health\s*\{[\s\S]*?flex:\s*0 0 34px/);
  assert.match(library, /\.detail-panel\s*\{[\s\S]*?position:\s*absolute[\s\S]*?inset:\s*0/);
  assert.match(sidebar, /role:\s*'listbox'/);
  assert.match(sidebar, /role:\s*'option'/);
  assert.match(sidebar, /aria-selected/);
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']) assert.match(sidebar, new RegExp(key));
  assert.match(sidebar, /scrollIntoView/);
  assert.match(shell, /role:\s*'status'/);
  assert.match(shell, /'aria-live':\s*'polite'/);
});
