import type { EmbeddedGuide } from '../types.js';

export const WIKITREE_GUIDE: EmbeddedGuide = {
  id: 'wikitree',
  command: 'wikitree',
  category: 'federal-general',
  summary: 'Search and read public WikiTree profiles, ancestors, and biographies',
  body: `# WikiTree

Search and read public WikiTree profiles, ancestors, and biographies via \`kinloom wikitree\` and the public WikiTree API (\`api.wikitree.com\`). No account or API key is required for public profiles.

- **Public profiles:** no authentication, no key. Only public profiles are returned; private profiles come back privacy-limited.
- **Private profiles:** need a WikiTree member login via the API's \`clientLogin\` flow (multi-step, user goes to WikiTree.com and returns with a token). The CLI does not implement login; see "API reference" below.

## CLI usage (\`kinloom wikitree\`)

### Search for people

\`\`\`bash
# Search public profiles by first and last name (or positional name / --given / --surname)
kinloom wikitree search --first Abraham --last Lincoln
kinloom wikitree search Abraham Lincoln --birth-year 1809

# Same search, raw JSON
kinloom wikitree search --first Abraham --last Lincoln --limit 5 --json

# Narrow by birth location
kinloom wikitree search --last Barton --birth-location "Massachusetts" --limit 10

# Require dates on matches (otherwise dateless profiles are also returned)
kinloom wikitree search --first Clara --last Barton --date-include both
\`\`\`

### Look up one profile

\`\`\`bash
# By WikiTree ID (<Surname>-<Number> from search output) or profile URL (aliases: get, show, profile)
kinloom wikitree person <WikiTree-ID>
kinloom wikitree get <WikiTree-ID>

# Raw JSON, all fields
kinloom wikitree person <WikiTree-ID> --fields '*' --json

# By numeric user Id
kinloom wikitree person <numeric-id>
\`\`\`

### Ancestors and biography

\`\`\`bash
# Two generations of ancestors
kinloom wikitree ancestors <WikiTree-ID> --depth 2

# Biography text (wiki markup) for a profile
kinloom wikitree bio <WikiTree-ID>

# Biography as HTML instead
kinloom wikitree bio <WikiTree-ID> --format html
\`\`\`

### Disk cache and environment variables

\`search\`, \`person\`, \`ancestors\`, and \`bio\` cache successful API responses on disk under \`~/.cache/kinloom-wikitree/\` (default TTL \`168\` hours, advisory locking per cache key, atomic temp-file writes). HTTP errors and non-zero WikiTree API status errors are never cached.

- \`--refresh\`: bypass cached reads and write the fresh response to disk.
- \`--cache-ttl-hours <hours>\`: override TTL for one call (\`0\` disables cached reads).
- \`KINLOOM_WIKITREE_CACHE_DIR\`: override the cache directory path.
- \`KINLOOM_WIKITREE_CACHE_TTL_HOURS\`: override the default TTL in hours.
- \`WIKITREE_APP_ID\`: application id sent with every API call (default \`Kinloom\`). WikiTree asks every client to send one; calls without an id are subject to strict rate limits.

## API reference (verified live 2026-11-24)

- Base: \`GET https://api.wikitree.com/api.php\` (GET or POST, JSON out). Docs: \`https://github.com/wikitree/wikitree-api\` (README plus one \`.md\` file per action).
- Auth: none for public profiles. Privacy-limited data for private ones.
- Response shape: a JSON array; each element has \`status\` (0 or \`""\` = ok, or an error string such as \`"Illegal WikiTree ID"\`) and the requested data.
- Dates use \`YYYY-MM-DD\` with \`00\` for unknown month/day; \`0000-00-00\` means no date at all.

| Action | Use | Key params |
| --- | --- | --- |
| \`getPerson\` | One person by WikiTree ID or numeric Id | \`key\`, \`fields\`, \`bioFormat\` (wiki/html/both), \`resolveRedirect\` (1 = follow redirects) |
| \`getProfile\` | Person or Free-Space profile by WikiTree ID or PageId | \`key\`, \`fields\` |
| \`searchPerson\` | Search like Special:SearchPerson | \`FirstName\`, \`LastName\`, \`BirthDate\`, \`DeathDate\`, \`BirthLocation\`, \`DeathLocation\`, \`Gender\`, \`fatherFirstName\`, \`fatherLastName\`, \`motherFirstName\`, \`motherLastName\`, \`dateInclude\` (both/neither), \`dateSpread\` (1-20), \`lastNameMatch\` (all/current/birth/strict), \`skipVariants\` (1), \`sort\`, \`limit\` (1-100, default 10), \`start\`, \`fields\` |
| \`getAncestors\` | DEPRECATED: the API errors and directs callers to \`getPeople\` with \`ancestors=N\` instead. Do not use. | — |
| \`getDescendants\` | Descendants following children (still works, verified 2026-11-24) | \`key\`, \`depth\`, \`fields\` |
| \`getRelatives\` | Parents, children, siblings, spouses | \`keys\`, \`getParents\`, \`getChildren\`, \`getSpouses\`, \`getSiblings\`, \`fields\` |
| \`getBio\` | Biography text for a profile | \`key\`, \`bioFormat\` |
| \`getPhotos\` | Photos connected to a profile | \`key\` |
| \`getCategories\` | Categories connected to a profile | \`key\` |
| \`getPeople\` | Several profiles by key and/or relationship; also the replacement for \`getAncestors\` via \`ancestors=N\` (max 25) and for descendants via \`descendants=N\` (max 10) | \`keys\`, \`fields\`, \`ancestors\`, \`descendants\`, \`nuclear\`, \`minGeneration\`, \`limit\`, \`start\` |
| \`clientLogin\` | Authenticate as a member (private profiles) | multi-step token flow, see docs |

Default \`getPerson\` fields are all fields except biography, children and spouses; \`fields=*\` returns everything. The \`Mother\` and \`Father\` fields hold numeric user Ids; follow them with \`getPerson\` by Id.

### API behavior notes (verified live 2026-11-24)

- Some matches returned by \`searchPerson\` contain only \`Id\` and \`index\` (sparse matches); follow up with \`kinloom wikitree person <Id>\` for the full profile.
- \`getPeople\` returns \`status: ""\` (empty string) on success rather than \`0\`; the CLI accepts both \`0\` and \`""\`.
- The legacy \`getAncestors\` action returns a deprecation error directing callers to \`getPeople\` with \`ancestors=N\`; the CLI's \`ancestors\` command already uses \`getPeople\`.

## One Name Studies (website)

- WikiTree hosts surname-level collaborative projects called One Name Studies at \`https://www.wikitree.com/wiki/Space:<Surname>_Name_Study\` and \`https://www.wikitree.com/wiki/Project:One_Name_Studies\`.
- Profiles participating in a study carry a \`{{One Name Study|name=<Surname>}}\` sticker and a matching surname study category.
- Website note: \`wikitree.com\` profile and space pages can return a WAF challenge (HTTP 202, empty body) to plain curl, so read website pages through a browser, not curl. The API at \`api.wikitree.com\` is unaffected and answers direct HTTP requests.

## Rules and limits

- **WikiTree is a lead, not evidence.** Profiles are collaborative and user-contributed; a profile states what other researchers believe, not what a record proves. Always follow the profile's cited sources, and cross-check against primary records before staging conclusions in a **Research Package** (\`research/people/<person_id>/patch.json\`). Never copy a WikiTree parentage claim without its citation.
- **Pre-1700 lines need primary citations.** Pre-1700 profiles in particular are expected to cite primary sources. If a profile's only sources are compiled genealogies, treat the claim as secondary and look for the underlying record.
- **Document conflicting claims.** WikiTree profiles record disputes in Research Notes. When two researchers disagree on parentage or dates, keep both claims and their reasoning; do not pick a winner silently.
- **Living people are excluded** from public search results. Do not try to retrieve them through the API.
- **Rate limits:** WikiTree subjects calls without an \`appId\` to strict rate limits. The CLI always sends one. Keep calls to about one per second and do not batch hundreds of lookups in a loop without a pause.
- **Do not edit through the API.** The API is read-only; edits go through the website by a logged-in member. The CLI never writes.
- **Redirects:** merged profiles redirect to a surviving WikiTree ID. Pass \`--resolve-redirect\` (person) or \`resolveRedirect=1\` so a lookup follows the merge instead of returning the redirect stub.

## Kinloom Research Package workflow

Never edit \`data/*.yaml\` directly from a research session. Follow Kinloom's staged **Research Package** workflow and **Living Privacy Rule** (never include living people's portraits, exact birth dates, street addresses, or pronunciations in public archives):

1. Discover research targets with \`kinloom status --missing-biography\` or \`kinloom status --end-of-line\`.
2. Gather privacy-fenced context with \`kinloom context <person_id> --include-family\`.
3. Stage any downloaded images or documents under \`research/people/<person_id>/scans/\` and prepare them with \`kinloom prep-scan\` or \`kinloom ocr\` when needed.
4. Write cited findings into \`research/people/<person_id>/patch.json\`.
5. Audit, integrate, verify, and sync:

\`\`\`bash
kinloom audit --all-staged --pending-only --strict
kinloom integrate --all-staged --pending-only
kinloom pronounce audit --strict
kinloom verify
kinloom migrate
kinloom sync --sync-missing-media --verify-live
\`\`\``,
};
