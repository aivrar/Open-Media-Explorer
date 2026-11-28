import test from 'node:test';
import assert from 'node:assert/strict';
import {
  albumsOf, artistsOf, audiobooksOf, booksOf, compareNames, discNumber, durationText, durationTooltip, entryDurationText, episodeCode, folderTree,
  episodeTitle, formatDetails, formatLabel, genresOf, movieBadges, movieCodecs, moviesOf, musicOf, prepareEntrySearch,
  searchEntries, showsOf, sizeText, sortBy, totalDurationText, totalLengthText, videoQuality, videoTitle, videosOf,
} from '../src/lib/computer-catalog.js';
import { computerQueueState, playComputerEntries } from '../src/lib/computer-play.js';

test('audio, audiobooks and videos are separate', () => {
  const entries = [
    { kind: 'audio', ext: 'mp3' }, { kind: 'audio', ext: 'M4B' },
    { kind: 'audio', ext: 'flac', genre: 'Spoken Audiobook' }, { kind: 'video', genre: 'Audiobook' },
  ];
  assert.deepEqual(musicOf(entries), entries.slice(0, 1));
  assert.deepEqual(audiobooksOf(entries), entries.slice(1, 3));
  assert.deepEqual(videosOf(entries), entries.slice(3));
});

test('album identity uses folder, directory and album, joining matching disc folders', () => {
  const track = (id, rel, options = {}) => ({
    id, folder: 'music', rel, album: 'Greatest Hits', artist: 'Ensemble',
    duration: 90, ext: 'flac', acodec: 'flac', lossless: true, bits: 24, sample_rate: 96000,
    ...options,
  });
  const entries = [
    track('b', 'Best/CD2/1.flac', { album_artist: 'Group', track: 1, mtime: 7 }),
    track('a10', 'Best/CD 1/10.flac', { album_artist: 'Group', has_cover: true, mtime: 5 }),
    track('a2', 'Best/CD 1/2.flac', { album_artist: 'Group', year: 2019, genre: 'Rock', art: { file: 'cover.jpg' } }),
    track('c', 'Other/1.flac', { track: 2, artist: 'John' }),
    track('d', 'Other/2.flac', { track: 1, artist: 'Jane', acodec: 'mp3', bitrate: 320000 }),
    track('e', 'Other/1.flac', { folder: 'backup' }),
    track('f', 'Best/CD3/1.flac', { album_artist: 'Different Group' }),
    { id: 'r', rel: 'untagged.flac', folder: 'loose', ext: 'flac', probed: false },
    track('g', 'Best/CD3/2.flac', { album: 'CD3', probed: false }),
  ];
  const albums = albumsOf(entries);
  assert.equal(albums.length, 5);
  assert.equal(new Set(albums.map(({ key }) => key)).size, 5);
  const [box, compilation, copy, unknown, fallback] = albums;
  assert.deepEqual(box.tracks.map(({ id }) => id), ['a2', 'a10', 'b', 'f']);
  assert.deepEqual(box.tracks.map(discNumber), [1, 1, 2, 3]);
  assert.equal(box.artist, 'Group');
  assert.equal(box.year, 2019);
  assert.equal(box.genre, 'Rock');
  assert.equal(box.duration, 360);
  assert.equal(box.added, 7);
  assert.equal(box.artEntryId, 'a2');
  assert.equal(box.format, 'FLAC 24/96');
  assert.equal(compilation.artist, 'Various Artists');
  assert.equal(compilation.format, 'Mixed');
  assert.deepEqual(compilation.tracks.map(({ id }) => id), ['d', 'c']);
  assert.equal(copy.artist, 'Ensemble');
  assert.equal(unknown.title, 'Unknown album');
  assert.equal(unknown.artist, 'Various Artists');
  assert.equal(unknown.year, null);
  assert.equal(fallback.title, 'CD3');
  assert.equal(discNumber({ disc: 5, rel: 'CD1/a.flac' }), 5);
});

