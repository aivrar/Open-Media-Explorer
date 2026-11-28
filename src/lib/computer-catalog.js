// Entries are the local file records returned by the Computer library.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const searchKeys = new WeakMap();
const preparedSearchLists = new WeakSet();
const pathSearchKeys = new WeakMap();
const groupSearchKeys = new WeakMap();
const fileNames = new WeakMap();
const videoTitles = new WeakMap();
const codecNames = {
  aac: 'AAC', alac: 'ALAC', ape: 'APE', flac: 'FLAC', mp3: 'MP3',
  opus: 'Opus', vorbis: 'Vorbis', wavpack: 'WavPack', wmalossless: 'WMA',
};

export function fileName(entry) {
  if (!fileNames.has(entry)) fileNames.set(entry, (entry.rel || '').split('/').pop());
  return fileNames.get(entry);
}
export const computerItemId = (entry) => `computer:${entry.id}`;

export function computerMoveDestinations(moves) {
  const destinations = new Map();
  for (const [from, to] of moves.toReversed()) destinations.set(from, destinations.get(to) ?? to);
  return destinations;
}

export function computerFileKind(entry) {
  if (entry.kind === 'video') return hasEpisode(entry) ? 'Episode' : 'Movie';
  return isAudiobook(entry) ? 'Audiobook' : '';
}

export function computerFileFormat(entry) {
  return entry.kind === 'video' ? (entry.ext || '').toUpperCase() : formatLabel(entry);
}

const nameKey = (text) => String(text ?? '').replace(/^the\s+/i, '');
export const compareNames = (a, b) => collator.compare(nameKey(a), nameKey(b));
const compareNumbers = (a, b) => (Number(a) || 0) - (Number(b) || 0);

export function sortBy(list, key, { numeric = false, descending = false } = {}) {
  const compare = numeric ? compareNumbers : collator.compare;
  const direction = descending ? -1 : 1;
  return list.map((item) => ({ item, value: numeric ? key(item) : nameKey(key(item)) }))
    .sort((a, b) => direction * compare(a.value, b.value))
    .map(({ item }) => item);
}

export const isAudiobook = (entry) => entry.kind === 'audio'
  && (entry.ext?.toLowerCase() === 'm4b' || /audiobook/i.test(entry.genre || ''));
export const musicOf = (items) => items.filter((entry) => entry.kind === 'audio' && !isAudiobook(entry));
export const audiobooksOf = (items) => items.filter(isAudiobook);
export const videosOf = (items) => items.filter((entry) => entry.kind === 'video');

const normalize = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function entrySearchKey(entry) {
  let key = searchKeys.get(entry);
  if (key === undefined) {
    const title = normalize(entry.title || '');
    const episode = normalize(entry.episode_title || '');
    const titleKey = [title, episode].join('\n');
    const other = normalize([entry.artist, entry.album, entry.album_artist, entry.genre, fileName(entry)].join('\n'));
    key = { title, episode, titleKey, text: [titleKey, other].join('\n') };
    searchKeys.set(entry, key);
  }
  return key;
}

export function prepareEntrySearch(items) {
  if (preparedSearchLists.has(items)) return;
  for (const entry of items) entrySearchKey(entry);
  preparedSearchLists.add(items);
}

const searchWords = (text) => text.split(/\s+/u).filter(Boolean);
function containsWords(key, words) {
  for (const word of words) {
    if (!key.includes(word)) return false;
  }
  return true;
}

export function groupSearch(text) {
  const words = searchWords(normalize(text));
  return words.length ? (group) => {
    let key = groupSearchKeys.get(group);
    if (key === undefined) {
      key = normalize([group.title, group.author, group.narrator].join('\n'));
      groupSearchKeys.set(group, key);
    }
    return containsWords(key, words);
  } : null;
}

export function entrySearch(text, { paths = false } = {}) {
  const words = searchWords(normalize(text));
  return words.length ? (entry) => {
    let key = paths ? pathSearchKeys.get(entry) : entrySearchKey(entry).text;
    if (key === undefined) {
      key = entrySearchKey(entry).text + '\n' + normalize(entry.rel || '');
      pathSearchKeys.set(entry, key);
    }
    return containsWords(key, words);
  } : null;
}

