"""Persistent starred local files, independent of the Computer index."""
from __future__ import annotations

import json
import math
import re
import secrets
import threading
import time
from http import HTTPStatus
from pathlib import Path

from worldmedia_runtime import _atomic_write_json
from worldmedia_security import ApiError

COMPUTER_STARS_FILENAME = "computer-stars.json"
_MAX_STARS = 200_000
_MAX_BATCH = 2_000
_ID = re.compile(r"[0-9a-f]{24}", re.IGNORECASE | re.ASCII)
_SNAP_FIELDS = ("title", "artist", "album", "duration", "kind", "ext", "format")


def _identity(value):
    if isinstance(value, str) and _ID.fullmatch(value):
        return value.lower()
    raise ValueError("Choose valid file IDs.")


def _snap(value: dict) -> dict:
    result = {}
    for key in _SNAP_FIELDS:
        item = value.get(key)
        if isinstance(item, str):
            result[key] = item[:300]
        elif type(item) in (int, float):
            try:
                if math.isfinite(item):
                    result[key] = item
            except OverflowError:
                pass
    return result


def _nonnegative(value) -> bool:
    return type(value) is int and value >= 0


class ComputerStars:
    def __init__(self, path: Path, *, clock=time.time_ns) -> None:
        self.path = path
        self._clock = clock
        self._lock = threading.Lock()
        self._rows: dict[str, dict] | None = None
        self._seq = 0
        self._snapshot = None

    def _load(self) -> None:
        if self._rows is not None:
            return
        rows, seq = {}, 0
        try:
            with self.path.open(encoding="utf-8") as handle:
                data = json.load(handle)
            if (not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1
                    or not _nonnegative(data.get("seq")) or not isinstance(data.get("stars"), list)
                    or len(data["stars"]) > _MAX_STARS):
                raise ValueError("Invalid stars file")
            seq = data["seq"]
            used = set()
            for row in data["stars"]:
                if (not isinstance(row, dict) or not _nonnegative(row.get("t"))
                        or not _nonnegative(row.get("seq")) or not 0 < row["seq"] <= seq
                        or row["seq"] in used or not isinstance(row.get("snap"), dict)):
                    raise ValueError("Invalid star")
                identity = _identity(row.get("id"))
                if identity in rows:
                    raise ValueError("Duplicate star")
                used.add(row["seq"])
                rows[identity] = {"id": identity, "t": row["t"], "seq": row["seq"], "snap": _snap(row["snap"])}
        except FileNotFoundError:
            pass
        except (ValueError, RecursionError):
            backup = self.path.with_name(f"{self.path.stem}-unreadable-{secrets.token_hex(8)}.json")
            self.path.replace(backup)
            rows, seq = {}, 0
        self._rows, self._seq = rows, seq

    def snapshot(self) -> dict:
        with self._lock:
            self._load()
            if self._snapshot is None:
                self._snapshot = {"stars": sorted(self._rows.values(), key=lambda row: row["seq"], reverse=True),
                                  "count": len(self._rows)}
            return self._snapshot

    def _save(self, rows: dict, seq: int) -> None:
        _atomic_write_json(self.path, {"version": 1, "seq": seq, "stars": list(rows.values())})
        self._rows, self._seq = rows, seq
        self._snapshot = None

    def move(self, pairs: list[tuple[str, str]]) -> None:
        with self._lock:
            self._load()
            if not any(old in self._rows for old, _ in pairs):
                return
            rows = self._rows.copy()
            for old, new in pairs:
                star = rows.pop(old, None)
                if star is not None and new not in rows:
                    rows[new] = {**star, "id": new}
            self._save(rows, self._seq)

    def update(self, body: dict) -> dict:
        add, remove = body.get("add", []), body.get("remove", [])
        try:
            if body.keys() - {"add", "remove"} or not isinstance(add, list) or not isinstance(remove, list):
                raise ValueError("Send lists of files to star or unstar.")
            if len(add) + len(remove) > _MAX_BATCH:
                raise ValueError("Choose at most 2,000 files at a time.")
            updates = {}
            for row in add:
                if not isinstance(row, dict) or not isinstance(row.get("snap"), dict):
                    raise ValueError("Send a snapshot for each starred file.")
                updates[_identity(row.get("id"))] = _snap(row["snap"])
            removals = dict.fromkeys(map(_identity, remove))
        except ValueError as error:
            raise ApiError(HTTPStatus.BAD_REQUEST, "INVALID_COMPUTER_STARS", str(error)) from None

        with self._lock:
            self._load()
            rows = self._rows.copy()
            new_ids = [identity for identity in updates if identity not in rows]
            seq = self._seq + len(new_ids)
            positions = dict(zip(new_ids, range(seq, self._seq, -1)))
            now = self._clock() // 1_000_000
            added = []
            for identity, snap in updates.items():
                old = rows.get(identity)
                t, number = (old["t"], old["seq"]) if old else (now, positions[identity])
                record = {"id": identity, "t": t, "seq": number}
                added.append(record)
                rows[identity] = {**record, "snap": snap}
            removed = [identity for identity in removals if rows.pop(identity, None) is not None]
            if len(rows) > _MAX_STARS:
                raise ApiError(HTTPStatus.BAD_REQUEST, "COMPUTER_STARS_LIMIT", "Too many starred files.")
            self._save(rows, seq)
            return {"added": added, "removed": removed, "count": len(rows)}