test('direct tracks and disc folders share a normalized album key, even with patchy tags', () => {
  const track = { folder: 'saved', album: 'Double Album', album_artist: 'A Band', rel: 'Double Album/one.flac' };
  for (const [directory, disc, joins] of [
    ['Double Album', 1, true], ['Double Album/CD1', 1, true], ['Double Album/CD 2', 2, true],
    ['Double Album/dIsC 2 - Live', 2, true], ['Double Album/Disk2', 2, true],
    ['Double Album/Disc 2/Extras', 1, false], ['Different Album/CD2', 2, false],
    ['Double Album/Disco 2', 1, false],
  ]) {
    const other = { ...track, album: ' d\u00f3uble album ', rel: directory + '/two.flac', album_artist: '', probed: false };
    assert.equal(discNumber(other), disc, directory);
    assert.equal(albumsOf([track, other]).length, joins ? 1 : 2, directory);
  }
  assert.equal(albumsOf([track, { ...track, album: 'Another title' }]).length, 2);
  assert.equal(albumsOf([track, { ...track, folder: 'other-saved-folder' }]).length, 2);
});

test('search precomputes a key once per entry and matches all accent-insensitive words across fields', () => {
  let reads = 0;
  const match = {
    get title() { reads++; return 'Écoute'; },
    artist: 'Björk', album: 'Café', album_artist: 'Ártist', genre: 'Folk', rel: 'Unseen/03-Söng.flac',
  };
  const entries = [match, { title: 'Écoute', artist: 'Björk', rel: 'cafe.mp3' }];
  prepareEntrySearch(entries);
  assert.deepEqual(searchEntries(entries, '  eCOUTE   bjork café ARTist FOLK SONG  '), [match]);
  assert.deepEqual(searchEntries(entries, 'ecoute cafe'), entries);
  assert.deepEqual(searchEntries(entries, 'unseen'), []);
  assert.equal(searchEntries(entries, '   '), entries);
  assert.equal(reads, 1);
});

test('name sorting is locale- and number-aware and ignores a leading The', () => {
  const names = ['Zed', 'The Album 10', 'The Ålbum 2', 'Beat'];
  assert.deepEqual(sortBy(names, (name) => name), ['The Ålbum 2', 'The Album 10', 'Beat', 'Zed']);
  assert.equal(compareNames('The Cafe', 'Café'), 0);
  assert.deepEqual(sortBy([{ n: 20 }, { n: 2 }], ({ n }) => n, { numeric: true, descending: true }), [{ n: 20 }, { n: 2 }]);
});

test('format labels cover lossless resolution, DSD rates, lossy rates and unknown codecs', () => {
  const cases = [
    [{ acodec: 'flac', lossless: true, bits: 24, sample_rate: 96000 }, 'FLAC 24/96'],
    [{ acodec: 'alac', lossless: true, bits: 16, sample_rate: 44100 }, 'ALAC 16/44.1'],
    [{ acodec: 'pcm_s24le', ext: 'wav', lossless: true, bits: 24, sample_rate: 88200 }, 'WAV 24/88.2'],
    [{ acodec: 'flac', lossless: true }, 'FLAC'],
    [{ acodec: 'flac', lossless: true, bits: 24 }, 'FLAC 24-bit'],
    [{ acodec: 'flac', lossless: true, sample_rate: 96000 }, 'FLAC 96 kHz'],
    [{ acodec: 'dsd_lsbf', sample_rate: 2822400 }, 'DSD64'],
    [{ acodec: 'dsd_msbf', sample_rate: 5644800 }, 'DSD128'],
    [{ acodec: 'dsd_lsbf_planar', sample_rate: 11289600 }, 'DSD256'],
    [{ acodec: 'dst', sample_rate: 22579200 }, 'DSD512'],
    [{ acodec: 'dst' }, 'DSD'],
    [{ acodec: 'mp3', bitrate: 320000 }, 'MP3 320 kbps'],
    [{ acodec: 'aac', bitrate: 255900 }, 'AAC 256 kbps'],
    [{ acodec: 'opus', bitrate: 128000 }, 'Opus 128 kbps'],
    [{ acodec: 'vorbis', bitrate: 156999 }, 'Vorbis 157 kbps'],
    [{ acodec: 'unknown', ext: 'mka', bitrate: 123000 }, 'MKA'],
    [{ acodec: 'constructor', ext: 'mka' }, 'MKA'],
    [{ ext: 'ogg' }, 'OGG'],
    [{}, ''],
  ];
  for (const [entry, expected] of cases) assert.equal(formatLabel(entry), expected, JSON.stringify(entry));
});

