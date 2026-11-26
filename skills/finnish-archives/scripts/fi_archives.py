#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "httpx>=0.27",
# ]
# ///
"""Search open Finnish historical and genealogical archives.

Verified live public endpoints (no API key, no login, no CAPTCHA):
  - HisKi (Genealogical Society of Finland, https://hiski.genealogia.fi):
      * GET  /hiski?en+A00 (complete parish list with 4-digit parish codes)
      * POST /hiski (parish and nationwide baptisms, marriages, burials, moves)
      * GET  /hiski?en+<parish>+<book>+<row_id> (individual event detail + SSHY link)
  - Digihakemisto (National Archives of Finland Astia index, https://digihakemisto.net):
      * POST /haku (search National Archives parish church books, henkikirjat,
        court books, estate inventories, and general settlement registers)
      * GET  /aineisto/<id> (inspect archive series and digitized volumes with Astia links)

Finna (https://api.finna.fi and https://www.finna.fi) currently enforces a
Cloudflare managed challenge (HTTP 403, Cf-Mitigated: challenge) on automated
HTTP clients. This CLI never bypasses challenges and instead exposes offline
browser URLs via the `url` subcommand.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import email.utils
import hashlib
import html as html_mod
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from typing import Any, Callable, Iterator
from urllib.parse import urlencode, urljoin, urlparse

import httpx

DEFAULT_CACHE_TTL_HOURS = 168.0
CACHE_SCHEMA = 1
USER_AGENT = "Kinloom/0.21 (genealogy research CLI; +https://github.com/tiberriver256/kinloom)"

HISKI_BASE = "https://hiski.genealogia.fi"
HISKI_ENDPOINT = f"{HISKI_BASE}/hiski"
HISKI_PARISHES_URL = f"{HISKI_ENDPOINT}?en+A00"

DIGIHAKEMISTO_BASE = "https://digihakemisto.net"
DIGIHAKEMISTO_SEARCH_URL = f"{DIGIHAKEMISTO_BASE}/haku"
DIGIHAKEMISTO_ARCHIVE_BASE = f"{DIGIHAKEMISTO_BASE}/aineisto"

ASTIA_CARD_BASE = "https://astia.narc.fi/uusiastia/kortti_aineisto.html"
ASTIA_SEARCH_URL = "https://astia.narc.fi/uusiastia/aineistot.html"
FINNA_SEARCH_URL = "https://www.finna.fi/Search/Results"
DIGI_NEWSPAPERS_URL = "https://digi.kansalliskirjasto.fi/search"
SSHY_BASE_URL = "https://www.sukuhistoria.fi/sshy/index_eng.htm"

ALLOWED_HISKI_HOSTS = frozenset({"hiski.genealogia.fi"})
ALLOWED_DIGIHAKEMISTO_HOSTS = frozenset({"digihakemisto.net"})
TRANSIENT_STATUS_CODES = frozenset({429, 500, 502, 503, 504})
MAX_HTTP_ATTEMPTS = 3
RETRY_BASE_SECONDS = 0.5
MIN_INTERVAL_S = 0.2

BOOK_ALIASES: dict[str, str] = {
    "christened": "kastetut",
    "baptism": "kastetut",
    "baptisms": "kastetut",
    "birth": "kastetut",
    "births": "kastetut",
    "kastetut": "kastetut",
    "married": "vihityt",
    "marriage": "vihityt",
    "marriages": "vihityt",
    "vihityt": "vihityt",
    "buried": "haudatut",
    "burial": "haudatut",
    "burials": "haudatut",
    "death": "haudatut",
    "deaths": "haudatut",
    "haudatut": "haudatut",
    "moved-in": "smuutt",
    "in": "smuutt",
    "smuutt": "smuutt",
    "moved-out": "umuutt",
    "out": "umuutt",
    "umuutt": "umuutt",
    "all": "kaikki",
    "kaikki": "kaikki",
}

BOOK_LABELS: dict[str, str] = {
    "kastetut": "christened",
    "vihityt": "married",
    "haudatut": "buried",
    "smuutt": "moved-in",
    "umuutt": "moved-out",
    "kaikki": "all",
}

DIGIHAKEMISTO_PRESETS: dict[str, str] = {
    "parishes": "*seurakun*, *församl*",
    "henkikirjat": "läänin henkikirjat",
    "tax": "läänin henkikirjat",
    "court": "tuomiokunnan,tuomiokirjat",
    "inventories": "id:perukirjat",
    "say": "id:1585519449",
}

PARISH_CODE_RE = re.compile(r"^\d{4}$")
SAFE_ARCHIVE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
HISKI_EVENT_HREF_RE = re.compile(
    r"/hiski\?(?:en|fi|sv)\+(\d{4})\+(kastetut|vihityt|haudatut|smuutt|umuutt)\+(\d+)",
    re.IGNORECASE,
)
HISKI_PERMALINK_RE = re.compile(r"/hiski\?(?:en|fi|sv)\+(t\d+)", re.IGNORECASE)
TOTAL_EVENTS_RE = re.compile(r"(?:A total of\s+)?(\d+)\s+events?\s+found", re.IGNORECASE)
YEAR_RE = re.compile(r"^\d{4}$")


class CliError(Exception):
    """User-facing CLI error with an exit code."""

    def __init__(self, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.exit_code = exit_code


def cache_dir() -> Path:
    specific = os.environ.get("KINLOOM_FI_ARCHIVES_CACHE_DIR")
    if specific:
        return Path(specific).expanduser()
    shared = os.environ.get("KINLOOM_CACHE_DIR")
    if shared:
        return Path(shared).expanduser() / "fi-archives"
    return Path.home() / ".cache" / "kinloom" / "fi-archives"


def resolve_ttl_hours(cli_ttl: float | None) -> float:
    if cli_ttl is not None:
        if not math.isfinite(cli_ttl) or cli_ttl < 0:
            raise CliError(f"Invalid --cache-ttl-hours value: {cli_ttl!r} (must be >= 0).", 2)
        return float(cli_ttl)
    raw = os.environ.get("KINLOOM_FI_ARCHIVES_CACHE_TTL_HOURS")
    if raw is not None and raw.strip():
        try:
            parsed = float(raw.strip())
        except ValueError as exc:
            raise CliError(f"Invalid KINLOOM_FI_ARCHIVES_CACHE_TTL_HOURS value: {raw!r}.", 2) from exc
        if not math.isfinite(parsed) or parsed < 0:
            raise CliError(
                f"Invalid KINLOOM_FI_ARCHIVES_CACHE_TTL_HOURS value: {raw!r} (must be >= 0).",
                2,
            )
        return parsed
    return DEFAULT_CACHE_TTL_HOURS


@contextmanager
def file_lock(lock_path: Path) -> Iterator[None]:
    """Advisory exclusive lock (POSIX flock); no-op where fcntl is unavailable."""
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


def validate_url(url: str, *, allowed_hosts: frozenset[str]) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise CliError(f"Refusing non-HTTPS URL: {url!r}", 2)
    if parsed.username or parsed.password:
        raise CliError("Refusing URL containing embedded credentials.", 2)
    host = (parsed.hostname or "").lower()
    if host not in allowed_hosts:
        raise CliError(
            f"Refusing host {host!r}; allowed hosts: {', '.join(sorted(allowed_hosts))}.",
            2,
        )
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
            stripped = raw.strip()
            try:
                val = float(stripped)
                if math.isfinite(val) and 0 <= val <= 30:
                    return val
            except ValueError:
                try:
                    dt = email.utils.parsedate_to_datetime(stripped)
                    delta = dt.timestamp() - time.time()
                    if math.isfinite(delta) and 0 <= delta <= 30:
                        return delta
                except (TypeError, ValueError, OverflowError):
                    pass
    if RETRY_BASE_SECONDS <= 0:
        return 0.0
    return RETRY_BASE_SECONDS * (2 ** (attempt - 1))


def _check_not_challenged(resp: httpx.Response, text: str, label: str) -> None:
    if (resp.headers.get("Cf-Mitigated") or "").lower() == "challenge":
        raise CliError(f"{label} returned a Cloudflare challenge; open it in a browser instead.")
    if "Processing JavaScript challenge" in text or "<title>Just a moment...</title>" in text:
        raise CliError(f"{label} returned a JavaScript anti-bot challenge; open it in a browser instead.")


def _request_with_retry(
    client: httpx.Client,
    method: str,
    url: str,
    *,
    allowed_hosts: frozenset[str],
    label: str,
    **kwargs: Any,
) -> httpx.Response:
    validate_url(url, allowed_hosts=allowed_hosts)
    if MIN_INTERVAL_S > 0:
        time.sleep(MIN_INTERVAL_S)
    last_exc: Exception | None = None
    for attempt in range(1, MAX_HTTP_ATTEMPTS + 1):
        try:
            resp = client.request(method, url, **kwargs)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            last_exc = exc
            if attempt < MAX_HTTP_ATTEMPTS:
                delay = _retry_delay(attempt)
                if delay > 0:
                    time.sleep(delay)
                continue
            raise CliError(f"{label} request failed after {attempt} attempt(s): {exc}") from exc
        except httpx.HTTPError as exc:
            raise CliError(f"{label} request failed: {exc}") from exc

        final_url = str(resp.url)
        validate_url(final_url, allowed_hosts=allowed_hosts)

        if resp.status_code in TRANSIENT_STATUS_CODES and attempt < MAX_HTTP_ATTEMPTS:
            delay = _retry_delay(attempt, resp)
            if delay > 0:
                time.sleep(delay)
            continue

        if resp.status_code >= 400:
            if (resp.headers.get("Cf-Mitigated") or "").lower() == "challenge":
                raise CliError(f"{label} returned HTTP {resp.status_code} (Cloudflare challenge); use a browser.")
            raise CliError(f"{label} returned HTTP {resp.status_code} from {final_url}")
        return resp

    raise CliError(f"{label} request failed: {last_exc}")


def _clean_text(raw: str) -> str:
    text = html_mod.unescape(raw).replace("\xa0", " ")
    return " ".join(text.split())


def _decode_hiski(resp: httpx.Response) -> str:
    return resp.content.decode("iso-8859-1", errors="replace")


def parse_hiski_parishes(page: str) -> list[dict[str, str]]:
    """Parse 4-digit parish options from HisKi's /hiski?en+A00 parish list."""
    seen: set[str] = set()
    parishes: list[dict[str, str]] = []
    for match in re.finditer(r'<OPTION\s+VALUE="?([^">]+)"?[^>]*>([^<\r\n]+)', page, re.IGNORECASE):
        code = match.group(1).strip()
        name = _clean_text(match.group(2))
        if not PARISH_CODE_RE.fullmatch(code) or not name or code in seen:
            continue
        seen.add(code)
        parishes.append({
            "code": code,
            "name": name,
            "url": f"{HISKI_ENDPOINT}?en+{code}",
        })
    return parishes


