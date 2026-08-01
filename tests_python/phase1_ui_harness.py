"""Isolated real-browser stress harness for Phase 1 catalog orchestration.

The harness serves the exact hashed production frontend and intercepts only
Radio Browser metadata requests with a deterministic local catalog.  It is not
part of the shipped server.  Callers must launch Edge with a disposable user
data directory; the seed script also labels and verifies its synthetic
favorites so the normal World Media profile is never read or changed.
"""
from __future__ import annotations

import json
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import worldmedia_server


APP_PORT = 19838
CATALOG_SIZE = 1_200

SEED_SCRIPT = """
<script>
(() => {
  // This page is launched only with a fresh, disposable Edge profile.  These
  // two records are test sentinels, never copies of the user's real favorites.
  const favorite = (id, title) => ({
    id, title, description: 'Phase 1 isolated favorite sentinel.',
    source: 'internet-archive', type: 'audio', stream_url: '',
    stream_kind: 'audio', delivery: 'on-demand', download_url: '',
    download_name: '', capture_headers: {}, thumbnail: '', year: 2026,
    country: 'US', language: 'en', tags: ['phase1-test'],
    license: 'Test fixture', source_url: 'https://example.invalid/phase1',
    content_rating: 'unrated', phase1_sentinel: true,
  });
  localStorage.clear();
  localStorage.setItem('worldmedia.favorites.v1', JSON.stringify([
    favorite('phase1-favorite:one', 'Phase 1 Favorite One'),
    favorite('phase1-favorite:two', 'Phase 1 Favorite Two'),
  ]));
  localStorage.setItem('worldmedia.settings.v1', JSON.stringify({
    version: 1, theme: 'dark', defaultMode: 'library',
    recordingQuality: 'balanced',
    enabledSources: {
      'radio-browser': true, 'iptv-org': false,
      'internet-archive': false, 'nasa': false,
      'wikimedia': false, 'librivox': false,
      'media-ccc': false, 'library-of-congress': false,
      'gpodder': false, 'peertube': false, 'owncast': false,
    },
    showExplicitContent: false,
  }));
  window.__phase1Audit = { errors: [] };
  window.addEventListener('error', (event) => {
    window.__phase1Audit.errors.push(String(event.error || event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    window.__phase1Audit.errors.push(String(event.reason));
  });
})();
</script>
"""

