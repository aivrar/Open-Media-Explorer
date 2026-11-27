export const STATION_LIST_GAP = 8;
export const STATION_ROW_HEIGHTS = { small: 56, medium: 68, large: 84 };
const OVERSCAN = 2;
const optionId = (index) => `tuner-station-${index}`;

export function stationListWindow(count, rowHeight, height, scrollTop = 0, columns = 1) {
  const stride = rowHeight + STATION_LIST_GAP;
  const total = Math.max(0, Math.ceil(count / columns) * stride - STATION_LIST_GAP);
  const first = Math.max(0, Math.floor(scrollTop / stride) - OVERSCAN);
  const last = Math.ceil((scrollTop + height) / stride) + OVERSCAN;
  return { stride, total, start: Math.min(count, first * columns), end: Math.min(count, last * columns) };
}

export function tunedScrollTop(index, columns, stride, height, total) {
  const middle = Math.floor((height + STATION_LIST_GAP) / stride / 2);
  const top = (Math.floor(index / columns) - middle) * stride;
  return Math.max(0, Math.min(total - height, top));
}

export function mountTunerStationList(list, content, { makeOption, tune, onRender, onScroll }) {
  const controller = new AbortController();
  let stations = [];
  let selected = -1;
  let active = -1;
  let rowHeight = STATION_ROW_HEIGHTS.small;
  let height = 0;
  let columns = 1;
  let rendered = null;
  let focusedOption = null;
  let keyboardFocus = false;

  function draw(force = false) {
    if (!height || !stations.length) {
      if (rendered) {
        content.replaceChildren();
        onRender();
      }
      rendered = null;
      focusedOption?.classList.remove('is-focused');
      focusedOption = null;
      list.removeAttribute('aria-activedescendant');
      return;
    }

    const { start, end, stride } = stationListWindow(stations.length, rowHeight, height, list.scrollTop, columns);
    if (force || !rendered || start !== rendered.start || end !== rendered.end) {
      const nodes = [];
      for (let index = start; index < end; index++) {
        const option = makeOption(stations[index], index === selected);
        option.id = optionId(index);
        option.dataset.index = index;
        option.style.top = `${Math.floor(index / columns) * stride}px`;
        if (columns === 2) {
          option.style.width = 'calc(50% - 4px)';
          option.style.left = index % 2 ? 'calc(50% + 4px)' : '0';
        }
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === selected));
        option.setAttribute('aria-posinset', index + 1);
        option.setAttribute('aria-setsize', stations.length);
        nodes.push(option);
      }
      content.replaceChildren(...nodes);
      rendered = { start, end };
      onRender();
    }
    const nextFocus = keyboardFocus ? content.children[active - start] : null;
    if (nextFocus !== focusedOption) {
      focusedOption?.classList.remove('is-focused');
      focusedOption = nextFocus;
      focusedOption?.classList.add('is-focused');
    }
    if (focusedOption) list.setAttribute('aria-activedescendant', optionId(active));
    else list.removeAttribute('aria-activedescendant');
  }

  function setScroll(top, total) {
    list.scrollTop = Math.max(0, Math.min(total - height, top));
  }

  function keepActiveInView() {
    const stride = rowHeight + STATION_LIST_GAP;
    const first = Math.ceil((list.scrollTop - 0.5) / stride) * columns;
    const lastRow = Math.floor((list.scrollTop + height - rowHeight + 0.5) / stride);
    const last = Math.min(stations.length - 1, (lastRow + 1) * columns - 1);
    active = Math.min(Math.max(last, first), Math.max(first, active));
  }

  function clearKeyboardFocus() {
    if (!keyboardFocus) return;
    keyboardFocus = false;
    draw();
  }

  const options = { signal: controller.signal };
  list.addEventListener('scroll', () => {
    draw();
    onScroll();
  }, { ...options, passive: true });
  list.addEventListener('scrollend', () => {
    const { stride, total } = stationListWindow(stations.length, rowHeight, height, 0, columns);
    const top = Math.round(list.scrollTop / stride) * stride;
    if (Math.abs(top - list.scrollTop) > 0.5) setScroll(top, total);
    draw();
  }, options);
  list.addEventListener('focus', () => {
    if (!height || !stations.length || !list.matches(':focus-visible')) return;
    keyboardFocus = true;
    keepActiveInView();
    draw();
  }, options);
  list.addEventListener('blur', clearKeyboardFocus, options);
  list.addEventListener('pointerdown', clearKeyboardFocus, options);
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (!option || !content.contains(option)) return;
    list.focus({ preventScroll: true });
    keyboardFocus = false;
    active = Number(option.dataset.index);
    tune(active);
    draw();
  }, options);
  list.addEventListener('keydown', (event) => {
    const { key } = event;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' '].includes(key)) return;
    event.stopPropagation();
    if (!height || !stations.length) return;
    event.preventDefault();
    keyboardFocus = true;
    keepActiveInView();
    const { stride, total } = stationListWindow(stations.length, rowHeight, height, 0, columns);
    const page = Math.max(1, Math.floor((height + STATION_LIST_GAP) / stride) * columns);
    switch (key) {
      case 'ArrowLeft': if (active % columns) active--; break;
      case 'ArrowRight': if (active % columns < columns - 1) active++; break;
      case 'ArrowUp': if (active >= columns) active -= columns; break;
      case 'ArrowDown': if (Math.floor(active / columns) < Math.floor((stations.length - 1) / columns)) active += columns; break;
      case 'PageUp': active -= page; break;
      case 'PageDown': active += page; break;
      case 'Home': active = 0; break;
      case 'End': active = stations.length - 1; break;
      case 'Enter':
      case ' ': tune(active); draw(); return;
      default: return;
    }
    active = Math.max(0, Math.min(stations.length - 1, active));
    const top = stride * Math.floor(active / columns);
    setScroll(Math.min(top, Math.max(list.scrollTop, top + rowHeight - height)), total);
    draw();
  }, options);

  return {
    update(nextStations, index, nextHeight, size, force = false, nextColumns = 1) {
      const newRowHeight = STATION_ROW_HEIGHTS[size];
      const changed = nextStations !== stations || index !== selected || nextHeight !== height
        || columns !== nextColumns || rowHeight !== newRowHeight;
      force ||= changed;
      columns = nextColumns;
      stations = nextStations;
      selected = stations.length ? index : -1;
      height = nextHeight;
      rowHeight = newRowHeight;
      list.tabIndex = height && stations.length ? 0 : -1;
      if (!height || !stations.length) {
        active = -1;
        keyboardFocus = false;
        content.style.height = '0px';
        draw();
        return;
      }
      const { stride, total } = stationListWindow(stations.length, rowHeight, height, 0, columns);
      content.style.height = `${total}px`;
      if (force) {
        active = selected;
        setScroll(tunedScrollTop(selected, columns, stride, height, total), total);
      }
      draw(force);
    },
    destroy() { controller.abort(); },
  };
}
