/**
 * Fair, bounded orchestration for catalog metadata work.
 *
 * The scheduler is deliberately transport-agnostic: callers provide an async
 * task and receive an AbortSignal owned by this queue.  Keeping policy here
 * prevents Library browse/search/snapshot lanes from each growing their own
 * incompatible concurrency and cooldown rules.
 */

export const CATALOG_PRIORITY = Object.freeze({
  PREFETCH: 0,
  SNAPSHOT: 5,
  INITIAL: 10,
  SEARCH: 20,
  USER: 30,
});

// One global slot per registered source lets every provider make progress
// independently. Provider modules can opt into stricter pacing or additional
// same-source slots through their exported catalogPolicy.
export const DEFAULT_CATALOG_CONCURRENCY = 11;
export const DEFAULT_SOURCE_CONCURRENCY = 1;
export const DEFAULT_MAX_QUEUE = 256;
export const DEFAULT_COOLDOWN_BASE_MS = 1_500;
export const DEFAULT_COOLDOWN_MAX_MS = 30_000;
export const DEFAULT_TASK_TIMEOUT_MS = 60_000;
// The longest wait a provider may declare (Retry-After or an explained hold).
// The Library's browse progress uses the same cap, so a queued search never
// starts before a browse hold ends.
export const MAX_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
export const PLAYBACK_CATALOG_CONCURRENCY = 2;
export const PLAYBACK_BACKGROUND_CONCURRENCY = 1;
// Global slots that background work (prefetch and snapshot refresh) may never
// take, so what the user is looking at can start at once. A small scheduler
// keeps at most a quarter of its slots this way.
export const FOREGROUND_RESERVED_SLOTS = 2;

function abortError(reason = null) {
  if (reason?.name === 'AbortError') return reason;
  if (typeof DOMException === 'function') {
    return new DOMException(String(reason?.message || reason || 'Aborted'), 'AbortError');
  }
  const error = new Error(String(reason?.message || reason || 'Aborted'));
  error.name = 'AbortError';
  return error;
}

function finiteNonnegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function retryableFailure(error) {
  if (!error || error.name === 'AbortError') return false;
  const status = Number(error.status || 0);
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * @typedef {Object} CatalogJob
 * @property {string} sourceId
 * @property {string} key
 * @property {(context: {signal: AbortSignal, sourceId: string, key: string}) => Promise<any>} task
 */

export class CatalogScheduler {
  constructor(options = {}) {
    this.maxConcurrent = Math.max(1, Number(options.maxConcurrent) || DEFAULT_CATALOG_CONCURRENCY);
    this.defaultSourceConcurrency = Math.max(
      1, Number(options.defaultSourceConcurrency) || DEFAULT_SOURCE_CONCURRENCY,
    );
    this.maxQueue = Math.max(this.maxConcurrent, Number(options.maxQueue) || DEFAULT_MAX_QUEUE);
    this.cooldownBaseMs = finiteNonnegative(options.cooldownBaseMs, DEFAULT_COOLDOWN_BASE_MS);
    this.cooldownMaxMs = Math.max(
      this.cooldownBaseMs,
      finiteNonnegative(options.cooldownMaxMs, DEFAULT_COOLDOWN_MAX_MS),
    );
    this.taskTimeoutMs = finiteNonnegative(options.taskTimeoutMs, DEFAULT_TASK_TIMEOUT_MS);
    this.now = options.now || (() => Date.now());
    this.setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer || ((handle) => clearTimeout(handle));
    this.enqueueMicrotask = options.enqueueMicrotask || ((fn) => queueMicrotask(fn));
    this.pausePriorityAt = Number.isFinite(Number(options.pausePriorityAt))
      ? Number(options.pausePriorityAt)
      : CATALOG_PRIORITY.SNAPSHOT;

    this.queues = new Map();
    this.sourceOrder = [];
    this.knownSources = new Set();
    this.sourceCursor = 0;
    this.sourceState = new Map();
    this.policies = new Map();
    this.jobsByKey = new Map();
    this.activeJobs = new Set();
    this.activeBySource = new Map();
    this.activeCount = 0;
    this.pendingCount = 0;
    this.sequence = 0;
    this.visible = options.visible !== false;
    this.playbackPriority = options.playbackPriority === true;
    this.playbackMaxConcurrent = Math.max(
      1,
      Math.min(
        this.maxConcurrent,
        Number(options.playbackMaxConcurrent) || PLAYBACK_CATALOG_CONCURRENCY,
      ),
    );
    this.foregroundReserve = Math.min(
      Math.floor(this.maxConcurrent / 4),
      Math.floor(finiteNonnegative(options.foregroundReserve, FOREGROUND_RESERVED_SLOTS)),
    );
    this.playbackBackgroundConcurrent = Math.max(
      1,
      Math.min(
        this.playbackMaxConcurrent,
        Number(options.playbackBackgroundConcurrent) || PLAYBACK_BACKGROUND_CONCURRENCY,
      ),
    );
    this.closed = false;
    this.drainQueued = false;
    this.wakeTimer = null;
    this.wakeAt = 0;

    for (const [sourceId, policy] of Object.entries(options.policies || {})) {
      this.setPolicy(sourceId, policy);
    }
  }

  _state(sourceId) {
    let state = this.sourceState.get(sourceId);
    if (!state) {
      state = {
        enabled: true,
        cooldownUntil: 0,
        // End of a cooldown the provider declared (Retry-After), as opposed
        // to an ordinary failure backoff.
        declaredUntil: 0,
        nextStartAt: 0,
        failures: 0,
      };
      this.sourceState.set(sourceId, state);
    }
    return state;
  }

  _policy(sourceId) {
    return this.policies.get(sourceId) || {
      maxConcurrent: this.defaultSourceConcurrency,
      minIntervalMs: 0,
    };
  }

  setPolicy(sourceId, policy = {}) {
    if (!sourceId) throw new TypeError('Catalog policy requires a source id');
    this.policies.set(sourceId, {
      maxConcurrent: Math.max(
        1, Number(policy.maxConcurrent) || this.defaultSourceConcurrency,
      ),
      minIntervalMs: finiteNonnegative(policy.minIntervalMs, 0),
    });
    this._queueDrain();
  }

  setSourceEnabled(sourceId, enabled) {
    const state = this._state(sourceId);
    state.enabled = enabled !== false;
    if (!state.enabled) this.cancelSource(sourceId, abortError('Source disabled'));
    else this._queueDrain();
  }

  setVisible(visible) {
    const next = visible !== false;
    if (this.visible === next) return;
    this.visible = next;
    if (next) this._queueDrain();
    else this._rescheduleWake();
  }

  /** Reserve bandwidth for active media without stopping catalog collection. */
  setPlaybackPriority(active) {
    const next = active === true;
    if (this.playbackPriority === next) return;
    this.playbackPriority = next;
    this._rescheduleWake();
  }

  /** Bind low-priority pause/resume to a document without making the class impure. */
  bindVisibility(documentLike = globalThis.document) {
    if (!documentLike?.addEventListener) return () => {};
    const update = () => this.setVisible(documentLike.visibilityState !== 'hidden');
    update();
    documentLike.addEventListener('visibilitychange', update);
    return () => documentLike.removeEventListener('visibilitychange', update);
  }

  /**
   * Queue one source operation. Equal source/key pairs share one promise until
   * the underlying task has actually released its slot.
   */
  enqueue({ sourceId, key, task, priority = CATALOG_PRIORITY.INITIAL, signal = null }) {
    if (this.closed) return Promise.reject(abortError('Catalog scheduler closed'));
    if (!sourceId || typeof sourceId !== 'string') {
      return Promise.reject(new TypeError('Catalog job requires a source id'));
    }
    if (!key || typeof key !== 'string') {
      return Promise.reject(new TypeError('Catalog job requires a stable key'));
    }
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('Catalog job requires a task function'));
    }
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    if (!this._state(sourceId).enabled) return Promise.reject(abortError('Source disabled'));

    const dedupeKey = `${sourceId}\u0000${key}`;
    const duplicate = this.jobsByKey.get(dedupeKey);
    if (duplicate) return duplicate.promise;
    if (this.pendingCount >= this.maxQueue) {
      const error = new Error(`Catalog queue limit ${this.maxQueue} reached`);
      error.name = 'CatalogQueueFullError';
      return Promise.reject(error);
    }

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const job = {
      sourceId,
      key,
      dedupeKey,
      task,
      priority: Number(priority) || 0,
      sequence: this.sequence++,
      signal,
      controller: null,
      timeoutHandle: null,
      state: 'queued',
      settled: false,
      resolve: resolvePromise,
      reject: rejectPromise,
      promise,
      onAbort: null,
    };

    if (signal) {
      job.onAbort = () => this._cancelJob(job, abortError(signal.reason));
      signal.addEventListener('abort', job.onAbort, { once: true });
    }
    let queue = this.queues.get(sourceId);
    if (!queue) {
      queue = [];
      this.queues.set(sourceId, queue);
      if (!this.knownSources.has(sourceId)) {
        this.knownSources.add(sourceId);
        this.sourceOrder.push(sourceId);
      }
    }
    queue.push(job);
    queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
    this.jobsByKey.set(dedupeKey, job);
    this.pendingCount += 1;
    this._queueDrain();
    return promise;
  }

  setCooldown(sourceId, delayMs, options = {}) {
    const state = this._state(sourceId);
    const value = finiteNonnegative(delayMs, 0);
    const until = options.absolute === true ? value : this.now() + value;
    state.cooldownUntil = Math.max(state.cooldownUntil, until);
    if (options.declared === true) state.declaredUntil = Math.max(state.declaredUntil, until);
    this._rescheduleWake();
    return state.cooldownUntil;
  }

  /** Read-only: how long a source's cooldown has left, or 0 when it has none. */
  cooldownRemainingMs(sourceId) {
    const state = this.sourceState.get(sourceId);
    if (!state) return 0;
    return Math.max(0, state.cooldownUntil - this.now());
  }

  /** Read-only: time left of a cooldown the provider itself declared
   *  (Retry-After), or 0. Ordinary failure backoff never counts. */
  declaredCooldownRemainingMs(sourceId) {
    const state = this.sourceState.get(sourceId);
    if (!state) return 0;
    return Math.max(0, Math.min(state.declaredUntil, state.cooldownUntil) - this.now());
  }

  /**
   * Move a source's queued work up to `priority` (what the user is looking
   * at). Running work is unaffected. Returns how many queued jobs were raised.
   */
  promote(sourceId, priority = CATALOG_PRIORITY.USER) {
    const queue = this.queues.get(sourceId);
    if (!queue?.length) return 0;
    let raised = 0;
    for (const job of queue) {
      if (job.priority < priority) {
        job.priority = priority;
        raised += 1;
      }
    }
    if (raised > 0) {
      queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
      this._queueDrain();
    }
    return raised;
  }

  recordFailure(sourceId, error = null) {
    if (!retryableFailure(error)) return 0;
    const state = this._state(sourceId);
    state.failures += 1;
    // No Retry-After is null, not 0 (Number(null) is 0: no cooldown at all).
    const retryAfter = error?.retryAfterMs == null ? Number.NaN : Number(error.retryAfterMs);
    const fallback = Math.min(
      this.cooldownMaxMs,
      this.cooldownBaseMs * (2 ** Math.max(0, state.failures - 1)),
    );
    const delay = Number.isFinite(retryAfter) && retryAfter >= 0
      ? Math.min(MAX_RETRY_AFTER_MS, retryAfter)
      : fallback;
    this.setCooldown(sourceId, delay, { declared: Number.isFinite(retryAfter) && retryAfter > 0 });
    return delay;
  }

  recordSuccess(sourceId) {
    const state = this._state(sourceId);
    state.failures = 0;
  }

  resetSource(sourceId) {
    const state = this._state(sourceId);
    state.failures = 0;
    state.cooldownUntil = 0;
    state.declaredUntil = 0;
    state.nextStartAt = 0;
    this._queueDrain();
  }

  cancelSource(sourceId, reason = abortError()) {
    const queue = [...(this.queues.get(sourceId) || [])];
    for (const job of queue) this._cancelJob(job, abortError(reason));
    for (const job of [...this.activeJobs]) {
      if (job.sourceId === sourceId) this._cancelJob(job, abortError(reason));
    }
    this._rescheduleWake();
  }

  cancelAll(reason = abortError()) {
    for (const sourceId of [...this.queues.keys()]) this.cancelSource(sourceId, reason);
    for (const job of [...this.activeJobs]) this._cancelJob(job, abortError(reason));
    this._rescheduleWake();
  }

  destroy(reason = abortError('Catalog scheduler closed')) {
    if (this.closed) return;
    this.closed = true;
    this.cancelAll(reason);
    this._clearWake();
  }

  stats() {
    return {
      active: this.activeCount,
      pending: this.pendingCount,
      visible: this.visible,
      activeBySource: Object.fromEntries(this.activeBySource),
    };
  }

  _settle(job, error, value) {
    if (job.settled) return;
    job.settled = true;
    if (error) job.reject(error);
    else job.resolve(value);
  }

  _removeQueued(job) {
    const queue = this.queues.get(job.sourceId);
    if (!queue) return false;
    const index = queue.indexOf(job);
    if (index < 0) return false;
    queue.splice(index, 1);
    this.pendingCount = Math.max(0, this.pendingCount - 1);
    if (queue.length === 0) this.queues.delete(job.sourceId);
    return true;
  }

  _cleanupJob(job) {
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    if (this.jobsByKey.get(job.dedupeKey) === job) this.jobsByKey.delete(job.dedupeKey);
  }

  _cancelJob(job, reason) {
    if (job.state === 'done') return;
    if (job.state === 'queued') {
      this._removeQueued(job);
      job.state = 'done';
      this._cleanupJob(job);
      this._settle(job, reason);
      this._queueDrain();
      return;
    }
    if (job.state === 'active') {
      job.controller?.abort(reason);
      // Reject the consumer promptly, but retain the active slot and dedupe
      // record until the task acknowledges cancellation and actually exits.
      this._settle(job, reason);
    }
  }

  _queueDrain() {
    if (this.closed || this.drainQueued) return;
    this.drainQueued = true;
    this.enqueueMicrotask(() => {
      this.drainQueued = false;
      this._drain();
    });
  }

  _eligibleAt(sourceId) {
    const state = this._state(sourceId);
    return Math.max(state.cooldownUntil, state.nextStartAt);
  }

  _pickNext() {
    if (this.sourceOrder.length === 0) return null;
    const now = this.now();
    let bestPriority = -Infinity;
    const eligibleSources = new Set();

    const activeBackground = this.playbackPriority
      ? [...this.activeJobs].filter((job) => job.priority <= this.pausePriorityAt).length
      : 0;
    // Background work leaves the last slots free for foreground work.
    const backgroundFull = !this.playbackPriority
      && this.activeCount >= this.maxConcurrent - this.foregroundReserve;
    for (const sourceId of this.sourceOrder) {
      const queue = this.queues.get(sourceId);
      if (!queue?.length) continue;
      const state = this._state(sourceId);
      const policy = this._policy(sourceId);
      if (!state.enabled) continue;
      if ((this.activeBySource.get(sourceId) || 0) >= policy.maxConcurrent) continue;
      const job = queue[0];
      if (!this.visible && job.priority <= this.pausePriorityAt) continue;
      if (backgroundFull && job.priority <= this.pausePriorityAt) continue;
      if (this.playbackPriority && job.priority <= this.pausePriorityAt
          && activeBackground >= this.playbackBackgroundConcurrent) continue;
      if (this._eligibleAt(sourceId) > now) continue;
      if (job.priority > bestPriority) {
        bestPriority = job.priority;
        eligibleSources.clear();
      }
      if (job.priority === bestPriority) eligibleSources.add(sourceId);
    }
    if (eligibleSources.size === 0) return null;

    for (let offset = 0; offset < this.sourceOrder.length; offset++) {
      const index = (this.sourceCursor + offset) % this.sourceOrder.length;
      const sourceId = this.sourceOrder[index];
      if (!eligibleSources.has(sourceId)) continue;
      this.sourceCursor = (index + 1) % this.sourceOrder.length;
      const queue = this.queues.get(sourceId);
      const job = queue.shift();
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      if (queue.length === 0) this.queues.delete(sourceId);
      return job;
    }
    return null;
  }

  _start(job) {
    job.state = 'active';
    job.controller = new AbortController();
    this.activeJobs.add(job);
    this.activeCount += 1;
    this.activeBySource.set(job.sourceId, (this.activeBySource.get(job.sourceId) || 0) + 1);
    const state = this._state(job.sourceId);
    state.nextStartAt = this.now() + this._policy(job.sourceId).minIntervalMs;

    const taskPromise = Promise.resolve()
      .then(() => job.task({
        signal: job.controller.signal,
        sourceId: job.sourceId,
        key: job.key,
      }));
    let operation = taskPromise;
    if (this.taskTimeoutMs > 0) {
      const timeout = new Promise((_, reject) => {
        job.timeoutHandle = this.setTimer(() => {
          job.timeoutHandle = null;
          const error = new Error(
            `[${job.sourceId}] catalog task timed out after ${this.taskTimeoutMs} ms`,
          );
          error.name = 'CatalogTaskTimeoutError';
          error.status = 408;
          error.retryable = true;
          reject(error);
          job.controller?.abort(abortError(error));
        }, this.taskTimeoutMs);
      });
      operation = Promise.race([taskPromise, timeout]);
    }
    operation
      .then(
        (value) => this._finish(job, null, value),
        (error) => this._finish(job, error),
      );
  }

  _finish(job, error, value) {
    if (job.state === 'done') return;
    job.state = 'done';
    if (job.timeoutHandle != null) this.clearTimer(job.timeoutHandle);
    job.timeoutHandle = null;
    this.activeJobs.delete(job);
    this.activeCount = Math.max(0, this.activeCount - 1);
    const sourceActive = Math.max(0, (this.activeBySource.get(job.sourceId) || 1) - 1);
    if (sourceActive === 0) this.activeBySource.delete(job.sourceId);
    else this.activeBySource.set(job.sourceId, sourceActive);

    if (error) this.recordFailure(job.sourceId, error);
    else this.recordSuccess(job.sourceId);
    this._cleanupJob(job);
    this._settle(job, error, value);
    this._queueDrain();
  }

  _clearWake() {
    if (this.wakeTimer != null) this.clearTimer(this.wakeTimer);
    this.wakeTimer = null;
    this.wakeAt = 0;
  }

  _rescheduleWake() {
    this._clearWake();
    this._queueDrain();
  }

  _scheduleWake() {
    const now = this.now();
    let earliest = Infinity;
    for (const [sourceId, queue] of this.queues) {
      if (!queue.length || !this._state(sourceId).enabled) continue;
      if (!this.visible && queue[0].priority <= this.pausePriorityAt) continue;
      if ((this.activeBySource.get(sourceId) || 0) >= this._policy(sourceId).maxConcurrent) continue;
      earliest = Math.min(earliest, this._eligibleAt(sourceId));
    }
    if (!Number.isFinite(earliest) || earliest <= now) return;
    if (this.wakeTimer != null && this.wakeAt <= earliest) return;
    this._clearWake();
    this.wakeAt = earliest;
    this.wakeTimer = this.setTimer(() => {
      this.wakeTimer = null;
      this.wakeAt = 0;
      this._queueDrain();
    }, Math.max(0, earliest - now));
  }

  _drain() {
    if (this.closed) return;
    this._clearWake();
    const concurrency = this.playbackPriority ? this.playbackMaxConcurrent : this.maxConcurrent;
    while (this.activeCount < concurrency) {
      const job = this._pickNext();
      if (!job) break;
      if (job.signal?.aborted || !this._state(job.sourceId).enabled) {
        job.state = 'done';
        this._cleanupJob(job);
        this._settle(job, abortError(job.signal?.reason || 'Source disabled'));
        continue;
      }
      this._start(job);
    }
    this._scheduleWake();
  }
}

export const catalogScheduler = new CatalogScheduler();
