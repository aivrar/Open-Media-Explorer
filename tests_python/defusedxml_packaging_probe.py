"""Tiny Phase 0 PyInstaller probe; excluded from unittest discovery."""
from __future__ import annotations

import json

import defusedxml
from defusedxml.ElementTree import fromstring
from defusedxml.common import DefusedXmlException


def main() -> int:
    safe = fromstring(b"<rss><channel /></rss>", forbid_dtd=True)
    rejected = False
    try:
        fromstring(
            b'<!DOCTYPE rss [<!ENTITY fixture "expanded">]><rss>&fixture;</rss>',
            forbid_dtd=True,
            forbid_entities=True,
            forbid_external=True,
        )
    except DefusedXmlException:
        rejected = True
    print(json.dumps({
        "defusedxml": defusedxml.__version__,
        "safe_root": safe.tag,
        "hostile_rejected": rejected,
    }, sort_keys=True))
    return 0 if safe.tag == "rss" and rejected else 1


if __name__ == "__main__":
    raise SystemExit(main())
