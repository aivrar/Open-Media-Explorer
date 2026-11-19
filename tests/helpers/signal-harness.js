/** A small event simulation on one clock for audio-signal.js and the
 *  visualizer loop: timers fire when due, animation frames on the first
 *  display refresh after they were asked for (every `frameMs`; a minimised
 *  WebView2 window gets about one a second). */

export function createClockHarness() {
  const frames = [];
  const timers = [];
  let now = 0;
  let handle = 0;
  const counts = { frameRequests: 0, timersSet: 0, maxPending: 0, maxFramesPending: 0 };
  const liveFrames = () => frames.filter((frame) => frame.live);
  const liveTimers = () => timers.filter((timer) => timer.live);
  const pending = () => liveFrames().length + liveTimers().length;
  const track = () => {
    counts.maxPending = Math.max(counts.maxPending, pending());
    counts.maxFramesPending = Math.max(counts.maxFramesPending, liveFrames().length);
  };
  const io = {
    requestFrame: (fn) => {
      handle += 1;
      counts.frameRequests += 1;
      frames.push({ fn, handle, live: true });
      track();
      return handle;
    },
    cancelFrame: (id) => { for (const frame of frames) if (frame.handle === id) frame.live = false; },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, due: now + Math.max(0, Number(ms) || 0), live: true };
      counts.timersSet += 1;
      timers.push(timer);
      track();
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.live = false; },
    clock: () => now,
  };
  /** Let `ms` of time pass with the display refreshing every `frameMs`. */
  const run = (ms, frameMs = 1000 / 60) => {
    const end = now + ms;
    for (;;) {
      let timer = null;
      for (const entry of liveTimers()) if (!timer || entry.due < timer.due) timer = entry;
      const refresh = liveFrames().length ? (Math.floor(now / frameMs + 1e-9) + 1) * frameMs : Number.POSITIVE_INFINITY;
      const at = Math.min(timer ? timer.due : Number.POSITIVE_INFINITY, refresh);
      if (!(at <= end)) break;
      now = Math.max(now, at);
      if (timer && timer.due <= refresh) {
        timer.live = false;
        timer.fn();
      } else {
        for (const frame of liveFrames()) { frame.live = false; frame.fn(now); }
      }
    }
    now = end;
  };
  return { io, run, pending, counts, liveTimers, liveFrames, get now() { return now; } };
}

/** A document double with visibility and listener bookkeeping. */
export function fakeVisibilityDoc() {
  const listeners = new Map();
  const doc = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
  };
  const count = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  const setVisible = (visible) => {
    doc.visibilityState = visible ? 'visible' : 'hidden';
    for (const fn of [...(listeners.get('visibilitychange') || [])]) fn();
  };
  return { doc, listeners, count, setVisible };
}

/** An analyser double: bytes at `level`, float dB at `db`. */
export function fakeAnalyser({ level = 200, db = -40, sampleRate = 48000 } = {}) {
  const node = {
    context: { sampleRate },
    fftSize: 2048,
    minDecibels: -85,
    maxDecibels: -15,
    level,
    db,
    floatCalls: 0,
    getFloatTimeDomainData: (data) => data.fill(0.02),
    getByteFrequencyData: (data) => data.fill(node.level),
    getFloatFrequencyData: (data) => { node.floatCalls += 1; data.fill(node.db); },
  };
  return node;
}
