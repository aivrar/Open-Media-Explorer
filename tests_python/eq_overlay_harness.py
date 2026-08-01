"""Test-only real-browser harness for the production EQ overlay."""
from __future__ import annotations

import json
import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import worldmedia_server


PORT = 19835
SOURCE_ROOT = (worldmedia_server.BASE_DIR / "src").resolve()

DIAGNOSTIC_HTML = b"""<!doctype html><html><head><meta charset="utf-8">
<title>World Media EQ Overlay Test</title><link rel="stylesheet" href="/src/styles/base.css"><style>
body{font:17px system-ui;background:#10151d;color:#e9f1ff;max-width:760px;margin:45px auto;padding:24px}
#run{font:inherit;padding:12px 18px;border:0;border-radius:9px;background:#55d6c2;color:#07120f;font-weight:700}
#result{margin-top:20px;padding:16px;border:1px solid #526077;border-radius:10px}.pass{color:#67e8a5}.fail{color:#ff7b86}
#app{position:fixed;left:-10000px;top:0;width:980px;height:650px}.player-bar{display:none}
</style></head><body><h1>World Media production EQ overlay test</h1>
<p>This runs only against isolated localStorage and production EQ modules.</p>
<button id="run">Run overlay test</button><div id="result">Waiting for one click.</div>
<div id="app"><button id="launcher">EQ launcher</button><footer id="player-bar" class="player-bar" hidden>
<img id="player-art" alt=""><span id="player-title"></span><span id="player-source"></span>
<button id="player-fav"></button><button id="player-play"><span id="icon-play"></span><span id="icon-pause" hidden></span></button>
<button id="player-stop"></button><button id="player-next-broken"></button>
<input id="player-seek" type="range"><span id="player-time"></span><span id="player-dur"></span>
<button id="player-mute"></button><input id="player-volume" type="range">
<audio id="audio-el"></audio><video id="video-el"></video></footer></div><div id="modal-host"></div>
<script type="module">
const result = document.querySelector('#result');
const runButton = document.querySelector('#run');
const restartKey = 'worldmedia.eq-harness.restart';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const make = (id, title) => ({
  id, title, description: '', source: 'test', type: 'audio',
  stream_url: 'https://media.invalid/test.mp3', stream_kind: 'audio',
  delivery: 'on-demand', download_url: '', capture_headers: {}, tags: [],
});
async function report(data) {
  await fetch('/api/test/eq-result', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data),
  });
}

runButton.onclick = async () => {
  runButton.disabled = true;
  result.textContent = 'Running...';
  try {
    const restart = JSON.parse(localStorage.getItem(restartKey) || 'null');
    if (!restart) localStorage.clear();
    const stateMod = await import('/src/lib/state.js');
    const store = await import('/src/lib/eq-store.js');
    const player = await import('/src/lib/player.js');
    const overlay = await import('/src/lib/eq-overlay.js');
    await stateMod.initState();
    player.initPlayer();
    overlay.initEqOverlay();

    const first = make('test:eq-one', 'EQ One');
    const second = make('test:eq-two', 'EQ Two');
    const launcher = document.querySelector('#launcher');
    launcher.focus();

    if (restart) {
      localStorage.removeItem(restartKey);
      let saved = store.loadEqState();
      assert(JSON.stringify(saved.global) === JSON.stringify(restart.global), 'Global curve did not survive restart exactly');
      assert(saved.favorites[first.id]?.bands[0] === 7.5, 'first favorite did not survive restart');
      assert(saved.favorites[second.id], 'second favorite did not survive restart');
      const customKeys = Object.keys(saved.customPresets);
      assert(customKeys.length === 2, 'custom presets did not survive restart');
      assert(customKeys.some((key) => saved.customPresets[key].name === 'First custom'), 'first custom name did not survive restart');
      assert(customKeys.some((key) => saved.customPresets[key].name === 'Second custom'), 'second custom name did not survive restart');

      stateMod.setCurrentItem(first);
      let modal = overlay.openEqOverlay();
      assert(modal.querySelector('.eq-band-slider[data-index="0"]').value === '7.5', 'first favorite UI did not restore after restart');
      assert(modal.querySelector('[data-eq-scope]').textContent === 'EQ One', 'first favorite scope did not restore after restart');
      stateMod.setCurrentItem(second);
      assert(modal.querySelector('[data-eq-scope]').textContent === 'EQ Two', 'second favorite scope did not restore after restart');
      modal.querySelector('[data-eq-favorite]').click();
      await wait(20);
      saved = store.loadEqState();
      assert(!saved.favorites[second.id], 'unfavorite did not remove per-item curve');
      assert(store.getEffectiveEq(saved, second.id, false).bands[0] === saved.global.bands[0], 'unfavorite did not restore Global');

      const bands = modal.querySelector('.eq-bands');
      modal.querySelector('.eq-modal').style.width = '620px';
      await new Promise(requestAnimationFrame);
      assert(bands.scrollWidth > bands.clientWidth, 'narrow overlay did not expose horizontal scrolling');
      localStorage.setItem('worldmedia.downloads.keep', 'media');
      localStorage.setItem('worldmedia.ffmpeg.keep', 'tool');
      stateMod.clearCache();
      assert(localStorage.getItem(store.EQ_STORAGE_KEY) === null, 'clear cache did not remove EQ');
      assert(localStorage.getItem('worldmedia.downloads.keep') === 'media' && localStorage.getItem('worldmedia.ffmpeg.keep') === 'tool', 'clear cache removed media/tools');
      modal.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      assert(!document.querySelector('[data-eq-modal]'), 'backdrop did not close overlay');
      const data = {
        passed: true, sliders: 11, customPresets: 2, favoritesTested: 2,
        narrowScroll: true, focusRestored: true, debounceMs: 150,
        realPageReload: true,
      };
      result.className = 'pass';
      result.textContent = 'PASS - production overlay interactions, scopes, presets, real restart persistence, and cache boundary';
      await report(data);
      return;
    }

    stateMod.setCurrentItem(first);
    let modal = overlay.openEqOverlay();
    assert(modal && modal.querySelectorAll('.eq-band-slider').length === 11, 'expected preamp plus ten bands');
    assert(document.querySelector('#app').inert === true, 'app must be inert while modal is open');
    assert(document.activeElement?.dataset.eqAct === 'close', 'close button should receive initial focus');
    assert(modal.querySelector('[data-eq-scope]').textContent === 'Global', 'first item should start Global');
    const preset = modal.querySelector('[data-eq-preset]');
    preset.value = 'builtin:bass-boost';
    preset.dispatchEvent(new Event('change'));
    await wait(180);
    let saved = store.loadEqState();
    assert(saved.global.presetId === 'bass-boost', 'built-in snapshot did not autosave');
    const low = modal.querySelector('.eq-band-slider[data-index="0"]');
    low.value = '7';
    low.dispatchEvent(new Event('input', {bubbles: true}));
    modal.querySelector('[data-eq-favorite]').click();
    await wait(20);
    saved = store.loadEqState();
    assert(saved.favorites[first.id]?.bands[0] === 7, 'favorite did not clone the audible pending curve');
    assert(modal.querySelector('[data-eq-scope]').textContent === 'EQ One', 'favorite title scope not displayed');
    modal.querySelector('[data-eq-act="new-preset"]').click();
    const name = modal.querySelector('[data-eq-preset-name]');
    name.value = 'First custom';
    name.dispatchEvent(new Event('input', {bubbles: true}));
    low.value = '8';
    low.dispatchEvent(new Event('input', {bubbles: true}));
    await wait(180);
    saved = store.loadEqState();
    let customKeys = Object.keys(saved.customPresets);
    assert(customKeys.length === 1, 'first custom preset missing');
    assert(saved.customPresets[customKeys[0]].name === 'First custom', 'rapid rename was lost');
    assert(saved.customPresets[customKeys[0]].bands[0] === 8, 'selected custom did not auto-update');
    low.value = '7.5';
    low.dispatchEvent(new Event('input', {bubbles: true}));
    window.dispatchEvent(new Event('pagehide'));
    saved = store.loadEqState();
    assert(saved.favorites[first.id]?.bands[0] === 7.5, 'page hide did not flush the pending favorite curve');
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    assert(!document.querySelector('[data-eq-modal]'), 'Escape did not close overlay');
    assert(document.activeElement === launcher, 'focus was not restored');
    modal = overlay.openEqOverlay();
    assert(modal.querySelector('.eq-band-slider[data-index="0"]').value === '7.5', 'favorite curve did not restore');
    stateMod.setCurrentItem(second);
    assert(modal.querySelector('[data-eq-scope]').textContent === 'Global', 'second item did not load Global');
    modal.querySelector('[data-eq-act="new-preset"]').click();
    const nameTwo = modal.querySelector('[data-eq-preset-name]');
    nameTwo.value = 'Second custom';
    nameTwo.dispatchEvent(new Event('input', {bubbles: true}));
    await wait(180);
    saved = store.loadEqState();
    customKeys = Object.keys(saved.customPresets);
    assert(customKeys.length === 2, 'second custom preset missing');
    modal.querySelector('[data-eq-favorite]').click();
    await wait(20);
    assert(store.loadEqState().favorites[second.id], 'second favorite scope missing');

    localStorage.setItem(restartKey, JSON.stringify({stage: 2, global: store.loadEqState().global}));
    location.reload();
  } catch (error) {
    localStorage.removeItem(restartKey);
    const data = {passed: false, error: String(error), stack: error?.stack || ''};
    result.className = 'fail';
    result.textContent = 'FAIL - ' + error;
    await report(data);
  } finally {
    runButton.disabled = false;
  }
};

const autorun = new URLSearchParams(location.search).get('autorun') === '1';
if (autorun || localStorage.getItem(restartKey)) queueMicrotask(() => runButton.click());
</script></body></html>"""


