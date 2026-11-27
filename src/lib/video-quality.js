import { formatStreamBitrate } from './stream-quality.js';

export function normalizeVideoQuality(value) {
  if (value === 'best') return value;
  if (!Number.isFinite(value?.height) || value.height <= 0) {
    return Number.isFinite(value?.bitrate) && value.bitrate > 0 ? { bitrate: value.bitrate } : 'auto';
  }
  const quality = { height: value.height };
  if (Number.isFinite(value.frameRate) && value.frameRate > 0) quality.frameRate = value.frameRate;
  return quality;
}

function frameRateOf(value) {
  const [frames, seconds = 1] = String(value ?? '').split('/');
  const rate = Number(frames) / Number(seconds);
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : 0;
}

export function videoQualityLevel(raw, id) {
  return {
    id,
    period: raw.mediaInfo?.streamInfo?.id,
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    bitrate: Number(raw.bandwidth ?? raw.attrs?.BANDWIDTH ?? raw.bitrate) || 0,
    frameRate: frameRateOf(raw.frameRate || raw.attrs?.['FRAME-RATE']),
  };
}

export function videoQualityOptions(levels) {
  const sorted = levels.filter((level) => level.height > 0 || level.bitrate > 0).sort((a, b) =>
    b.height - a.height || b.bitrate - a.bitrate || b.frameRate - a.frameRate || b.width - a.width);
  const counts = new Map();
  return sorted.map((level) => {
    const { height, frameRate, bitrate } = level;
    const distinguishRate = sorted.some((other) =>
      other.height === height && other.frameRate && other.frameRate !== frameRate);
    const label = [
      height ? height + 'p' : '',
      height && distinguishRate && frameRate ? frameRate + ' fps' : '',
      formatStreamBitrate(bitrate / 1000, { hls: true }),
    ].filter(Boolean).join(' \u00b7 ');
    const count = (counts.get(label) || 0) + 1;
    counts.set(label, count);
    return {
      level,
      quality: height ? (distinguishRate && frameRate ? { height, frameRate } : { height }) : { bitrate },
      label: count === 1 ? label : label + ' (' + count + ')',
    };
  });
}

export function matchVideoQuality(options, quality) {
  if (!quality || typeof quality !== 'object' || !options.length) return null;
  if (quality.bitrate > 0) {
    const byBitrate = options.filter(({ level }) => level.bitrate > 0 && !level.height);
    return byBitrate.find(({ level }) => level.bitrate <= quality.bitrate) ?? byBitrate.at(-1) ?? null;
  }
  const sized = options.filter(({ level }) => level.height > 0);
  const height = sized.find(({ level }) => level.height <= quality.height)?.level.height
    ?? sized.at(-1)?.level.height;
  const peers = sized.filter(({ level }) => level.height === height);
  return peers.find(({ level }) => level.frameRate === quality.frameRate) ?? peers[0] ?? null;
}

// Follow hls.js's size rule. Allow the first size that covers the long edge,
// including every rendition with those dimensions.
export function pictureSizeLevel(levels, { width, height }, pixelRatio = globalThis.devicePixelRatio || 1) {
  if (!(width > 0 && height > 0)) return null;
  const edge = Math.max(width, height) * pixelRatio;
  const index = levels.findIndex((level, i) => {
    const next = levels[i + 1];
    return Math.max(level.width, level.height) >= edge
      && (level.width !== next?.width || level.height !== next?.height);
  });
  return index < 0 ? levels.at(-1) ?? null : levels[index];
}

export function observePictureSize(video, onSize, {
  page = globalThis.document, window = globalThis.window, Observer = globalThis.ResizeObserver,
  onObserved = () => {},
} = {}) {
  page?.addEventListener?.('fullscreenchange', onSize);
  window?.addEventListener?.('resize', onSize);
  video.addEventListener?.('resize', onSize);
  const observer = Observer && new Observer((entries) => {
    onSize();
    onObserved(entries);
  });
  observer?.observe(video, { box: 'border-box' });
  return () => {
    page?.removeEventListener?.('fullscreenchange', onSize);
    window?.removeEventListener?.('resize', onSize);
    video.removeEventListener?.('resize', onSize);
    observer?.disconnect?.();
  };
}