class _HiskiResultsParser(HTMLParser):
    """Stream-parse HisKi legacy HTML tables with unclosed TD/TH/TR elements."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.sections: list[dict[str, Any]] = []
        self._in_font_heading = False
        self._in_bold = False
        self._heading_buf: list[str] = []
        self._current_heading = ""
        self._in_result_table = False
        self._table_depth = 0
        self._current_rows: list[dict[str, Any]] = []
        self._row_cells: list[dict[str, Any]] | None = None
        self._cell: dict[str, Any] | None = None

    def _close_cell(self) -> None:
        if self._cell is not None and self._row_cells is not None:
            self._cell["text"] = _clean_text("".join(self._cell["buf"]))
            del self._cell["buf"]
            self._row_cells.append(self._cell)
            self._cell = None

    def _close_row(self) -> None:
        self._close_cell()
        if self._row_cells is not None:
            if self._row_cells:
                self._current_rows.append({"cells": self._row_cells})
            self._row_cells = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        attr_map = {k.lower(): (v or "") for k, v in attrs}

        if tag == "font" and attr_map.get("size", "").strip() == "+2":
            self._in_font_heading = True
            self._heading_buf = []
            return
        if tag == "b" and self._in_font_heading:
            self._in_bold = True
            return

        if tag == "table":
            if self._in_result_table:
                self._table_depth += 1
            elif attr_map.get("border") == "1":
                self._in_result_table = True
                self._table_depth = 1
                self._current_rows = []
            return

        if not self._in_result_table or self._table_depth != 1:
            return

        if tag == "tr":
            self._close_row()
            self._row_cells = []
        elif tag in ("td", "th"):
            if self._row_cells is None:
                self._row_cells = []
            self._close_cell()
            colspan = 1
            raw_cs = attr_map.get("colspan", "").strip()
            if raw_cs.isdigit():
                colspan = int(raw_cs)
            self._cell = {"tag": tag, "colspan": colspan, "hrefs": [], "buf": []}
        elif tag == "a" and self._cell is not None:
            href = attr_map.get("href", "").strip()
            if href:
                self._cell["hrefs"].append(href)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "b" and self._in_bold:
            self._in_bold = False
            return
        if tag == "font" and self._in_font_heading:
            text = _clean_text("".join(self._heading_buf))
            if text:
                self._current_heading = text
            self._in_font_heading = False
            self._in_bold = False
            self._heading_buf = []
            return
        if tag == "table" and self._in_result_table:
            if self._table_depth == 1:
                self._close_row()
                self.sections.append({"heading": self._current_heading, "rows": self._current_rows})
                self._in_result_table = False
                self._current_rows = []
            self._table_depth -= 1
            return
        if not self._in_result_table or self._table_depth != 1:
            return
        if tag in ("td", "th"):
            self._close_cell()
        elif tag == "tr":
            self._close_row()

    def handle_data(self, data: str) -> None:
        if self._in_font_heading and self._in_bold:
            self._heading_buf.append(data)
        if self._cell is not None:
            self._cell["buf"].append(data)


def _hiski_row_to_record(
    book: str,
    parish_name: str,
    parish_code: str,
    row_id: str,
    href: str,
    texts: list[str],
) -> dict[str, Any]:
    def col(idx: int) -> str:
        return texts[idx] if idx < len(texts) else ""

    base: dict[str, Any] = {
        "parish": parish_name,
        "parish_code": parish_code,
        "book": BOOK_LABELS.get(book, book),
        "book_code": book,
        "row_id": row_id,
        "event_url": urljoin(HISKI_BASE, href),
    }
    if book == "kastetut":
        base.update({
            "born": col(0),
            "christened": col(1),
            "village": col(2),
            "farm": col(3),
            "father": col(4),
            "mother": col(5),
            "child": col(6),
        })
    elif book == "vihityt":
        base.update({
            "announced": col(0),
            "married": col(1),
            "groom_village": col(2),
            "groom_farm": col(3),
            "groom": col(4),
            "bride": col(5),
            "bride_village": col(6),
            "bride_farm": col(7),
        })
    elif book == "haudatut":
        base.update({
            "died": col(0),
            "buried": col(1),
            "village": col(2),
            "farm": col(3),
            "person": col(4),
            "cause": col(5),
            "age_years": col(6),
            "age_months": col(7),
            "age_weeks": col(8),
            "age_days": col(9),
        })
    elif book in ("smuutt", "umuutt"):
        base.update({
            "departure": col(0),
            "arrival": col(1),
            "village": col(2),
            "farm": col(3),
            "person": col(4),
            "other_place": col(5),
        })
    else:
        base["columns"] = texts
    return base


def parse_hiski_results(page: str) -> dict[str, Any]:
    """Parse one or more HisKi HTML result tables (single-parish or all-parish)."""
    parser = _HiskiResultsParser()
    parser.feed(page)
    parser.close()

    records: list[dict[str, Any]] = []
    for section in parser.sections:
        heading = section["heading"]
        parish_name = heading.split(" - ", 1)[0].strip() if " - " in heading else heading
        for row in section["rows"]:
            cells = row["cells"]
            if not cells:
                continue
            if all(cell["tag"] == "th" for cell in cells):
                continue
            event_href = ""
            match: re.Match[str] | None = None
            for href in cells[0]["hrefs"]:
                m = HISKI_EVENT_HREF_RE.search(href)
                if m:
                    event_href = href
                    match = m
                    break
            if match is None:
                if records and len(cells) >= 2 and not cells[0]["text"]:
                    note = " ".join(c["text"] for c in cells[1:] if c["text"]).strip()
                    if note:
                        prev_note = records[-1].get("comment") or ""
                        records[-1]["comment"] = f"{prev_note}; {note}" if prev_note else note
                continue
            parish_code, book_code, row_id = match.group(1), match.group(2).lower(), match.group(3)
            texts = [cell["text"] for cell in cells]
            records.append(
                _hiski_row_to_record(book_code, parish_name, parish_code, row_id, event_href, texts)
            )

    reported_total: int | None = None
    total_matches = TOTAL_EVENTS_RE.findall(page)
    if total_matches:
        reported_total = sum(int(val) for val in total_matches)

    return {
        "total_reported": reported_total if reported_total is not None else len(records),
        "records": records,
    }


def parse_hiski_event_detail(page: str, *, parish_code: str, book_code: str, row_id: str) -> dict[str, Any]:
    """Parse one HisKi event detail page (/hiski?en+<parish>+<book>+<row_id>)."""
    h2 = re.search(r"<H2>(.*?)</H2>", page, re.IGNORECASE | re.DOTALL)
    h3 = re.search(r"<H3>(.*?)</H3>", page, re.IGNORECASE | re.DOTALL)
    parish_name = _clean_text(re.sub(r"<[^>]+>", " ", h2.group(1))) if h2 else ""
    book_title = _clean_text(re.sub(r"<[^>]+>", " ", h3.group(1))) if h3 else BOOK_LABELS.get(book_code, book_code)

    permalink_m = HISKI_PERMALINK_RE.search(page)
    permalink_id = permalink_m.group(1) if permalink_m else ""

    sshy_m = re.search(r'HREF="(https?://www\.sukuhistoria\.fi/[^"]+)"', page, re.IGNORECASE)
    sshy_url = sshy_m.group(1) if sshy_m else ""

    fields: dict[str, str] = {}
    table_m = re.search(r"<TABLE\s+BORDER=4[^>]*>(.*?)</TABLE>", page, re.IGNORECASE | re.DOTALL)
    if table_m:
        body = table_m.group(1)
        for tr_chunk in re.split(r"<TR[^>]*>", body, flags=re.IGNORECASE)[1:]:
            cells = re.split(r"<T[DH][^>]*>", tr_chunk, flags=re.IGNORECASE)[1:]
            cleaned = [_clean_text(re.sub(r"<[^>]+>", " ", c)) for c in cells]
            if not cleaned:
                continue
            label = cleaned[0].rstrip(":").strip()
            values = [v for v in cleaned[1:] if v]
            if label and label.lower() != "links":
                fields[label] = " | ".join(values)

    return {
        "parish": parish_name,
        "parish_code": parish_code,
        "book": book_title,
        "book_code": book_code,
        "row_id": row_id,
        "permalink_id": permalink_id,
        "permalink_url": f"{HISKI_ENDPOINT}?en+{permalink_id}" if permalink_id else "",
        "event_url": f"{HISKI_ENDPOINT}?en+{parish_code}+{book_code}+{row_id}",
        "sshy_url": sshy_url,
        "fields": fields,
    }


def parse_digihakemisto_search(page: str) -> list[dict[str, Any]]:
    """Parse archive rows from Digihakemisto POST /haku."""
    results: list[dict[str, Any]] = []
    row_pattern = re.compile(
        r'<tr\s+class="searchrow[^"]*"[^>]*>(.*?)(?=<tr\s+class="searchrow|</table>)',
        re.IGNORECASE | re.DOTALL,
    )
    for row_m in row_pattern.finditer(page):
        chunk = row_m.group(1)
        link_m = re.search(
            r'<a\s+class="aineisto"\s+href="(/aineisto/([A-Za-z0-9_-]+))"[^>]*>(.*?)</a>',
            chunk,
            re.IGNORECASE | re.DOTALL,
        )
        if not link_m:
            continue
        href, archive_id, link_inner = link_m.group(1), link_m.group(2), link_m.group(3)
        title = _clean_text(re.sub(r"<[^>]+>", " ", link_inner))
        nodigi = bool(re.search(r'\bclass="[^"]*\bnodigi\b', link_inner, re.IGNORECASE))
        comment_m = re.search(
            r'<span\s+class="searchtarget\s+searchtarget2"[^>]*>(.*?)</span>',
            chunk,
            re.IGNORECASE | re.DOTALL,
        )
        comment = _clean_text(re.sub(r"<[^>]+>", " ", comment_m.group(1))) if comment_m else ""
        digitized = (not nodigi) and ("ei digitoitu" not in comment.lower())
        astia_url = f"{ASTIA_CARD_BASE}?id={archive_id}" if archive_id.isdigit() else ""
        results.append({
            "id": archive_id,
            "title": title,
            "comment": comment,
            "digitized": digitized,
            "digihakemisto_url": urljoin(DIGIHAKEMISTO_BASE, href),
            "astia_url": astia_url,
        })
    return results


def parse_digihakemisto_archive(page: str, archive_id: str) -> dict[str, Any]:
    """Parse archive metadata and child series/volumes from /aineisto/<id>."""
    title_m = re.search(r"<title[^>]*>(.*?)</title>", page, re.IGNORECASE | re.DOTALL)
    title = _clean_text(title_m.group(1)) if title_m else ""

    astia_m = re.search(r'id="alkup"\s+href="(https://astia\.narc\.fi/[^"]+)"', page, re.IGNORECASE)
    astia_url = astia_m.group(1) if astia_m else (f"{ASTIA_CARD_BASE}?id={archive_id}" if archive_id.isdigit() else "")

    notes = [
        _clean_text(re.sub(r"<[^>]+>", " ", m.group(1)))
        for m in re.finditer(r'<span\s+class="tieto"[^>]*>(.*?)</span>', page, re.IGNORECASE | re.DOTALL)
    ]
    access_msgs = [
        _clean_text(re.sub(r"<[^>]+>", " ", m.group(1)))
        for m in re.finditer(r'<div\s+class="msg"[^>]*>(.*?)</div>', page, re.IGNORECASE | re.DOTALL)
    ]

    children: list[dict[str, Any]] = []
    row_pattern = re.compile(
        r'<tr\s+class="searchrow[^"]*"[^>]*>(.*?)(?=<tr\s+class="searchrow|</table>)',
        re.IGNORECASE | re.DOTALL,
    )
    for row_m in row_pattern.finditer(page):
        chunk = row_m.group(1)
        link_m = re.search(
            r'<a[^>]*href="(/(?:aineisto|item)/([^"]+))"[^>]*>(.*?)</a>',
            chunk,
            re.IGNORECASE | re.DOTALL,
        )
        if not link_m:
            continue
        href, child_token, link_inner = link_m.group(1), link_m.group(2), link_m.group(3)
        child_id = child_token.strip("/").split("/")[-1]
        child_title = _clean_text(re.sub(r"<[^>]+>", " ", link_inner))
        nodigi = bool(re.search(r'\bclass="[^"]*\bnodigi\b', link_inner, re.IGNORECASE))
        comment_m = re.search(
            r'<span\s+class="searchtarget\s+searchtarget2"[^>]*>(.*?)</span>',
            chunk,
            re.IGNORECASE | re.DOTALL,
        )
        comment = _clean_text(re.sub(r"<[^>]+>", " ", comment_m.group(1))) if comment_m else ""
        digitized = (not nodigi) and ("ei digitoitu" not in comment.lower())
        children.append({
            "id": child_id,
            "kind": "item" if href.startswith("/item/") else "series",
            "title": child_title,
            "comment": comment,
            "digitized": digitized,
            "digihakemisto_url": urljoin(DIGIHAKEMISTO_BASE, href),
            "astia_url": f"{ASTIA_CARD_BASE}?id={child_id}" if child_id.isdigit() else "",
        })

    return {
        "id": archive_id,
        "title": title,
        "digihakemisto_url": f"{DIGIHAKEMISTO_ARCHIVE_BASE}/{archive_id}",
        "astia_url": astia_url,
        "notes": [n for n in notes if n],
        "access_notes": [m for m in access_msgs if m],
        "children": children,
    }


def _load_parishes(*, refresh: bool, ttl_hours: float) -> tuple[list[dict[str, str]], bool]:
    def _fetch() -> dict[str, Any]:
        with _client() as c:
            resp = _request_with_retry(
                c,
                "GET",
                HISKI_PARISHES_URL,
                allowed_hosts=ALLOWED_HISKI_HOSTS,
                label="HisKi parish list",
            )
            html = _decode_hiski(resp)
            _check_not_challenged(resp, html, "HisKi parish list")
        return {"parishes": parse_hiski_parishes(html)}

    data, hit = cached_call(
        "hiski_parishes",
        {"lang": "en"},
        _fetch,
        refresh=refresh,
        ttl_hours=ttl_hours,
        cacheable=lambda r: bool(r.get("parishes")),
    )
    return list(data.get("parishes") or []), bool(hit)


def _resolve_parish_spec(parish: str, *, refresh: bool, ttl_hours: float) -> str:
    cleaned = parish.strip()
    if not cleaned or cleaned.lower() in ("*", "all", "kaikki"):
        return "*"
    parts = [p.strip() for p in cleaned.split(",") if p.strip()]
    if all(PARISH_CODE_RE.fullmatch(p) for p in parts):
        return ",".join(parts)

    parishes, _ = _load_parishes(refresh=refresh, ttl_hours=ttl_hours)
    resolved: list[str] = []
    for part in parts:
        if PARISH_CODE_RE.fullmatch(part):
            resolved.append(part)
            continue
        needle = part.lower()
        exact = [
            p["code"]
            for p in parishes
            if p["name"].lower() == needle
            or any(seg.strip().lower() == needle for seg in p["name"].split(" - "))
        ]
        if len(exact) == 1:
            resolved.append(exact[0])
            continue
        partial = [p for p in parishes if needle in p["name"].lower()]
        if len(partial) == 1:
            resolved.append(partial[0]["code"])
            continue
        if len(partial) > 1:
            sample = ", ".join(f'{p["code"]} ({p["name"]})' for p in partial[:6])
            raise CliError(
                f"Ambiguous parish {part!r}; matches: {sample}. Pass a 4-digit parish code.",
                2,
            )
        raise CliError(
            f"Unknown parish {part!r}. Run `parishes --query {part}` to find its 4-digit code.",
            2,
        )
    return ",".join(resolved)


def _validate_years(from_year: str | None, to_year: str | None) -> tuple[str, str]:
    fy = (from_year or "").strip()
    ty = (to_year or "").strip()
    if fy and not YEAR_RE.fullmatch(fy):
        raise CliError(f"Invalid --from-year {from_year!r}; expected 4-digit YYYY.", 2)
    if ty and not YEAR_RE.fullmatch(ty):
        raise CliError(f"Invalid --to-year {to_year!r}; expected 4-digit YYYY.", 2)
    if fy and ty and int(fy) > int(ty):
        raise CliError("--from-year must not be greater than --to-year.", 2)
    return fy, ty


def _hiski_maxkpl(limit: int) -> str:
    for bucket in (15, 30, 50, 100, 250, 500, 1000):
        if limit <= bucket:
            return str(bucket)
    return "1000"


def _parse_event_ref(raw: str) -> tuple[str, str, str]:
    text = raw.strip()
    if text.startswith(("http://", "https://")):
        validate_url(text, allowed_hosts=ALLOWED_HISKI_HOSTS)
        m = HISKI_EVENT_HREF_RE.search(text)
        if not m:
            raise CliError(
                "Expected a HisKi event URL like https://hiski.genealogia.fi/hiski?en+0001+kastetut+418.",
                2,
            )
        return m.group(1), m.group(2).lower(), m.group(3)
    tokens = re.split(r"[+/:]", text)
    if len(tokens) == 3:
        parish_code, raw_book, row_id = tokens[0].strip(), tokens[1].strip().lower(), tokens[2].strip()
        book_code = BOOK_ALIASES.get(raw_book, "")
        if PARISH_CODE_RE.fullmatch(parish_code) and book_code in ("kastetut", "vihityt", "haudatut", "smuutt", "umuutt") and row_id.isdigit():
            return parish_code, book_code, row_id
    raise CliError(
        f"Invalid HisKi event reference {raw!r}; use '<parish_code>/<book>/<row_id>' "
        "(e.g. '0001/kastetut/418') or a full HisKi event URL.",
        2,
    )


def _parse_archive_id(raw: str) -> str:
    text = raw.strip()
    if text.startswith(("http://", "https://")):
        validate_url(text, allowed_hosts=ALLOWED_DIGIHAKEMISTO_HOSTS)
        parsed = urlparse(text)
        parts = [p for p in parsed.path.split("/") if p]
        if len(parts) >= 2 and parts[0] == "aineisto" and SAFE_ARCHIVE_ID_RE.fullmatch(parts[1]):
            return parts[1]
        raise CliError(f"Expected https://digihakemisto.net/aineisto/<id>, got {raw!r}.", 2)
    if text.lower().startswith("id:"):
        text = text[3:].strip()
    if not SAFE_ARCHIVE_ID_RE.fullmatch(text):
        raise CliError(f"Invalid Digihakemisto archive id {raw!r}.", 2)
    return text


def _emit_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def cmd_parishes(args: argparse.Namespace) -> None:
    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    parishes, hit = _load_parishes(refresh=args.refresh, ttl_hours=ttl)
    total = len(parishes)
    if args.query:
        needle = args.query.strip().lower()
        parishes = [p for p in parishes if needle in p["name"].lower() or needle == p["code"]]
    if args.limit is not None:
        if args.limit < 1:
            raise CliError("--limit must be >= 1.", 2)
        parishes = parishes[: args.limit]
    if args.as_json:
        _emit_json({
            "query": args.query,
            "total": total,
            "returned": len(parishes),
            "parishes": parishes,
            "cache_hit": bool(hit),
        })
        return
    marker = " [cache]" if hit else ""
    print(f"Showing {len(parishes)} of {total} HisKi parish(es):{marker}")
    for p in parishes:
        print(f"  {p['code']}  {p['name']}  {p['url']}")


def cmd_hiski(args: argparse.Namespace) -> None:
    if args.limit < 1 or args.limit > 1000:
        raise CliError("--limit must be between 1 and 1000.", 2)
    book_code = BOOK_ALIASES.get(args.book.strip().lower())
    if not book_code:
        raise CliError(
            f"Unsupported --book {args.book!r}; choose christened, married, buried, moved-in, moved-out, or all.",
            2,
        )
    fy, ty = _validate_years(args.from_year, args.to_year)
    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    srk = _resolve_parish_spec(args.parish, refresh=args.refresh, ttl_hours=ttl)

    if srk == "*" and book_code == "kaikki":
        raise CliError(
            "HisKi does not support nationwide ('*') searches with --book all; "
            "pick --book christened, married, buried, moved-in, or moved-out, or specify a --parish.",
            2,
        )

    form_data: dict[str, str] = {
        "komento": "haku",
        "srk": srk,
        "kirja": book_code,
        "kieli": "en",
        "maxkpl": _hiski_maxkpl(args.limit),
    }
    if fy:
        form_data["alkuvuosi"] = fy
    if ty:
        form_data["loppuvuosi"] = ty
    if args.village:
        form_data["ikyla"] = args.village.strip()

    if book_code == "kastetut":
        if args.given:
            form_data["etunimi"] = args.given.strip()
        if args.father_given:
            form_data["ietunimi"] = args.father_given.strip()
        if args.father_patronymic:
            form_data["ipatronyymi"] = args.father_patronymic.strip()
        if args.surname:
            form_data["isukunimi"] = args.surname.strip()
        if args.mother_given:
            form_data["aetunimi"] = args.mother_given.strip()
        if args.mother_surname:
            form_data["asukunimi"] = args.mother_surname.strip()
    else:
        if args.given:
            form_data["ietunimi"] = args.given.strip()
        elif args.father_given:
            form_data["ietunimi"] = args.father_given.strip()
        if args.father_patronymic:
            form_data["ipatronyymi"] = args.father_patronymic.strip()
        if args.surname:
            form_data["isukunimi"] = args.surname.strip()
        if args.mother_given:
            form_data["aetunimi"] = args.mother_given.strip()
        if args.mother_surname:
            form_data["asukunimi"] = args.mother_surname.strip()

    has_filter = any(
        k in form_data
        for k in ("etunimi", "ietunimi", "ipatronyymi", "isukunimi", "aetunimi", "asukunimi", "ikyla", "alkuvuosi", "loppuvuosi")
    )
    if not has_filter:
        raise CliError("Provide at least one filter (--surname, --given, --village, --from-year, etc.).", 2)

    cache_payload = dict(form_data)

    def _fetch() -> dict[str, Any]:
        encoded = urlencode(form_data, encoding="iso-8859-1", errors="ignore").encode("ascii")
        with _client() as c:
            resp = _request_with_retry(
                c,
                "POST",
                HISKI_ENDPOINT,
                allowed_hosts=ALLOWED_HISKI_HOSTS,
                label="HisKi search",
                content=encoded,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            html = _decode_hiski(resp)
            _check_not_challenged(resp, html, "HisKi search")
        if "unknown parish" in html.lower():
            raise CliError(f"HisKi rejected parish code {srk!r}.")
        return parse_hiski_results(html)

    result, hit = cached_call(
        "hiski_search",
        cache_payload,
        _fetch,
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: isinstance(r.get("records"), list),
    )
    records = list(result.get("records") or [])[: args.limit]
    total_reported = int(result.get("total_reported") or len(records))

    if args.as_json:
        _emit_json({
            "parish": srk,
            "book": BOOK_LABELS.get(book_code, book_code),
            "total_reported": total_reported,
            "returned": len(records),
            "records": records,
            "cache_hit": bool(hit),
        })
        return

    marker = " [cache]" if hit else ""
    print(f"HisKi {BOOK_LABELS.get(book_code, book_code)} (parish={srk}): {total_reported} found, showing {len(records)}:{marker}")
    for rec in records:
        parish_tag = f"{rec['parish']} ({rec['parish_code']})" if rec.get("parish") else rec["parish_code"]
        if rec["book_code"] == "kastetut":
            date_s = rec.get("born") or rec.get("christened") or ""
            print(f"- {date_s} | {parish_tag} | Child: {rec.get('child', '')} | Parents: {rec.get('father', '')} & {rec.get('mother', '')}")
        elif rec["book_code"] == "vihityt":
            date_s = rec.get("married") or rec.get("announced") or ""
            print(f"- {date_s} | {parish_tag} | {rec.get('groom', '')} & {rec.get('bride', '')}")
        elif rec["book_code"] == "haudatut":
            date_s = rec.get("died") or rec.get("buried") or ""
            print(f"- {date_s} | {parish_tag} | {rec.get('person', '')} | Cause: {rec.get('cause', '')}")
        else:
            date_s = rec.get("arrival") or rec.get("departure") or ""
            print(f"- {date_s} | {parish_tag} | {rec.get('person', '')} | Place: {rec.get('other_place', '')}")
        print(f"  {rec['event_url']}")


def cmd_event(args: argparse.Namespace) -> None:
    parish_code, book_code, row_id = _parse_event_ref(args.event_ref)
    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    url = f"{HISKI_ENDPOINT}?en+{parish_code}+{book_code}+{row_id}"

    def _fetch() -> dict[str, Any]:
        with _client() as c:
            resp = _request_with_retry(
                c,
                "GET",
                url,
                allowed_hosts=ALLOWED_HISKI_HOSTS,
                label="HisKi event",
            )
            html = _decode_hiski(resp)
            _check_not_challenged(resp, html, "HisKi event")
        return parse_hiski_event_detail(html, parish_code=parish_code, book_code=book_code, row_id=row_id)

    detail, hit = cached_call(
        "hiski_event",
        {"parish_code": parish_code, "book_code": book_code, "row_id": row_id},
        _fetch,
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: bool(r.get("fields") or r.get("parish")),
    )
    if args.as_json:
        _emit_json({**detail, "cache_hit": bool(hit)})
        return
    marker = " [cache]" if hit else ""
    print(f"{detail['parish']} ({detail['parish_code']}) - {detail['book']} #{detail['row_id']}{marker}")
    for key, val in (detail.get("fields") or {}).items():
        print(f"  {key}: {val}")
    if detail.get("sshy_url"):
        print(f"  SSHY scan link: {detail['sshy_url']}")
    if detail.get("permalink_url"):
        print(f"  Permalink: {detail['permalink_url']}")
    print(f"  Event URL: {detail['event_url']}")


def cmd_archives_search(args: argparse.Namespace) -> None:
    if args.limit < 1 or args.limit > 500:
        raise CliError("--limit must be between 1 and 500.", 2)
    query = (args.query or "").strip()
    if args.preset:
        query = DIGIHAKEMISTO_PRESETS[args.preset]
    if not query:
        raise CliError("Provide QUERY or --preset (parishes, henkikirjat, court, inventories, say).", 2)
    ttl = resolve_ttl_hours(args.cache_ttl_hours)

    def _fetch() -> dict[str, Any]:
        with _client() as c:
            resp = _request_with_retry(
                c,
                "POST",
                DIGIHAKEMISTO_SEARCH_URL,
                allowed_hosts=ALLOWED_DIGIHAKEMISTO_HOSTS,
                label="Digihakemisto search",
                data={"query": query},
            )
            html = resp.text
            _check_not_challenged(resp, html, "Digihakemisto search")
        return {"archives": parse_digihakemisto_search(html)}

    data, hit = cached_call(
        "digihakemisto_search",
        {"query": query},
        _fetch,
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: isinstance(r.get("archives"), list),
    )
    archives = list(data.get("archives") or [])
    if args.digitized:
        archives = [a for a in archives if a.get("digitized")]
    total = len(archives)
    archives = archives[: args.limit]

    if args.as_json:
        _emit_json({
            "query": query,
            "total": total,
            "returned": len(archives),
            "archives": archives,
            "cache_hit": bool(hit),
        })
        return
    marker = " [cache]" if hit else ""
    print(f'Digihakemisto "{query}": {total} match(es), showing {len(archives)}:{marker}')
    for arch in archives:
        flag = "[digitized]" if arch.get("digitized") else "[not-digitized]"
        print(f"- {arch['id']} {flag} {arch['title']}")
        if arch.get("comment"):
            print(f"  {arch['comment']}")
        print(f"  {arch['digihakemisto_url']}")


def cmd_archive_inspect(args: argparse.Namespace) -> None:
    if args.limit < 1 or args.limit > 500:
        raise CliError("--limit must be between 1 and 500.", 2)
    archive_id = _parse_archive_id(args.archive_id)
    ttl = resolve_ttl_hours(args.cache_ttl_hours)
    url = f"{DIGIHAKEMISTO_ARCHIVE_BASE}/{archive_id}"

    def _fetch() -> dict[str, Any]:
        with _client() as c:
            resp = _request_with_retry(
                c,
                "GET",
                url,
                allowed_hosts=ALLOWED_DIGIHAKEMISTO_HOSTS,
                label="Digihakemisto archive",
            )
            html = resp.text
            _check_not_challenged(resp, html, "Digihakemisto archive")
        return parse_digihakemisto_archive(html, archive_id)

    detail, hit = cached_call(
        "digihakemisto_archive",
        {"id": archive_id},
        _fetch,
        refresh=args.refresh,
        ttl_hours=ttl,
        cacheable=lambda r: bool(r.get("title") or r.get("children")),
    )
    children = list(detail.get("children") or [])
    if args.digitized:
        children = [c for c in children if c.get("digitized")]
    total_children = len(children)
    children = children[: args.limit]

    if args.as_json:
        _emit_json({
            **detail,
            "total_children": total_children,
            "returned_children": len(children),
            "children": children,
            "cache_hit": bool(hit),
        })
        return
    marker = " [cache]" if hit else ""
    print(f"{detail['id']}  {detail['title']}{marker}")
    if detail.get("astia_url"):
        print(f"  Astia: {detail['astia_url']}")
    for note in detail.get("notes") or []:
        print(f"  Note: {note}")
    print(f"  Children: {len(children)} of {total_children}")
    for child in children:
        flag = "[digitized]" if child.get("digitized") else "[not-digitized]"
        print(f"  - {child['id']} {flag} {child['title']}")
        if child.get("comment"):
            print(f"    {child['comment']}")
        print(f"    {child['digihakemisto_url']}")


def cmd_url(args: argparse.Namespace) -> None:
    printed = False
    if args.finna:
        print(f"{FINNA_SEARCH_URL}?{urlencode({'lookfor': args.finna.strip(), 'type': 'AllFields'})}")
        printed = True
    if args.astia:
        print(ASTIA_SEARCH_URL)
        printed = True
    if args.hiski is not None:
        code = args.hiski.strip()
        if code and PARISH_CODE_RE.fullmatch(code):
            print(f"{HISKI_ENDPOINT}?en+{code}")
        else:
            print(f"{HISKI_ENDPOINT}?en")
        printed = True
    if args.digihakemisto is not None:
        print(DIGIHAKEMISTO_BASE + "/")
        printed = True
    if args.digi:
        print(f"{DIGI_NEWSPAPERS_URL}?{urlencode({'query': args.digi.strip()})}")
        printed = True
    if args.sshy:
        print(SSHY_BASE_URL)
        printed = True
    if not printed:
        print(f"HisKi:         {HISKI_ENDPOINT}?en")
        print(f"Digihakemisto: {DIGIHAKEMISTO_BASE}/")
        print(f"Astia (NARC):  {ASTIA_SEARCH_URL}")
        print(f"Finna:         {FINNA_SEARCH_URL}")
        print(f"SSHY:          {SSHY_BASE_URL}")
        print(f"Digi (NLF):    {DIGI_NEWSPAPERS_URL}")


def _add_cache_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Bypass the disk cache for this request (the fresh result is still cached).",
    )
    parser.add_argument(
        "--cache-ttl-hours",
        type=float,
        default=None,
        help="Cache TTL in hours (default 168, env KINLOOM_FI_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fi-archives",
        description="Search Finnish historical archives (HisKi parish registers & Digihakemisto/Astia index).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_parishes = sub.add_parser("parishes", help="List or filter HisKi Finnish parishes and 4-digit codes.")
    p_parishes.add_argument("--query", "-q", default=None, help="Filter parish names or codes (Finnish or Swedish).")
    p_parishes.add_argument("--limit", type=int, default=None, help="Maximum parishes to display.")
    p_parishes.add_argument("--json", dest="as_json", action="store_true", help="Emit JSON with boolean cache_hit.")
    _add_cache_flags(p_parishes)
    p_parishes.set_defaults(func=cmd_parishes)

    p_hiski = sub.add_parser("hiski", help="Search HisKi parish baptisms, marriages, burials, and moves.")
    p_hiski.add_argument(
        "--book",
        default="christened",
        help="Book type: christened|births, married|marriages, buried|burials, moved-in, moved-out, or all.",
    )
    p_hiski.add_argument(
        "--parish",
        default="*",
        help="4-digit HisKi parish code, parish name, comma-separated codes, or '*' for all parishes (default '*').",
    )
    p_hiski.add_argument("--surname", default=None, help="Father / groom / person surname (isukunimi).")
    p_hiski.add_argument("--given", default=None, help="Child first name (christened) or person first name (other books).")
    p_hiski.add_argument("--father-given", default=None, help="Father first name (ietunimi).")
    p_hiski.add_argument("--father-patronymic", default=None, help="Father / person patronymic (ipatronyymi).")
    p_hiski.add_argument("--mother-given", default=None, help="Mother / bride / relative first name (aetunimi).")
    p_hiski.add_argument("--mother-surname", default=None, help="Mother / bride / relative surname (asukunimi).")
    p_hiski.add_argument("--village", default=None, help="Village or farm name (ikyla).")
    p_hiski.add_argument("--from-year", "--start-year", dest="from_year", default=None, help="Start year (YYYY).")
    p_hiski.add_argument("--to-year", "--end-year", dest="to_year", default=None, help="End year (YYYY).")
    p_hiski.add_argument("--limit", type=int, default=30, help="Maximum records to return (1-1000, default 30).")
    p_hiski.add_argument("--json", dest="as_json", action="store_true", help="Emit JSON with boolean cache_hit.")
    _add_cache_flags(p_hiski)
    p_hiski.set_defaults(func=cmd_hiski)

    p_event = sub.add_parser("event", help="Inspect one HisKi event detail page (with SSHY scan link).")
    p_event.add_argument("event_ref", help="Event reference '<parish>/<book>/<row_id>' or full HisKi event URL.")
    p_event.add_argument("--json", dest="as_json", action="store_true", help="Emit JSON with boolean cache_hit.")
    _add_cache_flags(p_event)
    p_event.set_defaults(func=cmd_event)

    p_archives = sub.add_parser("archives", help="Search National Archives of Finland (Astia) via Digihakemisto.")
    p_archives.add_argument("query", nargs="?", default=None, help="Search terms (supports * wildcards).")
    p_archives.add_argument(
        "--preset",
        choices=sorted(DIGIHAKEMISTO_PRESETS.keys()),
        default=None,
        help="Built-in query preset (parishes, henkikirjat, tax, court, inventories, say).",
    )
    p_archives.add_argument("--digitized", action="store_true", help="Show only archives marked as digitized.")
    p_archives.add_argument("--limit", type=int, default=30, help="Maximum archive rows to return (default 30).")
    p_archives.add_argument("--json", dest="as_json", action="store_true", help="Emit JSON with boolean cache_hit.")
    _add_cache_flags(p_archives)
    p_archives.set_defaults(func=cmd_archives_search)

    p_archive = sub.add_parser("archive", help="Inspect one Digihakemisto/Astia archive series or volume list.")
    p_archive.add_argument("archive_id", help="Digihakemisto/Astia archive id (e.g. 1299923671) or URL.")
    p_archive.add_argument("--digitized", action="store_true", help="Show only digitized child series/volumes.")
    p_archive.add_argument("--limit", type=int, default=50, help="Maximum child rows to return (default 50).")
    p_archive.add_argument("--json", dest="as_json", action="store_true", help="Emit JSON with boolean cache_hit.")
    _add_cache_flags(p_archive)
    p_archive.set_defaults(func=cmd_archive_inspect)

    p_url = sub.add_parser("url", help="Build verified browser URLs for Finna, Astia, HisKi, Digihakemisto, Digi, SSHY.")
    p_url.add_argument("--finna", default=None, help="Finna browser search URL (Finna API is Cloudflare-challenged).")
    p_url.add_argument("--astia", action="store_true", help="National Archives of Finland Astia search page.")
    p_url.add_argument("--hiski", nargs="?", const="", default=None, help="HisKi portal or 4-digit parish page.")
    p_url.add_argument("--digihakemisto", nargs="?", const="", default=None, help="Digihakemisto home page.")
    p_url.add_argument("--digi", default=None, help="National Library of Finland Digi newspapers search URL.")
    p_url.add_argument("--sshy", action="store_true", help="Finland's Family History Association (SSHY) portal.")
    p_url.set_defaults(func=cmd_url)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        args.func(args)
        return 0
    except BrokenPipeError:
        devnull = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(devnull, sys.stdout.fileno())
        except (OSError, ValueError):
            pass
        finally:
            os.close(devnull)
        return 0
    except CliError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return exc.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
