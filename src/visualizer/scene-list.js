/**
 * The scene chooser: a button with the scene's name and cost badge that opens
 * a panel with a search field and a scrollable list of every scene, grouped
 * by Psychedelia's category and sorted by name (scenes.js orderedScenes), each
 * with a small badge for how hard it works the graphics card (light, medium,
 * heavy).
 *
 * Keyboard: the button opens it (Enter, Space, Down); in the search field
 * Up / Down move through the scenes shown, Enter picks, Escape closes and
 * returns to the button. Typing filters by name, category or cost word, and
 * "Favourites" shows only starred scenes (a star marks them in the list);
 * a scene picked while it is on comes with the effects and overlays starred
 * with it (onPick's `favourite`).
 * A click outside, focus moving out, or Escape closes it. In the side panel
 * the list opens in place, below its button.
 */

/** A black star (written as an escape; source files stay ASCII). */
export const STAR = String.fromCharCode(0x2605);
/** The Favourites filter's tooltip: what it shows, and what picking does. */
export const FAVOURITES_FILTER_TITLE = 'Show only favourite scenes; picking one brings back the effects and overlays starred with it';

export const COST_LABELS = Object.freeze({ light: 'Light', medium: 'Medium', heavy: 'Heavy' });
const COST_TITLES = Object.freeze({
  light: 'Light on the graphics card',
  medium: 'Works the graphics card moderately',
  heavy: 'Heavy on the graphics card; quality may be lowered on weaker computers',
});

const fold = (text) => String(text || '').toLowerCase();

/** Scenes in `ordered` that match `query` (name, category or cost word). */
export function filterScenes(ordered, query, only = null) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const kept = only ? ordered.filter((scene) => only.has(scene.id)) : ordered;
  if (!words.length) return kept.slice();
  return kept.filter((scene) => {
    const text = `${fold(scene.name)} ${fold(scene.category)} ${fold(scene.cost)}`;
    return words.every((word) => text.includes(word));
  });
}

/**
 * @param {object} deps
 * @param {Document} deps.doc
 * @param {Array} deps.scenes  in the order to show them
 * @param {(id: string, how: { favourite: boolean }) => void} deps.onPick
 * @param {(target, name, fn, options?) => void} deps.listen  adds a listener
 *        that is removed when the tab is closed
 */
