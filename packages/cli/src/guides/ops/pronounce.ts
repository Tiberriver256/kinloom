import type { EmbeddedGuide } from '../types.js';

export const PRONOUNCE_GUIDE: EmbeddedGuide = {
  id: 'pronounce',
  command: 'pronounce',
  category: 'ops',
  summary: 'Look up verified IPA/audio and audit archive pronunciation coverage',
  body: `# Pronunciation Guide & Pronunciation Audit (\`kinloom pronounce\`)

Use \`kinloom pronounce\` when researching **Pronunciation Guides** for deceased people and places, verifying **IPA** transcriptions and **Respellings** against primary linguistic references, or running a **Pronunciation Audit** across \`kinloom.config.yaml\`, \`data/people.yaml\`, and \`data/places.yaml\`.

## Subcommands

### 1. Look up verified IPA and native audio

\`\`\`bash
kinloom pronounce lookup <term> [--lang nl|sv|fi|pl|de|en] [--refresh] [--json]
\`\`\`

- Queries Wiktionary (\`<lang>.wiktionary.org\` and \`en.wiktionary.org\`), Wikipedia (\`<lang>.wikipedia.org\` and \`en.wikipedia.org\`), and **Forvo** (when \`FORVO_API_KEY\` is configured), and emits structured, anti-bot-compliant lookup URLs for **Forvo**, **YouGlish**, **VOA Pronunciation Guide**, **NameShouts**, **Pronounce Names**, and **HowToPronounce**.
- Extracts verified **IPA** templates (\`{{IPA|...}}\`, \`{{IPA-nl|...}}\`, \`{{IPA-sv|...}}\`, \`{{IPA-pl|...}}\`, \`{{IPA-fi|...}}\`, \`{{IPA-de|...}}\`, \`{{IPA-en|...}}\`, \`{{pron|...}}\`) and Wikimedia Commons audio files (\`{{audio|...}}\`).
- Ranks sources by tier, always prioritizing **Tier 1 (\`native_speaker\`)** evidence (Forvo, YouGlish, Wikimedia Commons native audio, Wiktionary) above **Tier 2 (\`broadcast_lexicon\`)** (VOA Pronunciation Guide, Wikipedia IPA) and **Tier 3 (\`community\`)** (NameShouts, Pronounce Names, HowToPronounce). Never rely on automated/generated voices alone for local or historical exceptions.
- Reports two-source cross-check status in \`--json\` output: \`corroborated\` (\`true\` when matched across at least 2 independent databases), \`sourceCount\`, \`highestTier\`, \`native_speaker_verified\`, and \`verification_note\`.
- Never bypasses CAPTCHAs, Cloudflare challenges, or paywalls; gated or JS-rendered databases return \`status: "requires_api_key"\` or \`"manual_lookup"\` with the exact pre-formatted query URL.
- Caches results atomically under \`~/.cache/kinloom-pronounce/\` (overrideable via \`KINLOOM_PRONOUNCE_CACHE_DIR\`) with a top-level \`cache_hit\` boolean in \`--json\` output.
- Retries HTTP 429, 5xx, and transient network failures up to 4 attempts honoring \`Retry-After\`.
- Sets \`verified: true\` only when upstream returns verified IPA or native-speaker audio. Never fabricate IPA when \`verified\` is \`false\`.

Examples:

\`\`\`bash
# Dutch town with Wiktionary IPA and Wikimedia Commons audio
kinloom pronounce lookup Goes --lang nl --json

# Swedish place name
kinloom pronounce lookup Uppsala --lang sv --json

# English surname or place
kinloom pronounce lookup Mercer --lang en --json
\`\`\`

### 2. Run a Pronunciation Audit over an archive

\`\`\`bash
kinloom pronounce audit [--repo <path>] [--strict] [--json]
\`\`\`

Audits the **Pronunciation Lexicon** (\`kinloom.config.yaml\` \`pronunciations\`), every confirmed-deceased person in \`data/people.yaml\`, and every place in \`data/places.yaml\` for:

1. **100% deceased Full-Name Pronunciation coverage:** Every confirmed-deceased person must resolve to \`coverage: 'full'\` (not missing, **Surname Pronunciation** only, or **Partial Pronunciation**).
2. **100% Place coverage:** Every place in \`data/places.yaml\` must resolve to a **Pronunciation Guide**.
3. **Zero Living leaks (Living Privacy Rule):** Verifies \`0\` **Living** people have any pronunciation entry in \`data/people.yaml\` or \`kinloom.config.yaml\`; any living leak fails loudly.
4. **Unsourced entries:** Entries missing both \`source_url\` and \`source_label\` (and whether \`note\` is absent).
5. **Homonymous bare place collisions:** Bare place keys (for example \`"Zeeland"\` or \`"Holland"\`) when \`data/places.yaml\` contains multiple places with that name across different countries or regions. Prefer qualified keys such as \`"Zeeland, Netherlands"\` and \`"Zeeland, Michigan"\`, or set \`region\` / \`match_full_name_contains\`.
6. **Linguistic and IPA quality warnings:** Empty entries, unslashed or malformed IPA strings, and suspicious American/English IPA symbols (\`/ɝ/\`, \`/ɚ/\`, \`/ɹ/\`, \`/aɪ/\`, \`/oʊ/\`, \`/eɪ/\`, \`/θ/\`, \`/ð/\`) inside non-English entries (\`nl\`, \`sv\`, \`pl\`, \`fi\`, \`de\`).

Pass \`--strict\` to exit non-zero whenever any deceased person lacks **Full-Name Pronunciation** coverage, any place lacks coverage, any homonymous bare place collision exists, or any **Living** leak exists.

## Pre-sync gate

Run the strict **Pronunciation Audit** right before archive verification and **Archive Sync**:

\`\`\`bash
kinloom pronounce audit --strict
kinloom verify
kinloom migrate
kinloom sync --sync-missing-media --verify-live
\`\`\`

## Provenance and Pronunciation Variants

When adding or updating a **Pronunciation Guide** in the **Pronunciation Lexicon** (\`kinloom.config.yaml\`) or in a staged **Research Package**, record provenance, **Respelling** (\`phonetic\` schema key), verified **IPA**, and regional **Pronunciation Variants**:

\`\`\`yaml
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
\`\`\`

## Environment variables

- \`KINLOOM_PRONOUNCE_CACHE_DIR\`: Override disk cache directory (default \`~/.cache/kinloom-pronounce\`).
- \`FORVO_API_KEY\`: Optional Forvo API key enabling automated Tier 1 native-speaker audio lookup in \`kinloom pronounce lookup\`.`,
};
