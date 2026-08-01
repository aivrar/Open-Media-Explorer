"""Test-only browser harness. Never imported by the production launcher."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import worldmedia_server
from tests_python import fixture_server
from tests_python.fixture_server import MediaFixtureServer
from worldmedia_media import MediaRegistry, SafeConnector


APP_PORT = 19833
FIXTURE_PORT = 19834

DIAGNOSTIC_HTML = b"""<!doctype html><html><head><meta charset="utf-8">
<title>World Media Relay Analyser Test</title><style>
body{font:18px system-ui;background:#10151d;color:#e9f1ff;max-width:760px;margin:60px auto;padding:24px}
button{font:inherit;padding:12px 18px;border-radius:9px;border:0;background:#55d6c2;color:#07120f;font-weight:700}
#result{margin-top:24px;padding:18px;border:1px solid #526077;border-radius:10px}.pass{color:#67e8a5}.fail{color:#ff7b86}
</style></head><body><h1>World Media relay analyser test</h1>
<p>This uses cross-origin fixture media, the opaque localhost relay, real media elements, and the production EQ engine.</p>
<button id="run">Run analyser test</button><div id="result">Waiting for the required user click.</div>
<script type="module">
const result=document.querySelector('#result');
async function report(data){await fetch('/api/test/analyser-result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});}
async function register(session,item_id,url,media_type){const envelope=await (await fetch('/api/v1/media/register',{method:'POST',headers:{'Content-Type':'application/json','X-WorldMedia-Token':session.token},body:JSON.stringify({item_id,url,delivery:'on-demand',media_type,capture_headers:{}})})).json();if(!envelope.ok)throw new Error(envelope.error?.code||'registration failed');return envelope.data;}
async function waitEnded(media,timeout=5000){if(media.ended)return true;await Promise.race([new Promise((resolve,reject)=>{media.addEventListener('ended',resolve,{once:true});media.addEventListener('error',()=>reject(new Error('media error '+media.error?.code)),{once:true});}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('media timeout')),timeout))]);return media.ended;}
document.querySelector('#run').onclick=async()=>{const button=document.querySelector('#run');button.disabled=true;result.textContent='Running...';
try{const {AudioEngine}=await import('/test-audio-engine.js');const session=(await (await fetch('/api/v1/session')).json()).data;
const engine=new AudioEngine();await engine.resume({create:true});
const tone=await register(session,'browser:tone','http://127.0.0.1:19834/media/tone.wav','audio');
const audio=new Audio(tone.relay_url);await engine.attachElement(audio,{curve:{preamp:-3,bands:[12,6,0,0,0,0,0,0,0,0]}});await audio.play();const audioSignal=await engine.verifySignal(audio,{attempts:20,intervalMs:50});const peak=engine.signalRms();const audioEnded=await waitEnded(audio);audio.pause();
const direct=await register(session,'browser:video','http://127.0.0.1:19834/media/video.mp4','video');const video=document.createElement('video');video.volume=.4;video.src=direct.relay_url;const directAttach=await engine.attachElement(video);await video.play();video.pause();const pauseWorked=video.paused;await video.play();const videoSignal=await engine.verifySignal(video,{attempts:20,intervalMs:50});const videoEnded=await waitEnded(video);
video.removeAttribute('src');video.load();
const hlsRegistration=await register(session,'browser:hls','http://127.0.0.1:19834/hls/vod/index.m3u8','hls');const module=await import('/test-hls.js');const Hls=module.default||module.Hls;const hls=new Hls({enableWorker:false});hls.loadSource(hlsRegistration.relay_url);hls.attachMedia(video);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('HLS manifest timeout')),5000);hls.on(Hls.Events.MANIFEST_PARSED,()=>{clearTimeout(timer);resolve();});hls.on(Hls.Events.ERROR,(_event,data)=>{if(data.fatal){clearTimeout(timer);reject(new Error('HLS '+data.type));}});});const hlsAttach=await engine.attachElement(video);await video.play();const hlsSignal=await engine.verifySignal(video,{attempts:30,intervalMs:50});const hlsEnded=await waitEnded(video,7000);hls.destroy();
video.pause();video.removeAttribute('src');video.load();
const dashRegistration=await register(session,'browser:dash','http://127.0.0.1:19834/dash/generated/manifest.mpd','dash');const dash=await import('/test-dash.js');const dashPlayer=dash.MediaPlayer().create();dashPlayer.initialize(video,dashRegistration.relay_url,false);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('DASH manifest timeout')),7000);const ready=()=>{clearTimeout(timer);resolve();};const failed=(event)=>{clearTimeout(timer);const error=event?.error;reject(new Error(`DASH ${error?.code||'error'} ${error?.message||''} ${error?.data?.url||error?.data?.request?.url||''}`.trim()));};dashPlayer.on(dash.MediaPlayer.events.STREAM_INITIALIZED,ready);dashPlayer.on(dash.MediaPlayer.events.ERROR,failed);});const dashAttach=await engine.attachElement(video);await video.play();const dashSignal=await engine.verifySignal(video,{attempts:40,intervalMs:50});video.pause();const dashPauseWorked=video.paused;await video.play();const dashEnded=await waitEnded(video,9000);dashPlayer.destroy();
const response=[...engine.getFrequencyResponse([31,1000,16000])];const status=engine.getStatus();await engine.destroy();
const passed=audioSignal&&videoSignal&&hlsSignal&&dashSignal&&audioEnded&&videoEnded&&hlsEnded&&dashEnded&&pauseWorked&&dashPauseWorked&&status.sourceCount===2&&directAttach.sourceCreated===true&&hlsAttach.sourceCreated===false&&dashAttach.sourceCreated===false&&response[0]>2;const data={passed,peak,audioSignal,videoSignal,hlsSignal,dashSignal,audioEnded,videoEnded,hlsEnded,dashEnded,pauseWorked,dashPauseWorked,sourceCount:status.sourceCount,directSourceCreated:directAttach.sourceCreated,hlsSourceCreated:hlsAttach.sourceCreated,dashSourceCreated:dashAttach.sourceCreated,response,audioRelay:tone.relay_url,videoRelay:direct.relay_url,hlsRelay:hlsRegistration.relay_url,dashRelay:dashRegistration.relay_url};result.className=passed?'pass':'fail';result.textContent=passed?`PASS - EQ RMS ${peak.toFixed(4)}; two reusable sources; audio, video, HLS, and DASH ended`:`FAIL - ${JSON.stringify(data)}`;await report(data);
}catch(error){const data={passed:false,error:String(error)};result.className='fail';result.textContent='FAIL - '+error;await report(data);}finally{button.disabled=false;}};
if(new URLSearchParams(location.search).get('autorun')==='1')queueMicrotask(()=>document.querySelector('#run').click());
</script></body></html>"""


class BrowserRelayHandler(worldmedia_server.WorldMediaHandler):
    analyser_result: dict | None = None
    hls_javascript = (worldmedia_server.BASE_DIR / "src" / "vendor" / "hls.js").read_bytes()
    dash_javascript = (
        worldmedia_server.BASE_DIR / "node_modules" / "dashjs" / "dist" / "modern" / "esm" / "dash.all.min.js"
    ).read_bytes()
    audio_engine_javascript = (worldmedia_server.BASE_DIR / "src" / "lib" / "audio-engine.js").read_bytes()
    eq_store_javascript = (worldmedia_server.BASE_DIR / "src" / "lib" / "eq-store.js").read_bytes()

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path == "/relay-analyser-test":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(DIAGNOSTIC_HTML)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(DIAGNOSTIC_HTML)
            return
        if path == "/test-hls.js":
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(self.hls_javascript)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(self.hls_javascript)
            return
        if path == "/test-dash.js":
            body = self.dash_javascript
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/test-audio-engine.js":
            body = self.audio_engine_javascript
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/eq-store.js":
            body = self.eq_store_javascript
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/test/analyser-result":
            return self._send_json({"ok": True, "result": type(self).analyser_result})
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if urllib.parse.urlsplit(self.path).path == "/api/test/analyser-result":
            length = min(int(self.headers.get("Content-Length") or 0), 4096)
            try:
                value = json.loads(self.rfile.read(length))
            except (ValueError, json.JSONDecodeError):
                value = {"passed": False, "error": "invalid diagnostic result"}
            type(self).analyser_result = value if isinstance(value, dict) else None
            return self._send_json({"ok": True})
        return super().do_POST()


def prepare_browser_media(directory: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("FFmpeg is required only for the browser diagnostic harness")
    mp4 = directory / "browser.mp4"
    segment = directory / "browser-segment0.ts"
    dash_directory = directory / "dash"
    dash_directory.mkdir()
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=blue:s=96x54:r=10",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
        "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "40",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "24k", "-movflags", "+faststart", str(mp4),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=green:s=96x54:r=10",
        "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=8000",
        "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "40",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "24k",
        "-f", "mpegts", str(segment),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    subprocess.run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=purple:s=96x54:r=10",
        "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=8000",
        "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "40",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "24k",
        "-f", "dash", "-seg_duration", "1", "-use_template", "1", "-use_timeline", "1",
        str(dash_directory / "manifest.mpd"),
    ], check=True, cwd=dash_directory, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    fixture_server.VIDEO_BYTES = mp4.read_bytes()
    fixture_server.SEGMENT_BYTES = segment.read_bytes()
    fixture_server.DASH_FILES = {
        f"/dash/generated/{path.name}": (
            path.read_bytes(),
            "application/dash+xml" if path.suffix == ".mpd" else "video/iso.segment",
        )
        for path in dash_directory.iterdir() if path.is_file()
    }


def main() -> None:
    connector = SafeConnector(address_policy=lambda address: address in {"127.0.0.1", "::1"})
    worldmedia_server.MEDIA_REGISTRY = MediaRegistry(connector, ttl_seconds=300)
    with tempfile.TemporaryDirectory(prefix="worldmedia-browser-relay-") as temp:
        prepare_browser_media(Path(temp))
        with MediaFixtureServer(FIXTURE_PORT):
            server = worldmedia_server.ThreadingServer(
                ("127.0.0.1", APP_PORT), BrowserRelayHandler
            )
            try:
                server.serve_forever()
            finally:
                worldmedia_server.shutdown_services(timeout=1)
                server.server_close()


if __name__ == "__main__":
    main()