test('format details use all known fields and name common channel layouts', () => {
  const full = { acodec: 'flac', bits: 24, sample_rate: 96000, channels: 2, bitrate: 2304000 };
  assert.equal(formatDetails(full), `FLAC · 24-bit · 96 kHz · Stereo · ${(2304).toLocaleString()} kbps`);
  for (const [channels, expected] of [[1, 'Mono'], [2, 'Stereo'], [6, '5.1'], [8, '7.1'], [4, '4 ch']]) {
    assert.equal(formatDetails({ channels }), expected);
  }
  assert.equal(formatDetails({ acodec: 'alac', sample_rate: 44100 }), 'ALAC · 44.1 kHz');
  assert.equal(formatDetails({ acodec: 'dst', bits: 1, sample_rate: 2822400 }), 'DSD64 · 1-bit · 2822.4 kHz');
  assert.equal(formatDetails({ ext: 'm4a' }), 'M4A');
  assert.equal(formatDetails({}), '');
});

test('durations, video titles, quality and size are compact', () => {
  for (const [seconds, expected] of [[0, '0:00'], [187.9, '3:07'], [3765, '1:02:45'], [undefined, ''], [-1, ''], [Infinity, '']]) {
    assert.equal(durationText(seconds), expected);
  }
  for (const [seconds, label] of [[0, '0 s'], [40, '40 s'], [59.9, '59 s'], [60, '1 min'],
    [47 * 60, '47 min'], [3599, '59 min'], [3600, '1 h 00 min'], [3900, '1 h 05 min'], [4320, '1 h 12 min']]) {
    assert.equal(totalDurationText(seconds), label);
  }
  assert.equal(totalDurationText((12 * 24 + 4) * 3600, true), '12 days 4 h');
  assert.equal(totalDurationText(86400, true), '1 day');
  assert.equal(videoTitle({ title: 'Show Name', season: 2, episode: 5 }), 'Show Name · S02E05');
  assert.equal(videoTitle({ title: 'Movie' }), 'Movie');
  for (const [height, quality] of [[2160, '4K'], [1080, '1080p'], [720, '720p'], [540, 'SD'], [undefined, '']]) {
    assert.equal(videoQuality({ height, vcodec: 'h264' }, false), quality);
    assert.equal(videoQuality({ height, vcodec: 'h264' }, true), quality ? quality + ' · H264' : 'H264');
  }
  assert.equal(sizeText(1_500_000_000), `${(1.4).toLocaleString()} GB`);
  assert.equal(sizeText(1024), '1 KB');
  assert.equal(sizeText(0), '0 B');
  assert.equal(sizeText(undefined), '');
});

test('estimated lengths are marked with a tilde and an Estimated length tooltip', () => {
  assert.equal(entryDurationText({ duration: 1_048, duration_estimated: true }), '~17:28');
  assert.equal(entryDurationText({ duration: 1_048 }), '17:28');
  assert.equal(entryDurationText({ duration: 1_048, duration_estimated: false }), '17:28');
  assert.equal(durationTooltip({ duration: 1_048, duration_estimated: true }), 'Estimated length');
  assert.equal(durationTooltip({ duration: 1_048 }), '');
  assert.equal(totalLengthText({ duration: 1_048, duration_estimated: true }), '~17 min');
  assert.equal(totalLengthText({ duration: 1_048 }), '17 min');
});

