"""Verify actual archived extraction bytes against the originating source checkout."""

import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import zipfile


def source_hashes(root, candidates):
    expected = {}
    for filename in candidates:
        if not isinstance(filename, str) or "\\" in filename or "\0" in filename:
            raise ValueError("Invalid tracked extraction candidate")
        relative = Path(filename)
        if relative.is_absolute() or any(part in ("", ".", "..") for part in filename.split("/")):
            raise ValueError("Extraction candidate escapes source")
        location = root / relative
        if location.is_symlink() or not location.is_file() or location.stat().st_size > 20 * 1024 * 1024:
            raise ValueError("Extraction source is not a bounded regular file")
        if location.resolve(strict=True) != location.absolute():
            raise ValueError("Extraction source has a linked ancestor")
        expected[filename] = hashlib.sha256(location.read_bytes()).hexdigest()
    return expected


def archived_hashes(archive, expected):
    found = {}
    prefix = None
    with zipfile.ZipFile(archive) as native:
        entries = native.infolist()
        if len(entries) > 200_000 or sum(item.file_size for item in entries) > 1024 * 1024 * 1024:
            raise ValueError("CodeQL extraction archive exceeds bounded limits")
        seen = set()
        for item in entries:
            if item.is_dir():
                continue
            name = item.filename
            if name in seen or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError("Duplicate or linked native extraction archive entry")
            seen.add(name)
            matches = [filename for filename in expected if name == filename or name.endswith("/" + filename)]
            if not matches:
                continue
            selected = max(matches, key=len)
            if selected in found or item.file_size > 20 * 1024 * 1024:
                raise ValueError("Ambiguous or oversized native extraction source")
            current_prefix = name[:-len(selected)]
            if prefix is not None and current_prefix != prefix:
                raise ValueError("Native extraction source spans multiple archive roots")
            prefix = current_prefix
            value = native.read(item)
            if hashlib.sha256(value).hexdigest() != expected[selected]:
                raise ValueError("Native extracted source differs from the actual checkout")
            found[selected] = expected[selected]
    if not found:
        raise ValueError("No selected tracked source was genuinely archived by CodeQL")
    return found


def verify(archive, root, candidates):
    root = Path(root).resolve(strict=True)
    found = archived_hashes(archive, source_hashes(root, candidates))
    return {"files": len(found), "sourceDigest": hashlib.sha256(
        json.dumps(sorted(found.items()), separators=(",", ":")).encode()).hexdigest()}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        root = os.environ["GITHUB_WORKSPACE"]
        print(json.dumps(verify(request["archive"], root, request["files"])))
    except (ValueError, zipfile.BadZipFile) as error:
        print(f"::error::CodeQL extraction archive validation failed ({type(error).__name__}): {error}", file=sys.stderr)
        sys.exit(1)
    except (KeyError, OSError) as error:
        print(f"::error::CodeQL extraction inputs or filesystem unavailable ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
