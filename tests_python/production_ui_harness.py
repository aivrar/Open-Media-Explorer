"""Real-Edge acceptance harness for the exact production frontend bundle.

This file is test-only. It serves ``frontend/index.html`` with two inline
diagnostic scripts added around the unchanged, hashed production entrypoint.
The browser uses an isolated profile and loopback media, so the user's saved
World Media state is never read or changed.
"""
from __future__ import annotations

import io
import json
import math
import struct
import sys
import tempfile
import threading
import urllib.parse
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import worldmedia_server
from tests_python import fixture_server
from tests_python.browser_relay_harness import prepare_browser_media
from tests_python.fixture_server import MediaFixtureServer
from worldmedia_media import MediaRegistry, SafeConnector


APP_PORT = 19836
FIXTURE_PORT = 19837

SEED_SCRIPT = f"""
<script>
(() => {{
  const favorite = {{
    id: 'ui-harness:audio',
    title: 'UI Harness Audio',
    description: 'Isolated production-interface acceptance item.',
    source: 'internet-archive',
    type: 'audio',
    stream_url: 'http://127.0.0.1:{FIXTURE_PORT}/media/tone.wav',
    stream_kind: 'audio',
    delivery: 'on-demand',
    download_url: 'http://127.0.0.1:{FIXTURE_PORT}/media/tone.wav',
    source_url: 'https://archive.org/details/ui-harness-audio',
    capture_headers: {{}},
    thumbnail: '',
    tags: ['test', 'acceptance'],
    country: 'US',
    language: 'en',
    year: 2026,
    license: 'Test fixture'
  }};
  const hlsFavorite = {{
    id: 'ui-harness:hls',
    title: 'UI Harness HLS',
    description: 'Isolated adaptive-live acceptance item.',
    source: 'iptv-org',
    type: 'tv',
    stream_url: 'http://127.0.0.1:{FIXTURE_PORT}/hls/vod/index.m3u8',
    stream_kind: 'hls',
    delivery: 'live',
    download_url: '',
    source_url: 'https://iptv-org.github.io/',
    capture_headers: {{}}, thumbnail: '', tags: ['test', 'hls'],
    country: 'US', language: 'en', year: 2026, license: 'Test fixture'
  }};
  localStorage.clear();
  localStorage.setItem('worldmedia.favorites.v1', JSON.stringify([favorite, hlsFavorite]));
  localStorage.setItem('worldmedia.settings.v1', JSON.stringify({{
    version: 1,
    theme: 'dark',
    defaultMode: 'library',
    recordingQuality: 'balanced',
    enabledSources: {{
      'radio-browser': false,
      'iptv-org': false,
      'internet-archive': false,
      'nasa': false,
      'wikimedia': false,
      'librivox': false,
      'media-ccc': false,
      'library-of-congress': false,
      'gpodder': false,
      'peertube': false,
      'owncast': false
    }},
    showExplicitContent: false
  }}));

  window.__worldmediaUiAudit = {{ bindings: [], errors: [] }};
  const nativeAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, listener, options) {{
    if (this?.id === 'shutdown-btn' || (this === document && type === 'keydown')) {{
      window.__worldmediaUiAudit.bindings.push({{target: this.id || 'document', type}});
    }}
    return nativeAdd.call(this, type, listener, options);
  }};
  window.addEventListener('error', (event) => {{
    window.__worldmediaUiAudit.errors.push(String(event.error || event.message));
  }});
  window.addEventListener('unhandledrejection', (event) => {{
    window.__worldmediaUiAudit.errors.push(String(event.reason));
  }});
}})();
</script>
"""

