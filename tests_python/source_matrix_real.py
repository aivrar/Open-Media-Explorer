"""Opt-in current public-source relay matrix; excluded from unit discovery."""
from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import worldmedia_server
from worldmedia_media import MediaRegistry, SafeConnector


FFPROBE = shutil.which("ffprobe.exe") or shutil.which("ffprobe")
USER_AGENT = "WorldMediaWindows/0.1.2 phase11 matrix"


def fetch_json(url: str, timeout: float = 60) -> object:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def public_label(url: str) -> dict[str, str]:
    parsed = urllib.parse.urlsplit(url)
    suffix = Path(parsed.path).suffix.lower()[:12]
    return {"scheme": parsed.scheme, "host": parsed.hostname or "", "suffix": suffix}


def probe(registry: MediaRegistry, origin: str, category: str, sample: dict,
          expected_kind: str) -> tuple[dict | None, str]:
    url = sample["url"]
    registration = registry.register({
        "item_id": f"phase11:{category}", "url": url,
        "delivery": sample.get("delivery", "live"),
        "media_type": sample["media_type"], "capture_headers": sample.get("headers", {}),
        "title": f"Phase 11 {category}", "source": sample["source"], "download_name": "",
    })
    relay_url = f"{origin}/api/v1/media/{registration.token}"
    command = [
        FFPROBE, "-v", "error", "-rw_timeout", "8000000", "-seekable", "0",
        "-analyzeduration", "4000000", "-probesize", "4000000",
        "-show_entries", "stream=codec_type,codec_name", "-of", "json", relay_url,
    ]
    try:
        completed = subprocess.run(
            command, check=False, capture_output=True, text=True, timeout=14, shell=False,
        )
        if completed.returncode != 0:
            return None, f"ffprobe exit {completed.returncode}"
        streams = json.loads(completed.stdout or "{}").get("streams", [])
        if not any(stream.get("codec_type") == expected_kind for stream in streams):
            return None, f"no {expected_kind} stream"
        return {
            "category": category, "status": "passed", **public_label(url),
            "headers": sorted(sample.get("headers", {})),
            "streams": [
                {"type": stream.get("codec_type"), "codec": stream.get("codec_name")}
                for stream in streams
            ],
        }, ""
    except subprocess.TimeoutExpired:
        return None, "ffprobe timeout"
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return None, type(error).__name__
    finally:
        registry.expire(registration.token)


def first_working(registry: MediaRegistry, origin: str, category: str,
                  candidates: list[dict], expected_kind: str, attempts: int = 12) -> tuple[dict, list[dict]]:
    failures: list[dict] = []
    pool = candidates[:]
    random.Random(11).shuffle(pool)
    for sample in pool[:attempts]:
        try:
            result, error = probe(registry, origin, category, sample, expected_kind)
        except Exception as exc:  # SafeConnector/API rejection is valid matrix evidence.
            result, error = None, type(exc).__name__
        if result:
            result["attempts"] = len(failures) + 1
            return result, failures
        failures.append({"category": category, **public_label(sample["url"]), "error": error})
    return {
        "category": category, "status": "expected-upstream-failure",
        "attempts": len(failures), "reason": failures[-1]["error"] if failures else "no candidates",
    }, failures


def radio_samples() -> dict[str, list[dict]]:
    query = urllib.parse.urlencode({
        "hidebroken": "true", "limit": 1000, "order": "clickcount", "reverse": "true",
    })
    stations = fetch_json(f"https://de1.api.radio-browser.info/json/stations/search?{query}")
    if not isinstance(stations, list):
        raise RuntimeError("Radio Browser returned an invalid catalog")

    def item(station: dict) -> dict:
        return {
            "source": "radio-browser", "url": station.get("url_resolved") or station.get("url"),
            "media_type": "hls" if int(station.get("hls") or 0) == 1 else "audio", "headers": {},
        }

    valid = [station for station in stations if isinstance(station, dict)
             and isinstance(station.get("url_resolved") or station.get("url"), str)]
    return {
        "radio-http-mp3": [item(s) for s in valid if item(s)["url"].startswith("http://")
                           and str(s.get("codec") or "").upper() == "MP3" and int(s.get("hls") or 0) == 0],
        "radio-https-aac": [item(s) for s in valid if item(s)["url"].startswith("https://")
                            and "AAC" in str(s.get("codec") or "").upper() and int(s.get("hls") or 0) == 0],
        "radio-hls": [item(s) for s in valid if int(s.get("hls") or 0) == 1],
    }


