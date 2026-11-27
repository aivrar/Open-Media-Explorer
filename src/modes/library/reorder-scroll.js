const EDGE_ZONE = 64;
const MIN_SPEED = 4;
const MAX_SPEED = 22;

export function reorderScrollSpeed(y, top, bottom) {
  const zone = Math.min(EDGE_ZONE, (bottom - top) / 2);
  if (zone <= 0) return 0;
  const above = y - top;
  const below = bottom - y;
  const distance = Math.min(above, below);
  if (distance > zone || above === below) return 0;
  const speed = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * (1 - Math.max(0, distance) / zone);
  return above < below ? -Math.round(speed) : Math.round(speed);
}

function speedAt(scroller, doc, x, y) {
  const pane = scroller.getBoundingClientRect();
  if (x < pane.left || x >= pane.right) return 0;
  let bottom = Math.min(pane.bottom, doc.defaultView.innerHeight);
  // The dock only obscures the part of the pane covered by the video.
  for (const id of ['player-bar', 'video-el']) {
    const cover = doc.getElementById(id)?.getBoundingClientRect();
    if (cover?.height > 0 && cover.bottom > pane.top && x >= cover.left && x < cover.right) {
      bottom = Math.min(bottom, cover.top);
    }
  }
  return reorderScrollSpeed(y, Math.max(0, pane.top), bottom);
}

// These listeners belong to one native reorder drag. A stationary pointer
// can keep scrolling between dragover events and is hit-tested after a scroll.
export function startReorderScroll(scroller, { refresh, end, canExtend, extend, contains }) {
  const doc = scroller?.ownerDocument;
  const win = doc?.defaultView;
  if (!win?.requestAnimationFrame) return null;
  let point = null;
  let frame = null;
  let stopped = false;

  function hasRoom(speed) {
    return speed < 0
      ? scroller.scrollTop > 0
      : scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight - 1;
  }

  function queue() {
    const speed = point && speedAt(scroller, doc, point.x, point.y);
    if (!stopped && speed && (hasRoom(speed) || canExtend(speed))) {
      if (frame === null) frame = win.requestAnimationFrame(tick);
    } else if (frame !== null) {
      win.cancelAnimationFrame(frame);
      frame = null;
    }
  }

  function refreshAtPointer() {
    if (point) refresh(doc.elementFromPoint(point.x, point.y));
  }

  function tick() {
    frame = null;
    if (stopped || !point) return;
    const speed = speedAt(scroller, doc, point.x, point.y);
    if (!speed) return;
    if (!hasRoom(speed) && canExtend(speed)) extend(speed);
    scroller.scrollTop += speed;
    refreshAtPointer();
    queue();
  }

  function onDragOver(event) {
    point = { x: event.clientX, y: event.clientY };
    queue();
  }

  function onScroll() {
    refreshAtPointer();
    queue();
  }

  function onDragLeave(event) {
    if (event.relatedTarget) return;
    const { clientX: x, clientY: y, target } = event;
    if (target === doc.documentElement || x <= 0 || y <= 0 || x >= win.innerWidth || y >= win.innerHeight) end();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') end();
  }

  function onDrop(event) {
    // The results host handles and ends its own drops.
    if (!contains(event.target)) end();
  }

  doc.addEventListener('dragover', onDragOver, true);
  doc.addEventListener('dragleave', onDragLeave, true);
  doc.addEventListener('drop', onDrop, true);
  doc.addEventListener('dragend', end, true);
  doc.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('blur', end);
  scroller.addEventListener('scroll', onScroll, { passive: true });

  return () => {
    stopped = true;
    point = null;
    queue();
    doc.removeEventListener('dragover', onDragOver, true);
    doc.removeEventListener('dragleave', onDragLeave, true);
    doc.removeEventListener('drop', onDrop, true);
    doc.removeEventListener('dragend', end, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('blur', end);
    scroller.removeEventListener('scroll', onScroll);
  };
}
