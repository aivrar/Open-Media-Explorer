/**
 * Flash limiter: the one place every sound-derived value a scene receives
 * passes through first - its u_audio / u_beat uniforms (beat clock included),
 * the parameter links that push a scene's glow or brightness, and the time
 * surge (how much faster the picture runs with the music). Later slices (post
 * FX flash, overlays) are meant to route through it too; the `flash` channel
 * is there for them.
 *
 * The rule: at most maxPulsesPerSecond (3) large pulses reach the picture in
 * any rolling second, counted together over every channel and the beat
 * clock; no pulse is deeper than maxPulseDepth; levels and speed may swell
 * but not snap.
 *
 * In detail, every drawn frame:
 *   1. Depth: a pulse channel (kick, snare, hat, beat, flash; 0..1 envelopes
 *      that jump on a hit) never goes above maxPulseDepth. A level channel
 *      (bass, mid, high, level) never sits more than maxLevelSwing above or
 *      below its own running average (levelSeconds); its swing above that
 *      average is its "drive".
 *   2. Edges, per channel: each channel has its own trigger. When its drive
 *      rises from below rearmLevel to pulseThreshold or more, that is a large
 *      pulse on that channel; the channel re-arms only when its own drive
 *      falls back below rearmLevel. So a channel held high cannot hide
 *      another channel's pulses.
 *   3. One budget: every pulse is charged to one shared rolling window. Edges
 *      on several channels in the same frame (one step() call) are the same
 *      flash and share its fate. On a later frame an edge shares it only if
 *      its channel is of the same family (kick, beat and bass; snare and
 *      mid; hat and high; the whole-band level follows any) as a charged
 *      edge less than coincidenceSeconds (50 ms) before - measured from that
 *      charged edge, so merges never chain. A kick and a snare 40 ms apart are
 *      two pulses. A pulse beyond the budget is held:
 *      that channel is scaled to just below pulseThreshold until it re-arms.
 *   4. Beat clock and trigger effects: one rolling window for everything
 *      (createFlashLedger). A shown clock's wrap (setClockShown(true): the
 *      scene's shader wraps u_beat.w) and a trigger effect's firing
 *      (fx-chain.js, through charge()) are charged to the same window as the
 *      envelope pulses and scene changes, so all of them together never
 *      exceed 3 in a rolling second; a charge stays when its effect is
 *      switched off. Each entry keeps its kind, and each kind has its own
 *      share: the clock (while shown) 1 a second, trigger effects (while one
 *      draws: setTriggersOn) 1 a second together, envelope pulses and scene
 *      changes the rest (3, 2 or 1). No kind can take another's share, so
 *      none starves the others. A charge in a frame already counted is the
 *      same flash: charged to its share, not again to the total.
 *      A firing with no room does not happen. A wrap with no room waits
 *      just short of it; once admitted the clock given takes the music's
 *      phase again (that jump is the charged wrap), so the wait leaves no
 *      lag. While the clock is shown or a trigger effect is on, the clock is
 *      slowed by powers of two to at most 1 cycle a second; otherwise it is
 *      kept to 3 cycles a second. The clock stays continuous whenever its
 *      pace changes.
 *      The tab keeps one window for the page (index.js), so closing and
 *      opening the tab again, or reset(), never starts a fresh second.
 *   5. Time surge: the speed multiplier follows the reactor's, but changes by
 *      at most maxSpeedSlew per second, up or down, and never goes above
 *      maxSpeed or the scene's own cap (setSpeedCap: a scene whose colours
 *      cycle or whose dive runs on its clock changes its light faster the
 *      faster its time runs; scenes.js maxSpeed).
 *   6. Zoom punch: Psychedelia's Beat Reactor zoom (1 + amount x (0.1 x
 *      kick punch + 0.025 x bass)), made here from the limited kick and bass,
 *      capped at maxZoom and eased by maxZoomSlew per second. It is motion,
 *      not light, and pulses only when a let-through kick does.
 *
 *   7. Scene changes: a cross-fade between scenes (index.js) asks
 *      transition() first; it is charged to the budget like a pulse, and an
 *      automatic change waits while the budget is full.
 *
 * What it does not do: it does not look at the picture. It limits the sound
 * values a scene is given, not the luminance the scene's own shader makes of
 * them, nor anything a shader does by itself over time; scene changes it only
 * counts (7), the cross-fade does the ramp.
 * The thresholds are in the reactor's 0..1 units, not measured luminance.
 * No timers and no allocation per frame; it is stepped by the frame loop.
 */

