"""Verify actual archived extraction bytes against the originating source checkout."""

import hashlib
from html.parser import HTMLParser
import json
import os
import re
from pathlib import Path
import stat
import sys
import zipfile

CAPABILITY_PATTERNS = (
    ("javascript", re.compile(r"\.(?:[cm]?js|jsx|es|es6)$", re.IGNORECASE)),
    ("typescript", re.compile(r"\.(?:[cm]?ts|tsx)$", re.IGNORECASE)),
)
CONTAINER_SUFFIXES = {".vue", ".html", ".htm", ".xhtm", ".xhtml"}
JAVASCRIPT_TYPES = {"", "module", "text/javascript", "application/javascript",
                    "text/ecmascript", "application/ecmascript", "application/x-javascript",
                    "text/jsx", "text/babel"}
TYPESCRIPT_TYPES = {"text/typescript", "application/typescript", "text/tsx"}
SCRIPT_LANGUAGES = {"js": "javascript", "jsx": "javascript", "ecmascript": "javascript",
                    "ts": "typescript", "tsx": "typescript"}
JAVASCRIPT_EVENTS = set("""
onabort onafterprint onanimationcancel onanimationend onanimationiteration onanimationstart
onauxclick onbeforeinput onbeforematch onbeforeprint onbeforetoggle onbeforeunload
onblur oncancel oncanplay oncanplaythrough onchange onclick onclose oncontextmenu
oncopy oncut ondblclick ondrag ondragend ondragenter ondragleave ondragover ondragstart
ondrop ondurationchange onemptied onended onerror onfocus onfocusin onfocusout
onfullscreenchange onfullscreenerror onhashchange oninput oninvalid onkeydown
onkeypress onkeyup onload onloadeddata onloadedmetadata onloadstart onmessage
onmousedown onmouseenter onmouseleave onmousemove onmouseout onmouseover onmouseup
onoffline ononline onpagehide onpageshow onpaste onpause onplay onplaying
onpointercancel onpointerdown onpointerenter onpointerleave onpointermove onpointerout
onpointerover onpointerup onpopstate onprogress onratechange onreadystatechange
onrejectionhandled onreset onresize onscroll onscrollend onseeked onseeking onselect
onselectionchange onselectstart onstalled onstorage onsubmit onsuspend ontimeupdate
ontoggle ontouchcancel ontouchend ontouchmove ontouchstart ontransitioncancel
ontransitionend ontransitionrun ontransitionstart onunhandledrejection onvolumechange
onwaiting onwheel
""".split())


class EmbeddedScripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.languages = set()
        self.script_language = None

    def handle_starttag(self, tag, attrs):
        values = {}
        for key, value in attrs:
            if key in values and (key in JAVASCRIPT_EVENTS or
                                  (tag == "script" and key in ("lang", "language", "type", "src"))):
                raise ValueError("Ambiguous embedded script language attributes")
            values[key] = value or ""
            if (key in JAVASCRIPT_EVENTS and value and value.strip()) or (
                    key in ("href", "src", "action") and not (tag == "script" and key == "src") and value and
                    value.strip().lower().startswith("javascript:") and
                    value.strip()[len("javascript:"):].strip()):
                self.languages.add("javascript")
        if tag != "script":
            return
        self.script_language = None
        if "src" in values:
            return
        kind = values.get("type", "").split(";", 1)[0].strip().lower()
        declared = {key: SCRIPT_LANGUAGES.get(value.strip().lower(), value.strip().lower())
                    for key, value in values.items() if key in ("lang", "language")}
        if len(set(declared.values())) > 1:
            raise ValueError("Conflicting embedded script language metadata")
        language = next(iter(declared.values()), "")
        if kind not in JAVASCRIPT_TYPES | TYPESCRIPT_TYPES:
            return
        if language == "typescript" or (not language and kind in TYPESCRIPT_TYPES):
            if kind in JAVASCRIPT_TYPES - {"", "module"}:
                raise ValueError("Conflicting embedded script language metadata")
            self.script_language = "typescript"
        elif language in ("", "javascript"):
            if kind in TYPESCRIPT_TYPES:
                raise ValueError("Conflicting embedded script language metadata")
            self.script_language = "javascript"

    def handle_data(self, data):
        if self.script_language and data.strip():
            self.languages.add(self.script_language)

    def handle_endtag(self, tag):
        if tag == "script":
            self.script_language = None

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)


def source_capabilities(filename, content):
    matched = {capability for capability, pattern in CAPABILITY_PATTERNS if pattern.search(filename)}
    if matched or Path(filename).suffix.lower() not in CONTAINER_SUFFIXES:
        return matched
    parser = EmbeddedScripts()
    if content.startswith((b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff")):
        text = content.decode("utf-32")
    elif content.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = content.decode("utf-16")
    else:
        # Only ASCII markup is interpreted; non-ASCII program bytes stay opaque.
        text = content.decode("latin-1")
    parser.feed(text)
    parser.close()
    return parser.languages


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


def archived_hashes(archive, expected, coverage=None):
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
            if coverage is not None:
                for capability in source_capabilities(selected, value):
                    coverage[capability] += 1
    if not found:
        raise ValueError("No selected tracked source was genuinely archived by CodeQL")
    return found


def verify(archive, root, candidates, language=None):
    if language is not None and language not in ("actions", "csharp", "cpp", "javascript-typescript", "python"):
        raise ValueError("Unknown native extraction language")
    root = Path(root).resolve(strict=True)
    coverage = {"javascript": 0, "typescript": 0} if language == "javascript-typescript" else None
    found = archived_hashes(archive, source_hashes(root, candidates), coverage)
    result = {"files": len(found), "sourceDigest": hashlib.sha256(
        json.dumps(sorted(found.items()), separators=(",", ":")).encode()).hexdigest()}
    if language is not None:
        result["sourceCoverage"] = coverage if coverage is not None else {language: len(found)}
    return result


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        root = os.environ["GITHUB_WORKSPACE"]
        print(json.dumps(verify(request["archive"], root, request["files"], request.get("language"))))
    except (ValueError, zipfile.BadZipFile) as error:
        print(f"::error::CodeQL extraction archive validation failed ({type(error).__name__}): {error}", file=sys.stderr)
        sys.exit(1)
    except (KeyError, OSError) as error:
        print(f"::error::CodeQL extraction inputs or filesystem unavailable ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