test('playback passes the visible order, requested index and media type to the player', async (t) => {
  const play = t.mock.fn();
  const entries = [
    { id: 'a', title: 'A', kind: 'audio', artist: 'Artist', album: 'Album' },
    { id: 'b', title: 'B', kind: 'audio' },
    { id: 'c', title: 'Show', kind: 'video', season: 2, episode: 5 },
  ];
  await playComputerEntries(entries, 0, { play });
  const [first] = play.mock.calls[0].arguments;
  assert.equal(first.id, 'computer:a');
  assert.equal(first.source, 'computer');
  assert.equal(first.type, 'audio');
  assert.equal(first.delivery, 'on-demand');
  assert.equal(first.description, 'Artist · Album');
  assert.equal(first.thumbnail, '');
  await playComputerEntries(entries, 2, { play });
  const [video] = play.mock.calls[1].arguments;
  assert.equal(video.type, 'video');
  assert.equal(video.title, 'Show · S02E05');
  assert.deepEqual(video._extra.computer, {
    id: 'c', artist: '', album: '', duration: null, format: '', formatDetails: '', kind: 'Episode', episodeTitle: '',
  });
  // The queue travels with the play call; the player commits it when playback switches.
  const queued = play.mock.calls[1].arguments[1].computerQueue;
  assert.equal(queued.index, 2);
  assert.deepEqual(queued.entries.map(({ id }) => id), ['a', 'b', 'c']);
  await playComputerEntries(entries, 0, { play, shuffle: true, random: () => 0 });
  assert.equal(play.mock.calls[2].arguments[0].id, 'computer:a');
  const shuffled = play.mock.calls[2].arguments[1].computerQueue;
  assert.equal(shuffled.index, 0);
  assert.deepEqual(shuffled.entries.map(({ id }) => id), ['a', 'c', 'b']);
  assert.deepEqual(entries.map(({ id }) => id), ['a', 'b', 'c']);
});

test('artists use the album artist or artist, put Various Artists last and take art from the newest album', () => {
  const items = [
    { id: 'old', album_artist: 'The Ensemble', artist: 'Guest', album: 'First', year: 2001, has_cover: true, rel: 'First/old.flac' },
    { id: 'new', artist: 'the Ensemble', album: 'Last', year: 2020, has_cover: true, rel: 'Last/new.flac' },
    { id: 'guest', artist: 'Guest' },
    { id: 'various', album_artist: 'Various Artists' },
    { id: 'blank', artist: ' ' },
    { id: 'zed', artist: 'Zed' },
  ];
  const artists = artistsOf(items);
  assert.deepEqual(artists.map(({ title }) => title), ['The Ensemble', 'Guest', 'Zed', 'Various Artists']);
  assert.deepEqual(artists[0].entries.map(({ id }) => id), ['old', 'new']);
  assert.deepEqual(artists[0].albums.map(({ title }) => title), ['Last', 'First']);
  assert.equal(artists[0].artEntryId, 'new');
  assert.equal(artists.at(-1).entries.length, 2);
});

test('genre tags split on three separators and only count each song once per normalized genre', () => {
  const entries = [
    { id: 'one', genre: 'Rock; Pop' }, { id: 'two', genre: 'Rock/Pop' },
    { id: 'three', genre: 'Rock, Pop, pop ; Fólk' }, { id: 'four', genre: 'folk;' },
    { id: 'five', genre: ' ; / ' }, { id: 'six' }, { id: 'seven', genre: 'Zydeco' },
  ];
  assert.deepEqual(genresOf(entries).map(({ title, entries }) => [title, entries.map(({ id }) => id)]), [
    ['Fólk', ['three', 'four']], ['Pop', ['one', 'two', 'three']], ['Rock', ['one', 'two', 'three']],
    ['Zydeco', ['seven']], ['Unknown', ['five', 'six']],
  ]);
});

test('genre slashes split only when every trimmed part has at least three characters', () => {
  for (const [label, expected] of [
    ['Pop Rock/Synth-pop/Ballad', ['Ballad', 'Pop Rock', 'Synth-pop']],
    [' AC/DC ; R/B , Country', ['AC/DC', 'Country', 'R/B']],
    [' Funk / Pop / R ', ['Funk / Pop / R']],
    ['Jazz/ Pop', ['Jazz', 'Pop']],
  ]) {
    assert.deepEqual(genresOf([{ genre: label }]).map(({ title }) => title), expected);
  }
});

