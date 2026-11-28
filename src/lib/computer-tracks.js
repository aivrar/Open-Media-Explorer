import { loadComputerSubtitle } from './computer-client.js';
import {
  loadComputerTrackPrefs, preferredComputerSubtitle, rememberComputerTracks, validSubtitleKey,
} from './computer-track-prefs.js';

function bindTrackMenu(button, menu, choose, video) {
  if (!button || !menu) return { setRows() {}, select() {} };
  const doc = button.ownerDocument;
  let rows = [];
  let focusOnOpen = 'checked';
  const isOpen = () => menu.matches(':popover-open');
  const hide = (focus = false) => {
    if (isOpen()) menu.hidePopover();
    if (focus) button.focus();
  };
  const place = () => {
    const anchor = button.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();
    const { clientWidth, clientHeight } = doc.documentElement;
    const bottom = Math.max(8, clientHeight - anchor.top + 6);
    const rightLimit = clientWidth - width - 8;
    let left = Math.max(8, Math.min(anchor.left, rightLimit));
    const picture = !video.hidden && video.getBoundingClientRect?.();
    if (picture?.width && picture.height
        && picture.left < left + width && picture.right > left
        && picture.top < clientHeight - bottom && picture.bottom > clientHeight - bottom - height) {
      if (picture.left - width - 8 >= 8) left = picture.left - width - 8;
      else if (picture.right + 8 <= rightLimit) left = picture.right + 8;
    }
    menu.style.left = left + 'px';
    menu.style.bottom = bottom + 'px';
  };
  const view = doc.defaultView;
  view?.addEventListener('resize', () => { if (isOpen()) place(); });

  menu.addEventListener('toggle', () => {
    const open = isOpen();
    button.setAttribute('aria-expanded', String(open));
    if (!open) return;
    place();
    const checked = rows.find(({ row }) => row.getAttribute('aria-checked') === 'true');
    const target = focusOnOpen === 'last' ? rows.at(-1) : focusOnOpen === 'first' ? rows[0] : checked ?? rows[0];
    focusOnOpen = 'checked';
    target?.row.focus();
  });
  button.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    if (isOpen()) return;
    focusOnOpen = event.key === 'ArrowUp' ? 'last' : 'first';
    menu.showPopover({ source: button });
  });
  menu.addEventListener('keydown', (event) => {
    const current = rows.findIndex(({ row }) => row === doc.activeElement);
    switch (event.key) {
      case 'ArrowDown': rows[(current + 1) % rows.length]?.row.focus(); break;
      case 'ArrowUp': rows[(Math.max(0, current) + rows.length - 1) % rows.length]?.row.focus(); break;
      case 'Home': rows[0]?.row.focus(); break;
      case 'End': rows.at(-1)?.row.focus(); break;
      case 'Enter': rows[current]?.row.click(); break;
      case 'Escape': hide(true); break;
      case 'Tab': hide(true); return;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  return {
    setRows(choices) {
      hide();
      button.hidden = choices.length === 0;
      rows = choices.map(({ value, label }) => {
        const row = doc.createElement('button');
        row.type = 'button';
        row.tabIndex = -1;
        row.setAttribute('role', 'menuitemradio');
        const text = doc.createElement('span');
        text.textContent = label;
        const mark = doc.createElement('span');
        mark.setAttribute('aria-hidden', 'true');
        row.append(text, mark);
        row.addEventListener('click', () => {
          hide(true);
          choose(value);
        });
        return { row, mark, value };
      });
      menu.replaceChildren(...rows.map(({ row }) => row));
    },
    select(value, busy = false) {
      for (const item of rows) {
        const checked = item.value === value;
        item.row.setAttribute('aria-checked', String(checked));
        if (checked && busy) item.row.setAttribute('aria-busy', 'true');
        else item.row.removeAttribute('aria-busy');
        item.mark.textContent = checked ? (busy ? '\u2713 \u2026' : '\u2713') : '';
      }
    },
  };
}

function retryDelay(signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, 1_000);
    function cancel() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export function bindComputerTracks(video, getElement, { chooseAudio, showMessage }) {
  let id;
  let file;
  let sourceAttached = false;
  let subtitles = [];
  let key = '';
  let lastKey = '';
  let load = null;
  let vttUrl = '';
  let trackElement = null;
  const subtitleButton = getElement('player-subtitles');
  const subtitleTitle = subtitleButton?.title;
  const subtitleMenu = bindTrackMenu(subtitleButton, getElement('player-subtitles-menu'),
    (value) => selectSubtitle(value, true), video);
  const audioMenu = bindTrackMenu(getElement('player-audio'), getElement('player-audio-menu'), chooseAudio, video);

  function removeTrack() {
    const track = trackElement;
    trackElement = null;
    track?.remove();
  }

  function detach() {
    sourceAttached = false;
    removeTrack();
  }

  function clearSubtitle() {
    load?.abort();
    load = null;
    removeTrack();
    if (vttUrl) URL.revokeObjectURL(vttUrl);
    vttUrl = '';
  }

  function updateSubtitleSelection() {
    const busy = load !== null;
    subtitleMenu.select(key, busy);
    if (subtitleButton) {
      if (busy) subtitleButton.setAttribute('aria-busy', 'true');
      else subtitleButton.removeAttribute('aria-busy');
      subtitleButton.title = busy ? 'Loading subtitles...' : subtitleTitle;
    }
  }

  function subtitleFailed(error) {
    if ((error?.status === 404 || error?.status === 422) && !error.retryable
        && file && loadComputerTrackPrefs().files.get(file)?.subtitle === key) {
      rememberComputerTracks(file, { subtitle: undefined });
    }
    clearSubtitle();
    key = '';
    updateSubtitleSelection();
    const fallback = 'This subtitle cannot be read.';
    const message = error?.status && error.message !== 'Local control request failed.' && error.message;
    showMessage(message || fallback);
  }

  function attachTrack() {
    if (!sourceAttached || trackElement || !vttUrl) return;
    const subtitle = subtitles.find((item) => item.key === key);
    if (!subtitle) return;
    const track = (video.ownerDocument ?? document).createElement('track');
    track.kind = 'subtitles';
    track.label = subtitle.label;
    track.srclang = subtitle.language || '';
    track.src = vttUrl;
    track.addEventListener('error', () => { if (trackElement === track) subtitleFailed(); });
    trackElement = track;
    video.appendChild(track);
    track.track.mode = 'showing';
  }

  async function fetchSubtitle(controller, requested) {
    const { signal } = controller;
    try {
      for (let retries = 0; ; retries++) {
        signal.throwIfAborted();
        const entry = id;
        try {
          const text = await loadComputerSubtitle(entry, requested, { signal });
          signal.throwIfAborted();
          vttUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt;charset=utf-8' }));
          load = null;
          attachTrack();
          updateSubtitleSelection();
          return;
        } catch (error) {
          if (!signal.aborted && entry !== id) continue;
          if (signal.aborted || error?.status !== 503 || !error?.retryable || retries >= 5) throw error;
          await retryDelay(signal);
        }
      }
    } catch (error) {
      if (!signal.aborted) subtitleFailed(error);
    }
  }

  function selectSubtitle(value, manual = false) {
    const subtitle = subtitles.find((item) => item.key === value);
    if (value && !subtitle) return;
    if (manual) rememberComputerTracks(file, { subtitle: value }, { subtitle: subtitle?.language || '' });
    if (value === key) return;
    clearSubtitle();
    key = value;
    if (subtitle) {
      lastKey = value;
      load = new AbortController();
      fetchSubtitle(load, key);
    }
    updateSubtitleSelection();
  }

  video.textTracks?.addEventListener('change', () => {
    if (trackElement && trackElement.track.mode !== 'showing') selectSubtitle('', true);
  });

  (video.ownerDocument ?? document).addEventListener('keydown', (event) => {
    if (!subtitles.length || event.defaultPrevented || event.repeat || event.isComposing
        || event.ctrlKey || event.altKey || event.metaKey || event.key?.toLowerCase() !== 'c') return;
    const target = event.target;
    if (target?.isContentEditable || target?.closest?.('textarea, select')) return;
    if (target?.tagName === 'INPUT'
        && ['text', 'search', 'url', 'email', 'password', 'number'].includes(target.type ?? 'text')) return;
    event.preventDefault();
    selectSubtitle(key ? '' : lastKey || subtitles.find((item) => item.default)?.key || subtitles[0].key, true);
  });

  function reset() {
    detach();
    clearSubtitle();
    id = file = undefined;
    key = lastKey = '';
    subtitles = [];
    subtitleMenu.setRows([]);
    updateSubtitleSelection();
    audioMenu.setRows([]);
  }

  return {
    detach,
    attach() {
      sourceAttached = true;
      attachTrack();
    },
    reset,
    rekey(entry, fingerprint) {
      if (id === undefined) return;
      id = entry;
      file = fingerprint;
    },
    update(entry, fingerprint, media) {
      const sameFile = id === entry && file === fingerprint;
      if (!sameFile) reset();
      id = entry;
      file = fingerprint;
      subtitles = (media.subtitles ?? []).filter((item) => validSubtitleKey(item.key));
      const audio = media.audio_tracks ?? [];
      if (!subtitles.some((item) => item.key === lastKey)) lastKey = '';
      subtitleMenu.setRows(subtitles.length ? [{ value: '', label: 'Off' },
        ...subtitles.map((item) => ({ value: item.key, label: item.label }))] : []);
      audioMenu.setRows(audio.length > 1 ? audio.map((item) => ({ value: item.index, label: item.label })) : []);
      audioMenu.select(audio.find((item) => item.selected)?.index);
      const prefs = loadComputerTrackPrefs();
      const saved = prefs.files.get(file)?.subtitle;
      if (saved && !subtitles.some((item) => item.key === saved)) {
        rememberComputerTracks(file, { subtitle: undefined });
      }
      const selected = sameFile ? (subtitles.some((item) => item.key === key) ? key : '')
        : preferredComputerSubtitle(prefs, file, subtitles, audio);
      selectSubtitle(selected);
      updateSubtitleSelection();
    },
  };
}