export function rankedComputerEntries(entries, text, limit, available) {
  const query = normalize(text).trim();
  const words = searchWords(query);
  if (!words.length) return [];
  const prefix = words.join(' ');
  const ranks = [[], [], []];
  for (const entry of entries) {
    const { title, episode, titleKey, text: key } = entrySearchKey(entry);
    if (!containsWords(key, words)) continue;
    const rank = title.startsWith(prefix) || episode.startsWith(prefix) ? 0
      : containsWords(titleKey, words) ? 1 : 2;
    const hits = ranks[rank];
    if (hits.length >= limit || !available(entry)) continue;
    hits.push(entry);
    if (rank === 0 && hits.length === limit) break;
  }
  return ranks.flat().slice(0, limit);
}

export function searchEntries(list, text) {
  const matches = entrySearch(text);
  return matches ? list.filter(matches) : list;
}

const directoryOf = (entry) => {
  const path = entry.rel || '';
  return path.slice(0, Math.max(0, path.lastIndexOf('/')));
};

function discFolder(directory) {
  return /(?:^|\/)(?:cd|disc|disk)[ ._-]*(\d+)(?:\s*-\s*[^/]+)?$/i.exec(directory);
}

export function discNumber(entry) {
  if (entry.disc > 0) return Number(entry.disc);
  return Number(discFolder(directoryOf(entry))?.[1]) || 1;
}

export function computerAlbumKey(song) {
  const directory = directoryOf(song);
  const disc = discFolder(directory);
  const albumDirectory = disc ? directory.slice(0, disc.index) : directory;
  return JSON.stringify([song.folder, albumDirectory, normalize(song.album?.trim() || 'Unknown album')]);
}

export function albumsOf(songs) {
  const groups = new Map();
  for (const song of songs) {
    const title = song.album?.trim() || 'Unknown album';
    const key = computerAlbumKey(song);
    if (!groups.has(key)) groups.set(key, { key, title, tracks: [] });
    groups.get(key).tracks.push(song);
  }
  for (const album of groups.values()) {
    const discs = album.tracks.map((track) => ({
      track, disc: discNumber(track), name: fileName(track),
    }));
    discs.sort((a, b) => a.disc - b.disc || compareNumbers(a.track.track, b.track.track)
      || collator.compare(a.name, b.name));
    album.tracks = discs.map(({ track }) => track);
    const first = album.tracks[0];
    album.artist = '';
    album.year = null;
    album.genre = '';
    album.duration = 0;
    album.artEntryId = '';
    album.added = 0;
    album.format = formatLabel(first);
    const firstFormat = audioFormatKey(first);
    let sharedArtist = first.artist;
    let minBitrate = Infinity;
    let maxBitrate = 0;
    for (const track of album.tracks) {
      album.artist ||= track.album_artist;
      album.year ||= track.year;
      album.genre ||= track.genre;
      album.duration += Number(track.duration) || 0;
      if (track.duration_estimated === true) album.duration_estimated = true;
      album.added = Math.max(album.added, Number(track.mtime) || 0);
      if (!album.artEntryId && (track.art || track.has_cover)) album.artEntryId = track.id;
      if (track.artist !== sharedArtist) sharedArtist = '';
      minBitrate = Math.min(minBitrate, Number(track.bitrate) || 0);
      maxBitrate = Math.max(maxBitrate, Number(track.bitrate) || 0);
      if (audioFormatKey(track) !== firstFormat) album.format = 'Mixed';
    }
    const bitrateAgrees = minBitrate > 0 && maxBitrate <= minBitrate * 1.05;
    if (album.format !== 'Mixed' && !bitrateAgrees) album.format = formatLabel({ ...first, bitrate: 0 });
    album.formatDetails = formatDetails(first, { includeBitrate: bitrateAgrees });
    album.artist ||= sharedArtist || 'Various Artists';
    album.showTrackArtist = sharedArtist !== album.artist;
    album.year ||= null;
    album.genre ||= '';
    album.error = album.tracks.find(({ error }) => error)?.error;
  }
  return [...groups.values()];
}

const khz = (rate) => Number((rate / 1_000).toFixed(1));
const kbps = (rate) => Math.round(rate / 1_000);
const dsdLabel = (entry) => entry.sample_rate >= 2_822_400
  ? `DSD${Math.round(entry.sample_rate / 44_100)}` : 'DSD';
const isDsd = (codec) => codec.startsWith('dsd_') || codec === 'dst';
const knownCodec = (codec) => Object.hasOwn(codecNames, codec) || codec.startsWith('pcm_');
const codecLabel = (entry, codec) => (Object.hasOwn(codecNames, codec) ? codecNames[codec] : '')
  || (entry.ext || (codec.startsWith('pcm_') ? 'PCM' : codec)).toUpperCase();

