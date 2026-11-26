---
name: pronounce
description: Look up verified IPA and Wikimedia Commons pronunciation audio on Wiktionary and Wikipedia, and audit a Kinloom archive's pronunciation lexicon for coverage gaps, missing citations, homonymous place collisions, and IPA quality issues.
---

# Pronunciation Research & Audit (`kinloom pronounce`)

Use `kinloom pronounce` when researching surname or place pronunciations, verifying IPA transcriptions against primary linguistic references, or auditing `kinloom.config.yaml` and `data/places.yaml` for collisions and missing citations.

## Subcommands

### 1. Look up verified IPA and native audio

```bash
kinloom pronounce lookup <term> [--lang nl|sv|fi|pl|de|en] [--refresh] [--json]
```

- Queries Wiktionary (`<lang>.wiktionary.org` and `en.wiktionary.org`) and Wikipedia (`<lang>.wikipedia.org` and `en.wikipedia.org`) via the MediaWiki API.
- Extracts verified IPA templates (`{{IPA|...}}`, `{{IPA-nl|...}}`, `{{IPA-sv|...}}`, `{{IPA-pl|...}}`, `{{IPA-fi|...}}`, `{{IPA-de|...}}`, `{{IPA-en|...}}`, `{{pron|...}}`) and Wikimedia Commons audio files (`{{audio|...}}`).
- Caches results atomically under `~/.cache/kinloom-pronounce/` (overrideable via `KINLOOM_PRONOUNCE_CACHE_DIR`) with a top-level `cache_hit` boolean in `--json` output.
- Retries HTTP 429, 5xx, and transient network failures up to 4 attempts honoring `Retry-After`.
- Sets `verified: true` only when upstream returns an IPA string. Never fabricate IPA when `verified` is `false`.

Examples:

```bash
# Dutch town with Wiktionary IPA and Wikimedia Commons audio
kinloom pronounce lookup Goes --lang nl --json

# Swedish place name
kinloom pronounce lookup Uppsala --lang sv --json

# English surname or place
kinloom pronounce lookup Mercer --lang en --json
```

### 2. Audit an archive's pronunciation lexicon

```bash
kinloom pronounce audit [--repo <path>] [--json]
```

Audits `kinloom.config.yaml` (`pronunciations`), deceased records in `data/people.yaml` (strictly excluding living individuals), and `data/places.yaml` for:

1. **Coverage gaps:** Distinct deceased surnames and non-trivial or foreign place names lacking pronunciation entries.
2. **Unsourced entries:** Pronunciation entries missing both `source_url` and `source_label` (and whether `note` is absent).
3. **Homonymous bare place collisions:** Bare place keys (for example `"Zeeland"` or `"Holland"`) when `data/places.yaml` contains multiple places with that name across different countries or regions. Prefer qualified keys such as `"Zeeland, Netherlands"` and `"Zeeland, Michigan"`, or set `region` / `match_full_name_contains`.
4. **Linguistic and IPA quality warnings:** Empty entries, unslashed or malformed IPA strings, and suspicious American/English IPA symbols (`/ɝ/`, `/ɚ/`, `/ɹ/`, `/aɪ/`, `/oʊ/`, `/eɪ/`, `/θ/`, `/ð/`) inside non-English entries (`nl`, `sv`, `pl`, `fi`, `de`).

## Provenance and multi-variant entries

When adding or updating a pronunciation in `kinloom.config.yaml` or `data/places.yaml`, record provenance and regional scope alongside the guide:

```yaml
pronunciations:
  "Zeeland, Netherlands":
    phonetic: ZAY-lahnt
    ipa: /ˈzeː.lɑnt/
    language: nl
    region: Netherlands
    source_label: Wiktionary (Dutch IPA)
    source_url: https://en.wiktionary.org/wiki/Zeeland
    variants:
      - label: West Michigan (English)
        phonetic: ZEE-lund
        ipa: /ˈziː.lənd/
        language: en-US
        region: Michigan
        source_label: Local American usage
```

## Environment variables

- `KINLOOM_PRONOUNCE_CACHE_DIR`: Override disk cache directory (default `~/.cache/kinloom-pronounce`).
