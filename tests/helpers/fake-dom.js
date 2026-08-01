/** Lightweight DOM and media doubles for deterministic player unit tests. */

export class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : Boolean(force);
    if (next) this.values.add(name); else this.values.delete(name);
    return next;
  }
}

export class FakeElement extends EventTarget {
  constructor(id = '', tagName = 'div') {
    super();
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.title = '';
    this.style = {};
    this.dataset = {};
    this.classList = new FakeClassList();
    this.children = [];
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, force) {
    const next = force === undefined ? !this.hasAttribute(name) : Boolean(force);
    if (next) this.setAttribute(name, ''); else this.removeAttribute(name);
    return next;
  }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { this.toggleAttribute('hidden', Boolean(value)); }
  appendChild(child) { this.children.push(child); return child; }
  remove() { this.removed = true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

export class FakeMediaElement extends FakeElement {
  constructor(id, tagName = 'audio') {
    super(id, tagName);
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = Number.NaN;
    this.volume = 1;
    this.muted = false;
    this.src = '';
    this.currentSrc = '';
    this.playError = null;
    this.autoEvents = true;
  }

  async play() {
    if (this.playError) throw this.playError;
    this.paused = false;
    this.ended = false;
    if (this.autoEvents) {
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
    }
  }

  pause() {
    const changed = !this.paused;
    this.paused = true;
    if (changed && this.autoEvents) this.dispatchEvent(new Event('pause'));
  }

  load() {
    this.currentSrc = this.src;
    if (this.autoEvents) this.dispatchEvent(new Event('emptied'));
  }

  removeAttribute(name) {
    super.removeAttribute(name);
    if (name === 'src') {
      this.src = '';
      this.currentSrc = '';
    }
  }

  canPlayType() { return ''; }
  emit(type) { this.dispatchEvent(new Event(type)); }
}

export function createFakeDocument(elements = []) {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const documentElement = new FakeElement('document-element', 'html');
  const body = new FakeElement('body', 'body');
  return {
    documentElement,
    body,
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tagName) => new FakeElement('', tagName),
    addEventListener() {},
    removeEventListener() {},
    register(element) { byId.set(element.id, element); return element; },
  };
}

export function createPlayerDom() {
  const ids = [
    'app', 'player-bar', 'player-title', 'player-source', 'player-art',
    'player-play', 'icon-play', 'icon-pause', 'player-stop', 'player-seek',
    'player-time', 'player-dur', 'player-volume', 'player-mute',
    'player-next-broken', 'player-fav',
    'player-capture', 'player-capture-label', 'player-capture-secondary',
    'player-capture-status', 'player-capture-status-text', 'player-capture-progress',
    'player-capture-progress-bar', 'player-capture-announcement', 'player-eq', 'player-eq-state',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement(id)]));
  elements['audio-el'] = new FakeMediaElement('audio-el', 'audio');
  elements['video-el'] = new FakeMediaElement('video-el', 'video');
  elements['icon-pause'].hidden = true;
  elements['player-seek'].disabled = true;
  return { elements, document: createFakeDocument(Object.values(elements)) };
}