export const FLASH_LIMITS = Object.freeze({
  maxPulsesPerSecond: 3,
  // One second, half-open on purpose: an entry exactly 1 s old has left it.
  // The ledger counts single large changes, and a flash is a pair of opposite
  // ones, so 3 a second is at most one and a half flashes, well inside the
  // usual limit of 3 flashes a second; a fourth change exactly 1.0000 s after
  // the first does not matter for safety, while a longer window would slow
  // the beat clock and refuse trigger firings visibly.
  windowSeconds: 1,
  pulseThreshold: 0.25,
  rearmLevel: 0.12,
  coincidenceSeconds: 0.05,
  maxPulseDepth: 0.6,
  maxLevelSwing: 0.35,
  levelSeconds: 1,
  clockReserve: 1,
  maxSpeedSlew: 1.5,
  maxSpeed: 3,
  zoomPunch: 0.5,
  maxZoom: 1.1,
  maxZoomSlew: 1,
});

export const PULSE_CHANNELS = Object.freeze(['kick', 'snare', 'hat', 'beat', 'flash']);
export const LEVEL_CHANNELS = Object.freeze(['bass', 'mid', 'high', 'level']);
const CHANNELS = Object.freeze([...PULSE_CHANNELS, ...LEVEL_CHANNELS]);
/** Channels one hit lifts together, a frame or so apart. */
const FAMILY = Object.freeze({
  kick: 'low', beat: 'low', bass: 'low', snare: 'mid', mid: 'mid', hat: 'high', high: 'high', level: 'level', flash: 'flash',
});
const FAMILY_NAMES = Object.freeze([...new Set(Object.values(FAMILY))]);

/** How far short of its next wrap a held beat clock waits (cycles). */
const CLOCK_HOLD_MARGIN = 0.001;

const clamp01 = (value) => (value > 1 ? 1 : (value > 0 ? value : 0)); // NaN -> 0

/** The kinds of large change of light the window holds. */
export const FLASH_KINDS = Object.freeze({
  envelope: 'envelope', // a pulse of the sound, or a scene change (transition)
  clock: 'clock', // a wrap of the beat clock the scene shows
  trigger: 'trigger', // a trigger effect firing (fx-chain.js)
});

/**
 * The rolling window of large changes of light: when each came (s) and of
 * which kind. It belongs to whoever must keep the count across limiters: the
 * tab keeps one for the life of the page (index.js), so closing and opening
 * the tab again, or a limiter's reset(), does not start a fresh second. Only
 * an array, read when a limiter runs; no timers. An entry is dropped once
 * windowSeconds old (and all of them if the clock jumped back past them by
 * more than that: another clock).
 */
export function createFlashLedger(windowSeconds = FLASH_LIMITS.windowSeconds) {
  const times = [];
  const kinds = [];
  const weights = []; // 1: counts; 0: the same flash as one already counted
  return {
    prune(now) {
      if (times.length && now < times[times.length - 1] - windowSeconds) { times.length = 0; kinds.length = 0; weights.length = 0; }
      while (times.length && now - times[0] >= windowSeconds) { times.shift(); kinds.shift(); weights.shift(); }
    },
    add(now, kind, weight = 1) { times.push(now); kinds.push(kind); weights.push(weight); },
    /** Large changes counted in the window now. */
    get total() { let sum = 0; for (let i = 0; i < weights.length; i += 1) sum += weights[i]; return sum; },
    /** Entries of `kind` in the window (shared ones too). */
    count(kind) { let n = 0; for (let i = 0; i < kinds.length; i += 1) if (kinds[i] === kind) n += 1; return n; },
    /** The newest counted entry is at `now`. */
    countedAt(now) {
      for (let i = times.length - 1; i >= 0 && times[i] === now; i -= 1) if (weights[i]) return true;
      return false;
    },
    get length() { return times.length; },
    clear() { times.length = 0; kinds.length = 0; weights.length = 0; },
  };
}