test('album formats compare codec, resolution and a five-percent bitrate range', () => {
  const mp3 = { kind: 'audio', acodec: 'mp3', sample_rate: 44100, channels: 2, bitrate: 100000 };
  for (const [changes, expected] of [
    [{ bitrate: 105000 }, 'MP3 · 44.1 kHz · Stereo · 100 kbps'],
    [{ bitrate: 105001 }, 'MP3 · 44.1 kHz · Stereo'],
    [{ bitrate: undefined }, 'MP3 · 44.1 kHz · Stereo'],
    [{ sample_rate: 48000 }, 'Mixed'],
    [{ acodec: 'aac' }, 'Mixed'],
    [{ bits: 16 }, 'Mixed'],
  ]) {
    const [album] = albumsOf([{ ...mp3, rel: '1.mp3' }, { ...mp3, ...changes, rel: '2.mp3' }]);
    assert.equal(album.format === 'Mixed' ? album.format : album.formatDetails, expected);
  }
});

test('folder nodes keep saved roots separate, track direct files and expose exactly their ordered subtree', () => {
  const saved = [{ id: 'a', path: 'D:\\Music' }, { id: 'b', path: 'E:\\Backup\\Music\\' }, { id: 'c', path: 'F:\\Empty' }];
  const entries = [
    { id: 'b1', folder: 'b', rel: 'Jazz/track 1.flac' },
    { id: 'a3', folder: 'a', rel: 'Jazz/Live/track 1.flac' },
    { id: 'a2', folder: 'a', rel: 'Jazz/track 10.flac' },
    { id: 'a4', folder: 'a', rel: 'Jazz Bonus/x.flac' },
    { id: 'a1', folder: 'a', rel: 'Jazz/track 2.flac' },
    { id: 'a0', folder: 'a', rel: 'a.flac' },
  ];
  const { roots, nodes } = folderTree(saved, entries);
  const ids = (items) => items.map(({ id }) => id);
  const [empty, main, backup] = roots;
  assert.equal(empty.title, 'Empty');
  assert.equal(empty.end, 0);
  assert.equal(main.path, saved[0].path);
  assert.equal(backup.path, saved[1].path);
  assert.notEqual(main.title, backup.title);
  assert.deepEqual(ids(main.files), ['a0']);
  assert.deepEqual(ids(main.entries), ['a0', 'a3', 'a1', 'a2', 'a4']);
  const jazz = main.children.get('Jazz');
  assert.equal(jazz.parent, main);
  assert.equal(nodes.get(jazz.key), jazz);
  assert.deepEqual(ids(jazz.files), ['a1', 'a2']);
  assert.deepEqual(ids(main.entries.slice(jazz.start, jazz.end)), ['a3', 'a1', 'a2']);
  assert.notEqual(jazz.key, backup.children.get('Jazz').key);
});

test('movies and shows split on either episode field, with cleaned show names and numerically ordered seasons', () => {
  const first = { id: 'first', title: 'Pilot', rel: 'Test.Show.S01E02.Pilot.mkv', season: 1, episode: 2 };
  const last = { id: 'last', title: 'Test Show', rel: 'Test Show S01E10.mkv', season: 1, episode: 10 };
  const special = { id: 'special', title: 'Test Show', rel: 'Test_Show_S00E01.mkv', season: 0, episode: 1, art: 'poster.jpg' };
  const otherSeason = { id: 'other', title: 'TEST SHOW', season: 2 };
  const unknownSeason = { id: 'unknown', title: 'Test Show', episode: 3 };
  const movie = { id: 'movie', title: 'Film' };
  const videos = [last, otherSeason, movie, first, unknownSeason, special];
  assert.deepEqual(moviesOf(videos), [movie]);
  const [show] = showsOf(videos);
  assert.equal(showsOf(videos).length, 1);
  assert.equal(show.title, 'Test Show');
  assert.equal(show.artEntryId, 'special');
  assert.deepEqual([...show.seasons], [[0, [special]], [1, [first, last]], [2, [otherSeason]], [undefined, [unknownSeason]]]);
  assert.deepEqual([special, first, otherSeason, unknownSeason].map(episodeCode), ['S00E01', 'S01E02', 'S02', 'E03']);
});

