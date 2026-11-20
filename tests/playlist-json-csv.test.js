import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { pickPlaylistFile } from '../src/lib/playlist-drop.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('a dropped .json or .csv file is picked up like an .m3u', () => {
  const json = { name: 'Stations.JSON' };
  const csv = { name: 'stations.csv' };
  assert.equal(pickPlaylistFile([{ name: 'notes.txt' }, json]), json);
  assert.equal(pickPlaylistFile([{ name: 'photo.png' }, csv]), csv);
  assert.equal(pickPlaylistFile([{ name: 'list.json.txt' }, { name: 'csv' }, { name: 'list.jsonl' }, { name: 'list.tsv' }]), null);
});

test('Import playlist sends a .json or .csv file\'s text unchanged; the backend reads it', async () => {
  const client = await import(`../src/lib/playlists.js?tables=${Date.now()}`);
  const sent = [];
  const request = async (_path, options) => {
    if (!options) return { playlists: [] };
    sent.push(options.body);
    return { playlist: { id: String(sent.length), name: options.body.name, items: [] } };
  };
  const json = '[{"name":"Caf\u00E9 FM","url":"https://example.org/live"}]';
  const csv = 'name,url\r\nOne,https://example.org/one\r\n';
  await client.importPlaylistFile(new File([json], 'radio.json'), 'auto', request);
  await client.importPlaylistFile(new File([csv], 'radio.CSV'), 'tv', request);
  assert.deepEqual(sent, [
    { name: 'radio.json', text: json, default_type: 'auto' },
    { name: 'radio.CSV', text: csv, default_type: 'tv' },
  ]);
  // The same 8 MiB limit as every playlist file.
  const big = { name: 'big.json', size: 8 * 1024 * 1024 + 1, arrayBuffer: async () => new ArrayBuffer(0) };
  await assert.rejects(client.importPlaylistFile(big, 'tv', request), /Playlist exceeds 8 MiB/);
});

test('the About page and the wiki name the new formats; the backend fetches nothing new', async () => {
  const about = await read('src/modes/about.js');
  assert.match(about, /Import your own M3U, M3U8, PLS, XSPF, JSON or CSV channel lists/);
  const wiki = await read('docs/wiki/02-using-the-application.md');
  assert.match(wiki, /\(M3U, PLS, XSPF, JSON or CSV\)/);
  assert.match(wiki, /A JSON or CSV list needs a `url` for each station/);
  const tables = await read('worldmedia_playlist_tables.py');
  assert.doesNotMatch(tables, /urlopen|requests|BoundedFetcher|SafeConnector|http\.client/);
});