AUDIT_SCRIPT = """
<script type="module">
const audit = window.__phase1Audit;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
async function until(predicate, message, timeout = 12000) {
  const end = performance.now() + timeout;
  let lastError = null;
  while (performance.now() < end) {
    try { const value = await predicate(); if (value) return value; }
    catch (error) { lastError = error; }
    await wait(40);
  }
  throw new Error(message + (lastError ? ` (${lastError})` : ''));
}
async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}
async function post(url, value = {}) {
  return jsonFetch(url, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(value),
  });
}
async function stats() { return (await jsonFetch('/api/test/phase1-stats')).stats; }
async function report(value) { await post('/api/test/phase1-result', value); }
function sourceCount() {
  const text = document.querySelector('.source-item[data-source="radio-browser"] [data-role="count"]')?.textContent || '';
  return Number(text.trim() || 0);
}
function setInput(element, value) {
  element.value = value;
  element.dispatchEvent(new Event('input', {bubbles: true}));
}
function sourceCheckbox() {
  return document.querySelector('[data-settings-modal] input[data-source="radio-browser"]');
}
async function openSettings() {
  document.querySelector('#settings-btn').click();
  return until(() => document.querySelector('[data-settings-modal]'), 'Settings did not open');
}
async function closeSettings() {
  document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  await until(() => !document.querySelector('[data-settings-modal]'), 'Settings did not close');
}
function assertSyntheticFavorites() {
  const favorites = JSON.parse(localStorage.getItem('worldmedia.favorites.v1') || '[]');
  assert(favorites.length === 2, 'Synthetic favorite count changed');
  assert(favorites[0].id === 'phase1-favorite:one' && favorites[1].id === 'phase1-favorite:two',
    'Synthetic favorite identity or order changed');
  assert(favorites.every((item) => item.phase1_sentinel === true),
    'Unknown favorite metadata was not preserved');
  return favorites.length;
}

function percentile(values, ratio) {
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1));
  return ordered[index] || 0;
}

async function measureScrollFrames(scroller, frames = 36) {
  const gaps = [];
  let previous = performance.now();
  for (let index = 0; index < frames; index++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const now = performance.now();
    gaps.push(now - previous);
    previous = now;
    scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight)
      * (index / Math.max(1, frames - 1)));
  }
  return percentile(gaps.slice(2), 0.95);
}

async function run() {
  const checks = [];
  const metrics = {domCardMax: 0};
  const runStarted = performance.now();
  try {
    await until(() => document.querySelector('.library-root'), 'Library did not boot');
    assert(document.querySelector('.library-sidebar'), 'Library sidebar is missing');
    const expectedSourceIds = [
      'radio-browser', 'iptv-org', 'internet-archive', 'nasa', 'wikimedia', 'librivox',
      'media-ccc', 'library-of-congress', 'gpodder', 'peertube', 'owncast',
    ];
    const directRows = expectedSourceIds.filter((id) =>
      document.querySelector(`.source-item[data-source="${id}"]`));
    assert(directRows.length === expectedSourceIds.length,
      'Production sidebar did not render all eleven registry sources');
    await until(() => document.querySelector('.cards-grid .card'), 'First catalog card did not render');
    metrics.firstCardMs = performance.now() - runStarted;
    await openSettings();
    const settingsSources = document.querySelectorAll(
      '[data-settings-modal] input[data-source]');
    assert(settingsSources.length === expectedSourceIds.length,
      'Settings did not render exactly eleven registry source switches');
    await closeSettings();
    checks.push('eleven-source-registry-ui');
    await until(() => sourceCount() >= 60, 'Initial scheduled catalog pages did not arrive');
    metrics.domCardMax = Math.max(metrics.domCardMax,
      document.querySelectorAll('.cards-grid .card').length);
    assert(metrics.domCardMax <= 300,
      'Initial mounted card ceiling exceeded 300');
    checks.push('scheduled-initial-load', 'initial-dom-ceiling');

    // Override visibility only inside this disposable page so the production
    // visibility listener is exercised deterministically in headless Edge.
    let hidden = true;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get: () => hidden ? 'hidden' : 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    const hiddenBefore = await stats();
    await wait(900);
    const hiddenAfter = await stats();
    assert(hiddenAfter.station_calls - hiddenBefore.station_calls <= 1,
      'Hidden page continued low-priority prefetch work');
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await until(async () => (await stats()).station_calls > hiddenAfter.station_calls,
      'Visible page did not resume queued catalog work');
    checks.push('visibility-pause-resume');

    // Quiesce the prefetch lane, make both adapter attempts return 429, then
    // verify the failure remains retryable instead of becoming exhaustion.
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await until(async () => (await stats()).active === 0, 'Catalog did not quiesce while hidden');
    await post('/api/test/phase1-fail-next', {count: 2});
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await until(() => document.querySelector('.results-status')?.textContent.includes('rate limited'),
      '429 did not become a rate-limited status', 10000);
    const countAtRateLimit = sourceCount();
    const retryButton = await until(() => {
      const button = document.querySelector('.sentinel-loadmore-btn');
      return button && button.textContent.includes('Retry') && button;
    }, 'Retry action was not exposed after 429');
    retryButton.click();
    await until(() => sourceCount() > countAtRateLimit, 'User retry did not resume the same cursor');
    assert(!document.querySelector('.results-status')?.textContent.includes('complete'),
      '429 was incorrectly represented as finite completion');
    checks.push('rate-limit-retry-no-false-exhaustion');

    await until(() => sourceCount() >= 900, 'Continuous prefetch did not reach its measured accumulation range', 20000);
    metrics.domCardMax = Math.max(metrics.domCardMax,
      document.querySelectorAll('.cards-grid .card').length);
    assert(metrics.domCardMax <= 300,
      'Mounted cards exceeded 300 after long catalog accumulation');
    const resultScroller = document.querySelector('.results');
    metrics.scrollFrameP95Ms = await measureScrollFrames(resultScroller);
    assert(metrics.scrollFrameP95Ms < 250,
      `Scroll frame p95 exceeded 250 ms: ${metrics.scrollFrameP95Ms}`);
    const firstBefore = document.querySelector('.cards-grid .card')?.dataset.id;
    resultScroller.scrollTop = resultScroller.scrollHeight;
    resultScroller.dispatchEvent(new Event('scroll', {bubbles: true}));
    const back = await until(() => {
      const button = document.querySelector('.results-window-back');
      return button && button.style.display !== 'none' && button;
    }, 'Sliding render window did not advance at the bottom', 10000);
    const firstAfter = document.querySelector('.cards-grid .card')?.dataset.id;
    assert(firstAfter && firstAfter !== firstBefore, 'Sliding window retained the same first card');
    assert(document.querySelectorAll('.cards-grid .card').length <= 300,
      'Sliding render window exceeded 300 mounted cards');
    back.click();
    await until(() => document.querySelector('.cards-grid .card')?.dataset.id !== firstAfter,
      'Show earlier items did not rewind the sliding window');
    checks.push('long-scroll-sliding-window');

    const queryCallsBefore = (await stats()).queries.length;
    const search = document.querySelector('.search-input');
    const searchStarted = performance.now();
    setInput(search, 'alpha');
    await wait(40);
    setInput(search, 'beta');
    await wait(40);
    setInput(search, 'gamma');
    await until(() => document.querySelector('.card-title')?.textContent.includes('Gamma'),
      'Final rapid search did not render partial results');
    metrics.rapidSearchMs = performance.now() - searchStarted;
    const rapidQueries = (await stats()).queries.slice(queryCallsBefore);
    assert(rapidQueries.includes('gamma'), 'Final rapid query was not requested');
    assert(!rapidQueries.includes('alpha') && !rapidQueries.includes('beta'),
      'Debounced intermediate queries reached the provider');
    assert(document.querySelectorAll('.cards-grid .card').length <= 300,
      'Search results exceeded the mounted card ceiling');
    checks.push('rapid-search-debounce-partial-render');

    await post('/api/test/phase1-fail-next', {count: 2});
    setInput(search, 'rate-search');
    await until(() => document.querySelector('.results-status')?.textContent.includes('rate limited'),
      'Failed text search did not expose a retryable rate-limit state');
    const searchRetry = await until(() => {
      const button = document.querySelector('.sentinel-loadmore-btn');
      return button && button.textContent.includes('Retry') && button;
    }, 'Failed text search did not expose Retry now');
    searchRetry.click();
    await until(() => document.querySelector('.card-title')?.textContent.includes('Rate Search'),
      'Retry now did not repeat the active text query');
    const rateSearchCalls = (await stats()).queries.filter((query) => query === 'rate-search');
    assert(rateSearchCalls.length === 3,
      'Text-search retry did not preserve both failed attempts and one successful retry');
    assert(document.querySelector('.sentinel-status')?.textContent.includes('search results loaded'),
      'Bounded search page was not labeled honestly');
    checks.push('text-search-rate-limit-retry');

    const callsBeforeTab = (await stats()).queries.length;
    setInput(search, 'return-after-tab');
    document.querySelector('.mode-btn[data-mode="tuner"]').click();
    await until(() => document.querySelector('#view-host')?.dataset.mode === 'tuner',
      'Tuner did not render');
    await wait(650);
    assert(!(await stats()).queries.slice(callsBeforeTab).includes('return-after-tab'),
      'Canceled debounce ran while Library was inactive');
    document.querySelector('.mode-btn[data-mode="library"]').click();
    await until(() => document.querySelector('.library-sidebar'),
      'Library sidebar disappeared after tab return');
    await until(() => (stats()).then((value) => value.queries.includes('return-after-tab')),
      'Pending query was not reconnected when Library returned');
    await until(() => document.querySelector('.card-title')?.textContent.includes('Return After Tab'),
      'Returned Library did not render the preserved query');
    checks.push('tab-cancel-and-resume', 'sidebar-restoration');

    setInput(search, '');
    await until(() => document.querySelector('.card-title')?.textContent.includes('Browse'),
      'Clearing search did not restore the accumulated browse pool');

    // Disable/re-enable once normally, then disable a deliberately delayed
    // in-flight page.  Its stale completion must not repopulate the UI.
    await openSettings();
    let checkbox = sourceCheckbox();
    assert(checkbox?.checked, 'Radio Browser switch was not enabled');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', {bubbles: true}));
    await closeSettings();
    await until(() => document.querySelector('.source-item[data-source="radio-browser"]')
      ?.getAttribute('aria-disabled') === 'true', 'Disabled source did not update sidebar state');
    const callsAtDisable = (await stats()).station_calls;
    await wait(500);
    assert((await stats()).station_calls === callsAtDisable,
      'Disabled source continued scheduling catalog requests');

    await post('/api/test/phase1-delay-next', {delay_ms: 1200});
    await openSettings();
    checkbox = sourceCheckbox();
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', {bubbles: true}));
    await closeSettings();
    const startOrButton = await until(async () => {
      if ((await stats()).active > 0) return 'active';
      const button = document.querySelector('.sentinel-loadmore-btn');
      return button && button.style.display !== 'none'
        && button.textContent.includes('Load more') ? button : null;
    }, 'Re-enabled source exposed neither work nor the bounded-prefetch action');
    if (startOrButton !== 'active') startOrButton.click();
    await until(async () => (await stats()).active > 0, 'Re-enabled source did not start work');
    await openSettings();
    checkbox = sourceCheckbox();
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', {bubbles: true}));
    await closeSettings();
    const disabledCallCount = (await stats()).station_calls;
    await wait(1500);
    assert((await stats()).delay_remaining === 0,
      'Delayed fixture request was never consumed by the re-enabled source');
    assert(document.querySelector('.source-item[data-source="radio-browser"]')
      ?.getAttribute('aria-disabled') === 'true', 'Source did not remain disabled');
    assert((await stats()).station_calls === disabledCallCount,
      'A stale completion scheduled more work after source cancellation');
    assert(document.querySelectorAll('.cards-grid .card').length === 0,
      'Disabled-source results remained visible after cancellation');
    checks.push('disable-reenable-cancel-stale-completion');

    const favoriteCount = assertSyntheticFavorites();
    assert(audit.errors.length === 0, `Unhandled browser errors: ${audit.errors.join(' | ')}`);
    checks.push('favorite-preservation', 'no-unhandled-errors');
    await report({
      passed: true, checks, favoriteCount, metrics,
      stats: await stats(),
      exactBundle: document.querySelector('script[src*="/assets/index-"]')?.getAttribute('src') || '',
    });
  } catch (error) {
    await report({
      passed: false, checks, error: String(error), stack: error?.stack || '',
      browserErrors: audit.errors, stats: await stats().catch(() => null),
    });
  }
}
run();
</script>
"""


