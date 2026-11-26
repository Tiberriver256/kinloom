#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "httpx>=0.27",
# ]
# ///
"""Search Minnesota Historical Society public archives (People Records & Newspapers Hub).

Verified live public endpoints (no API key, no login):
  - MNHS People Records Search JSON API (https://www.mnhs.org/_hcms/api):
      * Death Records Index (1904-2001)
      * Birth Records Index (1900-1934)
      * Minnesota State Censuses (1849-1905)
      * Veterans Graves Registration (1857-1975)
      * WWI Gold Star Roll (1915-1921), WWI Bonuses, WWI Service Questionnaires,
        and WWI Soldier Photos
  - MNHS Digital Newspaper Hub (https://newspapers.mnhs.org):
      * Full-text and date-range search across digitized Minnesota newspapers
      * Structured issue metadata and verified thumbnail downloads

Minnesota Digital Library (https://collection.mndigital.org) returns HTTP 403
(Cloudflare challenge) to automated requests and is therefore documented as
browser-only via the `mdl` subcommand.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from typing import Any, Callable, Iterator
from urllib.parse import parse_qs, quote, unquote, urljoin, urlparse

import httpx

DEFAULT_CACHE_TTL_HOURS = 168.0
CACHE_SCHEMA = 1
USER_AGENT = "Kinloom/0.18 (genealogy research CLI; +https://github.com/tiberriver256/kinloom)"

MNHS_BASE = "https://www.mnhs.org"
MNHS_PEOPLE_API = f"{MNHS_BASE}/_hcms/api"
MNHS_PEOPLE_RECORD_URL = f"{MNHS_BASE}/search/people/record"
MNHS_PEOPLE_SEARCH_URL = f"{MNHS_BASE}/search/people"

NEWSPAPERS_BASE = "https://newspapers.mnhs.org"
NEWSPAPERS_SEARCH_URL = f"{NEWSPAPERS_BASE}/jsp/PsSearchResults.jsp"
NEWSPAPERS_METADATA_URL = f"{NEWSPAPERS_BASE}/jsp/PsMetadata.jsp"
NEWSPAPERS_VIEWER_URL = f"{NEWSPAPERS_BASE}/jsp/PsImageViewer.jsp"
NEWSPAPERS_THUMB_URL = f"{NEWSPAPERS_BASE}/servlet/PsObjThumb"

MDL_HOME_URL = "https://collection.mndigital.org/"
MDL_DPLA_URL = "https://dp.la/search?partner=%22Minnesota+Digital+Library%22"

ALLOWED_HOSTS = frozenset({"www.mnhs.org", "newspapers.mnhs.org"})
ALLOWED_DOWNLOAD_HOSTS = frozenset({"newspapers.mnhs.org"})
TRANSIENT_STATUS_CODES = frozenset({429, 500, 502, 503, 504})
MAX_HTTP_ATTEMPTS = 3
RETRY_BASE_SECONDS = 0.5

RECORD_TYPE_SPECS: dict[str, dict[str, str | None]] = {
    "death-records": {
        "alias": "death",
        "label": "Death Records (1904-2001)",
        "search_path": "/death/getAllDeathRecords",
        "detail_path": "/death/getDeathRecordById",
        "date_field": "deathDateStart",
        "county_field": "county",
    },
    "birth-records": {
        "alias": "birth",
        "label": "Birth Records (1900-1934)",
        "search_path": "/birth/getAllBirthRecords",
        "detail_path": "/birth/getBirthRecordById",
        "date_field": "birthDateStart",
        "county_field": "county",
    },
    "census": {
        "alias": "census",
        "label": "Minnesota State Censuses (1849-1905)",
        "search_path": "/census/getAllCensusRecords",
        "detail_path": "/census/getCensusRecordById",
        "date_field": "censusDateStart",
        "county_field": "county",
    },
    "vets-graves": {
        "alias": "vets",
        "label": "Veterans Graves Registration (1857-1975)",
        "search_path": "/vets-graves/getAllVetsGravesRecords",
        "detail_path": "/vets-graves/vetsGravesRecordById",
        "date_field": "deathDateStart",
        "county_field": "burialLocation",
    },
    "gold-star": {
        "alias": "gold-star",
        "label": "WWI Gold Star Roll (1915-1921)",
        "search_path": "/gold-star/getAllGoldStarRecords",
        "detail_path": "/gold-star/getGoldStarRecordById",
        "date_field": "deathDateStart",
        "county_field": "residencePriorToService",
    },
    "wwi-bonuses": {
        "alias": "wwi-bonuses",
        "label": "WWI Bonuses",
        "search_path": "/wwi-bonuses-record/getAllWwiBonusesRecord",
        "detail_path": "/wwi-bonuses-record/wwiBonusesRecordById",
        "date_field": None,
        "county_field": "residence",
    },
    "wwi-service": {
        "alias": "wwi-service",
        "label": "WWI Service Questionnaires",
        "search_path": "/wwi-service-record/getAllWwiServiceRecord",
        "detail_path": "/wwi-service-record/wwiServiceRecordById",
        "date_field": None,
        "county_field": "residencePriorToService",
    },
    "wwi-soldiers-photos": {
        "alias": "wwi-photos",
        "label": "WWI Soldier Photos",
        "search_path": "/wwi-soldier-photos-record/getAllWwiSoldierPhotosRecord",
        "detail_path": "/wwi-soldier-photos-record/wwiSoldierPhotosRecordById",
        "date_field": None,
        "county_field": "residence",
    },
}

RECORD_TYPE_ALIASES: dict[str, str] = {
    "death": "death-records",
    "deaths": "death-records",
    "death-records": "death-records",
    "birth": "birth-records",
    "births": "birth-records",
    "birth-records": "birth-records",
    "census": "census",
    "state-census": "census",
    "vets": "vets-graves",
    "veterans": "vets-graves",
    "vets-graves": "vets-graves",
    "gold-star": "gold-star",
    "wwi-bonuses": "wwi-bonuses",
    "wwi-service": "wwi-service",
    "wwi-photos": "wwi-soldiers-photos",
    "wwi-soldiers-photos": "wwi-soldiers-photos",
}

NEWSPAPER_FIELD_MAP: dict[str, str] = {
    "all": "ALL",
    "content": "CONTENT",
    "title": "TITLE",
    "place": "PLACE_OF_PUBLICATION",
    "county": "SUBJECT_COUNTY",
    "city": "SUBJECT_CITY",
    "date": "DATE_PUBLISHED",
}

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
ISO_DATE_RE = re.compile(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$")
DOC_ID_SAFE_RE = re.compile(r"^[A-Za-z0-9._/-]+$")


class CliError(Exception):
    """User-facing CLI error with an exit code."""

    def __init__(self, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def cache_dir() -> Path:
    specific = os.environ.get("KINLOOM_MN_ARCHIVES_CACHE_DIR")
    if specific:
        return Path(specific).expanduser()
    shared = os.environ.get("KINLOOM_CACHE_DIR")
    if shared:
        return Path(shared).expanduser() / "mn-archives"
    return Path.home() / ".cache" / "kinloom" / "mn-archives"


def resolve_ttl_hours(cli_ttl: float | None) -> float:
    if cli_ttl is not None:
        if not math.isfinite(cli_ttl) or cli_ttl < 0:
            raise CliError(f"Invalid --cache-ttl-hours value: {cli_ttl!r} (must be >= 0).", 2)
        return float(cli_ttl)
    raw = os.environ.get("KINLOOM_MN_ARCHIVES_CACHE_TTL_HOURS")
    if raw is not None and raw.strip():
        try:
            parsed = float(raw.strip())
        except ValueError as exc:
            raise CliError(f"Invalid KINLOOM_MN_ARCHIVES_CACHE_TTL_HOURS value: {raw!r}.", 2) from exc
        if not math.isfinite(parsed) or parsed < 0:
            raise CliError(
                f"Invalid KINLOOM_MN_ARCHIVES_CACHE_TTL_HOURS value: {raw!r} (must be >= 0).",
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


def validate_url(url: str, *, allowed_hosts: frozenset[str] = ALLOWED_HOSTS) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise CliError(f"Refusing non-HTTPS URL: {url!r}", 2)
    host = (parsed.hostname or "").lower()
    if host not in allowed_hosts:
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
    allowed_hosts: frozenset[str] = ALLOWED_HOSTS,
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
            raise CliError(f"Minnesota Archives request failed after {attempt} attempt(s): {exc}") from exc
        except httpx.HTTPError as exc:
            raise CliError(f"Minnesota Archives request failed: {exc}") from exc

        final_url = str(resp.url)
        validate_url(final_url, allowed_hosts=allowed_hosts)

        if resp.status_code in TRANSIENT_STATUS_CODES and attempt < MAX_HTTP_ATTEMPTS:
            time.sleep(_retry_delay(attempt, resp))
            continue

        if resp.status_code >= 400:
            raise CliError(f"HTTP {resp.status_code} from {final_url}")
        return resp

    raise CliError(f"Minnesota Archives request failed: {last_exc}")


def resolve_record_type(raw: str) -> str:
    key = raw.strip().lower()
    resolved = RECORD_TYPE_ALIASES.get(key)
    if not resolved:
        valid = ", ".join(sorted(RECORD_TYPE_SPECS.keys()))
        raise CliError(f"Unknown record type {raw!r}. Choose from: {valid}.", 2)
    return resolved


def normalize_iso_date(raw: str, *, end_of_period: bool = False) -> str:
    text = raw.strip()
    m = ISO_DATE_RE.match(text)
    if not m:
        raise CliError(f"Invalid date {raw!r}; expected YYYY, YYYY-MM, or YYYY-MM-DD.", 2)
    year = int(m.group(1))
    month = int(m.group(2)) if m.group(2) else (12 if end_of_period else 1)
    if not 1 <= month <= 12:
        raise CliError(f"Invalid month in date {raw!r}.", 2)
    if m.group(3):
        day = int(m.group(3))
    elif end_of_period:
        # Compute last day of month safely via datetime.
        if month == 12:
            day = 31
        else:
            next_month = datetime(year, month + 1, 1, tzinfo=timezone.utc)
            last_day = datetime.fromtimestamp(next_month.timestamp() - 86400, tz=timezone.utc)
            day = last_day.day
    else:
        day = 1
    try:
        dt = datetime(year, month, day, tzinfo=timezone.utc)
    except ValueError as exc:
        raise CliError(f"Invalid calendar date {raw!r}: {exc}", 2) from exc
    return dt.strftime("%Y-%m-%d")


def date_to_utc_millis(raw: str, *, end_of_period: bool = False) -> int:
    iso = normalize_iso_date(raw, end_of_period=end_of_period)
    dt = datetime.strptime(iso, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _name_filter(field: str, value: str, match: str) -> dict[str, str]:
    clean = value.strip()
    if match == "equals":
        return {"field": field, "term": clean, "op": "="}
    if match == "starts-with":
        return {"field": field, "term": f"{clean}.*", "op": "*"}
    if match == "ends-with":
        return {"field": field, "term": f".*{clean}", "op": "*"}
    if match == "contains":
        return {"field": field, "term": f".*{clean}.*", "op": "*"}
    if match == "soundex":
        return {"field": field, "term": clean, "op": "$"}
    raise CliError(f"Unsupported --match value: {match!r}", 2)


def _county_filters(record_type: str, county: str) -> list[dict[str, str]]:
    clean = re.sub(r"\s+County$", "", county.strip(), flags=re.IGNORECASE)
    if not clean:
        return []
    spec = RECORD_TYPE_SPECS[record_type]
    field = spec["county_field"] or "county"
    if record_type == "vets-graves":
        items = [{"field": field, "term": f"{clean}.*", "op": "*"}]
        if clean.lower().startswith("hennepin"):
            items.append({"field": field, "term": "Fort Snelling.*", "op": "*"})
        return items
    if record_type in ("gold-star", "wwi-service", "wwi-bonuses", "wwi-soldiers-photos"):
        return [{"field": field, "term": f".*{clean}.*", "op": "*"}]
    return [{"field": field, "term": f"{clean}.*", "op": "*"}]


def build_people_query(
    record_type: str,
    *,
    last: str = "",
    first: str = "",
    middle: str = "",
    mother_maiden: str = "",
    county: str = "",
    match: str = "equals",
    begin_date: str = "",
    end_date: str = "",
    cert_id: str = "",
) -> dict[str, Any]:
    filters: list[dict[str, Any]] = []
    if cert_id.strip():
        filters.append({"field": "certificateId", "term": cert_id.strip(), "op": "="})
    else:
        name_clauses: list[dict[str, str]] = []
        if last.strip():
            name_clauses.append(_name_filter("familyName", last, match))
        if first.strip():
            name_clauses.append(_name_filter("firstName", first, match))
        if middle.strip():
            name_clauses.append(_name_filter("middleName", middle, match))
        if mother_maiden.strip():
            if record_type not in ("birth-records", "death-records"):
                raise CliError(
                    "--mother-maiden is only supported for birth-records and death-records.",
                    2,
                )
            name_clauses.append(_name_filter("mothersMaidenName", mother_maiden, match))
        if name_clauses:
            filters.append({"conjunction": "and", "filters": name_clauses})

        if county.strip():
            county_clauses = _county_filters(record_type, county)
            if county_clauses:
                filters.append({"conjunction": "or", "filters": county_clauses})

        date_field = RECORD_TYPE_SPECS[record_type]["date_field"]
        date_clauses: list[dict[str, str]] = []
        if begin_date.strip():
            if not date_field:
                raise CliError(f"Date filters are not supported for {record_type}.", 2)
            date_clauses.append(
                {"field": date_field, "term": normalize_iso_date(begin_date, end_of_period=False), "op": ">="}
            )
        if end_date.strip():
            if not date_field:
                raise CliError(f"Date filters are not supported for {record_type}.", 2)
            date_clauses.append(
                {"field": date_field, "term": normalize_iso_date(end_date, end_of_period=True), "op": "<="}
            )
        if date_clauses:
            filters.append({"conjunction": "and", "filters": date_clauses})

    if not filters:
        raise CliError(
            "Provide at least one filter (--last, --first, --county, --begin-year/--end-year, or --cert-id).",
            2,
        )

    sorts = [
        {"field": "familyName", "direction": "asc", "sortNulls": "last"},
        {"field": "firstName", "direction": "asc", "sortNulls": "last"},
    ]
    return {"query": "", "sorts": sorts, "filters": filters}


def _trim_iso_date(raw: Any) -> str:
    if not isinstance(raw, str):
        return ""
    return raw.split("T", 1)[0].strip()


def _normalize_people_hit(record_type: str, raw: dict[str, Any]) -> dict[str, Any]:
    record_id = str(raw.get("id") or "").strip()
    parts = [raw.get("firstName"), raw.get("middleName"), raw.get("familyName"), raw.get("suffix")]
    full_name = " ".join(str(p).strip() for p in parts if isinstance(p, str) and p.strip())
    date_field = RECORD_TYPE_SPECS[record_type]["date_field"]
    primary_date = _trim_iso_date(raw.get(date_field)) if date_field else ""
    county = (
        raw.get("county")
        or raw.get("burialLocation")
        or raw.get("residencePriorToService")
        or raw.get("residence")
        or ""
    )
    record_url = (
        f"{MNHS_PEOPLE_RECORD_URL}?uuid={quote(record_id, safe='')}&recordType={quote(record_type, safe='')}"
        if record_id
        else MNHS_PEOPLE_SEARCH_URL
    )
    out: dict[str, Any] = {
        "id": record_id,
        "record_type": record_type,
        "name": full_name,
        "first_name": raw.get("firstName") or "",
        "middle_name": raw.get("middleName") or "",
        "family_name": raw.get("familyName") or "",
        "certificate_id": str(raw.get("certificateId") or ""),
        "date": primary_date,
        "county": str(county).strip(),
        "url": record_url,
    }
    if raw.get("mothersMaidenName"):
        out["mothers_maiden_name"] = str(raw["mothersMaidenName"])
    if raw.get("birthDate"):
        out["birth_date"] = _trim_iso_date(raw["birthDate"])
    if raw.get("birthPlace"):
        out["birth_place"] = str(raw["birthPlace"])
    if raw.get("age") is not None and str(raw.get("age")).strip():
        out["age"] = str(raw["age"]).strip()
    if raw.get("locality"):
        out["locality"] = str(raw["locality"]).strip()
    if raw.get("lineInImage") is not None:
        out["line"] = raw["lineInImage"]
    if isinstance(raw.get("militaryServices"), list) and raw["militaryServices"]:
        out["military_services"] = [
            str(item.get("value")).strip()
            for item in raw["militaryServices"]
            if isinstance(item, dict) and item.get("value")
        ]
    return out


def _fetch_people_search(
    record_type: str,
    query_body: dict[str, Any],
    *,
    page: int,
    limit: int,
) -> dict[str, Any]:
    search_path = RECORD_TYPE_SPECS[record_type]["search_path"]
    assert search_path is not None
    url = f"{MNHS_PEOPLE_API}{search_path}?pageNum={page}&pageSize={limit}"
    with _client() as client:
        resp = _request_with_retry(
            client,
            "POST",
            url,
            json=query_body,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
    try:
        body = resp.json()
    except ValueError as exc:
        raise CliError(f"MNHS People API returned non-JSON response from {url}") from exc
    if not isinstance(body, dict) or not (body.get("success") is True or body.get("status") == 200):
        raise CliError(f"MNHS People API returned unsuccessful status from {url}")
    data = body.get("data")
    if not isinstance(data, dict):
        raise CliError(f"MNHS People API missing 'data' object from {url}")
    raw_hits = data.get("hits")
    if not isinstance(raw_hits, list):
        raise CliError(f"MNHS People API missing 'hits' list from {url}")
    records = [_normalize_people_hit(record_type, item) for item in raw_hits if isinstance(item, dict)]
    total = int(data.get("totalHitCount") or 0)
    return {
        "record_type": record_type,
        "total": total,
        "page": int(data.get("pageNum") or page),
        "page_size": int(data.get("pageSize") or limit),
        "page_count": int(data.get("pageCount") or 0),
        "results": records,
        "verified": True,
    }


def _fetch_people_record(record_type: str, record_id: str) -> dict[str, Any]:
    clean_id = record_id.strip()
    if not UUID_RE.match(clean_id):
        raise CliError(f"Invalid MNHS record UUID: {record_id!r}", 2)
    detail_path = RECORD_TYPE_SPECS[record_type]["detail_path"]
    assert detail_path is not None
    url = f"{MNHS_PEOPLE_API}{detail_path}?id={quote(clean_id, safe='')}"
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
        raise CliError(f"MNHS People API returned non-JSON detail response from {url}") from exc
    if not isinstance(body, dict) or not (body.get("success") is True or body.get("status") == 200):
        raise CliError(f"MNHS People API detail lookup failed for {clean_id}")
    data = body.get("data")
    if not isinstance(data, dict) or not data.get("id"):
        raise CliError(f"MNHS record not found: {clean_id} ({record_type})")
    return {
        "record_type": record_type,
        "id": clean_id,
        "summary": _normalize_people_hit(record_type, data),
        "record": data,
        "url": f"{MNHS_PEOPLE_RECORD_URL}?uuid={quote(clean_id, safe='')}&recordType={quote(record_type, safe='')}",
        "verified": True,
    }


class _NewspaperSearchParser(HTMLParser):
    """Parse MNHS Digital Newspaper Hub PsSearchResults.jsp result cells."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.items: list[dict[str, str]] = []
        self._in_cell = False
        self._cell_depth = 0
        self._current: dict[str, str] | None = None
        self._capture: str | None = None
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = dict(attrs)
        cls = attr_map.get("class") or ""
        if tag == "td" and "ps-result-cell" in cls.split():
            self._in_cell = True
            self._cell_depth = 1
            self._current = {}
            return
        if not self._in_cell or self._current is None:
            return
        if tag == "td":
            self._cell_depth += 1
        elif tag == "a" and "ps-result-title" in cls.split():
            href = attr_map.get("href") or ""
            title = (attr_map.get("title") or "").strip()
            if title:
                self._current["title"] = title
            doc_id = _extract_doc_id_from_href(href)
            if doc_id:
                self._current["doc_id"] = doc_id
            self._capture = "title"
            self._buf = []
        elif tag == "div" and "ps-result-detail" in cls.split():
            self._capture = "detail"
            self._buf = []
        elif tag == "img" and "ps-result-thumb" in cls.split():
            src = attr_map.get("src") or ""
            if src:
                cleaned = re.sub(r";jsessionid=[^?]+", "", src)
                self._current["thumb_url"] = urljoin(NEWSPAPERS_BASE, cleaned)

    def handle_endtag(self, tag: str) -> None:
        if not self._in_cell or self._current is None:
            return
        if self._capture == "title" and tag == "a":
            text = " ".join("".join(self._buf).split())
            if text and not self._current.get("title"):
                self._current["title"] = text
            self._capture = None
            self._buf = []
        elif self._capture == "detail" and tag == "div":
            text = " ".join("".join(self._buf).split())
            m = re.match(r"Publication Date:\s*(.+)$", text, re.IGNORECASE)
            if m:
                self._current["publication_date"] = m.group(1).strip()
            elif text:
                self._current.setdefault("detail", text)
            self._capture = None
            self._buf = []
        elif tag == "td":
            self._cell_depth -= 1
            if self._cell_depth <= 0:
                doc_id = self._current.get("doc_id", "")
                if doc_id:
                    quoted = quote(doc_id, safe="")
                    self._current["viewer_url"] = f"{NEWSPAPERS_VIEWER_URL}?doc_id={quoted}"
                    self._current["metadata_url"] = f"{NEWSPAPERS_METADATA_URL}?doc_id={quoted}"
                    if not self._current.get("thumb_url"):
                        self._current["thumb_url"] = f"{NEWSPAPERS_THUMB_URL}?tnName={quoted}"
                    self.items.append(self._current)
                self._in_cell = False
                self._current = None

    def handle_data(self, data: str) -> None:
        if self._capture is not None:
            self._buf.append(data)