export function formatLabel(entry) {
  const codec = (entry.acodec || '').toLowerCase();
  if (isDsd(codec)) return dsdLabel(entry);
  const name = codecLabel(entry, codec);
  if (!knownCodec(codec)) return name;
  if (entry.lossless) {
    const { bits, sample_rate: rate } = entry;
    const resolution = bits && rate ? `${bits}/${khz(rate)}`
      : bits ? `${bits}-bit` : rate ? `${khz(rate)} kHz` : '';
    return [name, resolution].filter(Boolean).join(' ');
  }
  return entry.bitrate ? `${name} ${kbps(entry.bitrate)} kbps` : name;
}

const audioFormatKey = (entry) => [
  (entry.acodec || entry.ext || '').toLowerCase(), Number(entry.bits) || 0, Number(entry.sample_rate) || 0,
].join('/');

export const bitrateText = (entry) => entry.bitrate ? `${kbps(entry.bitrate).toLocaleString()} kbps` : '';

export function formatDetails(entry, { includeBitrate = true } = {}) {
  const codec = (entry.acodec || '').toLowerCase();
  const channels = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' };
  return [
    isDsd(codec) ? dsdLabel(entry) : codecLabel(entry, codec),
    entry.bits && `${entry.bits}-bit`,
    entry.sample_rate && `${khz(entry.sample_rate)} kHz`,
    entry.channels && (channels[entry.channels] || `${entry.channels} ch`),
    includeBitrate && bitrateText(entry),
  ].filter(Boolean).join(' · ');
}

export function durationText(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) return '';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor(whole / 60) % 60;
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export function entryDurationText(entry) {
  const length = durationText(entry.duration);
  return length && entry.duration_estimated === true ? `~${length}` : length;
}

export function durationTooltip(entry) {
  return entry.duration > 0 && entry.duration_estimated === true ? 'Estimated length' : '';
}

export function totalLengthText(entry, includeDays = false) {
  if (!(entry.duration > 0)) return '';
  const length = totalDurationText(entry.duration, includeDays);
  return entry.duration_estimated === true ? `~${length}` : length;
}

