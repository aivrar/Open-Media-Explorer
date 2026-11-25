const CONCURRENCY = 4;
const REFRESH_MS = 3 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;

/** A session's title cache and request limits, independent of any mounted view. */
export function createFavoriteTitleScheduler({
  request, isEligible = () => true, onChange = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const records = new Map();
  const pending = new Map();
  let visible = new Map();
  let active = false;
  let timer = null;

  function setAddress(id, url) {
    if (records.get(id)?.url !== url) records.delete(id);
    const peek = pending.get(id);
    if (peek && peek.url !== url) peek.controller.abort();
  }

  async function start(id, url, time) {
    const controller = new AbortController();
    const record = { url, title: '', nextAt: time + REFRESH_MS };
    pending.set(id, { url, controller });
    records.set(id, record);
    onChange(id);
    let result;
    try {
      result = await request(id, url, controller.signal);
    } catch (_) {
      // A failed request and a station with no title share the same retry delay.
    } finally {
      pending.delete(id);
      if (!controller.signal.aborted && isEligible(id, url)) {
        if (typeof result?.title === 'string') record.title = result.title;
        if (!record.title) record.nextAt = now() + RETRY_MS;
        onChange(id);
      } else if (records.get(id) === record) {
        records.delete(id);
      }
      pump();
    }
  }

  function pump() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (!active) return;

    const time = now();
    let next = Infinity;
    for (const [id, url] of visible) {
      if (pending.size >= CONCURRENCY) break;
      if (pending.has(id) || !isEligible(id, url)) continue;
      const due = records.get(id)?.nextAt ?? time;
      if (due <= time) void start(id, url, time);
      else next = Math.min(next, due);
    }
    if (pending.size < CONCURRENCY && Number.isFinite(next)) {
      timer = setTimer(pump, Math.max(0, next - now()));
    }
  }

  return {
    setActive(value) {
      active = value;
      if (!active) {
        visible = new Map();
        for (const { controller } of pending.values()) controller.abort();
      }
      pump();
    },
    setAddress,
    setVisible(targets) {
      visible = targets;
      for (const [id, url] of visible) setAddress(id, url);
      for (const [id, { url, controller }] of pending) {
        if (visible.get(id) !== url) controller.abort();
      }
      pump();
    },
    titleFor(id, url) {
      const record = records.get(id);
      return record && record.url === url && now() < record.nextAt ? record.title : '';
    },
  };
}