class _NewspaperMetadataParser(HTMLParser):
    """Parse MNHS Digital Newspaper Hub PsMetadata.jsp key/value rows."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.fields: dict[str, str] = {}
        self._label: str | None = None
        self._capture: str | None = None
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "td":
            return
        cls = (dict(attrs).get("class") or "").split()
        if "ps-md-field-label" in cls:
            self._capture = "label"
            self._buf = []
        elif "ps-md-field-value" in cls:
            self._capture = "value"
            self._buf = []

    def handle_endtag(self, tag: str) -> None:
        if tag != "td" or self._capture is None:
            return
        text = " ".join("".join(self._buf).split())
        if self._capture == "label":
            self._label = text
        elif self._capture == "value" and self._label:
            self.fields[self._label] = text
            self._label = None
        self._capture = None
        self._buf = []

    def handle_data(self, data: str) -> None:
        if self._capture is not None:
            self._buf.append(data)


def _extract_doc_id_from_href(href: str) -> str:
    cleaned = re.sub(r";jsessionid=[^?]+", "", href)
    parsed = urlparse(cleaned)
    qs = parse_qs(parsed.query)
    vals = qs.get("doc_id")
    if vals and vals[0]:
        return unquote(vals[0]).strip()
    return ""


def parse_newspapers_search_html(html: str) -> tuple[int | None, list[dict[str, str]]]:
    m = re.search(r"\bpsRecCnt\s*=\s*(\d+)\b", html)
    total = int(m.group(1)) if m else None
    parser = _NewspaperSearchParser()
    parser.feed(html)
    return total, parser.items


def parse_newspapers_metadata_html(html: str) -> dict[str, str]:
    parser = _NewspaperMetadataParser()
    parser.feed(html)
    return parser.fields


def validate_newspaper_doc_id(raw: str) -> str:
    clean = unquote(raw.strip())
    if not clean or ".." in clean or clean.startswith("/") or not DOC_ID_SAFE_RE.match(clean):
        raise CliError(f"Invalid MNHS newspaper doc_id: {raw!r}", 2)
    return clean


def _fetch_newspapers_search(
    *,
    query: str,
    field: str,
    begin_date: str,
    end_date: str,
    county: str,
    city: str,
    title: str,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    clean_query = query.strip()
    if len(clean_query.replace("*", "").replace("?", "")) < 2:
        raise CliError("Newspaper query must contain at least 2 non-wildcard characters.", 2)
    if ":" in clean_query or ";" in clean_query:
        raise CliError("Newspaper query cannot contain ':' or ';' characters.", 2)

    params: dict[str, str] = {
        "query1": clean_query,
        "query1_field": NEWSPAPER_FIELD_MAP[field],
        "query1_modifier": "AND",
        "result_items": str(limit),
        "start_index": str(offset),
    }
    clause = 2
    if begin_date.strip() or end_date.strip():
        min_ms = date_to_utc_millis(begin_date or "1849-01-01", end_of_period=False)
        max_ms = date_to_utc_millis(end_date or "2026-12-31", end_of_period=True)
        if min_ms > max_ms:
            raise CliError("Begin date must not be after end date.", 2)
        params[f"query{clause}_field"] = "DATE_PUBLISHED_MILLIS"
        params[f"query{clause}_modifier"] = "AND"
        params[f"query{clause}_min"] = str(min_ms)
        params[f"query{clause}_max"] = str(max_ms)
        clause += 1
    if county.strip():
        params[f"query{clause}"] = re.sub(r"\s+County$", "", county.strip(), flags=re.IGNORECASE)
        params[f"query{clause}_field"] = "SUBJECT_COUNTY"
        params[f"query{clause}_modifier"] = "AND"
        clause += 1
    if city.strip():
        params[f"query{clause}"] = city.strip()
        params[f"query{clause}_field"] = "SUBJECT_CITY"
        params[f"query{clause}_modifier"] = "AND"
        clause += 1
    if title.strip():
        params[f"query{clause}"] = title.strip()
        params[f"query{clause}_field"] = "TITLE"
        params[f"query{clause}_modifier"] = "AND"

    with _client() as client:
        resp = _request_with_retry(client, "GET", NEWSPAPERS_SEARCH_URL, params=params)
    raw_total, items = parse_newspapers_search_html(resp.text)
    verified = raw_total is not None or bool(items)
    return {
        "query": clean_query,
        "field": field,
        "total": raw_total if raw_total is not None else len(items),
        "offset": offset,
        "limit": limit,
        "results": items[:limit],
        "verified": verified,
    }


def _fetch_newspapers_metadata(doc_id: str) -> dict[str, Any]:
    clean_id = validate_newspaper_doc_id(doc_id)
    url = f"{NEWSPAPERS_METADATA_URL}?doc_id={quote(clean_id, safe='')}"
    with _client() as client:
        resp = _request_with_retry(client, "GET", url)
    fields = parse_newspapers_metadata_html(resp.text)
    if not fields:
        raise CliError(f"No metadata found for newspaper doc_id {clean_id!r}.")
    return {
        "doc_id": clean_id,
        "url": url,
        "viewer_url": f"{NEWSPAPERS_VIEWER_URL}?doc_id={quote(clean_id, safe='')}",
        "thumb_url": f"{NEWSPAPERS_THUMB_URL}?tnName={quote(clean_id, safe='')}",
        "fields": fields,
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
        safe_leaf = re.sub(r"[^A-Za-z0-9._-]+", "_", default_name).strip("._") or "image.jpg"
        resolved_dir = target.resolve()
        candidate = (resolved_dir / safe_leaf).resolve()
        if resolved_dir not in candidate.parents:
            raise CliError(f"Output path escapes target directory: {candidate}", 2)
        return candidate
    return target.resolve()


def download_newspaper_thumb(doc_id_or_url: str, out: str, *, overwrite: bool = False) -> dict[str, Any]:
    raw = doc_id_or_url.strip()
    if raw.startswith(("http://", "https://")):
        url = validate_url(raw, allowed_hosts=ALLOWED_DOWNLOAD_HOSTS)
        parsed = urlparse(url)
        qs = parse_qs(parsed.query)
        tn = (qs.get("tnName") or qs.get("doc_id") or [""])[0]
        stem = re.sub(r"[^A-Za-z0-9._-]+", "_", unquote(tn)) if tn else "newspaper_thumb"
    else:
        doc_id = validate_newspaper_doc_id(raw)
        url = f"{NEWSPAPERS_THUMB_URL}?tnName={quote(doc_id, safe='')}"
        stem = re.sub(r"[^A-Za-z0-9._-]+", "_", doc_id)

    dest = resolve_safe_output_path(out, f"{stem}.jpg")
    if dest.exists() and not overwrite:
        data = dest.read_bytes()
        fmt = detect_image_format(data)
        if not fmt:
            raise CliError(f"Existing file at {dest} is not a valid image; pass --overwrite to replace.")
        return {
            "url": url,
            "path": str(dest),
            "bytes": len(data),
            "format": fmt,
            "skipped": True,
        }

    with _client() as client:
        resp = _request_with_retry(client, "GET", url, allowed_hosts=ALLOWED_DOWNLOAD_HOSTS)
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
        "url": url,
        "path": str(dest),
        "bytes": len(payload),
        "format": fmt,
        "skipped": False,
    }


def _emit_json(payload: Any) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def _print_people_text(result: dict[str, Any], cache_hit: bool) -> None:
    marker = " [cache]" if cache_hit else ""
    label = RECORD_TYPE_SPECS[result["record_type"]]["label"]
    print(
        f"{label} | total={result['total']} | page {result['page']}/{max(result['page_count'], 1)} "
        f"| showing {len(result['results'])}{marker}"
    )
    for rec in result["results"]:
        parts = [rec.get("name") or "(unnamed)"]
        if rec.get("date"):
            parts.append(rec["date"])
        if rec.get("county"):
            parts.append(rec["county"])
        if rec.get("locality"):
            parts.append(rec["locality"])
        if rec.get("age"):
            parts.append(f"age {rec['age']}")
        if rec.get("mothers_maiden_name"):
            parts.append(f"mother {rec['mothers_maiden_name']}")
        if rec.get("certificate_id"):
            parts.append(f"cert {rec['certificate_id']}")
        if rec.get("id"):
            parts.append(f"id {rec['id']}")
        print(" | ".join(parts))


def _add_cache_and_json_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", dest="as_json", action="store_true", help="Output structured JSON.")
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Bypass the disk cache for this request and refresh the cached entry.",
    )
    parser.add_argument(
        "--cache-ttl-hours",
        type=float,
        default=None,
        help="Cache TTL in hours (default 168; env KINLOOM_MN_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).",
    )


def _add_people_search_args(parser: argparse.ArgumentParser, *, include_mother: bool = True) -> None:
    parser.add_argument("--last", default="", help="Family (last) name.")
    parser.add_argument("--first", default="", help="Given (first) name.")
    parser.add_argument("--middle", default="", help="Middle name.")
    if include_mother:
        parser.add_argument(
            "--mother-maiden",
            default="",
            help="Mother's maiden surname (birth 1900-1934; death 1955-2001).",
        )
    parser.add_argument("--county", default="", help="Minnesota county name (e.g. Hennepin, Ramsey).")
    parser.add_argument(
        "--match",
        choices=["equals", "starts-with", "ends-with", "contains", "soundex"],
        default="equals",
        help="Name match operator (default: equals).",
    )
    parser.add_argument("--begin-year", default="", help="Earliest year or date (YYYY or YYYY-MM-DD).")
    parser.add_argument("--end-year", default="", help="Latest year or date (YYYY or YYYY-MM-DD).")
    parser.add_argument("--cert-id", default="", help="Exact MNHS certificate ID.")
    parser.add_argument("--page", type=int, default=1, help="1-based results page (default: 1).")
    parser.add_argument("--limit", type=int, default=25, help="Results per page, 1-100 (default: 25).")
    _add_cache_and_json_args(parser)


def _run_people_command(args: argparse.Namespace, record_type: str) -> int:
    if args.page < 1:
        raise CliError("--page must be >= 1.", 2)
    if not 1 <= args.limit <= 100:
        raise CliError("--limit must be between 1 and 100.", 2)
    mother_maiden = getattr(args, "mother_maiden", "")
    query_body = build_people_query(
        record_type,
        last=args.last,
        first=args.first,
        middle=args.middle,
        mother_maiden=mother_maiden,
        county=args.county,
        match=args.match,
        begin_date=args.begin_year,
        end_date=args.end_year,
        cert_id=args.cert_id,
    )
    cache_payload = {
        "record_type": record_type,
        "query": query_body,
        "page": args.page,
        "limit": args.limit,
    }
    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    result, hit = cached_call(
        f"people:{record_type}",
        cache_payload,
        lambda: _fetch_people_search(record_type, query_body, page=args.page, limit=args.limit),
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: bool(r.get("verified")),
    )
    if args.as_json:
        _emit_json({**result, "cache_hit": hit})
    else:
        _print_people_text(result, hit)
    return 0


def _run_record_command(args: argparse.Namespace) -> int:
    record_type = resolve_record_type(args.record_type)
    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    clean_id = args.uuid.strip()
    if not UUID_RE.match(clean_id):
        raise CliError(f"Invalid MNHS record UUID: {args.uuid!r}", 2)
    result, hit = cached_call(
        f"record:{record_type}",
        {"record_type": record_type, "id": clean_id},
        lambda: _fetch_people_record(record_type, clean_id),
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: bool(r.get("verified")),
    )
    if args.as_json:
        _emit_json({**result, "cache_hit": hit})
        return 0
    marker = " [cache]" if hit else ""
    summary = result["summary"]
    print(f"{RECORD_TYPE_SPECS[record_type]['label']}{marker}")
    print(f"  Name: {summary.get('name') or '(unnamed)'}")
    if summary.get("date"):
        print(f"  Date: {summary['date']}")
    if summary.get("county"):
        print(f"  County: {summary['county']}")
    if summary.get("certificate_id"):
        print(f"  Certificate ID: {summary['certificate_id']}")
    if summary.get("mothers_maiden_name"):
        print(f"  Mother's maiden name: {summary['mothers_maiden_name']}")
    if summary.get("birth_date"):
        print(f"  Birth date: {summary['birth_date']}")
    if summary.get("birth_place"):
        print(f"  Birth place: {summary['birth_place']}")
    print(f"  URL: {result['url']}")
    return 0


def _run_newspapers_search(args: argparse.Namespace) -> int:
    if not 1 <= args.limit <= 100:
        raise CliError("--limit must be between 1 and 100.", 2)
    if args.offset < 0:
        raise CliError("--offset must be >= 0.", 2)
    cache_payload = {
        "query": args.query.strip(),
        "field": args.field,
        "begin_year": args.begin_year,
        "end_year": args.end_year,
        "county": args.county,
        "city": args.city,
        "title": args.title,
        "limit": args.limit,
        "offset": args.offset,
    }
    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    result, hit = cached_call(
        "newspapers:search",
        cache_payload,
        lambda: _fetch_newspapers_search(
            query=args.query,
            field=args.field,
            begin_date=args.begin_year,
            end_date=args.end_year,
            county=args.county,
            city=args.city,
            title=args.title,
            limit=args.limit,
            offset=args.offset,
        ),
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: bool(r.get("verified")),
    )
    if args.as_json:
        _emit_json({**result, "cache_hit": hit})
        return 0
    marker = " [cache]" if hit else ""
    print(
        f"MNHS Digital Newspaper Hub | total={result['total']} | offset={result['offset']} "
        f"| showing {len(result['results'])}{marker}"
    )
    for item in result["results"]:
        parts = [
            item.get("title") or "(untitled)",
            item.get("publication_date") or "",
            item.get("doc_id") or "",
            item.get("viewer_url") or "",
        ]
        print(" | ".join(p for p in parts if p))
    return 0


def _run_newspapers_metadata(args: argparse.Namespace) -> int:
    clean_id = validate_newspaper_doc_id(args.doc_id)
    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    result, hit = cached_call(
        "newspapers:metadata",
        {"doc_id": clean_id},
        lambda: _fetch_newspapers_metadata(clean_id),
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: bool(r.get("verified")),
    )
    if args.as_json:
        _emit_json({**result, "cache_hit": hit})
        return 0
    marker = " [cache]" if hit else ""
    print(f"Newspaper Metadata ({clean_id}){marker}")
    for key, val in result["fields"].items():
        print(f"  {key}: {val}")
    print(f"  Viewer: {result['viewer_url']}")
    return 0


def _run_newspapers_download(args: argparse.Namespace) -> int:
    info = download_newspaper_thumb(args.target, args.out, overwrite=args.overwrite)
    if args.as_json:
        _emit_json(info)
        return 0
    verb = "Exists (skip)" if info["skipped"] else "Downloaded"
    print(f"{verb}: {info['path']} ({info['bytes']:,} bytes, {info['format']})")
    return 0


def _run_mdl_info(args: argparse.Namespace) -> int:
    payload = {
        "name": "Minnesota Digital Library",
        "status": "browser-only",
        "reason": "Automated HTTP requests to collection.mndigital.org receive HTTP 403 (Cloudflare challenge).",
        "home_url": MDL_HOME_URL,
        "dpla_url": MDL_DPLA_URL,
    }
    if args.as_json:
        _emit_json(payload)
        return 0
    print("Minnesota Digital Library (browser only):")
    print(f"  Home: {MDL_HOME_URL}")
    print(f"  DPLA partner search: {MDL_DPLA_URL}")
    print("  Note: collection.mndigital.org gates automated HTTP requests behind Cloudflare (HTTP 403).")
    print("  Use a browser for MDL photographs, county histories, plats, and archival manuscripts.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mn-archives",
        description="Search Minnesota Historical Society People Records and Digital Newspaper Hub (no key, no login).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_death = sub.add_parser("death", help="Search MNHS Death Records Index (1904-2001).")
    _add_people_search_args(p_death, include_mother=True)
    p_death.set_defaults(handler=lambda a: _run_people_command(a, "death-records"))

    p_birth = sub.add_parser("birth", help="Search MNHS Birth Records Index (1900-1934).")
    _add_people_search_args(p_birth, include_mother=True)
    p_birth.set_defaults(handler=lambda a: _run_people_command(a, "birth-records"))

    p_census = sub.add_parser("census", help="Search MNHS Minnesota State Censuses (1849-1905).")
    _add_people_search_args(p_census, include_mother=False)
    p_census.set_defaults(handler=lambda a: _run_people_command(a, "census"))

    p_vets = sub.add_parser("vets", help="Search MNHS Veterans Graves Registration (1857-1975).")
    _add_people_search_args(p_vets, include_mother=False)
    p_vets.set_defaults(handler=lambda a: _run_people_command(a, "vets-graves"))

    p_people = sub.add_parser(
        "people",
        help="Search any MNHS People Records collection (--type death|birth|census|vets-graves|gold-star|wwi-*).",
    )
    p_people.add_argument(
        "--type",
        dest="record_type",
        default="death-records",
        help="Record collection (death, birth, census, vets-graves, gold-star, wwi-bonuses, wwi-service, wwi-soldiers-photos).",
    )
    _add_people_search_args(p_people, include_mother=True)
    p_people.set_defaults(handler=lambda a: _run_people_command(a, resolve_record_type(a.record_type)))

    p_record = sub.add_parser("record", help="Fetch a single MNHS People Record by UUID and --type.")
    p_record.add_argument("uuid", help="Record UUID from search output.")
    p_record.add_argument(
        "--type",
        dest="record_type",
        required=True,
        help="Record collection (death, birth, census, vets-graves, gold-star, wwi-bonuses, wwi-service, wwi-soldiers-photos).",
    )
    _add_cache_and_json_args(p_record)
    p_record.set_defaults(handler=_run_record_command)

    p_news = sub.add_parser("newspapers", help="Search and inspect MNHS Digital Newspaper Hub issues.")
    news_sub = p_news.add_subparsers(dest="news_command", required=True)

    p_news_search = news_sub.add_parser("search", help="Search digitized Minnesota newspapers.")
    p_news_search.add_argument("query", help="Search word or phrase (at least 2 characters).")
    p_news_search.add_argument(
        "--field",
        choices=sorted(NEWSPAPER_FIELD_MAP.keys()),
        default="content",
        help="Field to search (default: content).",
    )
    p_news_search.add_argument("--begin-year", default="", help="Earliest publication date (YYYY or YYYY-MM-DD).")
    p_news_search.add_argument("--end-year", default="", help="Latest publication date (YYYY or YYYY-MM-DD).")
    p_news_search.add_argument("--county", default="", help="Filter by Minnesota county.")
    p_news_search.add_argument("--city", default="", help="Filter by city.")
    p_news_search.add_argument("--title", default="", help="Filter by newspaper title.")
    p_news_search.add_argument("--limit", type=int, default=20, help="Results per page, 1-100 (default: 20).")
    p_news_search.add_argument("--offset", type=int, default=0, help="0-based start offset (default: 0).")
    _add_cache_and_json_args(p_news_search)
    p_news_search.set_defaults(handler=_run_newspapers_search)

    p_news_meta = news_sub.add_parser("metadata", help="Fetch structured metadata for a newspaper issue doc_id.")
    p_news_meta.add_argument("doc_id", help="Issue doc_id from `newspapers search`.")
    _add_cache_and_json_args(p_news_meta)
    p_news_meta.set_defaults(handler=_run_newspapers_metadata)

    p_news_dl = news_sub.add_parser("download", help="Download a verified newspaper issue thumbnail image.")
    p_news_dl.add_argument("target", help="Issue doc_id or newspapers.mnhs.org thumbnail URL.")
    p_news_dl.add_argument("--out", required=True, help="Output file path or directory.")
    p_news_dl.add_argument("--overwrite", action="store_true", help="Overwrite an existing output file.")
    p_news_dl.add_argument("--json", dest="as_json", action="store_true", help="Output structured JSON.")
    p_news_dl.set_defaults(handler=_run_newspapers_download)

    p_mdl = sub.add_parser("mdl", help="Show browser-only URLs for Minnesota Digital Library.")
    p_mdl.add_argument("--json", dest="as_json", action="store_true", help="Output structured JSON.")
    p_mdl.set_defaults(handler=_run_mdl_info)

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