AUDIT_SCRIPT = """
<script type="module">
const audit = window.__worldmediaUiAudit;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
async function until(predicate, message, timeout = 10000) {
  const end = performance.now() + timeout;
  let lastError = null;
  while (performance.now() < end) {
    try { const value = predicate(); if (value) return value; } catch (error) { lastError = error; }
    await wait(40);
  }
  throw new Error(message + (lastError ? ` (${lastError})` : ''));
}
function input(element, value) {
  element.value = value;
  element.dispatchEvent(new Event('input', {bubbles: true}));
}
async function report(data) {
  await fetch('/api/test/ui-result', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data),
  });
}
async function run() {
  const checks = [];
  try {
    await until(() => document.querySelector('.library-root'), 'Library did not boot');
    assert(document.querySelector('#view-host')?.dataset.mode === 'library', 'Library is not the boot mode');
    assert(document.querySelector('.library-sidebar'), 'Library sidebar is missing');
    assert(document.querySelector('.search-input'), 'Library search is missing');
    assert(document.querySelectorAll('.filter-chips .chip').length >= 4, 'Library filters are incomplete');
    assert(document.querySelector('#shutdown-btn')?.dataset.shutdownBound === 'true', 'Shutdown was not initialized');
    const shutdownTypes = audit.bindings.filter((entry) => entry.target === 'shutdown-btn').map((entry) => entry.type);
    assert(shutdownTypes.includes('click') && shutdownTypes.includes('pointerup'), 'Shutdown activation paths are not both bound');
    checks.push('library-shell', 'shutdown-wiring');

    const favoritesOption = document.querySelector('.source-item[data-source="favorites"]');
    favoritesOption.focus();
    favoritesOption.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    const card = await until(() => document.querySelector('.card[data-id="ui-harness:audio"]'), 'Seeded favorite card did not render');
    const cardOpen = card.querySelector('.card-open');
    assert(cardOpen?.tagName === 'BUTTON', 'Library card does not use a native keyboard control');
    assert(cardOpen.getAttribute('aria-label')?.includes('UI Harness Audio'),
      'Library card has no useful accessible name');
    const cardFavorite = card.querySelector('.card-star');
    assert(cardFavorite?.getAttribute('aria-pressed') === 'true',
      'Card favorite does not expose its pressed state');
    const search = document.querySelector('.search-input');
    const chips = [...document.querySelectorAll('.filter-chips .chip')];
    input(search, 'UI Harness');
    input(chips[0], 'US');
    input(chips[1], 'en');
    input(chips[2], '2020');
    input(chips[3], '2030');
    await wait(220);
    assert(document.querySelector('.card[data-id="ui-harness:audio"]'), 'Search/filter removed a matching favorite');
    checks.push('favorite-search-filter');

    cardOpen.focus();
    cardOpen.click();
    await until(() => document.querySelector('.detail-title')?.textContent === 'UI Harness Audio', 'Card did not open its detail panel');
    await until(() => !document.querySelector('#player-bar').hidden, 'Card did not open the player bar');
    const play = document.querySelector('#player-play');
    await until(() => play.getAttribute('aria-label') === 'Pause', 'Autoplay did not become Pause', 12000);
    assert(!document.querySelector('#audio-el').paused, 'Audio is not actually playing');
    assert(document.querySelector('#player-fav').getAttribute('aria-pressed') === 'true', 'Player favorite state was not restored');

    play.click();
    await until(() => play.getAttribute('aria-label') === 'Play' && document.querySelector('#audio-el').paused, 'Pause did not update control state');
    play.click();
    await until(() => play.getAttribute('aria-label') === 'Pause' && !document.querySelector('#audio-el').paused, 'Resume did not update control state');

    const playerFavorite = document.querySelector('#player-fav');
    playerFavorite.click();
    await until(() => playerFavorite.getAttribute('aria-pressed') === 'false', 'Player favorite did not turn off');
    assert(JSON.parse(localStorage.getItem('worldmedia.favorites.v1')).length === 1, 'Unfavorite did not persist');
    playerFavorite.click();
    await until(() => playerFavorite.getAttribute('aria-pressed') === 'true', 'Player favorite did not turn on');
    assert(JSON.parse(localStorage.getItem('worldmedia.favorites.v1')).length === 2, 'Favorite did not persist');
    checks.push('keyboard-sidebar-card', 'card-detail-player', 'play-pause-resume',
      'favorite-persistence', 'accessible-card-state');

    const eq = document.querySelector('#player-eq');
    await until(() => !eq.disabled, 'EQ did not become available');
    eq.focus();
    eq.click();
    const eqModal = await until(() => document.querySelector('[data-eq-modal]'), 'EQ overlay did not open');
    assert(eqModal.querySelectorAll('.eq-band-slider').length === 11, 'EQ overlay is missing controls');
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    await until(() => !document.querySelector('[data-eq-modal]'), 'EQ overlay did not close');
    assert(document.activeElement === eq, 'EQ overlay did not restore focus');
    checks.push('eq-integration');

    const modes = {
      tuner: '.tuner-root', grid: '.grid-root', discovery: '.discovery-root', about: '.about-root'
    };
    for (const [mode, selector] of Object.entries(modes)) {
      document.querySelector(`.mode-btn[data-mode="${mode}"]`).click();
      await until(() => document.querySelector('#view-host')?.dataset.mode === mode && document.querySelector(selector), `${mode} did not render`);
      assert(!document.querySelector('.error-pane'), `${mode} rendered an error pane`);
      assert(document.querySelector(`.mode-btn[data-mode="${mode}"]`)?.getAttribute('aria-current') === 'page',
        `${mode} did not expose the active navigation state`);
    }
    document.querySelector('.mode-btn[data-mode="library"]').click();
    await until(() => document.querySelector('#view-host')?.dataset.mode === 'library' && document.querySelector('.library-root'), 'Library did not restore');
    assert(document.querySelector('.library-sidebar'), 'Library sidebar disappeared after tab navigation');
    await until(() => document.querySelector('.detail-title')?.textContent === 'UI Harness Audio', 'Library detail panel did not restore');
    checks.push('all-modes', 'library-detail-restoration');

    const settingsButton = document.querySelector('#settings-btn');
    settingsButton.focus();
    settingsButton.click();
    const settings = await until(() => document.querySelector('[data-settings-modal]'), 'Settings did not open');
    const themeSelect = settings.querySelector('#settings-theme');
    assert(themeSelect?.value === 'dark', 'Theme setting did not restore');
    for (const theme of ['light', 'midnight', 'forest', 'ember', 'amethyst', 'dark', 'system']) {
      themeSelect.value = theme;
      themeSelect.dispatchEvent(new Event('change', {bubbles: true}));
      if (theme === 'system') {
        assert(!document.documentElement.hasAttribute('data-theme'),
          'system theme did not return control to the Windows preference');
      } else {
        assert(document.documentElement.getAttribute('data-theme') === theme,
          `${theme} did not apply immediately`);
      }
      assert(JSON.parse(localStorage.getItem('worldmedia.settings.v1')).theme === theme,
        `${theme} did not persist immediately`);
    }
    themeSelect.value = 'dark';
    themeSelect.dispatchEvent(new Event('change', {bubbles: true}));
    assert(settings.querySelector('#settings-default-mode')?.value === 'library', 'Default mode setting did not restore');
    assert(settings.querySelector('#recording-quality')?.value === 'balanced', 'Recording quality did not restore');
    const expectedSourceIds = [
      'radio-browser', 'iptv-org', 'internet-archive', 'nasa', 'wikimedia', 'librivox',
      'media-ccc', 'library-of-congress', 'gpodder', 'peertube', 'owncast',
    ];
    assert(settings.querySelectorAll('input[data-source]').length === expectedSourceIds.length,
      'Settings source switches are incomplete');
    for (const sourceId of expectedSourceIds) {
      assert(settings.querySelector(`input[data-source="${sourceId}"]`),
        `Settings is missing the ${sourceId} switch`);
      assert(document.querySelector(`.source-item[data-source="${sourceId}"]`),
        `Library is missing the ${sourceId} source row`);
    }
    for (const sourceId of [
      'media-ccc', 'library-of-congress', 'gpodder', 'peertube', 'owncast',
    ]) {
      const sourceToggle = settings.querySelector(`input[data-source="${sourceId}"]`);
      assert(sourceToggle.checked === false, `${sourceId} did not restore its disabled test state`);
      sourceToggle.checked = true;
      sourceToggle.dispatchEvent(new Event('change', {bubbles: true}));
      assert(JSON.parse(localStorage.getItem('worldmedia.settings.v1'))
        .enabledSources[sourceId] === true, `${sourceId} enable did not persist`);
      sourceToggle.checked = false;
      sourceToggle.dispatchEvent(new Event('change', {bubbles: true}));
      assert(JSON.parse(localStorage.getItem('worldmedia.settings.v1'))
        .enabledSources[sourceId] === false, `${sourceId} disable did not persist`);
    }
    const explicitToggle = settings.querySelector('#settings-show-explicit');
    assert(explicitToggle?.checked === false, 'Explicit content did not default off');
    explicitToggle.checked = true;
    explicitToggle.dispatchEvent(new Event('change', {bubbles: true}));
    assert(JSON.parse(localStorage.getItem('worldmedia.settings.v1')).showExplicitContent === true,
      'Direct explicit-content opt-in did not persist');
    explicitToggle.checked = false;
    explicitToggle.dispatchEvent(new Event('change', {bubbles: true}));
    assert(JSON.parse(localStorage.getItem('worldmedia.settings.v1')).showExplicitContent === false,
      'Explicit-content opt-out did not persist');
    assert(settings.querySelector('[data-runtime-card]'), 'Runtime paths card is missing');
    assert(settings.querySelector('[data-ffmpeg-section]'), 'FFmpeg section is missing');
    await until(() => !settings.querySelector('[data-runtime-portable]')?.textContent.includes('Checking'), 'Runtime paths did not resolve');
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    await until(() => !document.querySelector('[data-settings-modal]'), 'Settings did not close');
    assert(document.activeElement === settingsButton, 'Settings did not restore focus');
    checks.push('eleven-source-settings', 'new-source-toggle-persistence',
      'explicit-content-direct-toggle', 'all-theme-switches', 'settings-runtime-focus');

    const focusStyle = getComputedStyle(document.querySelector('.card'));
    assert(focusStyle != null, 'Focusable card style could not be computed');
    assert(matchMedia('(prefers-reduced-motion: reduce)') != null,
      'Reduced-motion media query is unavailable');
    document.documentElement.style.zoom = '2';
    await wait(80);
    assert(document.querySelector('#player-bar').getBoundingClientRect().width > 0,
      'Player collapsed at 200 percent zoom');
    assert(document.querySelector('.library-sidebar').getBoundingClientRect().width > 0,
      'Library navigation collapsed at 200 percent zoom');
    document.documentElement.style.zoom = '';
    checks.push('zoom-200-layout', 'reduced-motion-capability');

    document.querySelector('#player-stop').click();
    await until(() => document.querySelector('#player-bar').hidden, 'Stop did not close player bar');
    assert(document.querySelector('#audio-el').paused, 'Stop did not pause audio');

    document.querySelector('.source-item[data-source="favorites"]').click();
    const hlsCard = await until(() => document.querySelector('.card[data-id="ui-harness:hls"]'), 'HLS favorite card did not render');
    hlsCard.querySelector('.card-open').click();
    await until(() => document.querySelector('.detail-title')?.textContent === 'UI Harness HLS', 'HLS detail did not open');
    const video = document.querySelector('#video-el');
    await until(() => !video.hidden, 'HLS video element did not open');
    await until(() => video.currentTime > 0 || video.ended, 'Production HLS playback never advanced', 15000);
    assert(!document.querySelector('#player-bar').hidden, 'HLS playback lost the player bar');
    document.querySelector('#player-stop').click();
    await until(() => document.querySelector('#player-bar').hidden && video.hidden, 'HLS stop did not clean up');
    checks.push('production-hls-start-stop');

    assert(audit.errors.length === 0, `Unhandled browser errors: ${audit.errors.join(' | ')}`);
    checks.push('stop-cleanup', 'no-unhandled-errors');

    await report({
      passed: true,
      checks,
      modes: ['library', ...Object.keys(modes)],
      shutdownBindings: shutdownTypes,
      favoriteCount: JSON.parse(localStorage.getItem('worldmedia.favorites.v1')).length,
      exactBundle: document.querySelector('script[src*="/assets/index-"]')?.getAttribute('src') || '',
    });
  } catch (error) {
    await report({passed: false, checks, error: String(error), stack: error?.stack || '', browserErrors: audit.errors});
  }
}
run();
</script>
"""


