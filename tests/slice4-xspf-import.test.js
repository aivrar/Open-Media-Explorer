import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { initPlaylistDrop, pickPlaylistFile } from '../src/lib/playlist-drop.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

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
    setAttribute() {}, remove() {},
  };
  const documentImpl = { body: { appendChild() {} }, createElement: () => hint };
  const imported = [];
  const dispose = initPlaylistDrop({ onPlaylist: (file) => imported.push(file), target, documentImpl });
  const fire = (type, dataTransfer) => {
    const event = { dataTransfer, prevented: false, preventDefault() { event.prevented = true; } };
    listeners.get(type)(event);
    return event;
  };
  return { fire, hint, imported, dispose };
}

test('a dropped .xspf file is picked up like an .m3u', () => {
  const xspf = { name: 'Stations.XSPF' };
  assert.equal(pickPlaylistFile([{ name: 'notes.txt' }, xspf]), xspf);
  assert.equal(pickPlaylistFile([{ name: 'radio.xspf' }]).name, 'radio.xspf');
  assert.equal(pickPlaylistFile([{ name: 'radio.xspf.txt' }, { name: 'xspf' }, { name: 'radio.xspfx' }, { name: 'radio.xml' }]), null);
});

test('dropping an .xspf imports it; other files show the accepted formats', async () => {
  const { fire, hint, imported, dispose } = dropHarness();
  fire('dragover', { types: ['Files'], files: [] });
  assert.equal(hint.textContent, 'Drop a playlist file (.m3u, .m3u8, .pls, .xspf, .json or .csv) to import it into My Playlists');

  const file = { name: 'radio.xspf' };
  assert.equal(fire('drop', { types: ['Files'], files: [file] }).prevented, true);
  await Promise.resolve();
  assert.deepEqual(imported, [file]);

  assert.equal(fire('drop', { types: ['Files'], files: [{ name: 'radio.asx' }] }).prevented, true);
  await Promise.resolve();
  assert.equal(imported.length, 1);
  assert.equal(hint.textContent, 'Only .m3u, .m3u8, .pls, .xspf, .json or .csv playlist files can be dropped here.');
  assert.equal(hint.classList.contains('is-rejected'), true);
  dispose();
});

test('Import playlist accepts an .xspf file and sends its text unchanged to the backend', async () => {
  const client = await import(`../src/lib/playlists.js?xspf=${Date.now()}`);
  let sent;
  const request = async (_path, options) => {
    if (!options) return { playlists: [] };
    sent = options.body;
    return { playlist: { id: 'a', name: 'radio.xspf', items: [] } };
  };
  const text = '<?xml version="1.0"?>\n<playlist xmlns="http://xspf.org/ns/0/"><trackList><track>'
    + '<location>https://example.org/live</location><title>Caf\u00e9</title></track></trackList></playlist>\n';
  await client.importPlaylistFile(new File([text], 'radio.XSPF'), 'radio', request);
  assert.deepEqual(sent, { name: 'radio.XSPF', text, default_type: 'radio' });
  await assert.rejects(client.importPlaylistFile(new File(['x'], 'radio.xml'), 'tv', request), /Choose an \.m3u, \.m3u8, \.pls, \.xspf, \.json or \.csv file\./);
});

test('the file picker, button and link help name every accepted format', async () => {
  const controls = await read('src/modes/library/personal-controls.js');
  assert.match(controls, /accept: '\.m3u,\.m3u8,\.pls,\.xspf,\.json,\.csv'/);
  assert.match(controls, /title: 'Import a local \.m3u, \.m3u8, \.pls, \.xspf, \.json or \.csv channel list\. A \.json or \.csv list needs a url for each station; name, logo, group and type are used when given\. A matching filename replaces that playlist; favorites are kept\. '/);
  // How to change the stations (issue 6): edit your own file and import it again.
  assert.match(controls, /'To change the stations, edit your own playlist file and import it again under the same file name; the copy the app keeps is not meant to be edited by hand\.'/);
  assert.match(controls, /select Online playlist for an M3U, PLS, XSPF, JSON or CSV channel list\./);
  const drop = await read('src/lib/playlist-drop.js');
  assert.match(drop, /const PLAYLIST_NAME = \/\\\.\(m3u8\?\|pls\|xspf\|json\|csv\)\$\/i;/);
});
