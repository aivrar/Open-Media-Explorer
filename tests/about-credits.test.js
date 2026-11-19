import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CREDIT_TEXT, PIECE_LABELS, PSYCHEDELIA_URL, buildVisualizerCredits, creditEntries, shareAlikeLabel, webLink,
} from '../src/modes/about-credits.js';
import { CREDITS_FAILED_TEXT, NOTICES_LINK_TEXT, showVisualizerCredits } from '../src/modes/about.js';
import { HELD_SCENE_ENTRIES, SCENES } from '../src/visualizer/scenes.js';
import { FakeNodeEl } from './helpers/visualizer-fakes.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('src/visualizer/vendor/psychedelia/manifest.json'));
const names = new Map([...SCENES, ...HELD_SCENE_ENTRIES].map((entry) => [entry.id, entry.name]));
const sceneName = (id) => names.get(id) || null;
const doc = { createElement: (tag) => new FakeNodeEl(tag) };
const all = (node) => [node, ...node.descendants()];
const textOf = (node) => all(node).map((n) => n.textContent).join('');
const build = (data = manifest) => buildVisualizerCredits(doc, data, sceneName);
const cardOf = (section, piece) => all(section).find((n) => n.getAttribute('data-piece') === piece);
const ddAfter = (card, term) => {
  const meta = card.descendants().find((n) => n.tagName === 'DL');
  const at = meta.children.findIndex((n) => n.tagName === 'DT' && n.textContent === term);
  return at >= 0 ? meta.children[at + 1] : null;
};

test('visualizer credits: every borrowed row of the manifest appears (its piece, with its scene), with author, licence and source', () => {
  assert.equal(manifest.borrowed.length, 55);
  const section = build();
  for (const row of manifest.borrowed) {
    const card = cardOf(section, row.piece);
    assert.ok(card, `a card for ${row.piece}`);
    const place = row.scene === '*'
      ? (/post-fx-library\.js$/.test(row.file) ? CREDIT_TEXT.postEffects : CREDIT_TEXT.everyScene)
      : sceneName(row.scene);
    assert.ok(place, `${row.scene} is a scene of the build (shown or held)`);
    assert.ok(textOf(ddAfter(card, 'Scenes')).split(', ').includes(place), `${row.piece}: ${place}`);
    assert.equal(textOf(ddAfter(card, 'Author')), row.author);
    assert.ok(textOf(ddAfter(card, 'Licence')).startsWith(row.licence), `${row.piece}: its licence as stated`);
    const source = ddAfter(card, 'Source');
    if (row.link) assert.equal(source.children[0].getAttribute('href'), row.link);
    else assert.equal(textOf(source), row.linkNote);
  }
  // One card per piece (the manifest repeats a piece per scene), each named.
  const pieces = [...new Set(manifest.borrowed.map((row) => row.piece))];
  assert.equal(all(section).filter((n) => n.getAttribute('data-piece')).length, pieces.length);
  for (const piece of pieces) assert.ok(PIECE_LABELS[piece], `a name for ${piece}`);
  assert.equal(all(section).find((n) => n.tagName === 'SUMMARY').textContent, CREDIT_TEXT.summary(pieces.length));
  assert.ok(all(section).some((n) => n.tagName === 'DETAILS'), 'collapsed behind a details');
});

test('visualizer credits: Psychedelia Studio first, with its licence as the manifest states it', () => {
  const section = build();
  const intro = section.children.find((n) => n.tagName === 'P');
  assert.match(textOf(intro), /The Visualizer is ported from Psychedelia Studio, by the same author \(Copyright \(c\) 2026 aivrar\), under the MIT licence/);
  assert.equal(manifest.license, 'MIT');
  assert.equal(intro.children.find((n) => n.tagName === 'A').getAttribute('href'), PSYCHEDELIA_URL);
  assert.equal(PSYCHEDELIA_URL, 'https://github.com/aivrar/psychedelia-studio');
});

