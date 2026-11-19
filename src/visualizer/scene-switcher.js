/**
 * Picks the scene the renderer draws: loads the scene's chunk (a dynamic
 * import), registers it, compiles it (in the background where the browser can)
 * and installs it, while the scene before it keeps being drawn.
 *
 * Every request supersedes the one before: a chunk that arrives for a scene
 * the user has already moved on from is ignored, a compile still running for
 * it is cancelled (its timer stopped, its program deleted), and nothing is
 * ever installed late. A scene that cannot be loaded or compiled leaves the
 * current one in place; if there is none yet, Plasma is tried instead.
 * suspend() (a lost context) cancels what is in flight and remembers what was
 * asked for; resume() asks for it again. destroy() cancels everything.
 * Each scene is prepared with overridesFor(entry, def) (its scenes.js
 * `defaults` and the look chosen for it); request(id, { reload: true })
 * prepares and compiles the scene being drawn again (a look that changes a
 * param compiled into its shader), the current picture staying meanwhile.
 *
 * preload(id) fetches and compiles a scene ahead (the shuffle's next one)
 * into one staging slot without showing it; a later request(id) for it then
 * installs it on the spot (staged(id) says when that is so). A new preload
 * replaces the staged scene (its program deleted); suspend() and destroy()
 * drop it. beforeInstall(id) is called just before any scene is installed
 * (the tab takes its cross-fade picture of the outgoing scene there).
 */

import { DEFAULT_SCENE, SCENES } from './scenes.js';
import { sceneDefaults } from './scene-renderer.js';

/** The numeric values in `wanted` that differ from those `prepared` has. */
function changedValues(prepared, wanted) {
  const changed = {};
  for (const [name, value] of Object.entries(wanted)) {
    if (Number.isFinite(value) && prepared.values[name] !== value) changed[name] = value;
  }
  return changed;
}

export const SWITCH_STATES = Object.freeze({
  loading: 'loading',
  ready: 'ready',
  failed: 'failed',
});

