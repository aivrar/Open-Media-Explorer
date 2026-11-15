import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { pickPlaylistFile } from '../src/lib/playlist-drop.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('a dropped .pls file is picked up like an .m3u', () => {
  const pls = { name: 'Station.PLS' };
  assert.equal(pickPlaylistFile([{ name: 'notes.txt' }, pls]), pls);
  assert.equal(pickPlaylistFile([{ name: 'radio.pls' }]).name, 'radio.pls');
  assert.equal(pickPlaylistFile([{ name: 'list.m3u8' }]).name, 'list.m3u8');
  assert.equal(pickPlaylistFile([{ name: 'radio.pls.txt' }, { name: 'pls' }, { name: 'radio.plsx' }]), null);
});

test('Import playlist accepts a .pls file and sends its text unchanged to the backend', async () => {
  const client = await import(`../src/lib/playlists.js?pls=${Date.now()}`);
  let sent;
  const request = async (_path, options) => {
    if (!options) return { playlists: [] };
    sent = options.body;
    return { playlist: { id: 'a', name: 'radio.pls', items: [] } };
  };
  const text = '[playlist]\nFile1=https://example.org/live\nTitle1=Live\n';
  await client.importPlaylistFile(new File([text], 'radio.pls'), 'radio', request);
  assert.deepEqual(sent, { name: 'radio.pls', text, default_type: 'radio' });
  await assert.rejects(client.importPlaylistFile(new File(['x'], 'radio.asx'), 'tv', request), /Choose an \.m3u, \.m3u8, \.pls or \.xspf file\./);
});

test('the playlist wording names .pls wherever it names .m3u', async () => {
  const drop = await read('src/lib/playlist-drop.js');
  assert.match(drop, /const PLAYLIST_NAME = \/\\\.\(m3u8\?\|pls\|xspf\)\$\/i;/);
  assert.match(drop, /Only \.m3u, \.m3u8, \.pls or \.xspf playlist files can be dropped here\./);
  const controls = await read('src/modes/library/personal-controls.js');
  // The short option fits the collapsed dropdown; the help text names the formats.
  assert.match(controls, /\['playlist', 'Online playlist'\]/);
  assert.match(controls, /or select Online playlist for an M3U, PLS or XSPF channel list\. Adding the same link updates it;/);
  const render = await read('src/modes/library/render.js');
  assert.match(render, /'Import a playlist above, or clear your filters\.'/);
});