test('visualizer credits: the share-alike piece carries its own licence label; the no-licence piece is marked in the notices\' words', () => {
  const section = build();
  const shareAlike = manifest.borrowed.filter((row) => /ShareAlike/.test(row.licence));
  assert.deepEqual(shareAlike.map((row) => row.piece), ['iq-apollonian']);
  const apollonian = cardOf(section, 'iq-apollonian');
  const flag = apollonian.descendants().find((n) => n.getAttribute('data-flag') === 'share-alike');
  assert.equal(flag.textContent, 'CC BY-NC-SA 3.0');
  assert.match(textOf(ddAfter(apollonian, 'Licence')), /This part stays under CC BY-NC-SA 3\.0\. It is not covered by the MIT licence above\./);
  assert.equal(cardOf(section, 'iq-normals').descendants().some((n) => n.getAttribute('data-flag')), false, 'no mark on an MIT piece');
  const unstated = manifest.borrowed.filter((row) => row.noLicenceStated);
  assert.deepEqual(unstated.map((row) => row.piece), ['knighty-pseudo-kleinian']);
  const knighty = cardOf(section, 'knighty-pseudo-kleinian');
  assert.equal(knighty.descendants().find((n) => n.getAttribute('data-flag') === 'no-licence').textContent, 'No licence stated');
  const licence = textOf(ddAfter(knighty, 'Licence'));
  assert.ok(licence.startsWith('no licence stated at the source'));
  assert.ok(licence.endsWith("Used with credit; it remains under its author's terms."));
  // The same words as the notices.
  const notices = read('public/THIRD_PARTY_NOTICES.txt').replace(/\s+/g, ' ');
  assert.ok(notices.includes("Used with credit; it remains under its author's terms."));
  assert.ok(notices.includes('It is not covered by the MIT licence above.'));
  assert.equal(shareAlikeLabel('MIT'), null);
});