test('shows keep roots and series directories separate and fold season folders', () => {
  const paths = [
    ['one', 'Copy A/Show/Season 1/Show.S01E02E03.mkv', 1, 2, 'E03', ''],
    ['one', 'Copy A/Show/S01/Show.S01E04-E05.Double.mkv', 1, 4, 'E05 Double', 'Double'],
    ['one', 'Copy A/Show/Staffel 2/Show.S02E01.mkv', 2, 1, 'Pilot'],
    ['one', 'Copy A/Show/Specials/Show.S00E01.mkv', 0, 1, 'Special'],
    ['one', 'Copy B/Show/Show.S01E01.mkv', 1, 1, 'Pilot'],
    ['two', 'Copy A/Show/Show.S01E01.mkv', 1, 1, 'Pilot'],
  ];
  const entries = paths.map(([folder, rel, season, episode, title, episode_title], id) => ({
    id, folder, rel, season, episode, title, episode_title,
  }));
  const shows = showsOf(entries);
  assert.equal(shows.length, 3);
  const show = shows.find((group) => group.entries.length === 4);
  assert.deepEqual(show.entries.map((entry) => episodeCode(entry)), ['S00E01', 'S01E02-E03', 'S01E04-E05', 'S02E01']);
  assert.deepEqual(show.rows.flatMap(({ episodes }) => episodes.map(({ entry }) => episodeTitle(entry))),
    ['Special', '', 'Double', 'Pilot']);
  assert.deepEqual(show.rows.flatMap(({ episodes }) => episodes.map(({ index }) => index)), [0, 1, 2, 3]);
  assert.deepEqual(show.seasons.get(1), entries.slice(0, 2));
});

test('movie badges handle cropped wide releases, both 10-bit signals, and surround layouts', () => {
  for (const [entry, badges] of [
    [{ width: 3840, height: 1600, pix_fmt: 'yuv420p10le', channels: 8 }, ['4K', '10-bit', '7.1']],
    [{ width: 1920, height: 800, vcodec: 'hevc', pix_fmt: 'p010le', channels: 6 }, ['1080p', '10-bit', '5.1']],
    [{ height: 720, vcodec: 'av1', bits: 10, channels: 2 }, ['720p', '10-bit']],
    [{ height: 540, vcodec: 'av1', bits: 8, channels: 1 }, ['SD']],
    [{ height: 2160, vcodec: 'hevc', pix_fmt: 'yuv420p', channels: 4 }, ['4K', '4 ch']],
    [{}, []],
  ]) assert.deepEqual(movieBadges(entry), badges);
  assert.equal(movieCodecs({ vcodec: 'hevc', acodec: 'eac3' }), 'HEVC · E-AC-3');
});

test('audiobooks group album tags by author, order parts and fall back to the file title', () => {
  const entries = [
    { id: 'last', album: ' The Book ', album_artist: 'Writer', rel: 'CD2/part 1.mp3', track: 1, duration: 70 },
    { id: 'first', album: 'the book', artist: 'writer', composer: 'Voice', rel: 'CD1/part 2.mp3', track: 2, duration: 50, art: 'cover.png' },
    { id: 'different', album: 'The Book', artist: 'Another Writer', duration: 110 },
    { id: 'solo', title: 'Solo Book', artist: 'Solo Author', duration: 200 },
    { id: 'file', rel: 'unlabelled.m4b', duration: 300 },
  ];
  const books = booksOf(entries);
  assert.equal(books.length, 4);
  const book = books.find(({ author }) => author === 'Writer');
  assert.equal(book.title, 'The Book');
  assert.equal(book.narrator, 'Voice');
  assert.equal(book.artEntryId, 'first');
  assert.equal(book.duration, 120);
  assert.deepEqual(book.entries.map(({ id }) => id), ['first', 'last']);
  assert.ok(books.some(({ title }) => title === 'Solo Book'));
  assert.ok(books.some(({ title }) => title === 'unlabelled.m4b'));
});