class EqOverlayHandler(worldmedia_server.WorldMediaHandler):
    eq_result: dict | None = None

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path == "/eq-overlay-test":
            return self._send_bytes(DIAGNOSTIC_HTML, "text/html; charset=utf-8")
        if path == "/api/test/eq-result":
            return self._send_json({"ok": True, "result": type(self).eq_result})
        if path.startswith("/src/"):
            candidate = (worldmedia_server.BASE_DIR / path.lstrip("/")).resolve()
            if SOURCE_ROOT not in candidate.parents or not candidate.is_file():
                return self.send_error(404, "not found")
            content_type = "text/css; charset=utf-8" if candidate.suffix == ".css" else "text/javascript; charset=utf-8"
            return self._send_bytes(candidate.read_bytes(), content_type)
        return super().do_GET()

    def _send_bytes(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        if urllib.parse.urlsplit(self.path).path == "/api/test/eq-result":
            length = min(int(self.headers.get("Content-Length") or 0), 8192)
            try:
                value = json.loads(self.rfile.read(length))
            except (ValueError, json.JSONDecodeError):
                value = {"passed": False, "error": "invalid diagnostic result"}
            type(self).eq_result = value if isinstance(value, dict) else None
            return self._send_json({"ok": True})
        return super().do_POST()


def main() -> None:
    server = worldmedia_server.ThreadingServer(("127.0.0.1", PORT), EqOverlayHandler)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