export function totalDurationText(seconds, includeDays = false) {
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (includeDays && hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} ${days === 1 ? 'day' : 'days'}${hours % 24 ? ` ${hours % 24} h` : ''}`;
  }
  return hours ? `${hours} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`;
}

export function videoTitle(entry) {
  if (!videoTitles.has(entry)) {
    const title = entry.title || fileName(entry);
    videoTitles.set(entry, hasEpisode(entry) ? [showName(entry), episodeCode(entry)].join(' · ') : title);
  }
  return videoTitles.get(entry);
}

export function videoQuality(entry, technical) {
  const height = entry.height;
  const quality = height >= 2160 ? '4K' : height >= 1080 ? '1080p' : height >= 720 ? '720p' : height > 0 ? 'SD' : '';
  return [quality, technical && entry.vcodec?.toUpperCase()].filter(Boolean).join(' · ');
}

export function sizeText(size) {
  if (size == null || size < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    unit++;
    size /= 1024;
  }
  return `${size.toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
}

export const pluralCount = (count, noun, plural = `${noun}s`) =>
  `${count.toLocaleString()} ${count === 1 ? noun : plural}`;

function groupEntries(entries, namesFor, keyFor = (_, name) => normalize(name)) {
  const groups = new Map();
  for (const entry of entries) {
    for (const name of namesFor(entry)) {
      const key = keyFor(entry, name);
      if (!groups.has(key)) groups.set(key, { key, title: name, entries: [] });
      const group = groups.get(key);
      group.entries.push(entry);
      group.error ||= entry.error;
    }
  }
  return [...groups.values()];
}

function sortGroups(groups, last) {
  return groups.sort((a, b) => Number(a.key === last) - Number(b.key === last) || compareNames(a.title, b.title));
}

export function newestAlbums(albums) {
  return [...albums].sort((a, b) => compareNumbers(b.year, a.year) || compareNames(a.title, b.title));
}

export function artistsOf(songs) {
  const artists = groupEntries(songs, (entry) => [entry.album_artist?.trim() || entry.artist?.trim() || 'Various Artists']);
  for (const artist of artists) {
    artist.songs = sortBy(artist.entries, (song) => song.title || fileName(song));
    artist.albums = newestAlbums(albumsOf(artist.entries));
    artist.artEntryId = artist.albums[0].artEntryId;
  }
  return sortGroups(artists, 'various artists');
}

export function genresOf(songs) {
  const genres = groupEntries(songs, (entry) => {
    const names = (entry.genre || '').split(/[;,]/u).flatMap((label) => {
      const parts = label.split('/').map((part) => part.trim());
      if (parts.every((part) => part.length >= 3)) return parts;
      return parts.some(Boolean) ? [label.trim()] : [];
    }).filter(Boolean);
    return names.length ? new Map(names.map((name) => [normalize(name), name])).values() : ['Unknown'];
  });
  return sortGroups(genres, 'unknown');
}

// Each folder stores a range of its root's path-ordered entries and its direct files.
export function folderTree(saved, entries) {
  const roots = saved.map(({ id, path, available }) => ({
    key: id, offline: available === false, title: path.split(/[\\/]/u).filter(Boolean).at(-1) || path, path,
    parent: null, children: new Map(), files: [],
  }));
  const rootIds = new Set(roots.map((root) => root.key));
  const names = new Map();
  for (const root of roots) {
    const key = normalize(root.title);
    names.set(key, (names.get(key) || 0) + 1);
  }
  for (const root of roots) {
    if (names.get(normalize(root.title)) > 1) root.title += ` (${root.path})`;
  }
  const paths = new Map();
  for (const entry of entries) {
    if (!rootIds.has(entry.folder)) continue;
    if (!paths.has(entry.folder)) paths.set(entry.folder, []);
    paths.get(entry.folder).push({ entry, segments: (entry.rel || '').split('/') });
  }
  const nodes = new Map();
  for (const root of roots) {
    const id = root.key;
    const ordered = paths.get(id) || [];
    ordered.sort((a, b) => {
      for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
        const first = a.segments[i];
        const second = b.segments[i];
        if (first !== second) return collator.compare(first, second) || (first < second ? -1 : 1);
      }
      return a.segments.length - b.segments.length;
    });
    root.entries = ordered.map(({ entry }) => entry);
    root.start = 0;
    root.end = ordered.length;
    root.key = JSON.stringify([id]);
    nodes.set(root.key, root);
    ordered.forEach(({ entry, segments }, index) => {
      let node = root;
      root.error ||= entry.error;
      for (let depth = 0; depth < segments.length - 1; depth++) {
        const segment = segments[depth];
        if (!node.children.has(segment)) {
          const key = JSON.stringify([id, ...segments.slice(0, depth + 1)]);
          const child = {
            key, offline: root.offline, title: segment, path: `${node.path.replace(/[\\/]$/u, '')}\\${segment}`, parent: node,
            children: new Map(), files: [],
            entries: root.entries, start: index,
          };
          node.children.set(segment, child);
          nodes.set(key, child);
        }
        node = node.children.get(segment);
        node.end = index + 1;
        node.error ||= entry.error;
      }
      node.files.push(entry);
    });
  }
  sortGroups(roots);
  return { roots, nodes, entries: roots.flatMap((root) => root.entries) };
}

const hasEpisode = (entry) => entry.season != null || entry.episode != null;
export const episodeTitle = (entry) => entry.episode_title
  ?? (entry.title?.trim().toLowerCase() !== showName(entry).toLowerCase() ? entry.title?.trim() || '' : '');
export const moviesOf = (videos) => videos.filter((entry) => !hasEpisode(entry));

export function computerFolderKeys(entry) {
  const parts = [entry.folder, ...(entry.rel || '').split('/').slice(0, -1)];
  return parts.map((_, index) => JSON.stringify(parts.slice(0, index + 1)));
}

export function computerFileSubtitle(entry) {
  if (entry.kind === 'video') {
    return hasEpisode(entry) ? showName(entry) : directoryOf(entry).split('/').at(-1) || '';
  }
  return [entry.artist, entry.album].filter(Boolean).join(' - ');
}

const episodePattern = /(?<![A-Za-z0-9])S(\d{1,3})E(\d{1,3})(?:[ ._-]*E(\d{1,3})(?!\d))?(?!\d)/iu;

function seriesDirectory(entry) {
  return directoryOf(entry).replace(/(?:^|\/)(?:(?:season|staffel|s)[ ._-]*\d+|specials)$/iu, '');
}