export function createFlashLimiter({ ledger: givenLedger = null, ...options } = {}) {
  const limits = { ...FLASH_LIMITS, ...options };
  const ledger = givenLedger || createFlashLedger(limits.windowSeconds);
  const out = { speed: 1, zoom: 1 };
  const average = {};
  const drives = {}; // this frame's drive per channel, before holding
  const armed = {};
  const held = {};
  for (const name of CHANNELS) { out[name] = 0; drives[name] = 0; armed[name] = true; held[name] = false; }
  for (const name of LEVEL_CHANNELS) average[name] = Number.NaN;
  let steps = 0; // step() calls so far
  let eventStep = -1; // the step of the last charged edge (one flash per frame)
  let eventPassed = false;
  // Per family: when its last charged edge came (s) and whether it passed.
  // Fixed at that edge: a follow-on merges only within coincidenceSeconds of
  // it, never of another follow-on, so merges do not chain.
  const familyAt = {};
  const familyPassed = {};
  for (const family of FAMILY_NAMES) { familyAt[family] = Number.NEGATIVE_INFINITY; familyPassed[family] = false; }
  let lastNow = Number.NaN;
  let drive = 0;
  let holding = false;
  let clockShown = false;
  let triggersOn = false;
  let speedCap = limits.maxSpeed;
  // Beat clock.
  let clockFactor = 1;
  let clockIn = Number.NaN;
  let clockOut = 0; // the anchor: the clock given at clockIn
  let clockGiven = 0; // the last clock given
  const stats = {
    pulses: 0, held: 0, heldFrames: 0, depthCapped: 0, slewed: 0, clockHeld: 0, transitions: 0,
    charges: 0, // charge() let through: trigger firings and clock wraps
    chargesShared: 0, // charge() in a frame already counted (the same flash)
    chargesHeld: 0, // charge() refused: no room for its kind
    clockWraps: 0, // wraps of a shown beat clock, charged
  };

  // Each kind has a share of the 3 a second: the beat clock (while the
  // scene shows it) one, trigger effects (while one draws) one, envelope
  // pulses and scene changes the rest - 3, 2 or 1. A share is its own: no
  // kind can take another's, so none starves; and all together never pass
  // maxPulsesPerSecond.
  const reserved = () => clockShown || triggersOn;
  const pulseBudget = () => limits.maxPulsesPerSecond
    - (clockShown ? limits.clockReserve : 0) - (triggersOn ? limits.clockReserve : 0);
  const clockLimit = () => (reserved() ? limits.clockReserve : limits.maxPulsesPerSecond);
  const prune = (now) => ledger.prune(now);
  /** Room for an envelope pulse or a scene change. */
  function envelopeRoom() {
    return ledger.total < limits.maxPulsesPerSecond && ledger.count(FLASH_KINDS.envelope) < pulseBudget();
  }
  /** One large change of light of `kind` ('trigger' or 'clock') at `now`
   *  (s; default: the last step()): true when its share has room, and it is
   *  charged (it stays charged when its effect goes); false: it must not
   *  show now. In a frame already counted it is the same flash (charged to
   *  its share, not to the total). */
  function charge(now = lastNow, kind = FLASH_KINDS.trigger) {
    const at = Number.isFinite(now) ? now : 0;
    prune(at);
    if (ledger.count(kind) >= limits.clockReserve) { stats.chargesHeld += 1; return false; }
    if (ledger.countedAt(at)) { ledger.add(at, kind, 0); stats.chargesShared += 1; return true; }
    if (ledger.total >= limits.maxPulsesPerSecond) { stats.chargesHeld += 1; return false; }
    ledger.add(at, kind, 1);
    stats.charges += 1;
    return true;
  }

  /** A rising edge on channel `name` at `now`: let it through or hold it.
   *  Edges in the same step (one drawn frame) are one flash. On a later
   *  frame, an edge is the same hit only when its channel is of the family
   *  of a charged edge less than coincidenceSeconds before (the predicted
   *  beat a frame before the kick it predicts, the bass a frame after);
   *  anything else - a snare 40 ms after a kick - is charged on its own. */
  function edge(now, name) {
    const family = FAMILY[name];
    if (eventStep === steps) {
      // The same flash: its family is opened by it too.
      if (!(now - familyAt[family] <= limits.coincidenceSeconds)) {
        familyAt[family] = now;
        familyPassed[family] = eventPassed;
      }
      return eventPassed;
    }
    if (now - familyAt[family] <= limits.coincidenceSeconds) return familyPassed[family];
    if (family === 'level') {
      // The whole-band level is lifted by every hit: it follows any family.
      for (const other of FAMILY_NAMES) if (now - familyAt[other] <= limits.coincidenceSeconds) return familyPassed[other];
    }
    eventStep = steps;
    eventPassed = envelopeRoom();
    familyAt[family] = now;
    familyPassed[family] = eventPassed;
    if (eventPassed) { ledger.add(now, FLASH_KINDS.envelope, 1); stats.pulses += 1; } else stats.held += 1;
    return eventPassed;
  }

  /** Limit one frame of raw values (`input`: any of the channel names, 0..1,
   *  and `speed`, the time surge) at `now` seconds. Returns the limiter's
   *  own output object (rewritten every call). */
  function step(now, input) {
    const dt = Number.isFinite(lastNow) && now > lastNow ? Math.min(1, now - lastNow) : 0;
    lastNow = now;
    steps += 1;
    for (const name of PULSE_CHANNELS) {
      let value = clamp01(Number(input?.[name]));
      if (value > limits.maxPulseDepth) { value = limits.maxPulseDepth; stats.depthCapped += 1; }
      out[name] = value;
      drives[name] = value;
    }
    const follow = dt > 0 ? 1 - Math.exp(-dt / limits.levelSeconds) : 0;
    for (const name of LEVEL_CHANNELS) {
      const value = clamp01(Number(input?.[name]));
      let avg = average[name];
      avg = Number.isFinite(avg) ? avg + (value - avg) * follow : value;
      average[name] = avg;
      let away = value - avg;
      if (away > limits.maxLevelSwing) { away = limits.maxLevelSwing; stats.depthCapped += 1; }
      if (away < -limits.maxLevelSwing) away = -limits.maxLevelSwing;
      out[name] = clamp01(avg + away);
      drives[name] = away > 0 ? away : 0;
    }
    prune(now);
    drive = 0;
    holding = false;
    for (const name of CHANNELS) {
      const raw = drives[name];
      if (raw < limits.rearmLevel) {
        armed[name] = true;
        held[name] = false;
      } else if (armed[name] && raw >= limits.pulseThreshold) {
        armed[name] = false;
        held[name] = !edge(now, name);
      }
      let limited = raw;
      if (held[name] && raw > 0) {
        const gain = Math.min(1, (limits.pulseThreshold * 0.95) / raw);
        limited = raw * gain;
        if (name in average) out[name] = clamp01(average[name] + limited);
        else out[name] = limited;
        holding = true;
      }
      if (limited > drive) drive = limited;
    }
    if (holding) stats.heldFrames += 1;
    // Time surge: follows, at a limited pace.
    let speed = Number(input?.speed);
    if (!(speed > 0)) speed = 1;
    if (speed > speedCap) speed = speedCap;
    const most = limits.maxSpeedSlew * dt;
    const change = speed - out.speed;
    if (change > most || change < -most) {
      out.speed += change > 0 ? most : -most;
      stats.slewed += 1;
    } else out.speed = speed;
    // Zoom punch (Psychedelia's Beat Reactor "zoom", applied through the
    // view zoom every scene's shader already has): from the limited kick
    // and bass, so it pulses no more often than they do, and eased in.
    const k = out.kick;
    const punch = k * k * (3 - 2 * k);
    let zoom = 1 + limits.zoomPunch * (0.1 * punch + 0.025 * out.bass);
    if (zoom > limits.maxZoom) zoom = limits.maxZoom;
    const zoomMost = limits.maxZoomSlew * dt;
    const zoomChange = zoom - out.zoom;
    out.zoom = zoomChange > zoomMost ? out.zoom + zoomMost : (zoomChange < -zoomMost ? out.zoom - zoomMost : zoom);
    return out;
  }

  /** The beat clock a scene gets, from the reactor's clock (`beats`) at
   *  `bpm` (0 or unknown: 120). */
  function beatClock(beats, bpm) {
    const value = Number(beats);
    if (!Number.isFinite(value)) return clockGiven;
    const rate = (Number(bpm) > 0 ? Number(bpm) : 120) / 60;
    const most = clockLimit();
    let factor = clockFactor;
    while (rate * factor > most + 1e-9 && factor > 1 / 64) factor /= 2;
    while (factor < 1 && rate * factor * 2 <= most * 0.95) factor *= 2;
    if (!Number.isFinite(clockIn) || value < clockIn) {
      // First call, or the clock went back (a reset): follow it from here.
      clockIn = value;
      clockOut = value * factor;
      clockFactor = factor;
      clockGiven = clockOut;
      return clockOut;
    }
    // The music's clock at the limited pace (never held back itself).
    const current = clockOut + (value - clockIn) * clockFactor;
    if (factor !== clockFactor) {
      // Re-anchor so it carries on from where it is, at the new pace.
      clockOut = current;
      clockIn = value;
      clockFactor = factor;
    }
    // A shown clock's wrap is a large change of light, charged to the
    // clock's own share. With no room the clock given waits just short of
    // the wrap; once admitted it takes the music's phase again (that jump is
    // the charged wrap), so the wait never leaves a lag behind it.
    if (clockShown && Math.floor(current) > Math.floor(clockGiven)) {
      if (!charge(lastNow, FLASH_KINDS.clock)) {
        stats.clockHeld += 1;
        clockGiven = Math.max(clockGiven, Math.floor(clockGiven) + 1 - CLOCK_HOLD_MARGIN);
        return clockGiven;
      }
      stats.clockWraps += 1;
    }
    // After a held wrap the jump to the music's phase is the charged wrap
    // itself, never larger than an ordinary one; it may bring the next wrap
    // nearer, but that one again needs the clock's own slot (charge() never
    // gives the clock a free envelope slot), so wraps stay a second apart.
    clockGiven = current;
    return current;
  }

  function reset() {
    // (Not the window: what was shown in the last second stays counted.)
    eventStep = -1;
    eventPassed = false;
    for (const family of FAMILY_NAMES) { familyAt[family] = Number.NEGATIVE_INFINITY; familyPassed[family] = false; }
    lastNow = Number.NaN;
    drive = 0;
    holding = false;
    clockFactor = 1;
    clockIn = Number.NaN;
    clockOut = 0;
    clockGiven = 0;
    out.speed = 1;
    out.zoom = 1;
    for (const name of CHANNELS) { out[name] = 0; drives[name] = 0; armed[name] = true; held[name] = false; }
    for (const name of LEVEL_CHANNELS) average[name] = Number.NaN;
  }

  /** A change of scene at `now` (s), shown as a cross-fade: a ramp, but
   *  between a dark and a bright scene still one large change of light, so
   *  it is charged to the same budget as a pulse. True when the budget has
   *  room (and it is charged); false: wait (the shuffle tries again). */
  function transition(now) {
    prune(now);
    if (!envelopeRoom()) return false;
    ledger.add(now, FLASH_KINDS.envelope, 1);
    stats.transitions += 1;
    return true;
  }

  /** The budget has room for a change at `now` (s); nothing is charged. */
  function room(now) {
    prune(now);
    return envelopeRoom();
  }

  return {
    step,
    room,
    beatClock,
    /** A trigger effect fires now: charge(now, 'trigger'). */
    charge: (now = lastNow) => charge(now, FLASH_KINDS.trigger),
    transition,
    reset,
    /** The scene shows the beat clock as a pulse: its wraps are charged
     *  (beatClock) and part of the budget is kept free for them. */
    setClockShown(shown) { clockShown = shown === true; },
    get clockShown() { return clockShown; },
    /** A trigger effect is on (it charges its firings with charge()): the
     *  same part of the budget is kept free for them. */
    setTriggersOn(on) { triggersOn = on === true; },
    get triggersOn() { return triggersOn; },
    /** Large changes of light in the rolling second now (all kinds). */
    get inWindow() { return ledger.total; },
    /** The window (shared when one was given). */
    ledger,
    /** The most the time surge may speed this scene up (1..maxSpeed). */
    setSpeedCap(cap) {
      const value = Number(cap);
      speedCap = value > 0 ? Math.max(1, Math.min(limits.maxSpeed, value)) : limits.maxSpeed;
    },
    get speedCap() { return speedCap; },
    /** Large pulses the envelopes may have in a rolling second now. */
    get pulseBudget() { return pulseBudget(); },
    limits: Object.freeze(limits),
    out,
    stats,
    /** The largest channel drive after limiting, this frame (0..1). */
    get drive() { return drive; },
    /** Some channel is held this frame. */
    get holding() { return holding; },
    get clockFactor() { return clockFactor; },
  };
}
