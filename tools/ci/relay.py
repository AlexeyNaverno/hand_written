#!/usr/bin/env python3
"""Download the files listed in tools/ci/relay.json into ./relay_out and write a manifest.

The development sandbox can reach github.com but not release assets or Hugging Face,
so a GitHub runner fetches the weights and publishes them under a git ref.
Files above 90 MB are split into parts (GitHub rejects blobs over 100 MB).
"""
import hashlib
import json
import os
import sys
import urllib.request

PART = 90 * 1024 * 1024


def fetch(url: str, dest: str) -> str:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "hand-written-relay"})
    h = hashlib.sha256()
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            f.write(chunk)
    return h.hexdigest()


def split(dest: str) -> list:
    size = os.path.getsize(dest)
    if size <= PART:
        return []
    parts = []
    with open(dest, "rb") as f:
        i = 0
        while True:
            chunk = f.read(PART)
            if not chunk:
                break
            name = f"{dest}.part{i:02d}"
            with open(name, "wb") as p:
                p.write(chunk)
            parts.append(os.path.basename(name))
            i += 1
    os.remove(dest)
    return parts


def main() -> int:
    cfg = json.load(open("tools/ci/relay.json", encoding="utf-8"))
    out = "relay_out"
    manifest, failed = [], 0
    for item in cfg["files"]:
        dest = os.path.join(out, item["path"])
        entry = {"path": item["path"], "url": item["url"]}
        try:
            digest = fetch(item["url"], dest)
            entry.update(sha256=digest, size=os.path.getsize(dest))
            want = item.get("sha256")
            if want and want != digest:
                entry["error"] = f"sha256 mismatch, expected {want}"
                os.remove(dest)
                failed += 1
            else:
                parts = split(dest)
                if parts:
                    entry["parts"] = parts
        except Exception as exc:  # keep going: one missing file must not hide the others
            entry["error"] = f"{type(exc).__name__}: {exc}"
            failed += 1
        print(json.dumps(entry, ensure_ascii=False))
        manifest.append(entry)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    return 0 if failed < len(cfg["files"]) else 1


if __name__ == "__main__":
    sys.exit(main())
