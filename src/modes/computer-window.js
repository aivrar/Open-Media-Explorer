export function computerWindow(count, stride, height, scrollTop, columns = 1) {
  const total = Math.ceil(count / columns) * stride;
  if (height <= 0 || count === 0) return { start: 0, end: 0, total };
  const top = Math.max(0, Math.min(scrollTop, total - height));
  const start = Math.max(0, Math.floor(top / stride) - 1) * columns;
  const end = Math.min(count, (Math.ceil((top + height) / stride) + 1) * columns);
  return { start, end, total };
}

export function mountComputerWindow(viewport, list, {
  stride, columnWidth, columnGap = 0, headerHeight = 0, horizontalStride = () => 0,
  makeRow, rowKind, indexOfKey, placeWindow, endMarker = null, canFocus = () => true,
  doc = viewport.ownerDocument, win = doc.defaultView,
  requestFrame = win?.requestAnimationFrame?.bind(win),
  cancelFrame = win?.cancelAnimationFrame?.bind(win),
  ResizeObserver = win?.ResizeObserver,
}) {
  const nodes = new Map();
  const listeners = new AbortController();
  let count = 0;
  let columns = 1;
  let extent = 0;
  let step = 0;
  let horizontal = false;
  const position = () => viewport[horizontal ? 'scrollLeft' : 'scrollTop'] || 0;
  const scrollTo = (top) => { viewport[horizontal ? 'scrollLeft' : 'scrollTop'] = top; };
  let active = -1;
  let frame = null;
  let focused = false;
  let focusedStar = false;
  let rendered;
  const recycled = new Map();

  function remove(index, row) {
    if (row.node.contains(doc.activeElement)) {
      focused = true;
      focusedStar = doc.activeElement === row.star;
    }
    row.dispose?.();
    row.node.remove();
    nodes.delete(index);
    if (row.kind != null) {
      if (!recycled.has(row.kind)) recycled.set(row.kind, []);
      recycled.get(row.kind).push(row);
    }
  }

  function nearestRow(index) {
    const total = rendered?.total || 0;
    const top = Math.max(0, Math.min(position(), total - extent));
    const start = Math.floor(top / step) * columns;
    const end = Math.ceil((top + extent) / step) * columns;
    let best = -1;
    let distance = Infinity;
    for (const [candidate, row] of nodes) {
      if (row.focusable === false) continue;
      const outside = candidate < start || candidate >= end;
      const cost = Math.abs(candidate - index) + (outside ? count : 0);
      if (cost < distance) {
        best = candidate;
        distance = cost;
      }
    }
    return best;
  }

  function focus(index, preferStar = false) {
    const target = nodes.get(nearestRow(index));
    const control = (preferStar && target?.star) || target?.focusNode || target?.node || viewport;
    control.focus({ preventScroll: true });
  }

  function draw(preferred = active) {
    const { start, end, total } = computerWindow(count, step, extent, position(), columns);
    if (rendered && rendered.start === start && rendered.end === end
      && rendered.total === total && rendered.columns === columns
      && rendered.horizontal === horizontal && rendered.step === step) return;
    rendered = { start, end, total, columns, horizontal, step };
    for (const [index, row] of nodes) {
      if (index < start || index >= end) remove(index, row);
    }
    placeWindow(rendered);
    let next = endMarker;
    for (let index = end - 1; index >= start; index--) {
      let row = nodes.get(index);
      if (!row) {
        const kind = rowKind?.(index);
        const spare = recycled.get(kind)?.pop();
        row = makeRow(index, spare);
        row.kind = kind;
        if (!spare && row.focusable !== false) {
          const activate = () => {
            active = Number(row.node.dataset.index);
            setTabStops();
          };
          (row.focusNode || row.node).addEventListener('focus', activate);
          row.star?.addEventListener('focus', activate);
        }
        row.node.dataset.index = index;
        nodes.set(index, row);
      }
      if (row.node.parentElement !== list || row.node.nextElementSibling !== next) {
        const control = row.node.contains(doc.activeElement) ? doc.activeElement : null;
        list.insertBefore(row.node, next);
        control?.focus({ preventScroll: true });
      }
      next = row.node;
    }
    recycled.clear();
    if (!nodes.has(active)) active = nearestRow(preferred);
    setTabStops();
    if (focused) {
      focused = false;
      focus(active, focusedStar);
      focusedStar = false;
    }
  }

  function setTabStops() {
    for (const [index, row] of nodes) {
      if (row.focusable === false) continue;
      const tabIndex = index === active ? 0 : -1;
      (row.focusNode || row.node).tabIndex = tabIndex;
      if (row.star) row.star.tabIndex = tabIndex;
    }
  }

  function measureSize() {
    const width = viewport.clientWidth || 0;
    const across = horizontalStride();
    horizontal = across > 0;
    step = across || (typeof stride === 'function' ? stride() : stride);
    const header = typeof headerHeight === 'function' ? headerHeight() : headerHeight;
    extent = horizontal ? width : Math.max(0, (viewport.clientHeight || 0) - header);
    const cardWidth = typeof columnWidth === 'function' ? columnWidth() : columnWidth;
    columns = cardWidth && !horizontal ? Math.max(1, Math.floor((width + columnGap) / (cardWidth + columnGap))) : 1;
  }

  function measure() {
    measureSize();
    draw();
  }

  function scrolled() {
    if (frame != null) return;
    if (!requestFrame) {
      draw();
      return;
    }
    frame = requestFrame(() => {
      frame = null;
      draw();
    });
  }

  function keydown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const row = nodes.get(active);
    if (event.target !== viewport && event.target !== (row?.focusNode || row?.node) && event.target !== row?.star) return;
    if (active < 0) return;
    const page = Math.max(1, Math.floor(extent / step)) * columns;
    const moves = {
      PageUp: -page, PageDown: page,
      ...(!horizontal && { ArrowUp: -columns, ArrowDown: columns }),
      ...(columnWidth ? { ArrowLeft: -1, ArrowRight: 1 } : {}),
      Home: -count, End: count,
    };
    const move = moves[event.key];
    if (typeof move !== 'number') return;
    event.preventDefault();
    const direction = Math.sign(move);
    const target = Math.min(count - 1, Math.max(0, active + move));
    // Skip any non-interactive disc heading, including the first row.
    let index = target;
    while (index >= 0 && index < count && !canFocus(index)) index += direction;
    if (index < 0 || index >= count) {
      index = target - direction;
      while (index >= 0 && index < count && !canFocus(index)) index -= direction;
    }
    if (index < 0 || index >= count) return;
    const top = Math.floor(index / columns) * step;
    scrollTo(Math.max(0, Math.min(top, Math.max(position(), top + step - extent))));
    active = index;
    draw();
    setTabStops();
    focus(active, event.target === row?.star);
  }

  const options = { signal: listeners.signal };
  viewport.tabIndex = -1;
  viewport.addEventListener('scroll', scrolled, { ...options, passive: true });
  viewport.addEventListener('keydown', keydown, options);
  const observer = ResizeObserver && new ResizeObserver(measure);
  observer?.observe(viewport);
  if (!observer) win?.addEventListener('resize', measure, options);

  return {
    position,
    focusedRow() {
      const row = nodes.get(active);
      if (row?.node.contains(doc.activeElement)) return { index: active, key: row.key, top: position() };
      return null;
    },
    update(size, top = position(), restoreFocus = null, indexOfRow) {
      const previous = restoreFocus?.index ?? active;
      const row = nodes.get(active);
      const key = restoreFocus?.key ?? (row?.node.contains(doc.activeElement) || indexOfRow ? row?.key : null);
      const matching = key == null ? -1 : indexOfKey(key);
      active = -1;
      const reused = [];
      for (const [index, row] of nodes) {
        const next = indexOfRow?.(row) ?? -1;
        if (next < 0) remove(index, row);
        else {
          row.node.dataset.index = next;
          row.reindex?.(next);
          reused.push([next, row]);
        }
      }
      nodes.clear();
      for (const [index, row] of reused) nodes.set(index, row);
      if (indexOfRow) active = matching < 0 ? previous : matching;
      focused ||= Boolean(restoreFocus) || doc.activeElement === viewport;
      count = size;
      rendered = null;
      measureSize();
      const { total } = computerWindow(count, step, extent, 0, columns);
      // Set the scroll position after the new scroll extent exists.
      placeWindow({ start: 0, end: 0, total, columns, horizontal, step });
      scrollTo(top);
      draw(matching < 0 ? previous : matching);
    },
    forEachRow(fn) { nodes.forEach(fn); },
    focus,
    destroy() {
      listeners.abort();
      observer?.disconnect();
      if (frame != null) cancelFrame?.(frame);
      for (const [index, row] of nodes) remove(index, row);
      recycled.clear();
    },
  };
}