def iptv_samples() -> dict[str, list[dict]]:
    streams = fetch_json("https://iptv-org.github.io/api/streams.json")
    if not isinstance(streams, list):
        raise RuntimeError("iptv-org returned an invalid catalog")

    def item(stream: dict) -> dict:
        url = stream.get("url")
        headers = {}
        referer = stream.get("http_referrer") or stream.get("referrer")
        if isinstance(referer, str) and referer:
            headers["referer"] = referer
        user_agent = stream.get("user_agent")
        if isinstance(user_agent, str) and user_agent:
            headers["userAgent"] = user_agent
        return {
            "source": "iptv-org", "url": url,
            "media_type": "dash" if ".mpd" in url.lower() else "hls", "headers": headers,
        }

    valid = [stream for stream in streams if isinstance(stream, dict)
             and isinstance(stream.get("url"), str) and stream["url"].startswith(("http://", "https://"))]
    hls = [s for s in valid if ".m3u8" in s["url"].lower()]
    return {
        "iptv-ordinary-hls": [item(s) for s in hls if not item(s)["headers"] and s["url"].startswith("https://")],
        "iptv-required-referer": [item(s) for s in valid if item(s)["headers"].get("referer")],
        "iptv-required-user-agent": [item(s) for s in valid if item(s)["headers"].get("userAgent")],
        "iptv-http-hls": [item(s) for s in hls if s["url"].startswith("http://")],
        "iptv-dash": [item(s) for s in valid if ".mpd" in s["url"].lower()],
    }


def on_demand_samples() -> tuple[dict[str, list[dict]], list[dict]]:
    categories: dict[str, list[dict]] = {
        "archive-audio": [{
            "source": "internet-archive", "delivery": "on-demand", "media_type": "audio",
            "url": "https://www.archive.org/download/count_monte_cristo_0711_librivox/"
                   "count_of_monte_cristo_001_dumas_64kb.mp3", "headers": {},
        }],
        "archive-video": [{
            "source": "internet-archive", "delivery": "on-demand", "media_type": "video",
            "url": url, "headers": {},
        } for url in (
            "https://archive.org/download/HealthYo1953/HealthYo1953.mp4",
            "https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4",
            "https://archive.org/download/BigBuckBunny_328/BigBuckBunny_512kb.mp4",
            "https://archive.org/download/Sita_Sings_the_Blues/Sita_Sings_the_Blues_DVD_NTSC4.mp4",
        )],
        "nasa-audio": [{
            "source": "nasa", "delivery": "on-demand", "media_type": "audio",
            "url": "https://images-assets.nasa.gov/audio/Ep411_CHAPEA_2_AudioLog_1/"
                   "Ep411_CHAPEA_2_AudioLog_1~orig.mp3", "headers": {},
        }],
        "wikimedia-audio": [{
            "source": "wikimedia", "delivery": "on-demand", "media_type": "audio",
            "url": "https://upload.wikimedia.org/wikipedia/commons/7/7e/"
                   "Speech_of_John_Hossack_by_John_Hossack_as_read_by_Veronica_Jenkins_for_LibriVox_%282011%29.ogg",
            "headers": {},
        }],
        "librivox-chapter": [{
            "source": "librivox", "delivery": "on-demand", "media_type": "audio",
            "url": "https://www.archive.org/download/count_monte_cristo_0711_librivox/"
                   "count_of_monte_cristo_001_dumas_64kb.mp3", "headers": {},
        }],
    }

    nasa = fetch_json("https://images-api.nasa.gov/search?q=earth&media_type=video&page_size=40")
    nasa_video: list[dict] = []
    for item in nasa.get("collection", {}).get("items", []) if isinstance(nasa, dict) else []:
        # The item href is the asset collection; links[0] is normally only a JPEG preview.
        href = item.get("href") if isinstance(item, dict) else ""
        if not isinstance(href, str) or not href.startswith("https://"):
            continue
        try:
            assets = fetch_json(href, timeout=20)
        except Exception:
            continue
        urls = assets if isinstance(assets, list) else []
        for url in urls:
            if isinstance(url, str) and urllib.parse.urlsplit(url).path.lower().endswith((".mp4", ".webm")):
                nasa_video.append({
                    "source": "nasa", "delivery": "on-demand", "media_type": "video",
                    "url": url, "headers": {},
                })
                break
        if len(nasa_video) >= 8:
            break
    categories["nasa-video"] = nasa_video

    wiki_query = urllib.parse.urlencode({
        "action": "query", "generator": "search", "gsrsearch": "filetype:video",
        "gsrnamespace": "6", "gsrlimit": "50", "prop": "imageinfo",
        "iiprop": "url|mime|size", "format": "json", "origin": "*",
    })
    wikimedia = fetch_json(f"https://commons.wikimedia.org/w/api.php?{wiki_query}")
    wiki_video: list[dict] = []
    pages = wikimedia.get("query", {}).get("pages", {}) if isinstance(wikimedia, dict) else {}
    for page in pages.values() if isinstance(pages, dict) else []:
        info = page.get("imageinfo", [{}])[0] if isinstance(page, dict) else {}
        url = info.get("url") if isinstance(info, dict) else ""
        mime = info.get("mime") if isinstance(info, dict) else ""
        if isinstance(url, str) and mime in {"video/webm", "video/mp4"}:
            wiki_video.append({
                "source": "wikimedia", "delivery": "on-demand", "media_type": "video",
                "url": url, "headers": {},
            })
    categories["wikimedia-video"] = wiki_video

    books = fetch_json(
        "https://librivox.org/api/feed/audiobooks/?title=Count%20of%20Monte%20Cristo&format=json&limit=10"
    )
    zip_samples: list[dict] = [{
        "source": "librivox", "delivery": "on-demand", "media_type": "audio",
        "url": "https://archive.org/download/count_monte_cristo_0711_librivox/"
               "count_monte_cristo_0711_librivox_chapters1-39_64kb_mp3.zip",
        "headers": {},
    }]
    for book in books.get("books", []) if isinstance(books, dict) else []:
        url = book.get("url_zip_file") if isinstance(book, dict) else ""
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            zip_samples.append({
                "source": "librivox", "delivery": "on-demand", "media_type": "audio",
                "url": url, "headers": {},
            })
    return categories, zip_samples


