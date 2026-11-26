#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "httpx>=0.27",
# ]
# ///
"""Search Swedish National Archives (Riksarkivet) open APIs and download IIIF scans.

Verified live public endpoints (no API key, no login, no CAPTCHA):
  - Riksarkivet Search API (https://data.riksarkivet.se):
      * GET /api/records (archives, church books, volumes, and HTR transcribed text)
      * GET /api/records/birthrecords (indexed parish birth registers)
      * GET /api/records/marriagerecords (indexed parish marriage registers)
      * GET /api/records/indexoftitledeeds (indexed title deeds / lagfartsregister)
      * GET /register/<id> (full JSON detail for an indexed register record)
  - Riksarkivet IIIF Presentation v3 & Image API (https://lbiiif.riksarkivet.se):
      * GET /collection/arkiv/<archive_id> (archive and series IIIF collections)
      * GET /arkis!<bildid>/manifest (digitized volume manifest and canvas list)
      * GET /arkis!<page_id>/full/<size>/0/default.jpg (JPEG scan downloads)

Swedish National Censuses (Folkrakningar 1860-1930) and web forms under
https://sok.riksarkivet.se redirect automated HTTP clients to /captcha and are
exposed as browser-only links via the `census` subcommand.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from typing import Any, Callable, Iterator
from urllib.parse import quote, urlencode, urlparse

import httpx

DEFAULT_CACHE_TTL_HOURS = 168.0
CACHE_SCHEMA = 1
USER_AGENT = "Kinloom/0.19 (genealogy research CLI; +https://github.com/tiberriver256/kinloom)"

DATA_API_BASE = "https://data.riksarkivet.se"
RECORDS_API_URL = f"{DATA_API_BASE}/api/records"
BIRTHS_API_URL = f"{DATA_API_BASE}/api/records/birthrecords"
MARRIAGES_API_URL = f"{DATA_API_BASE}/api/records/marriagerecords"
DEEDS_API_URL = f"{DATA_API_BASE}/api/records/indexoftitledeeds"
REGISTER_BASE_URL = f"{DATA_API_BASE}/register"
ARCHIVE_BASE_URL = f"{DATA_API_BASE}/archive"

IIIF_BASE = "https://lbiiif.riksarkivet.se"
IIIF_COLLECTION_BASE = f"{IIIF_BASE}/collection/arkiv"
BILDVISNING_BASE = "https://sok.riksarkivet.se/bildvisning"
FOLKRAKNINGAR_URL = "https://sok.riksarkivet.se/folkrakningar"
KYRKOARKIV_URL = "https://sok.riksarkivet.se/kyrkoarkiv"

ALLOWED_API_HOSTS = frozenset({"data.riksarkivet.se", "lbiiif.riksarkivet.se"})
ALLOWED_DOWNLOAD_HOSTS = frozenset({"lbiiif.riksarkivet.se"})
TRANSIENT_STATUS_CODES = frozenset({429, 500, 502, 503, 504})
MAX_HTTP_ATTEMPTS = 3
RETRY_BASE_SECONDS = 0.5

RECORD_TYPE_FACETS: dict[str, str] = {
    "volume": "ObjectType:Record;Type:Volume",
    "archive": "ObjectType:RecordSet",
    "recordset": "ObjectType:RecordSet",
    "birth": "ObjectType:Register;Type:BirthRecord",
    "marriage": "ObjectType:Register;Type:MarriageRecord",
    "deed": "ObjectType:Register;Type:IndexOfTitleDeedsRecord",
    "title-deed": "ObjectType:Register;Type:IndexOfTitleDeedsRecord",
    "map": "ObjectType:Record;Type:MapDrawing",
    "photo": "ObjectType:Record;Type:Photography",
    "document": "ObjectType:Record;Type:Document",
    "agent": "ObjectType:Agent",
}

GENDER_ALIASES: dict[str, str] = {
    "kvinna": "Kvinna",
    "female": "Kvinna",
    "f": "Kvinna",
    "man": "Man",
    "male": "Man",
    "m": "Man",
    "okänt": "Okänt",
    "okant": "Okänt",
    "unknown": "Okänt",
}

CENSUS_YEAR_FLAGS: dict[int, str] = {
    1860: "Folk1860",
    1870: "Folk1870",
    1880: "Folk1880",
    1890: "Folk1890",
    1900: "Folk1900",
    1910: "Folk1910",
    1930: "Folk1930",
}

SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{3,80}$")
BILDID_RE = re.compile(r"^([A-Za-z0-9]+)(?:_(\d{1,6}))?$")
ARKIS_MANIFEST_RE = re.compile(r"/arkis!([A-Za-z0-9_]+)(?:/|$)")
HTML_TAG_RE = re.compile(r"</?em>", re.IGNORECASE)


class CliError(Exception):
    """User-facing CLI error with an exit code."""

    def __init__(self, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def cache_dir() -> Path:
    specific = os.environ.get("KINLOOM_SE_ARCHIVES_CACHE_DIR")
    if specific:
        return Path(specific).expanduser()
    shared = os.environ.get("KINLOOM_CACHE_DIR")
    if shared:
        return Path(shared).expanduser() / "se-archives"
    return Path.home() / ".cache" / "kinloom" / "se-archives"


def resolve_ttl_hours(cli_ttl: float | None) -> float:
    if cli_ttl is not None:
        if not math.isfinite(cli_ttl) or cli_ttl < 0:
            raise CliError(f"Invalid --cache-ttl-hours value: {cli_ttl!r} (must be >= 0).", 2)
        return float(cli_ttl)
    raw = os.environ.get("KINLOOM_SE_ARCHIVES_CACHE_TTL_HOURS")
    if raw is not None and raw.strip():
        try:
            parsed = float(raw.strip())
        except ValueError as exc:
            raise CliError(f"Invalid KINLOOM_SE_ARCHIVES_CACHE_TTL_HOURS value: {raw!r}.", 2) from exc
        if not math.isfinite(parsed) or parsed < 0:
            raise CliError(
                f"Invalid KINLOOM_SE_ARCHIVES_CACHE_TTL_HOURS value: {raw!r} (must be >= 0).",
                2,
            )
        return parsed
    return DEFAULT_CACHE_TTL_HOURS


@contextmanager
def file_lock(lock_path: Path) -> Iterator[None]:
    """Advisory exclusive lock (POSIX flock); no-op when fcntl is unavailable."""
    try:
        import fcntl
    except ImportError:
        yield
        return
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "a+b") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def atomic_write_bytes(dest: Path, payload: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        tmp.write_bytes(payload)
        os.replace(tmp, dest)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def atomic_write_json(dest: Path, payload: Any) -> None:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    atomic_write_bytes(dest, raw)


def cache_key(kind: str, payload: dict[str, Any]) -> str:
    canonical = json.dumps([kind, payload], sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def read_cache(path: Path, ttl_hours: float) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        entry = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(entry, dict) or entry.get("schema") != CACHE_SCHEMA:
        return None
    fetched = entry.get("fetched_at")
    if not isinstance(fetched, (int, float)):
        return None
    if ttl_hours <= 0 or (time.time() - fetched) > ttl_hours * 3600:
        return None
    result = entry.get("result")
    return result if isinstance(result, dict) else None


def cached_call(
    kind: str,
    payload: dict[str, Any],
    fetch: Callable[[], dict[str, Any]],
    *,
    refresh: bool,
    ttl_hours: float,
    cacheable: Callable[[dict[str, Any]], bool] = lambda _r: True,
) -> tuple[dict[str, Any], bool]:
    key = cache_key(kind, payload)
    root = cache_dir()
    path = root / f"{key}.json"
    if not refresh:
        hit = read_cache(path, ttl_hours)
        if hit is not None:
            return hit, True
    with file_lock(root / f"{key}.lock"):
        if not refresh:
            hit = read_cache(path, ttl_hours)
            if hit is not None:
                return hit, True
        result = fetch()
        if cacheable(result):
            atomic_write_json(
                path,
                {
                    "schema": CACHE_SCHEMA,
                    "fetched_at": time.time(),
                    "kind": kind,
                    "query": payload,
                    "result": result,
                },
            )
        return result, False


def _host_allowed(host: str, allowed_hosts: frozenset[str]) -> bool:
    if host in allowed_hosts:
        return True
    return False


def validate_url(url: str, *, allowed_hosts: frozenset[str] = ALLOWED_API_HOSTS) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise CliError(f"Refusing non-HTTPS URL: {url!r}", 2)
    host = (parsed.hostname or "").lower()
    if not _host_allowed(host, allowed_hosts):
        raise CliError(
            f"Refusing host {host!r}; allowed hosts: {', '.join(sorted(allowed_hosts))}.",
            2,
        )
    if parsed.username or parsed.password:
        raise CliError("Refusing URL containing embedded credentials.", 2)
    return url


def _client() -> httpx.Client:
    return httpx.Client(
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
        timeout=30.0,
    )


def _retry_delay(attempt: int, resp: httpx.Response | None = None) -> float:
    if resp is not None:
        raw = resp.headers.get("Retry-After")
        if raw:
            try:
                val = float(raw.strip())
                if math.isfinite(val) and 0 <= val <= 30:
                    return val
            except ValueError:
                pass
    return RETRY_BASE_SECONDS * (2 ** (attempt - 1))


def _request_with_retry(
    client: httpx.Client,
    method: str,
    url: str,
    *,
    allowed_hosts: frozenset[str] = ALLOWED_API_HOSTS,
    **kwargs: Any,
) -> httpx.Response:
    validate_url(url, allowed_hosts=allowed_hosts)
    last_exc: Exception | None = None
    for attempt in range(1, MAX_HTTP_ATTEMPTS + 1):
        try:
            resp = client.request(method, url, **kwargs)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            last_exc = exc
            if attempt < MAX_HTTP_ATTEMPTS:
                time.sleep(_retry_delay(attempt))
                continue
            raise CliError(f"Riksarkivet request failed after {attempt} attempt(s): {exc}") from exc
        except httpx.HTTPError as exc:
            raise CliError(f"Riksarkivet request failed: {exc}") from exc

        final_url = str(resp.url)
        validate_url(final_url, allowed_hosts=allowed_hosts)

        if resp.status_code in TRANSIENT_STATUS_CODES and attempt < MAX_HTTP_ATTEMPTS:
            time.sleep(_retry_delay(attempt, resp))
            continue

        if resp.status_code >= 400:
            raise CliError(f"HTTP {resp.status_code} from {final_url}")
        return resp

    raise CliError(f"Riksarkivet request failed: {last_exc}")


def _validate_year_range(year_min: int | None, year_max: int | None) -> None:
    if year_min is not None and not 1000 <= year_min <= 2100:
        raise CliError(f"Invalid --year-min {year_min!r}; expected a 4-digit year.", 2)
    if year_max is not None and not 1000 <= year_max <= 2100:
        raise CliError(f"Invalid --year-max {year_max!r}; expected a 4-digit year.", 2)
    if year_min is not None and year_max is not None and year_min > year_max:
        raise CliError("--year-min must not be greater than --year-max.", 2)


def _validate_paging(limit: int, offset: int) -> None:
    if not 1 <= limit <= 100:
        raise CliError("--limit must be between 1 and 100.", 2)
    if offset < 0:
        raise CliError("--offset must be >= 0.", 2)


def _first_lang_text(value: Any) -> str:
    if isinstance(value, str):
        return " ".join(value.split())
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str) and item.strip():
                return " ".join(item.split())
        return ""
    if isinstance(value, dict):
        for lang in ("sv", "en", "none"):
            vals = value.get(lang)
            if isinstance(vals, list) and vals:
                return " ".join(str(vals[0]).split())
            if isinstance(vals, str) and vals.strip():
                return " ".join(vals.split())
        for vals in value.values():
            if isinstance(vals, list) and vals:
                return " ".join(str(vals[0]).split())
    return ""


def _all_lang_texts(value: Any) -> list[str]:
    if isinstance(value, str):
        clean = " ".join(value.split())
        return [clean] if clean else []
    if isinstance(value, dict):
        for lang in ("sv", "en", "none"):
            vals = value.get(lang)
            if isinstance(vals, list) and vals:
                return [" ".join(str(v).split()) for v in vals if str(v).strip()]
        for vals in value.values():
            if isinstance(vals, list) and vals:
                return [" ".join(str(v).split()) for v in vals if str(v).strip()]
    return []


def normalize_bildid(raw: str) -> tuple[str, str | None]:
    """Parse a Riksarkivet bildid, bildvisning URL, or IIIF URL into (volume_id, page_id_or_None)."""
    text = raw.strip()
    if not text:
        raise CliError("Empty bildid or URL.", 2)
    if text.startswith(("http://", "https://")):
        parsed = urlparse(text)
        host = (parsed.hostname or "").lower()
        if host == "lbiiif.riksarkivet.se":
            validate_url(text, allowed_hosts=ALLOWED_DOWNLOAD_HOSTS)
            match = ARKIS_MANIFEST_RE.search(parsed.path)
            if not match:
                raise CliError(f"Could not extract arkis bildid from IIIF URL: {raw!r}", 2)
            token = match.group(1).lstrip("_")
        elif host == "sok.riksarkivet.se":
            if parsed.scheme != "https":
                raise CliError(f"Refusing non-HTTPS URL: {raw!r}", 2)
            parts = [p for p in parsed.path.split("/") if p]
            if len(parts) < 2 or parts[0].lower() != "bildvisning":
                raise CliError(
                    f"Expected a sok.riksarkivet.se/bildvisning/<bildid> URL, got: {raw!r}",
                    2,
                )
            token = parts[1].lstrip("_")
        else:
            raise CliError(
                f"Refusing host {host!r}; allowed hosts: lbiiif.riksarkivet.se, sok.riksarkivet.se.",
                2,
            )
    else:
        token = text.lstrip("_")
        if token.startswith("arkis!"):
            token = token[len("arkis!") :].lstrip("_")

    m = BILDID_RE.match(token)
    if not m:
        raise CliError(f"Invalid Riksarkivet bildid: {raw!r}", 2)
    vol_id = m.group(1)
    page_num = m.group(2)
    page_id = f"{vol_id}_{page_num}" if page_num else None
    return vol_id, page_id


def parse_archive_id(raw: str) -> str:
    text = raw.strip()
    if not text:
        raise CliError("Archive ID cannot be empty.", 2)
    if text.startswith(("http://", "https://")):
        parsed = urlparse(text)
        host = (parsed.hostname or "").lower()
        if host not in ("data.riksarkivet.se", "lbiiif.riksarkivet.se"):
            raise CliError(
                f"Refusing host {host!r}; expected data.riksarkivet.se or lbiiif.riksarkivet.se.",
                2,
            )
        if parsed.scheme != "https":
            raise CliError(f"Refusing non-HTTPS URL: {raw!r}", 2)
        leaf = [p for p in parsed.path.split("/") if p][-1] if parsed.path.strip("/") else ""
        for suffix in (".jsonld", ".rdfxml"):
            if leaf.endswith(suffix):
                leaf = leaf[: -len(suffix)]
        text = leaf
    if not SAFE_ID_RE.match(text):
        raise CliError(f"Invalid Riksarkivet archive ID: {raw!r}", 2)
    return text


def parse_register_id(raw: str) -> str:
    text = raw.strip()
    if not text:
        raise CliError("Register record ID cannot be empty.", 2)
    if text.startswith(("http://", "https://")):
        validate_url(text, allowed_hosts=frozenset({"data.riksarkivet.se"}))
        parsed = urlparse(text)
        parts = [p for p in parsed.path.split("/") if p]
        if len(parts) < 2 or parts[0] != "register":
            raise CliError(f"Expected https://data.riksarkivet.se/register/<id>, got: {raw!r}", 2)
        text = parts[1]
    if not SAFE_ID_RE.match(text):
        raise CliError(f"Invalid Riksarkivet register record ID: {raw!r}", 2)
    return text


def _normalize_https(url: str) -> str:
    if url.startswith("http://data.riksarkivet.se/"):
        return "https://" + url[len("http://") :]
    return url


def _extract_caption_list(items: Any) -> list[str]:
    if not isinstance(items, list):
        return []
    out: list[str] = []
    for entry in items:
        if isinstance(entry, dict) and entry.get("caption"):
            out.append(str(entry["caption"]).strip())
    return out


def _normalize_search_item(raw: dict[str, Any]) -> dict[str, Any]:
    item_id = str(raw.get("id") or "").strip()
    obj_type = str(raw.get("objectType") or "").strip()
    rec_type = str(raw.get("type") or "").strip()
    meta = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
    links = raw.get("_links") if isinstance(raw.get("_links"), dict) else {}

    hierarchy = _extract_caption_list(meta.get("hierarchy"))
    institutions = _extract_caption_list(meta.get("archivalInstitution"))
    caption = str(raw.get("caption") or "").strip()
    if not caption:
        if hierarchy:
            caption = " / ".join(hierarchy)
        elif meta.get("parish") and meta.get("fathersName"):
            caption = f"{meta['fathersName']} ({meta['parish']})"
        elif meta.get("referenceCode"):
            caption = str(meta["referenceCode"])

    iiif_manifests: list[str] = []
    raw_images = links.get("image")
    if isinstance(raw_images, list):
        for img in raw_images:
            if isinstance(img, str) and img.startswith("https://lbiiif.riksarkivet.se/"):
                iiif_manifests.append(img)
    elif isinstance(raw_images, str) and raw_images.startswith("https://lbiiif.riksarkivet.se/"):
        iiif_manifests.append(raw_images)

    snippets: list[dict[str, Any]] = []
    transcribed = raw.get("transcribedText")
    if isinstance(transcribed, dict) and isinstance(transcribed.get("snippets"), list):
        for snip in transcribed["snippets"][:5]:
            if not isinstance(snip, dict):
                continue
            text = HTML_TAG_RE.sub("", str(snip.get("text") or "")).strip()
            pages: list[str] = []
            if isinstance(snip.get("pages"), list):
                for pg in snip["pages"]:
                    if isinstance(pg, dict) and pg.get("id"):
                        pages.append(str(pg["id"]).lstrip("_"))
            snippets.append({"text": text, "pages": pages})
            for pg_id in pages:
                vol_id = pg_id.split("_", 1)[0]
                manifest_url = f"{IIIF_BASE}/arkis!{vol_id}/manifest"
                if manifest_url not in iiif_manifests:
                    iiif_manifests.append(manifest_url)

    out: dict[str, Any] = {
        "id": item_id,
        "object_type": obj_type,
        "type": rec_type,
        "caption": caption,
        "reference_code": str(meta.get("referenceCode") or "").strip(),
        "date": str(meta.get("date") or meta.get("year") or "").strip(),
        "parish": str(meta.get("parish") or "").strip(),
        "institution": institutions[0] if institutions else "",
        "digitized": bool(meta.get("onlyDigitisedMaterials")) or bool(iiif_manifests),
    }
    if hierarchy:
        out["hierarchy"] = hierarchy
    if meta.get("note"):
        out["note"] = str(meta["note"]).strip()
    for src_key, dst_key in (
        ("childsName", "child_name"),
        ("fathersName", "father"),
        ("mothersName", "mother"),
        ("groomsName", "groom"),
        ("bridesName", "bride"),
        ("propertyName", "property_name"),
        ("taxUnit", "tax_unit"),
        ("districtCourtSessions", "court_session"),
    ):
        if meta.get(src_key):
            out[dst_key] = str(meta[src_key]).strip()
    if snippets:
        out["snippets"] = snippets
    if iiif_manifests:
        out["iiif_manifests"] = iiif_manifests
    if isinstance(links.get("self"), str):
        out["self_url"] = _normalize_https(links["self"])
    if obj_type in ("Record", "RecordSet") and item_id:
        out["iiif_collection_url"] = f"{IIIF_COLLECTION_BASE}/{item_id}"
    return out


def _fetch_records_endpoint(url: str, params: dict[str, Any]) -> dict[str, Any]:
    with _client() as client:
        resp = _request_with_retry(
            client,
            "GET",
            url,
            params=params,
            headers={"Accept": "application/json"},
        )
    try:
        body = resp.json()
    except ValueError as exc:
        raise CliError(f"Riksarkivet API returned non-JSON response from {url}") from exc
    if not isinstance(body, dict) or not isinstance(body.get("items"), list):
        raise CliError(f"Unexpected Riksarkivet API payload from {url}")
    items = [_normalize_search_item(it) for it in body["items"] if isinstance(it, dict)]
    return {
        "total": int(body.get("totalHits") or 0),
        "hits": int(body.get("hits") or len(items)),
        "offset": int(body.get("offset") or params.get("offset") or 0),
        "results": items,
        "verified": True,
    }


def _fetch_register_detail(register_id: str) -> dict[str, Any]:
    clean_id = parse_register_id(register_id)
    url = f"{REGISTER_BASE_URL}/{quote(clean_id, safe='')}"
    with _client() as client:
        resp = _request_with_retry(
            client,
            "GET",
            url,
            headers={"Accept": "application/json"},
        )
    try:
        body = resp.json()
    except ValueError as exc:
        raise CliError(f"Riksarkivet register endpoint returned non-JSON for {clean_id}") from exc
    if not isinstance(body, dict):
        raise CliError(f"Unexpected register detail payload for {clean_id}")
    return {
        "id": clean_id,
        "url": url,
        "record": body,
        "verified": True,
    }


def _fetch_iiif_collection(archive_id: str) -> dict[str, Any]:
    clean_id = parse_archive_id(archive_id)
    url = f"{IIIF_COLLECTION_BASE}/{quote(clean_id, safe='')}"
    with _client() as client:
        resp = _request_with_retry(
            client,
            "GET",
            url,
            headers={"Accept": "application/json"},
        )
    try:
        body = resp.json()
    except ValueError as exc:
        raise CliError(f"Riksarkivet IIIF collection returned non-JSON for {clean_id}") from exc
    if not isinstance(body, dict) or body.get("type") != "Collection":
        raise CliError(f"Unexpected IIIF Collection payload for {clean_id}")

    summary_lines = _all_lang_texts(body.get("summary"))
    reference_code = ""
    institution = ""
    date_text = ""
    for line in summary_lines:
        if line.startswith("Referenskod:"):
            reference_code = line.split(":", 1)[1].strip()
        elif line.startswith("Arkivinstitution:"):
            institution = line.split(":", 1)[1].strip()
        elif line.startswith("Datering:"):
            date_text = line.split(":", 1)[1].strip()

    parsed_items: list[dict[str, str]] = []
    for entry in body.get("items") or []:
        if not isinstance(entry, dict):
            continue
        item_url = str(entry.get("id") or "").strip()
        item_type = str(entry.get("type") or "").strip()
        item_label = _first_lang_text(entry.get("label"))
        row: dict[str, str] = {
            "type": item_type,
            "label": item_label,
            "url": item_url,
        }
        if item_type == "Collection":
            parts = [p for p in urlparse(item_url).path.split("/") if p]
            if parts:
                row["archive_id"] = parts[-1]
        elif item_type == "Manifest":
            match = ARKIS_MANIFEST_RE.search(urlparse(item_url).path)
            if match:
                row["bildid"] = match.group(1).lstrip("_")
        parsed_items.append(row)

    return {
        "archive_id": clean_id,
        "url": url,
        "label": _first_lang_text(body.get("label")),
        "reference_code": reference_code,
        "institution": institution,
        "date": date_text,
        "count": len(parsed_items),
        "items": parsed_items,
        "verified": True,
    }


def _extract_canvas_info(index: int, canvas: dict[str, Any]) -> dict[str, Any]:
    canvas_id = str(canvas.get("id") or "").strip()
    page_id = ""
    match = ARKIS_MANIFEST_RE.search(urlparse(canvas_id).path)
    if match:
        page_id = match.group(1).lstrip("_")

    bildvisning_url = f"{BILDVISNING_BASE}/{page_id}" if page_id else ""
    source_ref = ""
    for meta in canvas.get("metadata") or []:
        if not isinstance(meta, dict):
            continue
        label = _first_lang_text(meta.get("label")).lower()
        val = _first_lang_text(meta.get("value"))
        if label in ("bildid", "image id") and val:
            page_id = val.lstrip("_")
        elif label in ("länk", "link") and val.startswith("https://"):
            bildvisning_url = val
        elif label in ("källhänvisning", "source reference") and val:
            source_ref = val

    image_base = f"{IIIF_BASE}/arkis!{page_id}" if page_id else ""
    full_image_url = f"{image_base}/full/max/0/default.jpg" if image_base else ""
    return {
        "index": index,
        "page_id": page_id,
        "label": _first_lang_text(canvas.get("label")) or f"Image {index}",
        "width": int(canvas.get("width") or 0),
        "height": int(canvas.get("height") or 0),
        "bildvisning_url": bildvisning_url,
        "source_reference": source_ref,
        "iiif_image_base": image_base,
        "full_image_url": full_image_url,
    }


def _fetch_iiif_manifest(volume_id: str) -> dict[str, Any]:
    url = f"{IIIF_BASE}/arkis!{quote(volume_id, safe='')}/manifest"
    with _client() as client:
        try:
            resp = _request_with_retry(
                client,
                "GET",
                url,
                allowed_hosts=ALLOWED_DOWNLOAD_HOSTS,
                headers={"Accept": "application/json"},
            )
        except CliError as exc:
            if "HTTP 403" in str(exc):
                raise CliError(
                    f"HTTP 403 from {url}: this volume is restricted on the public IIIF endpoint "
                    f"(check {BILDVISNING_BASE}/{volume_id} in a browser)."
                ) from exc
            raise
    try:
        body = resp.json()
    except ValueError as exc:
        raise CliError(f"Riksarkivet IIIF manifest returned non-JSON from {url}") from exc
    if not isinstance(body, dict) or body.get("type") != "Manifest":
        raise CliError(f"Unexpected IIIF Manifest payload from {url}")

    metadata: dict[str, str] = {}
    for entry in body.get("metadata") or []:
        if not isinstance(entry, dict):
            continue
        k = _first_lang_text(entry.get("label"))
        v = _first_lang_text(entry.get("value"))
        if k and v:
            metadata[k] = v

    raw_canvases = body.get("items") or []
    canvases = [
        _extract_canvas_info(idx, canvas)
        for idx, canvas in enumerate(raw_canvases, start=1)
        if isinstance(canvas, dict)
    ]

    return {
        "bildid": volume_id,
        "manifest_url": url,
        "bildvisning_url": f"{BILDVISNING_BASE}/{volume_id}",
        "label": _first_lang_text(body.get("label")),
        "metadata": metadata,
        "canvas_count": len(canvases),
        "canvases": canvases,
        "verified": True,
    }


def detect_image_format(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def looks_like_html(data: bytes, content_type: str) -> bool:
    ct = content_type.lower()
    if "text/html" in ct or "application/xhtml" in ct:
        return True
    head = data[:512].lstrip().lower()
    return head.startswith((b"<!doctype html", b"<html", b"<?xml", b"<head", b"<body"))


def resolve_safe_output_path(out: str, default_name: str) -> Path:
    raw = out.strip()
    if not raw or "\x00" in raw:
        raise CliError("Invalid output path.", 2)
    parts = Path(raw).parts
    if ".." in parts:
        raise CliError(f"Refusing output path with parent traversal segment ('..'): {raw!r}", 2)
    target = Path(raw).expanduser()
    if raw.endswith(os.sep) or (os.altsep and raw.endswith(os.altsep)) or (target.exists() and target.is_dir()):
        safe_leaf = re.sub(r"[^A-Za-z0-9._-]+", "_", default_name).strip("._") or "scan.jpg"
        resolved_dir = target.resolve()
        candidate = (resolved_dir / safe_leaf).resolve()
        if resolved_dir not in candidate.parents:
            raise CliError(f"Output path escapes target directory: {candidate}", 2)
        return candidate
    return target.resolve()


def build_iiif_image_url(
    target: str,
    *,
    page: int | None = None,
    width: int | None = None,
    full: bool = False,
) -> tuple[str, str]:
    """Return (iiif_image_url, page_id) from a bildid, bildvisning URL, or direct IIIF URL."""
    if width is not None and full:
        raise CliError("Pass either --width or --full, not both.", 2)
    if width is not None and not 64 <= width <= 12000:
        raise CliError("--width must be between 64 and 12000 pixels.", 2)
    if page is not None and page < 1:
        raise CliError("--page must be >= 1.", 2)

    raw = target.strip()
    if raw.startswith(("http://", "https://")):
        parsed = urlparse(raw)
        host = (parsed.hostname or "").lower()
        if host == "lbiiif.riksarkivet.se" and parsed.path.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            url = validate_url(raw, allowed_hosts=ALLOWED_DOWNLOAD_HOSTS)
            match = ARKIS_MANIFEST_RE.search(parsed.path)
            stem = match.group(1).lstrip("_") if match else "riksarkivet_scan"
            return url, stem

    vol_id, page_id = normalize_bildid(raw)
    if page_id is None:
        page_num = page if page is not None else 1
        page_id = f"{vol_id}_{page_num:05d}"
    elif page is not None:
        page_id = f"{vol_id}_{page:05d}"

    size_seg = f"{width}," if width is not None else "max"
    url = f"{IIIF_BASE}/arkis!{quote(page_id, safe='')}/full/{size_seg}/0/default.jpg"
    return url, page_id


def download_iiif_image(
    target: str,
    out: str,
    *,
    page: int | None = None,
    width: int | None = None,
    full: bool = False,
    overwrite: bool = False,
) -> dict[str, Any]:
    url, page_id = build_iiif_image_url(target, page=page, width=width, full=full)
    dest = resolve_safe_output_path(out, f"{page_id}.jpg")
    if dest.exists() and not overwrite:
        data = dest.read_bytes()
        fmt = detect_image_format(data)
        if not fmt:
            raise CliError(f"Existing file at {dest} is not a valid image; pass --overwrite to replace.")
        return {
            "page_id": page_id,
            "url": url,
            "bildvisning_url": f"{BILDVISNING_BASE}/{page_id}",
            "path": str(dest),
            "bytes": len(data),
            "format": fmt,
            "skipped": True,
            "cache_hit": True,
        }

    with _client() as client:
        resp = _request_with_retry(
            client,
            "GET",
            url,
            allowed_hosts=ALLOWED_DOWNLOAD_HOSTS,
            headers={"Accept": "image/jpeg,image/png,image/*;q=0.9"},
        )
    content_type = resp.headers.get("Content-Type", "")
    payload = resp.content
    if not payload:
        raise CliError(f"Refusing empty response body from {url}")
    if looks_like_html(payload, content_type):
        raise CliError(
            f"Refusing to save HTML response (Content-Type: {content_type or 'unknown'}) as an image from {url}"
        )
    fmt = detect_image_format(payload)
    if not fmt:
        raise CliError(
            f"Refusing non-image payload (Content-Type: {content_type or 'unknown'}) from {url}"
        )
    atomic_write_bytes(dest, payload)
    return {
        "page_id": page_id,
        "url": url,
        "bildvisning_url": f"{BILDVISNING_BASE}/{page_id}",
        "path": str(dest),
        "bytes": len(payload),
        "format": fmt,
        "skipped": False,
        "cache_hit": False,
    }


def _emit_json(payload: Any) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def _print_search_text(title: str, result: dict[str, Any], cache_hit: bool) -> None:
    marker = " [cache]" if cache_hit else ""
    print(
        f"{title} | total={result['total']} | offset={result['offset']} "
        f"| showing {len(result['results'])}{marker}"
    )
    for item in result["results"]:
        parts = [
            item.get("type") or item.get("object_type") or "Record",
            item.get("caption") or "(untitled)",
        ]
        if item.get("date"):
            parts.append(item["date"])
        if item.get("parish"):
            parts.append(item["parish"])
        if item.get("reference_code"):
            parts.append(item["reference_code"])
        if item.get("father"):
            parts.append(f"father: {item['father']}")
        if item.get("mother"):
            parts.append(f"mother: {item['mother']}")
        if item.get("groom"):
            parts.append(f"groom: {item['groom']}")
        if item.get("bride"):
            parts.append(f"bride: {item['bride']}")
        if item.get("digitized"):
            parts.append("[digitized]")
        if item.get("id"):
            parts.append(f"id={item['id']}")
        print(" | ".join(parts))
        if item.get("iiif_manifests"):
            print(f"    iiif: {item['iiif_manifests'][0]}")
        for snip in (item.get("snippets") or [])[:2]:
            page_str = f" [{', '.join(snip['pages'])}]" if snip.get("pages") else ""
            excerpt = snip.get("text", "")
            if len(excerpt) > 160:
                excerpt = excerpt[:157] + "..."
            print(f"    text{page_str}: {excerpt}")


def _add_cache_and_json_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", dest="as_json", action="store_true", help="Output structured JSON.")
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Bypass the disk cache for this request and write the fresh response.",
    )
    parser.add_argument(
        "--cache-ttl-hours",
        type=float,
        default=None,
        help="Cache TTL in hours (default 168; env KINLOOM_SE_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).",
    )


def _run_search(args: argparse.Namespace) -> int:
    _validate_paging(args.limit, args.offset)
    _validate_year_range(args.year_min, args.year_max)

    params: dict[str, Any] = {
        "limit": args.limit,
        "offset": args.offset,
        "sort": args.sort,
    }
    if args.text.strip():
        params["text"] = args.text.strip()
    if args.name.strip():
        params["name"] = args.name.strip()
    if args.place.strip():
        params["place"] = args.place.strip()
    if args.transcribed.strip():
        params["transcribed_text"] = args.transcribed.strip()
        params["only_digitised_materials"] = "true"
    if args.digitized:
        params["only_digitised_materials"] = "true"

    if not any(k in params for k in ("text", "name", "place", "transcribed_text")):
        raise CliError(
            "Provide at least one search term: --text, --name, --place, or --transcribed.",
            2,
        )

    if args.year_min is not None:
        params["year_min"] = args.year_min
    if args.year_max is not None:
        params["year_max"] = args.year_max

    if args.facet.strip():
        params["facet"] = args.facet.strip()
    elif args.record_type and args.record_type != "all":
        facet = RECORD_TYPE_FACETS.get(args.record_type)
        if not facet:
            raise CliError(f"Unsupported --type: {args.record_type!r}", 2)
        params["facet"] = facet

    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    result, hit = cached_call(
        "records:search",
        params,
        lambda: _fetch_records_endpoint(RECORDS_API_URL, params),
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: bool(r.get("verified")),
    )
    if args.as_json:
        _emit_json({**result, "cache_hit": hit})
    else:
        _print_search_text("Riksarkivet Search", result, hit)
    return 0


def _run_births(args: argparse.Namespace) -> int:
    _validate_paging(args.limit, args.offset)
    _validate_year_range(args.year_min, args.year_max)
    params: dict[str, Any] = {
        "limit": args.limit,
        "offset": args.offset,
        "sort": args.sort,
    }
    if args.first.strip():
        params["first_name"] = args.first.strip()
    if args.father.strip():
        params["fathers_name"] = args.father.strip()
    if args.mother.strip():
        params["mothers_name"] = args.mother.strip()
    if args.place.strip():
        params["place"] = args.place.strip()
    if args.witness.strip():
        params["baptismal_witness"] = args.witness.strip()
    if args.gender.strip():
        mapped = GENDER_ALIASES.get(args.gender.strip().lower())
        if not mapped:
            raise CliError(
                f"Invalid --gender {args.gender!r}; use Kvinna/female, Man/male, or Okänt/unknown.",
                2,
            )
        params["gender"] = mapped
    if args.year_min is not None:
        params["year_min"] = args.year_min
    if args.year_max is not None:
        params["year_max"] = args.year_max

    if not any(
        k in params
        for k in ("first_name", "fathers_name", "mothers_name", "place", "baptismal_witness", "year_min", "year_max")
    ):
        raise CliError(
            "Provide at least one filter (--first, --father, --mother, --place, --witness, or --year-min/--year-max).",
            2,
        )

    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    result, hit = cached_call(
        "records:births",
        params,
        lambda: _fetch_records_endpoint(BIRTHS_API_URL, params),
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: bool(r.get("verified")),
    )
    if args.as_json:
        _emit_json({**result, "cache_hit": hit})
    else:
        _print_search_text("Riksarkivet Birth Records", result, hit)
    return 0


def _run_marriages(args: argparse.Namespace) -> int:
    _validate_paging(args.limit, args.offset)
    _validate_year_range(args.year_min, args.year_max)
    params: dict[str, Any] = {
        "limit": args.limit,
        "offset": args.offset,
        "sort": args.sort,
    }
    if args.groom.strip():
        params["grooms_name"] = args.groom.strip()
    if args.bride.strip():
        params["brides_name"] = args.bride.strip()
    if args.groom_place.strip():
        params["grooms_home_place"] = args.groom_place.strip()
    if args.bride_place.strip():
        params["brides_home_place"] = args.bride_place.strip()
    if args.parish.strip():
        params["parish"] = args.parish.strip()
    if args.county.strip():
        params["county"] = args.county.strip()
    if args.year_min is not None:
        params["year_min"] = args.year_min
    if args.year_max is not None:
        params["year_max"] = args.year_max

    if not any(
        k in params
        for k in (
            "grooms_name",
            "brides_name",
            "grooms_home_place",
            "brides_home_place",
            "parish",
            "county",
            "year_min",
            "year_max",
        )
    ):
        raise CliError(
            "Provide at least one filter (--groom, --bride, --parish, --county, or --year-min/--year-max).",
            2,
        )

    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    result, hit = cached_call(
        "records:marriages",
        params,
        lambda: _fetch_records_endpoint(MARRIAGES_API_URL, params),
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: bool(r.get("verified")),
    )
    if args.as_json:
        _emit_json({**result, "cache_hit": hit})
    else:
        _print_search_text("Riksarkivet Marriage Records", result, hit)
    return 0


def _run_deeds(args: argparse.Namespace) -> int:
    _validate_paging(args.limit, args.offset)
    _validate_year_range(args.year_min, args.year_max)
    params: dict[str, Any] = {
        "limit": args.limit,
        "offset": args.offset,
        "sort": args.sort,
    }
    if args.parish.strip():
        params["parish"] = args.parish.strip()
    if args.property_name.strip():
        params["property_name"] = args.property_name.strip()
    if args.tax_unit.strip():
        params["tax_unit"] = args.tax_unit.strip()
    if args.court.strip():
        params["district_court_sessions"] = args.court.strip()
    if args.admin_unit.strip():
        params["administrative_unit"] = args.admin_unit.strip()
    if args.year_min is not None:
        params["year_min"] = args.year_min
    if args.year_max is not None:
        params["year_max"] = args.year_max

    if not any(
        k in params
        for k in ("parish", "property_name", "tax_unit", "district_court_sessions", "administrative_unit", "year_min", "year_max")
    ):
        raise CliError(
            "Provide at least one filter (--parish, --property, --court, or --year-min/--year-max).",
            2,
        )

    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    result, hit = cached_call(
        "records:deeds",
        params,
        lambda: _fetch_records_endpoint(DEEDS_API_URL, params),
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: bool(r.get("verified")),
    )
    if args.as_json:
        _emit_json({**result, "cache_hit": hit})
    else:
        _print_search_text("Riksarkivet Title Deeds Index", result, hit)
    return 0


def _run_record(args: argparse.Namespace) -> int:
    clean_id = parse_register_id(args.record_id)
    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    result, hit = cached_call(
        "register:detail",
        {"id": clean_id},
        lambda: _fetch_register_detail(clean_id),
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: bool(r.get("verified")),
    )
    if args.as_json:
        _emit_json({**result, "cache_hit": hit})
        return 0
    marker = " [cache]" if hit else ""
    rec = result["record"]
    print(f"Riksarkivet Register Record ({clean_id}){marker}")
    for key, value in rec.items():
        if value not in (None, "", "-"):
            print(f"  {key}: {value}")
    print(f"  url: {result['url']}")
    return 0


def _run_collection(args: argparse.Namespace) -> int:
    clean_id = parse_archive_id(args.archive_id)
    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    result, hit = cached_call(
        "iiif:collection",
        {"archive_id": clean_id},
        lambda: _fetch_iiif_collection(clean_id),
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: bool(r.get("verified")),
    )
    if args.as_json:
        _emit_json({**result, "cache_hit": hit})
        return 0
    marker = " [cache]" if hit else ""
    print(f"{result['label'] or clean_id} | items={result['count']}{marker}")
    if result.get("reference_code"):
        print(f"  Reference: {result['reference_code']}")
    if result.get("institution"):
        print(f"  Institution: {result['institution']}")
    if result.get("date"):
        print(f"  Date: {result['date']}")
    for item in result["items"]:
        ident = item.get("bildid") or item.get("archive_id") or ""
        print(f"  [{item['type']}] {item['label']} | id={ident} | {item['url']}")
    return 0


def _run_manifest(args: argparse.Namespace) -> int:
    if args.limit < 1:
        raise CliError("--limit must be >= 1.", 2)
    vol_id, _page_id = normalize_bildid(args.target)
    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    result, hit = cached_call(
        "iiif:manifest",
        {"bildid": vol_id},
        lambda: _fetch_iiif_manifest(vol_id),
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: bool(r.get("verified")),
    )
    if args.as_json:
        _emit_json({**result, "cache_hit": hit})
        return 0
    marker = " [cache]" if hit else ""
    print(f"{result['label'] or vol_id} | canvases={result['canvas_count']}{marker}")
    print(f"  Manifest: {result['manifest_url']}")
    print(f"  Viewer: {result['bildvisning_url']}")
    for k, v in (result.get("metadata") or {}).items():
        print(f"  {k}: {v}")
    for canvas in result["canvases"][: args.limit]:
        dims = f"{canvas['width']}x{canvas['height']}" if canvas["width"] else ""
        print(f"  p.{canvas['index']} | {canvas['page_id']} | {dims} | {canvas['full_image_url']}")
    if result["canvas_count"] > args.limit:
        print(f"  ... ({result['canvas_count'] - args.limit} more pages; pass --limit or --json to view all)")
    return 0


def _run_download(args: argparse.Namespace) -> int:
    info = download_iiif_image(
        args.target,
        args.out,
        page=args.page,
        width=args.width,
        full=args.full,
        overwrite=args.overwrite,
    )
    if args.as_json:
        _emit_json(info)
        return 0
    verb = "Exists (skip)" if info["skipped"] else "Downloaded"
    print(f"{verb}: {info['path']} ({info['bytes']:,} bytes, {info['format']})")
    print(f"  Source: {info['url']}")
    print(f"  Viewer: {info['bildvisning_url']}")
    return 0


def _run_census_info(args: argparse.Namespace) -> int:
    query: dict[str, str] = {"AvanceradSok": "False"}
    if args.surname.strip():
        query["Efternamn"] = args.surname.strip()
    if args.given.strip():
        query["Fornamn"] = args.given.strip()
    if args.birth_year is not None:
        if not 1700 <= args.birth_year <= 1930:
            raise CliError("--birth-year must be between 1700 and 1930.", 2)
        query["Fodelsear"] = str(args.birth_year)
    if args.parish.strip():
        query["Hemforsamling"] = args.parish.strip()
    if args.year is not None:
        flag = CENSUS_YEAR_FLAGS.get(args.year)
        if not flag:
            valid = ", ".join(str(y) for y in sorted(CENSUS_YEAR_FLAGS))
            raise CliError(f"Unsupported census --year {args.year}; choose from: {valid}.", 2)
        query[flag] = "true"

    census_url = f"{FOLKRAKNINGAR_URL}?{urlencode(query)}" if len(query) > 1 else FOLKRAKNINGAR_URL
    church_url = (
        f"{KYRKOARKIV_URL}?{urlencode({'Arkiv': args.parish.strip(), 'AvanceradSok': 'False'})}"
        if args.parish.strip()
        else KYRKOARKIV_URL
    )
    payload = {
        "name": "Riksarkivet Folkräkningar (Swedish National Censuses 1860-1930)",
        "status": "browser-only",
        "reason": "sok.riksarkivet.se redirects automated HTTP clients to /captcha.",
        "census_url": census_url,
        "church_archives_url": church_url,
        "open_census_years": sorted(CENSUS_YEAR_FLAGS.keys()),
    }
    if args.as_json:
        _emit_json(payload)
        return 0
    print("Riksarkivet Folkräkningar (browser only):")
    print(f"  Census search URL: {census_url}")
    print(f"  Parish church archives URL: {church_url}")
    print("  Open census years on sok.riksarkivet.se: 1860, 1870, 1880, 1890, 1900, 1910, 1930")
    print("  Note: sok.riksarkivet.se web search endpoints enforce a CAPTCHA for automated clients.")
    print("  Use `se-archives search`, `births`, `marriages`, `collection`, `manifest`, and `download`")
    print("  for the open public data.riksarkivet.se and lbiiif.riksarkivet.se APIs.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="se-archives",
        description="Search Swedish National Archives (Riksarkivet) open APIs and download IIIF scans.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_search = sub.add_parser(
        "search",
        help="Search Riksarkivet archives, digitized volumes, registers, and HTR transcribed text.",
    )
    p_search.add_argument("--text", default="", help="Free-text query across titles, notes, and metadata.")
    p_search.add_argument("--name", default="", help="Person or organization name query.")
    p_search.add_argument("--place", default="", help="Parish, town, or county name query.")
    p_search.add_argument(
        "--transcribed",
        default="",
        help="Search handwritten text recognition (HTR) transcripts across digitized volumes.",
    )
    p_search.add_argument(
        "--type",
        dest="record_type",
        choices=["all", *sorted(RECORD_TYPE_FACETS.keys())],
        default="all",
        help="Filter by record type (default: all).",
    )
    p_search.add_argument("--facet", default="", help="Raw Riksarkivet facet string override.")
    p_search.add_argument("--digitized", action="store_true", help="Limit results to digitized materials.")
    p_search.add_argument("--year-min", type=int, default=None, help="Earliest year (YYYY).")
    p_search.add_argument("--year-max", type=int, default=None, help="Latest year (YYYY).")
    p_search.add_argument(
        "--sort",
        choices=["relevance", "alphaAsc", "alphaDesc", "timeAsc", "timeDesc"],
        default="relevance",
        help="Sort order (default: relevance).",
    )
    p_search.add_argument("--limit", type=int, default=20, help="Results per page, 1-100 (default: 20).")
    p_search.add_argument("--offset", type=int, default=0, help="0-based result offset (default: 0).")
    _add_cache_and_json_args(p_search)
    p_search.set_defaults(handler=_run_search)

    p_births = sub.add_parser("births", help="Search Riksarkivet indexed birth records (Födelseregister).")
    p_births.add_argument("--first", default="", help="Child's given name.")
    p_births.add_argument("--father", default="", help="Father's name.")
    p_births.add_argument("--mother", default="", help="Mother's name.")
    p_births.add_argument("--place", default="", help="Parish or birth place.")
    p_births.add_argument("--witness", default="", help="Baptismal witness name.")
    p_births.add_argument("--gender", default="", help="Gender (Kvinna/female, Man/male, Okänt/unknown).")
    p_births.add_argument("--year-min", type=int, default=None, help="Earliest birth year (YYYY).")
    p_births.add_argument("--year-max", type=int, default=None, help="Latest birth year (YYYY).")
    p_births.add_argument("--sort", choices=["first_name", "date"], default="date", help="Sort order (default: date).")
    p_births.add_argument("--limit", type=int, default=20, help="Results per page, 1-100 (default: 20).")
    p_births.add_argument("--offset", type=int, default=0, help="0-based result offset (default: 0).")
    _add_cache_and_json_args(p_births)
    p_births.set_defaults(handler=_run_births)

    p_marriages = sub.add_parser("marriages", help="Search Riksarkivet indexed marriage records (Vigselregister).")
    p_marriages.add_argument("--groom", default="", help="Groom's name.")
    p_marriages.add_argument("--bride", default="", help="Bride's name.")
    p_marriages.add_argument("--groom-place", default="", help="Groom's home place.")
    p_marriages.add_argument("--bride-place", default="", help="Bride's home place.")
    p_marriages.add_argument("--parish", default="", help="Marriage parish.")
    p_marriages.add_argument("--county", default="", help="Swedish county (län).")
    p_marriages.add_argument("--year-min", type=int, default=None, help="Earliest marriage year (YYYY).")
    p_marriages.add_argument("--year-max", type=int, default=None, help="Latest marriage year (YYYY).")
    p_marriages.add_argument(
        "--sort",
        choices=["grooms_name", "brides_name", "date"],
        default="date",
        help="Sort order (default: date).",
    )
    p_marriages.add_argument("--limit", type=int, default=20, help="Results per page, 1-100 (default: 20).")
    p_marriages.add_argument("--offset", type=int, default=0, help="0-based result offset (default: 0).")
    _add_cache_and_json_args(p_marriages)
    p_marriages.set_defaults(handler=_run_marriages)

    p_deeds = sub.add_parser("deeds", help="Search Riksarkivet indexed title deeds (Lagfartsregister).")
    p_deeds.add_argument("--parish", default="", help="Parish name.")
    p_deeds.add_argument("--property", dest="property_name", default="", help="Farm or property name.")
    p_deeds.add_argument("--tax-unit", default="", help="Tax assessment unit (mantal).")
    p_deeds.add_argument("--court", default="", help="District court session (ting).")
    p_deeds.add_argument("--admin-unit", default="", help="Administrative unit.")
    p_deeds.add_argument("--year-min", type=int, default=None, help="Earliest year (YYYY).")
    p_deeds.add_argument("--year-max", type=int, default=None, help="Latest year (YYYY).")
    p_deeds.add_argument("--sort", choices=["parish", "year"], default="year", help="Sort order (default: year).")
    p_deeds.add_argument("--limit", type=int, default=20, help="Results per page, 1-100 (default: 20).")
    p_deeds.add_argument("--offset", type=int, default=0, help="0-based result offset (default: 0).")
    _add_cache_and_json_args(p_deeds)
    p_deeds.set_defaults(handler=_run_deeds)

    p_record = sub.add_parser("record", help="Fetch full JSON detail for a register record ID or URL.")
    p_record.add_argument("record_id", help="Register record ID or https://data.riksarkivet.se/register/<id> URL.")
    _add_cache_and_json_args(p_record)
    p_record.set_defaults(handler=_run_record)

    p_coll = sub.add_parser(
        "collection",
        help="Browse an archive or series IIIF Collection (lists child series and digitized volume manifests).",
    )
    p_coll.add_argument("archive_id", help="Archive/series ID (from search output) or IIIF collection URL.")
    _add_cache_and_json_args(p_coll)
    p_coll.set_defaults(handler=_run_collection)

    p_manifest = sub.add_parser("manifest", help="Inspect a digitized volume's IIIF Presentation v3 Manifest.")
    p_manifest.add_argument(
        "target",
        help="Volume bildid (e.g. 00124895, 80002567), bildvisning URL, or lbiiif manifest URL.",
    )
    p_manifest.add_argument("--limit", type=int, default=30, help="Canvases to show in text output (default: 30).")
    _add_cache_and_json_args(p_manifest)
    p_manifest.set_defaults(handler=_run_manifest)

    p_dl = sub.add_parser("download", help="Download a verified IIIF page scan JPEG from lbiiif.riksarkivet.se.")
    p_dl.add_argument(
        "target",
        help="Page bildid (e.g. 00124895_00001), volume bildid (with --page), bildvisning URL, or IIIF image URL.",
    )
    p_dl.add_argument("--page", type=int, default=None, help="1-based page number when target is a volume bildid.")
    p_dl.add_argument("--width", type=int, default=None, help="Scaled pixel width (64-12000; default: full max).")
    p_dl.add_argument("--full", action="store_true", help="Download full resolution (full/max/0/default.jpg).")
    p_dl.add_argument("--out", required=True, help="Output JPEG file path or directory.")
    p_dl.add_argument("--overwrite", action="store_true", help="Overwrite an existing output file.")
    p_dl.add_argument("--json", dest="as_json", action="store_true", help="Output structured JSON.")
    p_dl.set_defaults(handler=_run_download)

    p_census = sub.add_parser(
        "census",
        help="Build browser URLs for Swedish National Censuses (Folkräkningar 1860-1930; CAPTCHA-gated web UI).",
    )
    p_census.add_argument("--surname", default="", help="Surname (Efternamn).")
    p_census.add_argument("--given", default="", help="Given name (Fornamn).")
    p_census.add_argument("--birth-year", type=int, default=None, help="Birth year (1700-1930).")
    p_census.add_argument("--parish", default="", help="Home parish (Hemförsamling).")
    p_census.add_argument("--year", type=int, default=None, help="Census year (1860, 1870, 1880, 1890, 1900, 1910, 1930).")
    p_census.add_argument("--json", dest="as_json", action="store_true", help="Output structured JSON.")
    p_census.set_defaults(handler=_run_census_info)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except CliError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return exc.exit_code


if __name__ == "__main__":
    sys.exit(main())