export function createSceneSwitcher({
  renderer,
  scenes = SCENES,
  fallback = DEFAULT_SCENE,
  linksFor = () => [],
  // The values a scene is prepared with in place of Psychedelia's defaults
  // (scenes.js `defaults`, and the look chosen for it).
  overridesFor = (entry) => entry.defaults || null,
  onChange = null,
  beforeInstall = null,
  timers = {},
} = {}) {
  let token = 0;
  let job = null; // the compile in flight, if any
  let wanted = null; // id last asked for
  let current = null; // id being drawn
  let suspended = false;
  let inFlight = false; // a scene (or the current one again) is loading or compiling
  let destroyed = false;
  // The staging slot: { id, job, prepared, program, def, ready }.
  let stage = null;
  let stageToken = 0;
  // A compiled scene waiting for the picture to be ready for it
  // (beforeInstall asked to wait): { timer, program }.
  let held = null;
  const setTimer = timers.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = timers.clearTimer || ((handle) => clearTimeout(handle));
  const stats = {
    requests: 0, installs: 0, abandoned: 0, failures: 0, preloads: 0, fromStage: 0, stageDropped: 0, held: 0,
  };

  const entryFor = (id) => scenes.find((scene) => scene.id === id) || null;

  function tell(state, id, error = null) {
    try { onChange?.({ state, id, current, error }); } catch (_) {}
  }

  function cancelJob() {
    if (held) {
      const waiting = held;
      held = null;
      clearTimer(waiting.timer);
      renderer.discard(waiting.program);
      stats.abandoned += 1;
    }
    if (job) {
      const running = job;
      job = null;
      if (running.pending) stats.abandoned += 1;
      running.cancel();
    }
  }

  function fail(id, error, mine) {
    if (mine === token) {
      inFlight = false;
      // Not wanted any more: what is drawn stays, and nothing is busy.
      wanted = current;
    }
    stats.failures += 1;
    if (error) console.error(`visualizer: scene ${id} could not be shown:`, error);
    tell(SWITCH_STATES.failed, id, error);
    // Nothing on screen yet: fall back to Plasma (once; not if Plasma failed).
    if (mine === token && !current && id !== fallback && entryFor(fallback)) request(fallback);
  }

  /** Install a compiled scene. Values asked for while it compiled (a look
   *  chosen meanwhile): a plain uniform is set as it is installed; a param
   *  compiled into the shader means preparing it once more.
   *  beforeInstall(id) may return a number of ms to wait first (a change of
   *  picture still in progress): the compiled scene is held that long and
   *  asked again; a newer request drops it. */
  function finish(entry, def, prepared, program, mine = token) {
    const changed = changedValues(prepared, sceneDefaults(def, overridesFor(entry, def)));
    const compiled = new Set(def.specialize || []);
    if (Object.keys(changed).some((name) => compiled.has(name))) {
      renderer.discard(program);
      request(entry.id, { reload: true });
      return;
    }
    let wait = 0;
    try { wait = Number(beforeInstall?.(entry.id)) || 0; } catch (_) {}
    if (wait > 0) {
      stats.held += 1;
      held = { program, timer: 0 };
      held.timer = setTimer(() => {
        held = null;
        if (mine !== token || destroyed || suspended) { renderer.discard(program); return; }
        finish(entry, def, prepared, program, mine);
      }, wait);
      return;
    }
    renderer.install(prepared, program, linksFor(def));
    if (Object.keys(changed).length) renderer.setValues(changed);
    inFlight = false;
    current = entry.id;
    stats.installs += 1;
    tell(SWITCH_STATES.ready, entry.id);
  }

  /** Empty the staging slot (its compile stopped, its program deleted). */
  function dropStage() {
    if (!stage) return;
    const old = stage;
    stage = null;
    stageToken += 1;
    if (old.job) old.job.cancel();
    if (old.program) renderer.discard(old.program);
    stats.stageDropped += 1;
  }

  /** Fetch and compile scene `id` ahead, without showing it. False when it
   *  cannot be (unknown, suspended). */
  function preload(id) {
    if (destroyed || suspended) return false;
    const entry = entryFor(id);
    if (!entry) return false;
    if (stage && stage.id === entry.id) return true;
    dropStage();
    const mine = stageToken;
    const slot = {
      id: entry.id, job: null, prepared: null, program: null, def: null, ready: false,
    };
    stage = slot;
    stats.preloads += 1;
    let loading;
    try { loading = Promise.resolve(entry.load()); } catch (error) { loading = Promise.reject(error); }
    loading.then((module) => {
      if (mine !== stageToken || destroyed || suspended) return;
      const def = renderer.register(module, entry.id);
      const prepared = renderer.prepare(def, overridesFor(entry, def));
      slot.job = renderer.compile(prepared, (program) => {
        slot.job = null;
        if (mine !== stageToken || destroyed) { renderer.discard(program); return; }
        if (!program) { stage = null; stats.failures += 1; return; }
        Object.assign(slot, {
          prepared, program, def, ready: true,
        });
      }, timers);
    }).catch((error) => {
      if (mine !== stageToken) return;
      stage = null;
      stats.failures += 1;
      console.error(`visualizer: scene ${entry.id} could not be prepared ahead:`, error);
    });
    return true;
  }

  /** `reload`: prepare and compile it again even when it is the scene being
   *  drawn (its values changed in a way only a new compile can show). */
  function request(id, { reload = false } = {}) {
    if (destroyed) return null;
    const entry = entryFor(id) || entryFor(fallback);
    if (!entry) return null;
    stats.requests += 1;
    token += 1;
    const mine = token;
    cancelJob();
    wanted = entry.id;
    inFlight = false;
    if (suspended) return entry.id;
    if (entry.id === current && !reload) {
      tell(SWITCH_STATES.ready, entry.id);
      return entry.id;
    }
    if (!reload && stage && stage.ready && stage.id === entry.id) {
      // Compiled ahead: shown on the spot.
      const { def, prepared, program } = stage;
      stage = null;
      stageToken += 1;
      stats.fromStage += 1;
      inFlight = true;
      finish(entry, def, prepared, program, mine);
      return entry.id;
    }
    // Asked for before it was ready: loaded the usual way instead.
    if (stage && stage.id === entry.id) dropStage();
    inFlight = true;
    tell(SWITCH_STATES.loading, entry.id);
    let loading;
    try { loading = Promise.resolve(entry.load()); } catch (error) { loading = Promise.reject(error); }
    loading.then((module) => {
      if (mine !== token || destroyed || suspended) { stats.abandoned += 1; return; }
      const def = renderer.register(module, entry.id);
      const prepared = renderer.prepare(def, overridesFor(entry, def));
      job = renderer.compile(prepared, (program) => {
        job = null;
        if (mine !== token || destroyed) { renderer.discard(program); return; }
        if (!program) { fail(entry.id, null, mine); return; }
        finish(entry, def, prepared, program, mine);
      }, timers);
    }).catch((error) => {
      if (mine !== token || destroyed) return;
      fail(entry.id, error, mine);
    });
    return entry.id;
  }

  return {
    /** Show scene `id` (unknown ids show Plasma). Returns the id asked for. */
    request,
    preload,
    /** Scene `id` is compiled ahead and would be shown on the spot. */
    staged(id) { return Boolean(stage && stage.ready && stage.id === id); },
    /** The scene in the staging slot (ready or not), or null. */
    get stagedId() { return stage?.id || null; },
    dropStage,
    /** The context is gone: stop what is in flight, keep what was asked. */
    suspend() {
      suspended = true;
      inFlight = false;
      token += 1;
      // A held program went with the context.
      if (held) { clearTimer(held.timer); held = null; }
      cancelJob();
      // A staged program went with the context.
      if (stage) {
        if (stage.job) stage.job.cancel();
        stage = null;
        stageToken += 1;
      }
    },
    /** The context is back: ask again for the scene that was wanted.
     *  `restored`: the scene drawn went with the old context
     *  (scene-renderer.js restore), so nothing is drawn: the one wanted is
     *  compiled again the usual way, and if it cannot be, Plasma (as when
     *  nothing is on screen yet). */
    resume({ restored = false } = {}) {
      if (destroyed) return;
      suspended = false;
      if (restored && current) {
        const id = wanted || current;
        current = null;
        request(id);
        return;
      }
      if (wanted && wanted !== current) request(wanted);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      token += 1;
      cancelJob();
      dropStage();
    },
    get current() { return current; },
    get wanted() { return wanted; },
    /** A compile is running (waiting on the browser). */
    get compiling() { return Boolean(job?.pending); },
    get busy() { return wanted !== current || inFlight; },
    stats,
  };
}
