/** Authenticated client for hardened dynamic catalog and artwork routes. */

import { ControlApiError, controlRequest } from './capture-client.js';

function requiredString(value, code, message) {
  if (typeof value !== 'string' || !value.trim()) throw new ControlApiError(code, message);
  return value.trim();
}

export function resolvePodcastFeed(url, options = {}) {
  return controlRequest('/api/v1/catalog/feed/resolve', {
    ...options,
    method: 'POST',
    body: { url: requiredString(url, 'INVALID_FEED_URL', 'Podcast feed URL is missing.') },
  });
}

export function resolvePeerTubeVideo(watchUrl, uuid, options = {}) {
  return controlRequest('/api/v1/catalog/peertube/resolve', {
    ...options,
    method: 'POST',
    body: {
      watch_url: requiredString(watchUrl, 'INVALID_PEERTUBE_URL', 'PeerTube watch URL is missing.'),
      uuid: requiredString(uuid, 'INVALID_PEERTUBE_UUID', 'PeerTube UUID is missing.'),
    },
  });
}

export function getOwncastSnapshot(options = {}) {
  return controlRequest('/api/v1/catalog/owncast/snapshot', options);
}

export function registerCatalogAsset({ url, sourceId, itemId }, options = {}) {
  return controlRequest('/api/v1/assets/register', {
    ...options,
    method: 'POST',
    body: {
      url: requiredString(url, 'INVALID_ASSET_URL', 'Artwork URL is missing.'),
      source_id: requiredString(sourceId, 'INVALID_ASSET_SCOPE', 'Artwork source scope is missing.'),
      item_id: requiredString(itemId, 'INVALID_ASSET_SCOPE', 'Artwork item scope is missing.'),
    },
  });
}

export function expireCatalogAsset(assetId, sourceId, itemId, options = {}) {
  const token = requiredString(assetId, 'INVALID_ASSET_ID', 'Artwork registration ID is missing.');
  return controlRequest(`/api/v1/assets/${encodeURIComponent(token)}/expire`, {
    ...options,
    method: 'POST',
    body: {
      source_id: requiredString(sourceId, 'INVALID_ASSET_SCOPE', 'Artwork source scope is missing.'),
      item_id: requiredString(itemId, 'INVALID_ASSET_SCOPE', 'Artwork item scope is missing.'),
    },
  });
}

export function clearCatalogCache(options = {}) {
  return controlRequest('/api/v1/catalog/cache/clear', {
    ...options,
    method: 'POST',
    body: {},
  });
}