export function createSceneList({ doc, scenes, onPick, listen }) {
  const el = (tag, className, attributes = {}, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const badge = (cost) => el('span', `viz-cost viz-cost-${cost}`, { title: COST_TITLES[cost] || '' }, COST_LABELS[cost] || cost);

  const button = el('button', 'viz-select viz-scene', {
    type: 'button', 'aria-haspopup': 'dialog', 'aria-controls': 'viz-scene-panel', 'aria-expanded': 'false', 'aria-label': 'Scene', title: 'Choose a scene',
  });
  const buttonName = el('span', 'viz-scene-name');
  const buttonBadge = el('span', 'viz-cost');
  button.append(buttonName, buttonBadge);

  const panel = el('div', 'viz-scene-panel', { id: 'viz-scene-panel', role: 'dialog', 'aria-label': 'Scenes' });
  panel.hidden = true;
  const search = el('input', 'viz-scene-search', {
    type: 'search', placeholder: 'Search scenes', 'aria-label': 'Search scenes', autocomplete: 'off', spellcheck: 'false',
    'aria-controls': 'viz-scene-options',
  });
  // Only the starred scenes.
  const favouritesOnly = el('button', 'viz-seg viz-fav-filter', {
    type: 'button', 'aria-pressed': 'false', title: FAVOURITES_FILTER_TITLE,
  }, 'Favourites');
  const tools = el('div', 'viz-scene-tools');
  tools.append(search, favouritesOnly);
  // tabindex -1: the list scrolls and holds nothing focusable (the arrows
  // move through it from the search box), so Chromium (WebView2) would
  // otherwise make it a Tab stop of its own: the stray stop the old list had.
  const list = el('div', 'viz-scene-options', {
    id: 'viz-scene-options', role: 'listbox', 'aria-label': 'Scenes', tabindex: '-1',
  });
  const empty = el('p', 'viz-scene-empty', {}, 'No scene matches.');
  empty.hidden = true;
  panel.append(tools, list, empty);

  // One group per category, in the order given.
  const groups = [];
  const options = new Map();
  const marks = new Map(); // id -> its star
  const names = new Map(); // id -> its name
  for (const scene of scenes) {
    let group = groups[groups.length - 1];
    if (!group || group.category !== scene.category) {
      const node = el('div', 'viz-scene-group', { role: 'group', 'aria-label': scene.category || 'Other' });
      node.append(el('div', 'viz-scene-heading', { 'aria-hidden': 'true' }, scene.category || 'Other'));
      group = { category: scene.category, node, ids: [] };
      groups.push(group);
      list.append(node);
    }
    const option = el('div', 'viz-scene-option', {
      role: 'option', id: `viz-scene-${scene.id}`, 'data-scene': scene.id, 'aria-selected': 'false',
    });
    const star = el('span', 'viz-scene-star', { 'aria-hidden': 'true' }, STAR);
    star.hidden = true;
    option.append(el('span', 'viz-scene-option-name', {}, scene.name), badge(scene.cost), star);
    marks.set(scene.id, star);
    names.set(scene.id, scene.name);
    group.node.append(option);
    group.ids.push(scene.id);
    options.set(scene.id, option);
  }

  let current = null;
  let shown = scenes.slice();
  let active = -1;
  let starred = new Set();
  let onlyStarred = false;

  function setActive(index) {
    const before = shown[active];
    if (before) options.get(before.id).classList.remove('viz-active');
    active = shown.length ? Math.max(0, Math.min(shown.length - 1, index)) : -1;
    const now = shown[active];
    if (now) {
      const node = options.get(now.id);
      node.classList.add('viz-active');
      search.setAttribute('aria-activedescendant', node.getAttribute('id'));
      try { node.scrollIntoView?.({ block: 'nearest' }); } catch (_) {}
    } else {
      search.setAttribute('aria-activedescendant', '');
    }
  }

  function applyFilter() {
    // The row lit now is cleared while `shown` still has it.
    const before = shown[active];
    if (before) options.get(before.id).classList.remove('viz-active');
    active = -1;
    shown = filterScenes(scenes, search.value, onlyStarred ? starred : null);
    const visible = new Set(shown.map((scene) => scene.id));
    for (const [id, node] of options) node.hidden = !visible.has(id);
    for (const group of groups) group.node.hidden = !group.ids.some((id) => visible.has(id));
    empty.hidden = shown.length > 0;
    empty.textContent = onlyStarred && !starred.size ? 'No favourites yet: star a scene with the star button.' : 'No scene matches.';
    const at = shown.findIndex((scene) => scene.id === current);
    setActive(at >= 0 ? at : 0);
  }

  function open() {
    if (!panel.hidden) return;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    search.value = '';
    applyFilter();
    try { search.focus?.(); } catch (_) {}
  }

  function close(returnFocus = false) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus) { try { button.focus?.(); } catch (_) {} }
  }

  function pick(id) {
    close(true);
    // From the favourites (the filter on): with what was starred with it.
    if (id) onPick(id, { favourite: onlyStarred && starred.has(id) });
  }

  listen(button, 'click', () => (panel.hidden ? open() : close()));
  listen(button, 'keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault?.(); open(); }
  });
  listen(search, 'input', applyFilter);
  listen(favouritesOnly, 'click', () => {
    onlyStarred = !onlyStarred;
    favouritesOnly.setAttribute('aria-pressed', onlyStarred ? 'true' : 'false');
    applyFilter();
    try { search.focus?.(); } catch (_) {}
  });
  listen(search, 'keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault?.();
      setActive(active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter') {
      event.preventDefault?.();
      pick(shown[active]?.id);
    }
  });
  // Escape anywhere in the panel closes it and gives focus back to the button.
  listen(panel, 'keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault?.();
    event.stopPropagation?.();
    close(true);
  });
  // Focus moving to something outside the panel (Tab, Shift+Tab) closes it.
  // No relatedTarget (a click on a row, which takes no focus; the window
  // losing focus) is left to the pointer handler below.
  listen(panel, 'focusout', (event) => {
    const next = event.relatedTarget;
    if (!next || panel.contains?.(next) || button.contains?.(next)) return;
    close();
  });
  listen(list, 'click', (event) => {
    const node = event.target?.closest?.('[data-scene]') || (event.target?.getAttribute?.('data-scene') ? event.target : null);
    if (node) pick(node.getAttribute('data-scene'));
  });
  if (doc?.addEventListener) {
    listen(doc, 'pointerdown', (event) => {
      if (panel.hidden) return;
      const target = event.target;
      if (target && (panel.contains?.(target) || button.contains?.(target))) return;
      close();
    });
  }

  return {
    button,
    panel,
    search,
    list,
    options,
    get open() { return !panel.hidden; },
    get shown() { return shown.map((scene) => scene.id); },
    get active() { return shown[active]?.id || null; },
    /** Show scene `id` as the chosen one. */
    setCurrent(id) {
      const scene = scenes.find((row) => row.id === id);
      if (!scene) return;
      if (current && options.has(current)) options.get(current).setAttribute('aria-selected', 'false');
      current = id;
      options.get(id).setAttribute('aria-selected', 'true');
      buttonName.textContent = scene.name;
      buttonBadge.className = `viz-cost viz-cost-${scene.cost}`;
      buttonBadge.textContent = COST_LABELS[scene.cost] || scene.cost;
      buttonBadge.setAttribute('title', COST_TITLES[scene.cost] || '');
      button.setAttribute('aria-label', `Scene: ${scene.name}, ${COST_LABELS[scene.cost] || scene.cost}`);
    },
    get value() { return current; },
    favouritesOnly,
    /** The starred scene ids (a Set): marked in the list, and what the
     *  Favourites filter shows. */
    setFavourites(ids) {
      starred = new Set(ids);
      for (const [id, node] of options) {
        marks.get(id).hidden = !starred.has(id);
        node.setAttribute('aria-label', starred.has(id) ? `${names.get(id)}, favourite` : names.get(id));
      }
      if (!panel.hidden) applyFilter();
    },
    openList: open,
    close,
    pick,
  };
}
