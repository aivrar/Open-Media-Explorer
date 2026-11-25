import { controlRequest, mediaTypeForItem } from '../../lib/capture-client.js';
import { detectStreamKind } from '../../lib/item-model.js';
import { NOW_PLAYING_EVENT } from '../../lib/now-playing.js';
import { getNowPlaying } from '../../lib/player.js';
import { stationStreamAddresses } from '../../lib/station-stream-addresses.js';
import { getState, saveSettings, subscribe } from '../../lib/state.js';
import { createFavoriteTitleScheduler } from './favorite-title-scheduler.js';
import { view } from './state.js';
import { el, setDescriptionReference } from './utils.js';

let mounted;
let songLineCount = 0;

function effectiveAddress(item) {
  return stationStreamAddresses(item).main || item.stream_url || '';
}

function peekMediaType(item, url) {
  const urlKind = detectStreamKind(url.split(/[?#]/, 1)[0], 'audio');
  return urlKind === 'audio' && url === item.stream_url ? mediaTypeForItem(item) : urlKind;
}

const scheduler = createFavoriteTitleScheduler({
  isEligible: (id, url) => !!mounted?.eligibleItem(id, url),
  request(id, url, signal) {
    const item = mounted?.eligibleItem(id, url);
    if (!item) return null;
    return controlRequest('/api/v1/streams/title-peek', {
      method: 'POST', ownConnection: true, signal,
      beforeSend: () => {
        if (!mounted?.eligibleItem(id, url)) throw new DOMException('Favorite is unavailable.', 'AbortError');
      },
      body: {
        item_id: id,
        url,
        delivery: item.delivery || 'unknown',
        media_type: peekMediaType(item, url),
        capture_headers: item.capture_headers || {},
        source: item.source,
        title: item.originalTitle || item.title,
      },
    });
  },
  onChange: (id) => mounted?.paint(id),
});

export function splitFavoriteTitle(title) {
  const separator = / [-–—] /.exec(title);
  if (separator) {
    const performer = title.slice(0, separator.index).trim();
    const song = title.slice(separator.index + separator[0].length).trim();
    if (performer && song) return { performer, song };
  }
  return { performer: '', song: title };
}

export function favoriteTitlesButton() {
  return el('button', {
    className: 'chip', text: "Show what's playing", attrs: { type: 'button', 'aria-pressed': 'false' },
    on: { click: () => saveSettings({ showFavoriteTitles: getState().settings.showFavoriteTitles !== true }) },
  });
}

export function syncFavoriteTitles() {
  mounted?.sync();
}

export function mountFavoriteTitles(host, button) {
  const cards = new Map();
  const intersecting = new Set();
  const lines = new Map();
  let observer;
  let mutations;

  function playbackId() {
    const { currentItem, isPlaying } = getState();
    return isPlaying ? currentItem?.id : null;
  }

  function enabled() {
    return getState().settings.showFavoriteTitles === true
      && view.activeSource === 'favorites' && !document.hidden;
  }

  function eligibleItem(id, url) {
    const card = cards.get(id);
    const item = card?.__item;
    if (!enabled() || !card || card.parentElement !== host || card.isConnected === false || !intersecting.has(card)
        || item?.id !== id || item.type !== 'radio' || item.__contentHidden === true
        || id === playbackId() || item.delivery === 'on-demand' || !url
        || effectiveAddress(item) !== url || peekMediaType(item, url) !== 'audio') return null;
    return item;
  }

  function removeLine(card) {
    const line = lines.get(card);
    if (!line) return;
    setDescriptionReference(card.__open, line.getAttribute('id'), false);
    line.remove();
    lines.delete(card);
  }

  function paint(id) {
    const card = cards.get(id);
    if (!card?.__titleNode) return;
    const playing = id === playbackId();
    const playback = playing ? getNowPlaying() : null;
    const item = card.__item;
    const url = effectiveAddress(item);
    let title = '';
    if (playing) {
      if (playback?.itemId === id) title = playback.title;
    } else if (peekMediaType(item, url) === 'audio') {
      title = scheduler.titleFor(id, url);
    }
    const line = lines.get(card);
    if (line && (line.getAttribute('title') || '') === title) return;
    const { performer, song } = splitFavoriteTitle(title);
    const descriptionId = title ? `favorite-song-${++songLineCount}` : '';
    const node = el('span', {
      className: 'favorite-song-title',
      attrs: title ? { id: descriptionId, title, 'aria-label': title, role: 'group' } : {},
    },
    title ? el('span', { className: 'favorite-song-name', text: performer ? `♪ ${song}` : song }) : null,
    performer ? el('span', { className: 'favorite-song-performer', text: performer }) : null);
    removeLine(card);
    card.__titleNode.after(node);
    lines.set(card, node);
    setDescriptionReference(card.__open, descriptionId, true);
  }

  function updateVisible() {
    const targets = new Map();
    for (const [id, card] of cards) {
      const url = effectiveAddress(card.__item);
      if (eligibleItem(id, url)) targets.set(id, url);
    }
    scheduler.setVisible(targets);
  }

  function collectCards() {
    if (!observer) return;
    const next = new Map();
    for (const card of host.children) {
      const item = card.__item;
      if (item?.type === 'radio' && item.__contentHidden !== true) next.set(item.id, card);
    }
    for (const [id, card] of cards) {
      if (next.get(id) === card) continue;
      observer.unobserve(card);
      intersecting.delete(card);
      removeLine(card);
    }
    const previous = new Map(cards);
    cards.clear();
    for (const [id, card] of next) {
      cards.set(id, card);
      scheduler.setAddress(id, effectiveAddress(card.__item));
      if (previous.get(id) !== card) observer.observe(card);
      paint(id);
    }
    updateVisible();
  }

  function stop() {
    scheduler.setActive(false);
    observer?.disconnect();
    observer = null;
    mutations?.disconnect();
    mutations = null;
    for (const card of lines.keys()) removeLine(card);
    cards.clear();
    intersecting.clear();
  }

  function sync() {
    const checked = getState().settings.showFavoriteTitles === true;
    button.setAttribute('aria-pressed', String(checked));
    button.classList.toggle('is-active', checked);
    if (!enabled()) {
      stop();
      return;
    }
    if (observer) {
      collectCards();
      return;
    }
    // The viewport observer also clips against the Library's results scroller.
    observer = new IntersectionObserver((entries, source) => {
      if (source !== observer || document.hidden || view.activeSource !== 'favorites') return;
      for (const { target, isIntersecting, intersectionRatio } of entries) {
        if (target.parentElement !== host) continue;
        if (isIntersecting && intersectionRatio > 0) intersecting.add(target);
        else intersecting.delete(target);
      }
      updateVisible();
    });
    mutations = new MutationObserver(collectCards);
    mutations.observe(host, { childList: true });
    scheduler.setActive(true);
    collectCards();
  }

  function syncPlayback() {
    if (!observer) return;
    for (const id of cards.keys()) paint(id);
    updateVisible();
  }

  mounted = { eligibleItem, paint, sync };
  const subs = [
    subscribe('settings-change', sync),
    subscribe('station-streams-change', (id) => {
      const item = cards.get(id)?.__item || getState().favorites.find((favorite) => favorite.id === id);
      scheduler.setAddress(id, item ? effectiveAddress(item) : '');
      if (observer) collectCards();
    }),
    subscribe('playing-change', syncPlayback),
    subscribe('current-item', syncPlayback),
    subscribe(NOW_PLAYING_EVENT, syncPlayback),
  ];
  document.addEventListener('visibilitychange', sync);
  sync();
  return () => {
    stop();
    mounted = null;
    for (const off of subs) off();
    document.removeEventListener('visibilitychange', sync);
  };
}
