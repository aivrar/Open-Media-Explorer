import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { expectsPicture, hasPicture } from '../src/lib/video-picture.js';
import { carriesFiles, initPlaylistDrop, pickPlaylistFile } from '../src/lib/playlist-drop.js';
import { centeredScrollLeft } from '../src/modes/tuner.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('radio and audio items do not get the video square until a picture arrives', () => {
  assert.equal(expectsPicture({ type: 'radio' }), false);
  assert.equal(expectsPicture({ type: 'audio' }), false);
  assert.equal(expectsPicture({ type: 'tv' }), true);
  assert.equal(expectsPicture({ type: 'video' }), true);
  assert.equal(expectsPicture({}), true);
  assert.equal(expectsPicture(null), true);

  assert.equal(hasPicture({ videoWidth: 0, videoHeight: 0 }), false);
  assert.equal(hasPicture({ videoWidth: 1280, videoHeight: 720 }), true);
  assert.equal(hasPicture({ videoWidth: 1280 }), false);
  assert.equal(hasPicture(null), false);
});

test('the player shows the square from the stream itself, never hides a TV picture', async () => {
  const player = await read('src/lib/player.js');
  assert.match(player, /showVideo\(expectsPicture\(item\) \|\| hasPicture\(elements\.video\)\);/);
  assert.match(player, /if \(pictureStream && hasPicture\(elements\.video\)\) showVideo\(true\);/);
  assert.match(player, /addEventListener\?\.\('loadedmetadata', syncVideoPicture\)/);
  assert.match(player, /addEventListener\?\.\('resize', syncVideoPicture\)/);
  // The picture check may only ever reveal the square.
  assert.doesNotMatch(player.match(/function syncVideoPicture\(\) \{[^}]*\}/)[0], /showVideo\(false\)/);
});

test('the station strip centres the current station', () => {
  // Pill at 900 px in a 600 px strip that has not scrolled: centre it.
  assert.equal(centeredScrollLeft({ stripLeft: 0, stripWidth: 600, scrollLeft: 0, pillLeft: 900, pillWidth: 100 }), 650);
  // Same pill after the strip has scrolled 650 px is already centred.
  assert.equal(centeredScrollLeft({ stripLeft: 0, stripWidth: 600, scrollLeft: 650, pillLeft: 250, pillWidth: 100 }), 650);
  // The strip's own offset on the page does not matter.
  assert.equal(centeredScrollLeft({ stripLeft: 220, stripWidth: 600, scrollLeft: 0, pillLeft: 1120, pillWidth: 100 }), 650);
  // The first stations cannot be centred; never scroll past the start.
  assert.equal(centeredScrollLeft({ stripLeft: 0, stripWidth: 600, scrollLeft: 0, pillLeft: 10, pillWidth: 100 }), 0);
});

test('the strip is centred on every rebuild', async () => {
  const tuner = await read('src/modes/tuner.js');
  assert.match(tuner, /ui\.strip\.appendChild\(pill\);\s*\}\s*centerActivePill\(\);/);
});

test('only real file drags are handled, and only playlist files are imported', () => {
  assert.equal(carriesFiles({ types: ['Files'] }), true);
  assert.equal(carriesFiles({ types: ['text/plain', 'text/uri-list'] }), false);
  assert.equal(carriesFiles({ types: { 0: 'Files', length: 1, [Symbol.iterator]: Array.prototype[Symbol.iterator] } }), true);
  assert.equal(carriesFiles(null), false);

  const m3u = { name: 'My Radio.M3U' };
  assert.equal(pickPlaylistFile([{ name: 'notes.txt' }, m3u, { name: 'second.m3u8' }]), m3u);
  assert.equal(pickPlaylistFile([{ name: 'list.m3u8' }]).name, 'list.m3u8');
  assert.equal(pickPlaylistFile([{ name: 'song.mp3' }, { name: 'm3u' }, {}]), null);
  assert.equal(pickPlaylistFile(undefined), null);
});

function dropHarness() {
  const listeners = new Map();
  const target = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const classes = new Set();
  const hint = {
    hidden: false, textContent: '', className: '',
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    setAttribute() {}, remove() { hint.removed = true; },
  };
  const documentImpl = { body: { appendChild() {} }, createElement: () => hint };
  const imported = [];
  const dispose = initPlaylistDrop({ onPlaylist: (file) => imported.push(file), target, documentImpl });
  const fire = (type, dataTransfer, extra = {}) => {
    const event = { dataTransfer, prevented: false, preventDefault() { event.prevented = true; }, ...extra };
    listeners.get(type)(event);
    return event;
  };
  return { fire, hint, imported, dispose, listeners };
}

test('a dropped playlist is imported and never handed to Windows', async () => {
  const { fire, hint, imported, dispose, listeners } = dropHarness();
  assert.equal(hint.hidden, true);

  const drag = { types: ['Files'], files: [] };
  assert.equal(fire('dragover', drag).prevented, true);
  assert.equal(drag.dropEffect, 'copy');
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /Drop a playlist file \(\.m3u or \.m3u8\)/);

  // Leaving the window hides the hint; moving between elements does not.
  fire('dragleave', drag, { relatedTarget: {} });
  assert.equal(hint.hidden, false);
  fire('dragleave', drag, { relatedTarget: null });
  assert.equal(hint.hidden, true);

  const file = { name: 'stations.m3u' };
  assert.equal(fire('drop', { types: ['Files'], files: [file] }).prevented, true);
  await Promise.resolve();
  assert.deepEqual(imported, [file]);
  assert.equal(hint.hidden, true);

  // Any other file is kept inside the app too, with a message, not imported.
  assert.equal(fire('drop', { types: ['Files'], files: [{ name: 'photo.png' }] }).prevented, true);
  await Promise.resolve();
  assert.equal(imported.length, 1);
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /Only \.m3u or \.m3u8/);
  assert.equal(hint.classList.contains('is-rejected'), true);

  // Dragging text or a link inside the page is left alone.
  assert.equal(fire('dragover', { types: ['text/plain'] }).prevented, false);
  assert.equal(fire('drop', { types: ['text/plain'], files: [] }).prevented, false);

  dispose();
  assert.equal(listeners.size, 0);
  assert.equal(hint.removed, true);
});

test('a drop goes through the Library import and lands on My Playlists', async () => {
  const main = await read('src/main.js');
  assert.match(main, /initPlaylistDrop\(\{ onPlaylist: importDroppedPlaylist \}\)/);
  assert.match(main, /getState\(\)\.mode === 'tuner' \? tunerBand\(\) : ''/);
  assert.match(main, /showMyPlaylists\(\);\s*if \(getState\(\)\.mode !== 'library'\) setMode\('library'\);\s*await importLocalPlaylist\(file, type\);/);
  const controls = await read('src/modes/library/personal-controls.js');
  // The button and the drop share one import path (same confirm, same messages).
  assert.match(controls, /file\.addEventListener\('change', \(\) => \{[\s\S]*?importLocal\(selected\);/);
  const css = await read('src/styles/base.css');
  assert.match(css.match(/\.drop-hint \{[^}]*\}/)[0], /pointer-events: none;/);
});