def _long_tone_wav(seconds: int = 20) -> bytes:
    output = io.BytesIO()
    sample_rate = 8_000
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        frames = bytearray()
        for index in range(sample_rate * seconds):
            sample = int(12_000 * math.sin(2 * math.pi * 440 * index / sample_rate))
            frames.extend(struct.pack("<h", sample))
        wav.writeframes(frames)
    return output.getvalue()


def _injected_index() -> bytes:
    html = (worldmedia_server.ROOT / "index.html").read_text(encoding="utf-8")
    marker = '<script type="module" crossorigin src="/assets/index-'
    if marker not in html:
        raise RuntimeError("production index entrypoint marker was not found")
    html = html.replace(marker, SEED_SCRIPT + "\n    " + marker, 1)
    if "</body>" not in html:
        raise RuntimeError("production index body marker was not found")
    return html.replace("</body>", AUDIT_SCRIPT + "\n  </body>", 1).encode("utf-8")


class ProductionUiHandler(worldmedia_server.WorldMediaHandler):
    ui_result: dict | None = None
    injected_index = _injected_index()

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path == "/production-ui-test":
            return self._send_bytes(self.injected_index, "text/html; charset=utf-8")
        if path == "/api/test/ui-result":
            return self._send_json({"ok": True, "result": type(self).ui_result})
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if urllib.parse.urlsplit(self.path).path == "/api/test/ui-result":
            length = min(int(self.headers.get("Content-Length") or 0), 65_536)
            try:
                value = json.loads(self.rfile.read(length))
            except (ValueError, json.JSONDecodeError):
                value = {"passed": False, "error": "invalid UI audit result"}
            type(self).ui_result = value if isinstance(value, dict) else None
            return self._send_json({"ok": True})
        return super().do_POST()

    def _send_bytes(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    connector = SafeConnector(address_policy=lambda address: address in {"127.0.0.1", "::1"})
    original_registry = worldmedia_server.MEDIA_REGISTRY
    original_tone = fixture_server.TONE_WAV
    original_video = fixture_server.VIDEO_BYTES
    original_segment = fixture_server.SEGMENT_BYTES
    original_dash = fixture_server.DASH_FILES
    worldmedia_server.MEDIA_REGISTRY = MediaRegistry(connector, ttl_seconds=300)
    fixture_server.TONE_WAV = _long_tone_wav()
    with tempfile.TemporaryDirectory(prefix="worldmedia-production-ui-") as temp:
        prepare_browser_media(Path(temp))
        with MediaFixtureServer(FIXTURE_PORT):
            server = worldmedia_server.ThreadingServer(("127.0.0.1", APP_PORT), ProductionUiHandler)
            try:
                server.serve_forever()
            finally:
                server.server_close()
                worldmedia_server.shutdown_services(timeout=1)
                worldmedia_server.MEDIA_REGISTRY = original_registry
                fixture_server.TONE_WAV = original_tone
                fixture_server.VIDEO_BYTES = original_video
                fixture_server.SEGMENT_BYTES = original_segment
                fixture_server.DASH_FILES = original_dash


if __name__ == "__main__":
    main()
