import { randomOne } from '../lib/search.js';
import { SOURCES, getSourceLabel } from '../lib/sources.js';
import { getPlaybackActionCount, playItem } from '../lib/player.js';
import { catalogScheduler, CATALOG_PRIORITY } from '../lib/catalog-scheduler.js';
import { isContentAllowed } from '../lib/content-rating.js';

const filter = { type: '', country: '', tag: '', source: 'all' };
const TYPES = [
  ['', 'Any type'], ['radio', 'Radio only'], ['tv', 'TV only'],
  ['video', 'Video only'], ['audio', 'Audio only'],
];
const SURPRISE_DEADLINE_MS = 20_000;
const SOURCE_DEADLINE_MS = 4_000;
let nextRequest = 0;
let lastPick = null;
let lastSource = '';

export function mountSurprise(host, {
  doc, subscribe, getMode, getSettings, getCurrentItem, random = randomOne, play = playItem,
  playbackActionCount = getPlaybackActionCount,
  randomNumber = Math.random,
}) {
  let destroyed = false;
  let loading = false;
  let cancelRequest = null;

  function control(tag, className, attrs, text = '') {
    const node = doc.createElement(tag);
    node.className = className;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    node.textContent = text;
    host.appendChild(node);
    return node;
  }

  const button = control('button', 'btn btn-primary np-surprise-button', { type: 'button' }, 'Surprise Me');
  const chips = TYPES.map(([type, label]) => {
    const chip = control('button', 'chip', { type: 'button' }, label);
    chip.addEventListener('click', () => {
      filter.type = type;
      syncChips();
    });
    return [type, chip];
  });
  function syncChips() {
    for (const [type, chip] of chips) {
      const active = filter.type === type;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
    }
  }
  syncChips();

  const country = control('input', 'chip np-surprise-field', {
    type: 'text', placeholder: 'Country (US)', maxlength: '2', 'aria-label': 'Country',
  });
  country.value = filter.country;
  country.addEventListener('input', () => { filter.country = country.value.trim().toUpperCase(); });
  const tag = control('input', 'chip np-surprise-field', {
    type: 'text', placeholder: 'Tag (jazz)', 'aria-label': 'Tagged',
  });
  tag.value = filter.tag;
  tag.addEventListener('input', () => { filter.tag = tag.value.trim().toLowerCase(); });
  const sourceSelect = control('select', 'chip np-surprise-source', { 'aria-label': 'Surprise source' });
  sourceSelect.addEventListener('change', () => { filter.source = sourceSelect.value; });
  const status = control('div', 'np-surprise-status', { role: 'status' });

  function canPlay(item) {
    const settings = getSettings();
    return settings.enabledSources?.[item.source] !== false && isContentAllowed(item, settings);
  }

  function syncSettings() {
    const settings = getSettings();
    const enabled = SOURCES.filter(({ id }) => settings.enabledSources?.[id] !== false);
    if (filter.source !== 'all' && !enabled.some(({ id }) => id === filter.source)) filter.source = 'all';
    sourceSelect.replaceChildren();
    for (const [value, label] of [['all', 'Any source'], ...enabled.map(({ id, displayName }) => [id, displayName])]) {
      const option = doc.createElement('option');
      option.value = value;
      option.textContent = label;
      sourceSelect.appendChild(option);
    }
    sourceSelect.value = filter.source;
    if (lastPick && !canPlay(lastPick)) {
      lastPick = null;
      if (!loading) syncPick();
    }
  }

  function syncPick() {
    const current = getCurrentItem();
    const picked = lastPick && current?.id === lastPick.id && current.source === lastPick.source;
    if (!picked) lastPick = null;
    button.textContent = picked ? 'Surprise Me Again' : 'Surprise Me';
    status.textContent = picked ? `Selected from ${getSourceLabel(lastPick.source)}.` : '';
  }

  function isActive() {
    return !destroyed && getMode() === 'now-playing' && getSettings().nowPlayingSurprise !== false;
  }

  async function surprise() {
    if (loading || !isActive()) return;
    const requestGen = ++nextRequest;
    const actionCount = playbackActionCount();
    loading = true;
    button.textContent = 'Searching…';
    button.disabled = true;

    try {
      const enabled = SOURCES.filter((s) => getSettings().enabledSources?.[s.id] !== false);
      const filterType = filter.type;
      const filterCountry = filter.country;
      const filterTag = filter.tag;
      let candidatePool = enabled;
      if (filter.source !== 'all') {
        candidatePool = candidatePool.filter((source) => source.id === filter.source);
      }
      if (filterType) {
        candidatePool = candidatePool.filter((s) => s.types.includes(filterType));
      }
      status.textContent = `Searching ${candidatePool.length} ${candidatePool.length === 1 ? 'source' : 'sources'}…`;
      const lastIndex = candidatePool.findIndex(({ id }) => id === lastSource);
      let last = lastIndex >= 0 ? candidatePool.splice(lastIndex, 1)[0] : null;

      const passes = (i) => {
        if (filterType && i.type !== filterType) return false;
        if (filterCountry && (!i.country || i.country.toUpperCase() !== filterCountry)) return false;
        if (filterTag && !(i.tags || []).some((t) => String(t).toLowerCase().includes(filterTag))) return false;
        return canPlay(i);
      };

      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), SURPRISE_DEADLINE_MS);
      cancelRequest = () => {
        clearTimeout(deadline);
        controller.abort();
      };
      let chosen = null;
      try {
        while ((candidatePool.length || last) && !controller.signal.aborted) {
          const index = Math.floor(randomNumber() * candidatePool.length);
          const source = candidatePool.length ? candidatePool.splice(index, 1)[0] : last;
          if (source === last) last = null;
          const attempt = new AbortController();
          const timer = setTimeout(() => attempt.abort(), SOURCE_DEADLINE_MS);
          try {
            const item = await catalogScheduler.enqueue({
              sourceId: source.id,
              key: `surprise:${requestGen}`,
              priority: CATALOG_PRIORITY.USER,
              signal: AbortSignal.any([controller.signal, attempt.signal]),
              task: async ({ signal }) => {
                const opts = { limit: 20, signal, throwOnError: true };
                if (filterCountry) opts.country = filterCountry;
                if (filterTag) opts.tag = filterTag;
                const pool = (await random(source.id, opts)).filter(passes);
                return pool.length ? pool[Math.floor(randomNumber() * pool.length)] : null;
              },
            }).catch(() => null);
            if (item && canPlay(item)) {
              chosen = item;
              break;
            }
          } finally {
            clearTimeout(timer);
          }
        }
      } finally {
        cancelRequest?.();
        cancelRequest = null;
      }
      if (!isActive()) return;
      if (playbackActionCount() !== actionCount) {
        button.textContent = 'Surprise Me';
        status.textContent = '';
        return;
      }
      if (chosen && canPlay(chosen)) {
        lastPick = { ...chosen };
        lastSource = chosen.source;
        button.textContent = 'Surprise Me Again';
        status.textContent = `Selected from ${getSourceLabel(chosen.source)}.`;
        play(lastPick).catch(() => {});
      } else {
        button.textContent = 'No results — try again';
        status.textContent = 'No matching item was returned by the selected sources.';
      }
    } catch (error) {
      if (error?.name !== 'AbortError') console.warn('Surprise me failed:', error);
      if (isActive()) {
        button.textContent = 'Surprise Me';
        status.textContent = 'Something went wrong. Try again.';
      }
    } finally {
      loading = false;
      if (isActive()) button.disabled = false;
    }
  }

  button.addEventListener('click', surprise);
  const unsubscribe = subscribe('player-broken-next', () => {
    if (lastPick && getCurrentItem()?.id === lastPick.id) surprise();
  });
  const unsubscribeItem = subscribe('current-item', () => {
    if (!loading) syncPick();
  });
  syncSettings();
  syncPick();

  return {
    syncSettings,
    destroy() {
      destroyed = true;
      if (getSettings().nowPlayingSurprise === false) lastPick = null;
      cancelRequest?.();
      cancelRequest = null;
      unsubscribe();
      unsubscribeItem();
      host.replaceChildren();
    },
  };
}
