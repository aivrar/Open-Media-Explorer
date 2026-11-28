/**
 * Source registry: the single production authority for adapters and their UI
 * metadata. Settings, About, modes, colors, and lazy chunks all consume this
 * table so adding a source cannot leave a second hard-coded list behind.
 */

import { catalogScheduler } from './catalog-scheduler.js';

function source(definition) {
  return Object.freeze({
    ...definition,
    types: Object.freeze([...definition.types]),
    capabilities: Object.freeze([...definition.capabilities]),
  });
}

export const SOURCES = Object.freeze([
  source({
    id: 'radio-browser', displayName: 'Radio Browser', types: ['radio'],
    color: 'var(--source-radio-browser)', homepage: 'https://www.radio-browser.info/',
    description: 'Community-curated directory of live internet radio stations.',
    rightsNote: 'Streams remain subject to each broadcaster\'s terms.',
    capabilities: ['browse', 'search', 'live audio', 'record'],
  }),
  source({
    id: 'iptv-org', displayName: 'iptv-org', types: ['tv'],
    color: 'var(--source-iptv-org)', homepage: 'https://iptv-org.github.io/',
    description: 'Community registry of publicly listed live television streams.',
    rightsNote: 'Channel rights and availability remain with each broadcaster.',
    capabilities: ['browse', 'search', 'live video', 'record', 'content ratings'],
  }),
  source({
    id: 'internet-archive', displayName: 'Internet Archive', types: ['video', 'audio'],
    color: 'var(--source-internet-archive)', homepage: 'https://archive.org/',
    description: 'Large nonprofit archive of on-demand audio and video collections.',
    rightsNote: 'Rights vary by item; use the license and source record shown.',
    capabilities: ['browse', 'search', 'on demand', 'download'],
  }),
  source({
    id: 'nasa', displayName: 'NASA', types: ['video', 'audio'],
    color: 'var(--source-nasa)', homepage: 'https://images.nasa.gov/',
    description: 'Official NASA image, audio, and video library.',
    rightsNote: 'NASA media is generally public domain in the U.S.; item guidance still applies.',
    capabilities: ['browse', 'search', 'on demand', 'download'],
  }),
  source({
    id: 'wikimedia', displayName: 'Wikimedia Commons', types: ['video', 'audio'],
    color: 'var(--source-wikimedia)', homepage: 'https://commons.wikimedia.org/',
    description: 'Shared repository of free-licensed and public-domain media.',
    rightsNote: 'Follow the specific license and attribution terms on each file.',
    capabilities: ['browse', 'search', 'on demand', 'download'],
  }),
  source({
    id: 'librivox', displayName: 'LibriVox', types: ['audio'],
    color: 'var(--source-librivox)', homepage: 'https://librivox.org/',
    description: 'Volunteer recordings of public-domain books.',
    rightsNote: 'Recordings are dedicated to the public domain in the United States.',
    capabilities: ['browse', 'search', 'on demand', 'download'],
  }),
  source({
    id: 'media-ccc', displayName: 'media.ccc.de', types: ['video', 'audio', 'tv', 'radio'],
    color: 'var(--source-media-ccc)', homepage: 'https://media.ccc.de/',
    description: 'Technical conference recordings plus current C3VOC event streams.',
    rightsNote: 'The license encoded on each recording applies; otherwise consult the event.',
    capabilities: ['browse', 'search', 'on demand', 'live', 'download', 'record'],
  }),
  source({
    id: 'gpodder', displayName: 'gPodder Podcasts', types: ['audio', 'video', 'radio', 'tv'],
    color: 'var(--source-gpodder)', homepage: 'https://gpodder.net/',
    description: 'Open podcast directory resolved through publisher RSS/Atom feeds.',
    rightsNote: 'Episodes remain under each publisher\'s stated license or terms.',
    capabilities: ['browse', 'search', 'on demand', 'live', 'download', 'record', 'content ratings'],
  }),
  source({
    id: 'peertube', displayName: 'PeerTube', types: ['video', 'tv'],
    color: 'var(--source-peertube)', homepage: 'https://joinpeertube.org/',
    description: 'Federated independent video indexed through public SepiaSearch.',
    rightsNote: 'Licenses and download permission are controlled by each video and instance.',
    capabilities: ['browse', 'search', 'on demand', 'live video', 'conditional download', 'record', 'content ratings'],
  }),
  source({
    id: 'owncast', displayName: 'Owncast', types: ['tv'],
    color: 'var(--source-owncast)', homepage: 'https://owncast.online/',
    description: 'Directory of independent self-hosted live video broadcasters.',
    rightsNote: 'Independent broadcaster — see the source for rights and terms.',
    capabilities: ['browse', 'search', 'live video', 'record', 'content ratings'],
  }),
]);

export const SOURCE_IDS = Object.freeze(SOURCES.map((entry) => entry.id));

/**
 * Sources the app used to offer. They are kept only so items saved from them
 * still read sensibly: a label, the neutral colour, and a plain message when
 * playing one would need the removed adapter. Nothing lists or fetches them.
 */
export const RETIRED_SOURCES = Object.freeze({
  // Removed because loc.gov now answers apps only with a browser check.
  'library-of-congress': Object.freeze({ displayName: 'Library of Congress' }),
});

export const RETIRED_SOURCE_MESSAGE = 'Source no longer available.';

export function isRetiredSource(id) {
  return Object.hasOwn(RETIRED_SOURCES, String(id));
}

const SOURCE_BY_ID = new Map(SOURCES.map((entry) => [entry.id, entry]));

export function getSource(id) {
  return SOURCE_BY_ID.get(id);
}

export function getSourceLabel(id) {
  if (id === 'playlist') return 'My Playlists';
  if (id === 'computer') return 'Computer';
  return getSource(id)?.displayName || (isRetiredSource(id) ? RETIRED_SOURCES[id].displayName : id);
}

export function getSourceColor(id) {
  return getSource(id)?.color || 'var(--text-mute)';
}

/** Lazy adapter loader so each adapter is fetched/parsed only when needed. */
const ADAPTER_LOADERS = Object.freeze({
  'radio-browser': () => import('../adapters/radio-browser.js'),
  'iptv-org': () => import('../adapters/iptv-org.js'),
  'internet-archive': () => import('../adapters/internet-archive.js'),
  'nasa': () => import('../adapters/nasa.js'),
  'wikimedia': () => import('../adapters/wikimedia.js'),
  'librivox': () => import('../adapters/librivox.js'),
  'media-ccc': () => import('../adapters/media-ccc.js'),
  'gpodder': () => import('../adapters/gpodder.js'),
  'peertube': () => import('../adapters/peertube.js'),
  'owncast': () => import('../adapters/owncast.js'),
});

const adapterCache = new Map();

export async function loadAdapter(id) {
  if (id === 'playlist') return {}; // Imported channels already carry their canonical URLs.
  if (adapterCache.has(id)) return adapterCache.get(id);
  if (isRetiredSource(id)) {
    // Saved items may still name a removed source; say so plainly.
    throw Object.assign(new Error(`Retired source: ${id}`), {
      code: 'SOURCE_RETIRED',
      userMessage: RETIRED_SOURCE_MESSAGE,
    });
  }
  const loader = ADAPTER_LOADERS[id];
  if (!loader) throw new Error(`Unknown adapter: ${id}`);
  const mod = await loader();
  if (mod.catalogPolicy && typeof mod.catalogPolicy === 'object') {
    catalogScheduler.setPolicy(id, mod.catalogPolicy);
  }
  adapterCache.set(id, mod);
  return mod;
}