function showName(entry) {
  const stem = fileName(entry).replace(/\.[^.]+$/u, '').replace(/[._]/gu, ' ');
  for (const label of [stem, entry.title || '']) {
    const episode = episodePattern.exec(label);
    if (!episode) continue;
    const name = label.slice(0, episode.index).replace(/[._]/gu, ' ').trim()
      .replace(/[\s([-]+$/u, '').replace(/\s+/gu, ' ').trim();
    if (name) return name;
  }
  const directory = seriesDirectory(entry);
  return (episodePattern.test(stem) && directory.split('/').at(-1))
    || entry.title?.trim() || stem || 'Unknown show';
}

export function episodeCode(entry) {
  const pad = (number) => String(number).padStart(2, '0');
  const last = episodePattern.exec(fileName(entry))?.[3];
  return `${entry.season == null ? '' : `S${pad(entry.season)}`}${entry.episode == null ? '' : `E${pad(entry.episode)}`}${last == null ? '' : `-E${pad(last)}`}`;
}

export function showsOf(videos) {
  const shows = groupEntries(videos.filter(hasEpisode), (entry) => [showName(entry)],
    (entry, name) => JSON.stringify([entry.folder, seriesDirectory(entry), normalize(name)]));
  for (const show of shows) {
    const entries = show.entries.sort((a, b) => (a.season ?? Infinity) - (b.season ?? Infinity)
      || (a.episode ?? Infinity) - (b.episode ?? Infinity) || collator.compare(a.rel, b.rel));
    const seasons = new Map();
    const rows = new Map();
    for (const [index, entry] of entries.entries()) {
      const { season } = entry;
      if (!seasons.has(season)) {
        seasons.set(season, []);
        rows.set(season, { heading: season == null ? 'Episodes' : `Season ${season}`, episodes: [] });
      }
      seasons.get(season).push(entry);
      rows.get(season).episodes.push({ entry, index });
    }
    show.seasons = seasons;
    show.rows = [...rows.values()];
    show.artEntryId = (entries.find(({ art }) => art) || entries[0]).id;
  }
  return sortGroups(shows);
}

const videoCodecNames = { h264: 'H.264', hevc: 'HEVC', eac3: 'E-AC-3', ac3: 'AC-3', truehd: 'TrueHD', dts: 'DTS' };
export const movieCodec = (codec) => (Object.hasOwn(videoCodecNames, codec) && videoCodecNames[codec])
  || codec?.toUpperCase() || '';
export const movieCodecs = (entry) => [movieCodec(entry.vcodec), movieCodec(entry.acodec)].filter(Boolean).join(' · ');
export const audioLayout = (channels) => ({ 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' })[channels]
  || (channels > 0 ? `${channels} ch` : '');

export function movieResolution({ width, height }) {
  // Wide releases retain their resolution label after black bars are removed.
  if (width >= 3840 || height >= 2160) return '4K';
  if (width >= 1920 || height >= 1080) return '1080p';
  if (width >= 1280 || height >= 720) return '720p';
  return width > 0 || height > 0 ? 'SD' : '';
}

export function localVideoDetails(entry) {
  return [movieResolution(entry), movieCodecs(entry), entry.channels > 2 && audioLayout(entry.channels)]
    .filter(Boolean).join(' · ');
}

export function movieBadges(entry) {
  const { pix_fmt: pixel = '', bits, vcodec = '', channels } = entry;
  const tenBit = /p10/i.test(pixel) || (/^(hevc|av1)$/i.test(vcodec) && (bits === 10 || /10(?:le|be)?$/i.test(pixel)));
  return [movieResolution(entry), tenBit && '10-bit', channels > 2 && audioLayout(channels)].filter(Boolean);
}

export const bookFileOrder = (entry) => [discNumber(entry), Number(entry.track) || 0, entry.rel || ''];
export const compareBookFileOrder = (a, b) => a[0] - b[0] || a[1] - b[1] || collator.compare(a[2], b[2]);

const bookTitle = (entry) => entry.album?.trim() || entry.title?.trim() || fileName(entry) || 'Unknown book';
const bookAuthor = (entry) => entry.artist?.trim() || entry.album_artist?.trim() || '';

export function computerBookKey(entry) {
  return JSON.stringify(entry.album?.trim() ? [normalize(bookTitle(entry)), normalize(bookAuthor(entry))] : [entry.id]);
}

export function booksOf(entries) {
  const books = new Map();
  for (const entry of entries) {
    const title = bookTitle(entry);
    const author = bookAuthor(entry);
    const key = computerBookKey(entry);
    if (!books.has(key)) books.set(key, { key, title, author, entries: [], duration: 0 });
    const book = books.get(key);
    book.entries.push(entry);
    book.narrator ||= entry.composer?.trim();
    book.duration += Number(entry.duration) || 0;
    if (entry.duration_estimated === true) book.duration_estimated = true;
    book.error ||= entry.error;
    if (!book.artEntryId && (entry.art || entry.has_cover)) book.artEntryId = entry.id;
  }
  for (const book of books.values()) {
    book.entries.sort((a, b) => compareBookFileOrder(bookFileOrder(a), bookFileOrder(b)));
  }
  return sortGroups([...books.values()]);
}