def _injected_index() -> bytes:
    html = (worldmedia_server.ROOT / "index.html").read_text(encoding="utf-8")
    marker = '<script type="module" crossorigin src="/assets/index-'
    if marker not in html:
        raise RuntimeError("production index entrypoint marker was not found")
    html = html.replace(marker, SEED_SCRIPT + "\n    " + marker, 1)
    if "</body>" not in html:
        raise RuntimeError("production index body marker was not found")
    return html.replace("</body>", AUDIT_SCRIPT + "\n  </body>", 1).encode("utf-8")


class Phase1UiHandler(worldmedia_server.WorldMediaHandler):
    """Test-only handler with a deterministic Radio Browser upstream."""

    ui_result: dict | None = None
    injected_index = _injected_index()
    state_lock = threading.Lock()
    station_calls = 0
    active = 0
    max_active = 0
    failures_remaining = 0
    delay_remaining = 0
    delay_ms = 0
    queries: list[str] = []
    offsets: list[int] = []

    @classmethod
    def reset(cls) -> None:
        with cls.state_lock:
            cls.ui_result = None
            cls.station_calls = 0
            cls.active = 0
            cls.max_active = 0
            cls.failures_remaining = 0
            cls.delay_remaining = 0
            cls.delay_ms = 0
            cls.queries = []
            cls.offsets = []

    @classmethod
    def snapshot(cls) -> dict:
        with cls.state_lock:
            return {
                "station_calls": cls.station_calls,
                "active": cls.active,
                "max_active": cls.max_active,
                "failures_remaining": cls.failures_remaining,
                "delay_remaining": cls.delay_remaining,
                "queries": list(cls.queries),
                "offsets": list(cls.offsets),
            }

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/phase1-ui-test":
            return self._send_bytes(self.injected_index, "text/html; charset=utf-8")
        if parsed.path == "/api/test/phase1-result":
            return self._send_json({"ok": True, "result": type(self).ui_result})
        if parsed.path == "/api/test/phase1-stats":
            return self._send_json({"ok": True, "stats": type(self).snapshot()})
        if parsed.path == "/api/proxy":
            return self._handle_fake_proxy(parsed.query)
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path not in {
            "/api/test/phase1-result",
            "/api/test/phase1-fail-next",
            "/api/test/phase1-delay-next",
        }:
            return super().do_POST()
        value = self._read_test_json()
        cls = type(self)
        if path == "/api/test/phase1-result":
            cls.ui_result = value if isinstance(value, dict) else None
        elif path == "/api/test/phase1-fail-next":
            with cls.state_lock:
                cls.failures_remaining = max(0, min(10, int(value.get("count", 2))))
        else:
            with cls.state_lock:
                cls.delay_remaining = 1
                cls.delay_ms = max(0, min(5_000, int(value.get("delay_ms", 1_200))))
        return self._send_json({"ok": True})

    def _read_test_json(self) -> dict:
        length = min(int(self.headers.get("Content-Length") or 0), 65_536)
        try:
            value = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def _handle_fake_proxy(self, query: str) -> None:
        try:
            values = urllib.parse.parse_qs(
                query, keep_blank_values=True, strict_parsing=True, max_num_fields=1,
            )
            target = urllib.parse.urlsplit(values["url"][0])
        except (KeyError, IndexError, ValueError):
            return self._send_raw_json(
                {"error": "invalid fake proxy target"}, HTTPStatus.BAD_REQUEST,
            )

        if target.netloc == "all.api.radio-browser.info" and target.path == "/json/servers":
            return self._send_raw_json([{"name": "fixture.radio.invalid"}])
        if target.netloc == "fixture.radio.invalid" and target.path == "/json/stats":
            return self._send_raw_json({"status": "OK"})
        if target.netloc != "fixture.radio.invalid" or target.path != "/json/stations/search":
            return self._send_raw_json(
                {"error": "unexpected fake proxy target"}, HTTPStatus.NOT_FOUND,
            )

        params = urllib.parse.parse_qs(target.query, keep_blank_values=True)
        limit = max(1, min(100, int(params.get("limit", ["30"])[0])))
        offset = max(0, int(params.get("offset", ["0"])[0]))
        query_text = params.get("name", [""])[0].strip()
        cls = type(self)
        with cls.state_lock:
            cls.station_calls += 1
            cls.active += 1
            cls.max_active = max(cls.max_active, cls.active)
            cls.offsets.append(offset)
            if query_text:
                cls.queries.append(query_text)
            should_fail = cls.failures_remaining > 0
            if should_fail:
                cls.failures_remaining -= 1
            should_delay = cls.delay_remaining > 0
            delay_ms = cls.delay_ms if should_delay else 0
            if should_delay:
                cls.delay_remaining -= 1

        try:
            if delay_ms:
                time.sleep(delay_ms / 1_000)
            if should_fail:
                return self._send_raw_json(
                    {"error": "fixture rate limit"},
                    HTTPStatus.TOO_MANY_REQUESTS,
                    {"Retry-After": "1"},
                )
            available = limit if query_text else max(0, min(limit, CATALOG_SIZE - offset))
            slug = "-".join(query_text.lower().split()) or "browse"
            title = query_text.replace("-", " ").title() or "Browse"
            items = []
            for index in range(available):
                number = offset + index
                items.append({
                    "stationuuid": f"fixture-{slug}-{number:05d}",
                    "name": f"{title} Station {number:04d}",
                    "url_resolved": f"https://streams.example.invalid/{slug}/{number}.mp3",
                    "homepage": "https://example.invalid/radio",
                    "favicon": "",
                    "tags": "phase1,test",
                    "countrycode": "US",
                    "languagecodes": "en",
                    "hls": 0,
                    "clickcount": CATALOG_SIZE - number,
                })
            return self._send_raw_json(items)
        finally:
            with cls.state_lock:
                cls.active = max(0, cls.active - 1)

    def _send_raw_json(
        self,
        payload,
        status: HTTPStatus = HTTPStatus.OK,
        headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
            self.wfile.flush()

    def _send_bytes(self, body: bytes, content_type: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()


def main() -> None:
    Phase1UiHandler.reset()
    server = worldmedia_server.ThreadingServer(("127.0.0.1", APP_PORT), Phase1UiHandler)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        worldmedia_server.shutdown_services(timeout=1)


if __name__ == "__main__":
    main()