def probe_zip(registry: MediaRegistry, origin: str, samples: list[dict]) -> dict:
    failures = []
    for sample in samples[:8]:
        registration = None
        try:
            registration = registry.register({
                "item_id": "phase11:librivox-zip", "url": sample["url"],
                "delivery": "on-demand", "media_type": "audio", "capture_headers": {},
                "title": "Phase 11 LibriVox ZIP", "source": "librivox", "download_name": "book.zip",
            })
            request = urllib.request.Request(
                f"{origin}/api/v1/media/{registration.token}", headers={"Range": "bytes=0-15"},
            )
            with urllib.request.urlopen(request, timeout=20) as response:
                head = response.read(16)
                status = response.status
            if status in {200, 206} and head.startswith(b"PK"):
                return {
                    "category": "librivox-zip", "status": "passed",
                    **public_label(sample["url"]), "bytes_checked": len(head),
                }
            failures.append(f"status {status} magic {head[:2].hex()}")
        except Exception as error:
            failures.append(type(error).__name__)
        finally:
            if registration:
                registry.expire(registration.token)
    return {
        "category": "librivox-zip", "status": "expected-upstream-failure",
        "attempts": len(failures), "reason": failures[-1] if failures else "no candidates",
    }


def main() -> int:
    if os.environ.get("WORLDMEDIA_SOURCE_MATRIX") != "1":
        print("Set WORLDMEDIA_SOURCE_MATRIX=1 to probe current public streams.")
        return 2
    if not FFPROBE:
        print("ffprobe must be available on PATH.")
        return 2

    old_registry = worldmedia_server.MEDIA_REGISTRY
    registry = MediaRegistry(SafeConnector(idle_timeout=10), ttl_seconds=300)
    worldmedia_server.MEDIA_REGISTRY = registry
    server = worldmedia_server.ThreadingServer(("127.0.0.1", 0), worldmedia_server.WorldMediaHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    results: list[dict] = []
    failures: list[dict] = []
    relay_entries_after_cleanup = -1
    try:
        origin = f"http://127.0.0.1:{server.server_port}"
        on_demand, zip_samples = on_demand_samples()
        categories = {**radio_samples(), **iptv_samples(), **on_demand}
        for category, candidates in categories.items():
            expected = "audio" if (
                category.startswith("radio-")
                or category.endswith("-audio")
                or category == "librivox-chapter"
            ) else "video"
            attempts = 24 if category == "iptv-dash" else 12
            result, rejected = first_working(
                registry, origin, category, candidates, expected, attempts=attempts,
            )
            result["catalog_candidates"] = len(candidates)
            results.append(result)
            failures.extend(rejected)
        results.append(probe_zip(registry, origin, zip_samples))
    finally:
        registry.clear()
        relay_entries_after_cleanup = len(registry._entries) + len(registry._dash_templates)
        server.shutdown(); server.server_close(); thread.join(timeout=2)
        worldmedia_server.MEDIA_REGISTRY = old_registry

    broken = failures[0] if failures else {"status": "none encountered"}
    report = {
        "results": results,
        "broken_channel_evidence": broken,
        "relay_entries_after_cleanup": relay_entries_after_cleanup,
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    required = {
        "radio-http-mp3", "radio-https-aac", "radio-hls", "iptv-ordinary-hls",
        "iptv-required-referer", "iptv-required-user-agent", "iptv-http-hls", "iptv-dash",
        "archive-audio", "archive-video", "nasa-audio", "nasa-video",
        "wikimedia-audio", "wikimedia-video", "librivox-chapter", "librivox-zip",
    }
    passed = {entry["category"] for entry in results if entry["status"] == "passed"}
    return 0 if required <= passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
