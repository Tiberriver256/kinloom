import type { EmbeddedGuide } from '../types.js';

export const NJ_ARCHIVES_GUIDE: EmbeddedGuide = {
  id: 'nj-archives',
  command: 'nj-archives',
  category: 'state-archives',
  summary: 'Search New Jersey State Archives databases and Monmouth OPRS census',
  body: `# New Jersey Archives

Search the New Jersey State Archives searchable-databases portal and the Monmouth County OPRS 1875 census via \`kinloom nj-archives\`. No API key or login is required.

The State Archives in Trenton is the official repository for New Jersey public records of enduring value, from the colony founded in 1664 to the present. It holds over 57,000 cubic feet of paper records and over 32,000 reels of microfilm. Admission is free; copies and research carry fees. Most holdings are not digitized.

## CLI usage (\`kinloom nj-archives\`)

\`\`\`bash
# List the databases live from the portal index
kinloom nj-archives databases

# Early Land Records for a surname, Monmouth County only
kinloom nj-archives search land --surname Lincoln --county Monmouth

# Land records where the person is the grantee, 1670-1700
kinloom nj-archives search land --surname Lincoln --role Grantee --from-year 1670 --to-year 1700

# Supreme Court Case Files, 1704-1844
kinloom nj-archives search supreme-court --surname Smith --role Defendant

# Read two pages of results (11 rows per page) as JSON
kinloom nj-archives search land --surname Smith --pages 2 --json

# Monmouth County OPRS 1875 census, name contains Smith, all towns
kinloom nj-archives monmouth --surname Smith

# Monmouth 1875 census, Freehold, Population category, name starts with Smith
kinloom nj-archives monmouth --surname Smith --town Freehold --category Population --match starts

# Browser URL for a database search page or an order form
kinloom nj-archives url land
kinloom nj-archives url births-1848-1925
\`\`\`

\`search\` options: \`--surname\` (alias \`--last\`; required except for \`natguard-photos\`, which uses \`--keyword\`, and for the two marriage databases, which also accept \`--spouse-surname\` alone), \`--given\` (alias \`--first\`), \`--spouse-surname\` (alias \`--spouse\`) / \`--spouse-given\` (marriage databases), \`--county\`, \`--location\`, \`--from-year\`, \`--to-year\`, \`--role\` (land: Grantor/Grantee/Named/Official; supreme-court: Plaintiff/Defendant/Official/Victim/Other), \`--case-type\` / \`--case-number\` (supreme-court), \`--keyword\` (natguard-photos), \`--limit\`, \`--pages\` (stops cleanly when no further pager link exists), \`--refresh\`, \`--cache-ttl-hours\`, \`--json\`. County and role values are matched case-insensitively (and with or without a trailing \`" County"\`) against the live dropdown options on the search page. \`search\` refuses order-form-only databases with the form URL; use \`url\` for those.

Database names are forgiving: case, spaces, and underscores are normalized, and common variants resolve (\`marriages-colonial\`, \`marriage-colonial\`, \`colonial-marriage\` → \`colonial-marriages\`; \`marriages\` → \`marriages-1848-1900\`; \`deeds\` → \`land\`). A typo exits 2 with a "Did you mean" hint and makes no network call.

### Disk cache

\`search\` and \`monmouth\` cache each result on disk, keyed by database, every criterion, and \`--pages\`. A repeat search reads the cache file and makes no network call. JSON output carries \`"cache_hit": true|false\`, and text output marks hits with \`[cache]\`.

- Location: \`~/.cache/kinloom-nj-archives/\` (override with \`KINLOOM_NJ_ARCHIVES_CACHE_DIR\`).
- TTL: 168 hours (override with \`--cache-ttl-hours\` or \`KINLOOM_NJ_ARCHIVES_CACHE_TTL_HOURS\`; \`0\` disables reads).
- \`--refresh\` re-queries the portal and rewrites the entry.
- Writes are atomic (temp file + rename). Per-query advisory locking makes concurrent agents that run the same search wait for the first one and then read its file.

## How the machine interface works (verified live 2026-11-24)

There is no public API and no stable GET search URL. The portal is ASP.NET WebForms, and the CLI drives its real form flow over plain HTTP:

1. GET the portal index with a browser User-Agent and a cookie jar. A bare curl/HTTP default User-Agent gets 403 (bot protection, not an outage); with a browser UA the same request returns 200. The session sets \`ASP.NET_SessionId\` plus Imperva cookies, which must be carried through the flow.
2. POST the database row's \`__doPostBack\` event target to \`index.aspx\` with the page's \`__VIEWSTATE\` / \`__EVENTVALIDATION\`. The response is that database's search page (e.g. \`EarlyLandRecords.aspx\`).
3. POST the search form fields plus the \`Search\` button to the search page, again with fresh hidden fields. Results come back as a \`GridView1\` table; land-record rows link to scanned PDFs at \`https://www.state.nj.us/state/darm/EarlyLandRecordsPDF/<Liber...>.pdf\`.
4. Pagination is a further postback: \`__EVENTTARGET=ctl00$ContentPlaceHolder1$GridView1\`, \`__EVENTARGUMENT=Page$N\`. Searches are capped at 500 records; the CLI warns only when 500 rows were actually returned.

The Monmouth OPRS search is the same pattern on a second ASP.NET site: GET \`ASearch.aspx\`, POST \`txtName\` + town/category dropdowns + the \`radStarts\`/\`radContains\` radio + \`btnSearch\`. Results are a \`dgdArcSearch\` table (Town Name, Category, Person Name, Page #); each row links to a census-page PDF at \`https://oprs.co.monmouth.nj.us/Oprs/census/<Town>/<Category>/<page>.pdf\`.

## Searchable databases

Counts are what the portal showed live on 2026-11-24; staff add entries daily, so re-check. Test status: "live search" means a search was submitted and results parsed by the CLI on 2026-11-24; "form mapped" means the search page and its fields were read live but no search was submitted for that database yet.

| CLI key | Database | Count (2026-11-24) | Test status |
|---|---|---|---|
| \`land\` | Early Land Records, ca. 1650-1900s | 75,685 records, over 397,267 names | live search |
| \`supreme-court\` | Supreme Court Case Files, 1704-1844 | 55,114 case files, over 234,709 names | live search |
| \`colonial-marriages\` | Colonial Marriage Bonds, ca. 1666-1799 | 11,533 bonds | form mapped |
| \`marriages-1848-1900\` | Marriage Records, May 1848-Dec 1900 | ~492,000 records | form mapped |
| \`deaths-1848-1878\` | Death Records, May 1848-May 1878 | over 303,172 records | form mapped |
| \`deaths-1878-1900\` | Death Records, Jun 1878-Dec 1900 | 628,584 records | form mapped |
| \`name-changes\` | Legal Name Changes, 1847-1947 | 12,254 changes, 46,010 names | form mapped |
| \`census-1885\` | 1885 State Census, Passaic County and Atlantic City only | 69,302 names | form mapped |
| \`revwar-damage\` | Revolutionary War Damage Claims, 1776-1783 | 2,662 claims, 7,435 names | live search |
| \`civilwar-service\` | Civil War Service Records, 1861-1865 | 82,471 names | form mapped |
| \`civilwar-vouchers\` | Civil War Payment Vouchers, 1861-1865 | 15,770 vouchers, 114,212 names | form mapped |
| \`wwi-deaths\` | World War I Deaths | 3,427 names, 9,310 scanned images | form mapped |
| \`natguard-photos\` | New Jersey National Guard Photographs | 1,316 images | form mapped |

Searchable fields per database (verified from the live search forms): land searches by surname, given name, role (Grantor/Grantee/Named/Official), location, county, year span, and deed book; supreme-court by surname, given name, role (Plaintiff/Defendant/Official/Victim/Other), case type, county, year span, and case number; colonial marriages by groom and bride surnames/given names and year span; 1848-1900 marriages the same plus county; deaths by surname, given name, year span, and county; name changes by surname and given name; 1885 census by surname, given name, and location; Rev War damage claims by surname, given name, county, location, and year span; Civil War service by surname and given name; WWI deaths by surname, given name, and NJ county of residence; National Guard photographs by keyword, location, and year span.

Notes: the portal's own warning on land records is that most deeds executed after 1785 were recorded at the county level, not with the State, so county deed books are the follow-up. The 1875 state census survives for Essex, Hunterdon, Monmouth, and Sussex counties only, and the 1895 state census is available through subscription sites.

## Order-form only (no online search)

These portal rows lead to records-request (shopping-cart) forms, not searchable result grids. The CLI's \`search\` refuses them and prints the form URL; open the form in a browser to order. Certified copies cost $25.00 per document in addition to copy and research fees, and only for original records the Archives legally owns; allow up to 8 weeks for an order.

| CLI key | Form | Coverage |
|---|---|---|
| \`births-1848-1925\` | BirthRecordsRequest.aspx | Births May 1848-Dec 1925 |
| \`marriages-1848-1950\` | MarriageRecordsRequest.aspx | Marriages May 1848-Dec 1950 |
| \`deaths-1848-1950\` | DeathRecordsRequest.aspx | Deaths May 1848-Dec 1950 |
| \`county-clerks-marriages\` | CountyMarriageRecordRequest.aspx | Limited counties and date ranges |
| \`probate\` | ProbateRecordRequest.aspx | Probate, ca. 1660-1952, wills and inventories |
| \`naturalization\` | NaturalizationRecordRequest.aspx | County naturalization, limited counties/date ranges |
| \`revwar-search\` | RevWarRecordRequest.aspx | Revolutionary War records |
| \`wwi-search\` | WorldWarIRecordRequest.aspx | World War I records |

Later vital records belong to the Department of Health and are on microfilm at the Archives for in-person use only. Chancery Court cases 1743-1948 are largely in-house, some off-site with several days' retrieval; indexes are on microfilm 1825-1948.

## Monmouth County OPRS 1875 census

Monmouth County has its own county-level online index: https://oprs.co.monmouth.nj.us/oprs/Archives/ASearch.aspx (http redirects to https). The \`monmouth\` command searches the 1875 Census Information collection by person name, town (Atlantic, Freehold, Holmdel, Howell, Marlboro, Middletown, Ocean, Shrewsbury, Upper Freehold, Wall, or ALL), and category (Agriculture, Commerce, Manufactures, Mining, Population, Return of Births, Return of Deaths, or ALL), with \`--match starts\` (default on the site) or \`contains\`. The 1875 Monmouth County census is the only known copy of that enumeration for the county. Each hit gives the census page number and a PDF of the census page itself.

Cross-check any colonial-era Monmouth County hit against the State Archives Early Land Records database (\`kinloom nj-archives search land\`), since landowners who held land before 1785 often appear in state land patents as well.

Inferred, not verified: the Monmouth results page shows pager links whose postback targets (\`dgdArcSearch$ctl01$ctl0N\`) appear in the page HTML but were not exercised, so the CLI reads page 1 only. The other Monmouth collections (Common Pleas 1723-1899, Civil War Muster Lists, Civil War Bounty Pay, Slave Births 1804-1848, Slave Manumissions 1787-1844, Freeholder Lists, Incorporations and Partnerships) live on separate pages and are not covered by this CLI.

## Verification log (verified live 2026-11-24)

- Portal index \`https://wwwdnet-dos.nj.gov/DOS_ArchivesDBPortal/index.aspx\` fetched with a browser User-Agent: HTTP 200, 72 KB. Direct curl with the default User-Agent returned 403 (bot protection, not an outage).
- Early Land Records search and pagination (\`--pages 2\`) returned parsed rows with links to scanned Liber PDFs.
- Supreme Court Case Files search returned parsed case rows (for example surname Smith returns 1835 Trespass & Ejectment cases) and accurately reported "No Records Found" for empty queries.
- Revolutionary War Damage Claims search executed end-to-end and parsed cleanly.
- Monmouth OPRS 1875 census search fetched over HTTPS and returned parsed rows with census-page PDF links.
- Every searchable database's search page and field list was read live by navigating its portal row (see the table above); births and probate request forms were confirmed to be order forms (\`btnAddToCart\`, no \`Search\` button).
- Portal counts update continuously as staff enter records; re-run \`kinloom nj-archives databases\` rather than quoting counts from memory.

### Re-verification 2026-11-25

- All 13 searchable databases returned exit 0 live with surname \`Smith\` (natguard-photos with a keyword) in 0.8-1.9 s each. Paged searches with \`--role\`, \`--from-year\`/\`--to-year\`, and \`--county\` (up to \`--pages 12\`, 132 rows) also returned exit 0.
- The earlier HTTP 500 failures came from posting \`Page$N\` past the last page (ASP.NET EventValidation rejects it). The CLI now pages only when the grid renders a link for the next page, and it retries a transient 5xx once with a fresh session.
- The other failures were exit-2 usage errors: a spouse-only marriage search (\`--spouse-surname\` without \`--surname\`) and guessed database names (\`marriages-colonial\`). Both now work.

## What this guide does not cover

- Department of Agriculture Photographs (7,111 photographs), Federal Writers' Project Photographs (3,911 images), and the Military Service Records request form appear on the portal but have no CLI support; open them in the browser from the portal index.
- The other Monmouth OPRS collections listed above (Common Pleas, muster lists, slave births/manumissions, freeholders, incorporations) are separate pages, not covered.
- In-person-only holdings, microfilm-only records, and subscription indexes (FamilySearch, Ancestry).
- Do not invent an API endpoint, a query-string search URL, or an auth requirement for any of these portals. There is none verified. If the portal redesigns or the postback targets change, \`databases\` will show it (rows without a \`[key]\`) and the CLI's registry needs re-verifying against the live index.

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
