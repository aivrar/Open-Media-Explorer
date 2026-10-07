"""Disposable-profile browser acceptance of the exact packaged release."""
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request
import uuid
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / 'dist/Release-v0.1.3/WorldMediaWindows.exe'
SCRATCH = ROOT / 'build' / ('release-ui-' + uuid.uuid4().hex)
SCRATCH.mkdir()
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    PORT = sock.getsockname()[1]
BASE = f'http://127.0.0.1:{PORT}'
ENV = dict(os.environ, WORLDMEDIA_NO_BROWSER='1', WORLDMEDIA_WINDOWS_PORT=str(PORT),
           WORLDMEDIA_PORT=str(PORT), WORLDMEDIA_PORTABLE_ROOT=str(SCRATCH),
           WORLDMEDIA_STATE_ROOT=str(SCRATCH / 'data'))
TOKEN = ''
checks = []

def api(path, body=None):
    headers = {'Origin': BASE, 'X-WorldMedia-Token': TOKEN}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(BASE + path, headers=headers,
          data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)['data']

def start():
    global TOKEN
    process = subprocess.Popen([str(EXE)], env=ENV, cwd=SCRATCH,
        creationflags=subprocess.CREATE_NO_WINDOW)
    for _ in range(150):
        try:
            TOKEN = api('/api/v1/session')['token']
            return process
        except OSError:
            time.sleep(.2)
    raise RuntimeError('App startup timed out')

def mark(label):
    checks.append(label)
    print('PASS', label, flush=True)