test('visualizer credits: a link that is not http(s) is shown as text, never as a link; links open as the page\'s others do', () => {
  for (const bad of ['javascript:alert(1)', 'file:///C:/x.txt', 'ftp://example.org/a', 'not a url', '']) assert.equal(webLink(bad), null, bad);
  assert.equal(webLink('https://iquilezles.org/articles/smin/'), 'https://iquilezles.org/articles/smin/');
  const data = {
    ...manifest,
    borrowed: [
      { scene: 'plasma', file: 'src/effects/plasma.js', piece: 'odd-link', author: 'Someone', link: 'javascript:alert(1)', licence: 'MIT', nonCommercial: false, noLicenceStated: false },
      { scene: 'plasma', file: 'src/effects/plasma.js', piece: 'file-link', author: 'Someone', link: 'file:///C:/x.txt', licence: 'MIT', nonCommercial: false, noLicenceStated: false },
    ],
  };
  const section = build(data);
  for (const [piece, link] of [['odd-link', 'javascript:alert(1)'], ['file-link', 'file:///C:/x.txt']]) {
    const source = ddAfter(cardOf(section, piece), 'Source');
    assert.equal(source.descendants().some((n) => n.tagName === 'A'), false, `${piece}: no link`);
    assert.equal(textOf(source), link, `${piece}: shown as text`);
  }
  assert.equal(cardOf(section, 'odd-link').descendants().find((n) => n.tagName === 'H3').textContent, 'odd-link', 'an unnamed piece: its id');
  for (const a of all(build()).filter((n) => n.tagName === 'A')) {
    assert.match(a.getAttribute('href'), /^https:\/\//);
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noreferrer');
  }
});

test('visualizer credits: built when the About page is shown, from their own chunk; the manifest only there', () => {
  const about = read('src/modes/about.js');
  assert.match(about, /import\('\.\/about-credits-load\.js'\)/);
  assert.doesNotMatch(about, /^import .*about-credits/m, 'no static import');
  assert.match(about, /data-about-credits-slot/);
  const loader = read('src/modes/about-credits-load.js');
  assert.match(loader, /import \{ borrowed, copyright, license, origin \} from '\.\.\/visualizer\/vendor\/psychedelia\/manifest\.json';/, 'only the keys it needs');
  for (const file of ['src/main.js', 'src/modes/about.js', 'src/modes/about-credits.js']) {
    assert.doesNotMatch(read(file), /manifest\.json'/, `${file} does not import the manifest`);
  }
  assert.equal(creditEntries(null).length, 0);
});

test('CREDITS.md and THIRD_PARTY_NOTICES.txt name every borrowed piece\'s author and source as the manifest does', () => {
  const flat = (text) => text.replace(/\s+/g, ' ');
  const credits = flat(read('CREDITS.md'));
  const notices = flat(read('public/THIRD_PARTY_NOTICES.txt'));
  for (const entry of creditEntries(manifest.borrowed, sceneName)) {
    for (const [name, text] of [['CREDITS.md', credits], ['THIRD_PARTY_NOTICES.txt', notices]]) {
      assert.ok(text.includes(`Author: ${entry.author}`) || text.includes(`Copyright (c) 2014 ${entry.author}`), `${name}: ${entry.author}`);
      if (entry.link) assert.ok(text.includes(entry.link), `${name}: ${entry.link}`);
    }
  }
  for (const file of manifest.files.map((f) => f.source)) {
    assert.ok(read('CREDITS.md').includes(file), `CREDITS.md lists ${file}`);
    assert.ok(read('public/THIRD_PARTY_NOTICES.txt').includes(file), `THIRD_PARTY_NOTICES.txt lists ${file}`);
  }
});

test('visualizer credits: rows of one piece with another attribution are shown as a credit of their own, not under the first', () => {
  const row = { scene: 'plasma', file: 'src/effects/plasma.js', piece: 'iq-smin', author: 'Inigo Quilez', link: 'https://iquilezles.org/articles/smin/', licence: 'MIT', nonCommercial: false, noLicenceStated: false };
  const other = { ...row, scene: 'tunnel', file: 'src/effects/tunnel.js', author: 'Someone Else', link: 'https://example.org/smin', licence: 'no licence stated at the source', noLicenceStated: true };
  const entries = creditEntries([row, other, { ...row, scene: 'starfield' }], sceneName);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => [e.author, e.places.join(', ')]), [['Inigo Quilez', 'Plasma, Starfield'], ['Someone Else', 'Tunnel']]);
  const section = build({ ...manifest, borrowed: [row, other] });
  const cards = all(section).filter((n) => n.getAttribute('data-piece') === 'iq-smin');
  assert.equal(cards.length, 2, 'both credits shown');
  assert.deepEqual(cards.map((card) => textOf(ddAfter(card, 'Author'))), ['Inigo Quilez', 'Someone Else']);
  assert.equal(ddAfter(cards[1], 'Source').children[0].getAttribute('href'), 'https://example.org/smin');
  assert.equal(cards[0].descendants().some((n) => n.getAttribute('data-flag') === 'no-licence'), false);
  assert.equal(cards[1].descendants().some((n) => n.getAttribute('data-flag') === 'no-licence'), true);
});

test('About: credits that cannot be loaded leave one plain line pointing to the packaged notices (opening About again tries again)', async () => {
  const slot = new FakeNodeEl('div');
  const host = { querySelector: (selector) => (selector === '[data-about-credits-slot]' ? slot : null) };
  const errors = console.error;
  console.error = () => {};
  try {
    await showVisualizerCredits(host, { doc, load: () => Promise.reject(new Error('chunk missing')) });
  } finally {
    console.error = errors;
  }
  const text = textOf(slot);
  assert.equal(text, `${CREDITS_FAILED_TEXT}${NOTICES_LINK_TEXT}.`);
  assert.equal(text, 'The Visualizer credits could not be loaded. They are also in the packaged third-party notices.');
  const link = slot.descendants().find((n) => n.tagName === 'A');
  assert.equal(link.getAttribute('href'), '/THIRD_PARTY_NOTICES.txt');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noreferrer');
  // The same words and link as the Licenses section's.
  assert.match(read('src/modes/about.js'), /<a href="\/THIRD_PARTY_NOTICES\.txt" target="_blank" rel="noreferrer">Packaged third-party notices<\/a>/);
  // Loaded: the slot is replaced by the section (a connected slot only).
  let replaced = null;
  const live = Object.assign(new FakeNodeEl('div'), { isConnected: true, replaceWith(node) { replaced = node; } });
  await showVisualizerCredits({ querySelector: () => live }, { doc, load: async () => ({ visualizerCredits: () => 'credits' }) });
  assert.equal(replaced, 'credits');
  assert.equal(live.children.length, 0);
});