export function createVideoQuality(video, onChange) {
  let source = null;
  let sourceId;
  let levels = [];
  let options = [];
  let rendered = null;
  let preference = 'auto';
  let exact = null;
  let fellBack = false;
  let applied = null;

  function resolve(quality, pick) {
    const selected = pick && pick.sourceId === sourceId && options.find(({ level }) =>
      level.id === pick.id && level.height === pick.height && level.frameRate === pick.frameRate
      && level.bitrate === pick.bitrate);
    return selected || matchVideoQuality(options, quality);
  }

  function sync() {
    applyPreference(false);
  }

  function applyPreference(chosen) {
    if (!source || !levels.length) return;
    const mode = fellBack ? 'auto' : typeof preference === 'object' ? 'fixed' : preference;
    const fixed = mode === 'fixed' && options.length > 1 ? resolve(preference, exact)?.level : null;
    const rect = (mode === 'auto' || (mode === 'fixed' && !fixed)) && video.getBoundingClientRect?.();
    const cap = rect ? pictureSizeLevel(levels, rect) : null;
    if (applied?.mode === mode && applied.fixed === fixed && applied.cap === cap) return;
    const previous = applied;
    applied = { mode, fixed, cap };
    source.apply(applied, previous, levels, chosen);
  }

  function setSource(next) {
    source = next;
    sourceId = Symbol();
    levels = [];
    options = [];
    rendered = null;
    applied = null;
    onChange();
  }

  return {
    sync,
    setPreference(quality, pick, chosen = false) {
      preference = quality;
      exact = pick;
      if (chosen) fellBack = false;
      applyPreference(chosen);
    },
    resetSession() { fellBack = false; },
    setSource,
    clearSource(owner) {
      if (source === owner) setSource(null);
    },
    setLevels(owner, next) {
      if (source !== owner) return;
      if (next.length === levels.length && next.every((level, i) => {
        const old = levels[i];
        return level.id === old.id && level.height === old.height && level.width === old.width
          && level.bitrate === old.bitrate && level.frameRate === old.frameRate && level.period === old.period;
      })) return;
      levels = next;
      options = videoQualityOptions(levels);
      if (!levels.length && applied) {
        source.apply({ fixed: null, cap: null }, applied, levels);
        applied = null;
      }
      sync();
      onChange();
    },
    rendered(owner, raw) {
      if (source !== owner || rendered === raw) return;
      rendered = raw;
      onChange();
    },
    fallBack(owner) {
      if (source !== owner || !applied?.fixed) return false;
      fellBack = true;
      sync();
      onChange();
      return true;
    },
    view(quality, pick) {
      return {
        options,
        selected: resolve(quality, pick),
        now: Number(video.videoHeight) || Number(rendered?.height) || 0,
        fellBack,
        pick: ({ level: { id, height, frameRate, bitrate } }) => ({ sourceId, id, height, frameRate, bitrate }),
      };
    },
  };
}

export function createHlsVideoQuality(hls) {
  let recoveryCap = -1;
  let sizeCap = -1;
  let pendingAutoLevel = null;

  function resumeAuto() {
    if (pendingAutoLevel === null) return;
    pendingAutoLevel = null;
    // nextLevel also enters manual mode. loadLevel restores ABR without another flush.
    hls.loadLevel = -1;
  }

  function switchAutoLevel(level) {
    pendingAutoLevel = level;
    hls.nextLevel = level;
  }

  function setCap() {
    hls.autoLevelCapping = sizeCap < 0 ? recoveryCap
      : recoveryCap < 0 ? sizeCap : Math.min(sizeCap, recoveryCap);
  }

  return {
    apply({ fixed, cap }, previous, levels, chosen) {
      const oldCap = hls.maxAutoLevel;
      resumeAuto();
      sizeCap = cap?.id ?? -1;
      if (recoveryCap >= levels.length) recoveryCap = levels.length - 1;
      setCap();
      if (fixed) {
        hls.startLevel = fixed.id;
        if (chosen) hls.currentLevel = fixed.id;
        else hls.loadLevel = fixed.id;
        return;
      }
      if (previous?.fixed) {
        hls.loadLevel = -1;
        hls.startLevel = -1;
      }
      const ceiling = hls.maxAutoLevel;
      if (hls.nextAutoLevel > ceiling) hls.nextAutoLevel = ceiling;
      if (previous?.fixed || ceiling < 0 || hls.currentLevel < 0) return;
      if (cap && (hls.currentLevel > ceiling || hls.nextLevel > ceiling)) {
        switchAutoLevel(Math.min(ceiling, Math.max(hls.minAutoLevel, hls.nextAutoLevel)));
        return;
      }
      if (!previous?.cap || !cap || ceiling <= oldCap) return;
      const budget = hls.bandwidthEstimate * hls.config.abrBandWidthUpFactor;
      const next = levels.findLast((level) => level.id <= ceiling && level.bitrate > 0 && level.bitrate <= budget);
      if (next && next.id > hls.currentLevel) switchAutoLevel(next.id);
    },
    fragmentReady(level) {
      if (level === pendingAutoLevel) resumeAuto();
    },
    resumeAuto,
    lower() {
      resumeAuto();
      if (!hls.autoLevelEnabled || !(hls.maxAutoLevel > 0)) return false;
      recoveryCap = hls.maxAutoLevel - 1;
      setCap();
      if (hls.currentLevel > recoveryCap || hls.nextAutoLevel > recoveryCap) hls.nextAutoLevel = recoveryCap;
      return true;
    },
  };
}