process = start()
try:
    sources = ['radio-browser','iptv-org','internet-archive','nasa','wikimedia','librivox',
               'media-ccc','library-of-congress','gpodder','peertube','owncast']
    api('/api/v1/profile/preferences', {'values': {'worldmedia.settings.v1': json.dumps({
        'theme': 'dark', 'enabledSources': dict.fromkeys(sources, False)})}})
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True,
            args=['--autoplay-policy=no-user-gesture-required'])
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: print('BROWSER', message.type, message.text, flush=True) if message.type == 'warning' else None)
        page.goto(BASE)
        page.locator('.source-item[data-source="playlists"]').click()
        page.get_by_role('button', name='Add link', exact=True).click()
        page.get_by_label('Media type for new channels; playlist radio metadata overrides this').select_option('radio')
        page.get_by_label('Stream or playlist URL').fill('https://ice2.somafm.com/groovesalad-128-mp3')
        page.get_by_label('Channel or playlist name').fill('SomaFM Groove Salad')
        page.get_by_role('button', name='Add', exact=True).click()
        page.get_by_text('Channel saved. Select it below to play.', exact=True).wait_for()
        page.locator('.card-star').first.click()
        page.locator('.card-open').first.click()
        page.wait_for_function("document.querySelector('#audio-el').currentTime > 3", timeout=45000)
        mark('direct radio link, favorite, real audio playback')
        page.locator('#player-stop').click()
        page.get_by_role('button', name='Add link', exact=True).click()
        page.get_by_label('Stream or playlist URL').fill('https://somafm.com/m3u/groovesalad.m3u')
        page.get_by_label('Channel or playlist name').fill('SomaFM online playlist')
        page.get_by_label('Link type', exact=True).select_option('playlist')
        page.get_by_role('button', name='Add', exact=True).click()
        page.wait_for_function("document.querySelector('.playlist-message').textContent.includes('channels;')", timeout=30000)
        mark('online M3U import')
        page.get_by_label('Media type for new channels; playlist radio metadata overrides this').select_option('tv')
        page.locator('input[type=file]').set_input_files({'name':'Playback samples.m3u', 'mimeType':'audio/x-mpegurl', 'buffer':(
            '#EXTM3U\n#EXTINF:-1 group-title="Sample video",Big Buck Bunny HLS\n'
            'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8\n'
            '#EXTINF:-1 group-title="Sample video",Big Buck Bunny DASH\n'
            'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd\n').encode()})
        page.get_by_text('Imported 2 channels; 0 unsupported entries skipped; 0 duplicates removed.', exact=True).wait_for()
        mark('local file importer')
        for title in ['Big Buck Bunny HLS', 'Big Buck Bunny DASH']:
            card = page.locator('.card').filter(has=page.locator('.card-title', has_text=title))
            card.locator('.card-star').click()
            card.locator('.card-open').click()
            page.wait_for_function("document.querySelector('#video-el').currentTime > 3", timeout=60000)
            first = page.locator('#video-el').evaluate('(el) => el.currentTime')
            page.wait_for_function('(first) => document.querySelector("#video-el").currentTime > first + 4', arg=first, timeout=20000)
            page.locator('#player-stop').click()
            mark(title + ' real playback progresses')
        page.locator('.source-item[data-source="favorites"]').click()
        page.get_by_label('Filter saved items by media type').select_option('radio')
        assert page.locator('.card').count() == 1
        page.get_by_label('Filter saved items by media type').select_option('tv')
        assert page.locator('.card').count() == 2
        page.locator('.search-input').fill('DASH')
        page.wait_for_function("document.querySelectorAll('.card').length === 1")
        page.locator('.search-input').fill('')
        page.get_by_label('Filter saved items by media type').select_option('')
        mark('Favorites type filter and local search')
        for mode in ['tuner','grid','discovery','about','library']:
            page.locator(f'.mode-btn[data-mode="{mode}"]').click()
            page.locator(f'#{"view-host"}[data-mode="{mode}"]').wait_for()
            assert page.locator('.error-pane').count() == 0
        mark('all modes render')
        page.locator('.source-item[data-source="playlists"]').click()
        page.get_by_label('Choose an imported playlist').select_option('')
        page.get_by_role('button', name='Add link', exact=True).click()
        page.get_by_label('Stream or playlist URL').fill('https://example.com/live.m3u8')
        page.screenshot(path=str(SCRATCH / 'my-playlists.png'))
        page.set_viewport_size({'width': 960, 'height': 800})
        page.screenshot(path=str(SCRATCH / 'my-playlists-narrow.png'))
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert page.locator('.library-search-bar').evaluate('(el) => el.getBoundingClientRect().height <= innerHeight * .56')
        assert page.locator('.playlist-link-form').evaluate('(el) => [...el.querySelectorAll("input,select,button")].every(c => { const r=c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })')
        mark('wide/narrow playlist layout screenshots')
        # Test the real UI under a failed localStorage write, not only a DOM double.
        page.get_by_role('button', name='Cancel', exact=True).click()
        page.locator('.source-item[data-source="favorites"]').click()
        page.evaluate("() => { window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(k,v) { if(k === 'worldmedia.favorites.v1') throw new Error('Test quota failure'); return window.originalSetItem.call(this,k,v); }; }")
        page.locator('.card-star').first.click()
        assert page.locator('.card-star').first.get_attribute('aria-pressed') == 'true'
        assert page.locator('.persistence-notice').is_visible()
        page.evaluate('() => { Storage.prototype.setItem = window.originalSetItem; }')
        mark('visible save warning and unchanged star after write failure')
        page.locator('#shutdown-btn').click()
        assert process.wait(timeout=15) == 0
        mark('Shutdown button exits packaged process')
        context.close()
        process = start()
        context = browser.new_context()
        page = context.new_page()
        page.goto(BASE)
        page.locator('.source-item[data-source="favorites"]').click()
        page.wait_for_function("document.querySelectorAll('.card').length === 3")
        assert len(api('/api/v1/playlists')['playlists']) == 3
        mark('favorites and playlists survive native and browser restart')
        page.locator('#shutdown-btn').click()
        assert process.wait(timeout=15) == 0
        browser.close()
        assert not errors, errors
        (SCRATCH / 'result.json').write_text(json.dumps({'checks':checks, 'errors':errors}, indent=2))
        print('EVIDENCE', SCRATCH, flush=True)
finally:
    if process.poll() is None:
        try:
            api('/api/shutdown', {})
            process.wait(timeout=15)
        except Exception:
            subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'], check=False)
