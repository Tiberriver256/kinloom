import type { EmbeddedGuide } from '../types.js';

export const MO_ARCHIVES_GUIDE: EmbeddedGuide = {
  id: 'mo-archives',
  command: 'mo-archives',
  category: 'state-archives',
  summary: 'Search Missouri State Archives death certificates and vital abstracts',
  body: `# Missouri Archives

Search Missouri State Archives vital records via \`kinloom mo-archives\`: Missouri Death Certificates 1910-1975 with certificate images, and the pre-1910 Birth and Death Records Database with full abstracts. No API key or login is required.

## CLI usage (\`kinloom mo-archives\`)

### Search death certificates, 1910-1975

\`\`\`bash
# Search death certificates by name and year
kinloom mo-archives death --last Clemens --first Samuel --begin-year 1910 --end-year 1920

# All deaths for a surname in a county and decade, as JSON
kinloom mo-archives death --last Clemens --county Marion --begin-year 1910 --end-year 1939 --json

# Search by a parent's name (1953-1975 certificates only, see below)
kinloom mo-archives death --last Clemens --role father --begin-year 1953 --end-year 1975

# Download the certificate PDFs for the hits
kinloom mo-archives death --last Clemens --county Marion --begin-year 1910 --end-year 1920 --download ./downloads/mo-certs
\`\`\`

Options: \`--first\`, \`--middle\`, \`--role deceased|spouse|father|mother\` (default deceased), \`--match contains|starts-with|ends-with\` (default contains, applied to every name field given), \`--county\` (spelled as on the site, default all counties), \`--begin-year\` / \`--end-year\` (default 1910-1975), \`--begin-month\` / \`--end-month\` (1-12, 0 means all, default 0), \`--limit\` (default 50, one results page), \`--json\`, \`--download DIR\`.

### Search pre-1910 births and deaths

\`\`\`bash
# Deaths before 1910 (abstracts, no images)
kinloom mo-archives pre1910 --type death --name Clemens

# Births before 1910, in one county
kinloom mo-archives pre1910 --type birth --name Clemens --county Marion --json
\`\`\`

Options: \`--type birth|death\` (default death), \`--name\` (required; the site recommends last name only), \`--county\` (default all counties), \`--limit\` (default 50), \`--json\`.

### Fetch a pre-1910 full abstract

\`\`\`bash
kinloom mo-archives detail <detail-id>
kinloom mo-archives detail <detail-id-1> <detail-id-2> --json
\`\`\`

Takes one or more detail IDs from \`pre1910\` output. Returns county, microfilm roll and page, dates, birthplace, cause of death, and the other abstract fields.

### Download certificate PDFs by image URL

\`\`\`bash
kinloom mo-archives download "https://www.sos.mo.gov/images/archives/deathcerts/<year>/<filename>.PDF" --out ./downloads/mo-certs
\`\`\`

Always take the image URL from \`death\` output. The PDF filename is not derivable from the certificate number, so do not construct it by hand.

### Missouri Digital Heritage (browser only)

\`\`\`bash
kinloom mo-archives mdh
\`\`\`

Prints the MDH home page, Advanced Search, and Archives URLs. MDH has no verified machine interface; do the search in the browser.

### Disk cache and environment variables

\`death\`, \`pre1910\`, and \`detail\` cache successful responses on disk under \`~/.cache/kinloom-mo-archives/\` (default TTL \`168\` hours, advisory locking per cache key, atomic temp-file writes). HTTP errors and unverified 0-hit error pages are never cached.

- \`--refresh\`: bypass cached reads and write the fresh response to disk.
- \`--cache-ttl-hours <hours>\`: override TTL for one call (\`0\` disables cached reads).
- \`KINLOOM_MO_ARCHIVES_CACHE_DIR\`: override the cache directory path.
- \`KINLOOM_MO_ARCHIVES_CACHE_TTL_HOURS\`: override the default TTL in hours.

## Verified interface (verified live 2026-11-24)

- Portal: https://www.sos.mo.gov/mdh. Missouri State Archives: https://www.sos.mo.gov/archives. Address: 600 West Main Street, Jefferson City, MO 65102. Research room open Monday-Friday 8:00 AM-5:00 PM. Email archref@sos.mo.gov.
- MDH home page states that more than 9 million records can be accessed through it, including the collections of the Archives, the State Library, and other institutions across the state. No login or subscription is required.
- Both vital-records databases are plain HTML POST forms on \`s1.sos.mo.gov\`, no API and no key. The CLI GETs the form page first (session cookies plus the \`__ncforminfo\` token), then POSTs the search. The POST also succeeds without the token, but the CLI sends it when the page provides one.
- A browser User-Agent is required. Direct curl with the default User-Agent returns 403 on \`sos.mo.gov\` (bot protection, not an outage); with a browser User-Agent the same requests return 200. The CLI sends a Chrome User-Agent on every request.
- Death Certificates search posts to \`https://s1.sos.mo.gov/records/Archives/ArchivesMvc/\` with fields \`DeathCertNameSearchType\` (Deceased/Spouse/Father/Mother), \`LastName\`, \`FirstName\`, \`MiddleName\`, \`LNSearchMethod\` / \`FNSearchMethod\` / \`MNSearchMethod\` (Contains/StartsWith/EndsWith), \`BeginMonth\` / \`BeginYear\`, \`EndMonth\` / \`EndYear\`, \`CountyName\` (\`-- Search All --\` for all counties), \`Search\`. Years are required in practice: an empty year range silently returns no results (verified live).
- Results are paged 50 per page in the cookie session. The CLI follows the session pager (\`DeathCertificates/Results?PageNumber=N&recordsPerPage=50\`, same pattern for \`birthdeath/Results\`) until \`--limit\` or the total is reached. The total comes from the page text \`Showing records 1 to 50 of N\`.
- Death result columns: Name, Age, Date of Death, County, Certificate Number, Last Four SSN, Image. The image is a direct PDF link, \`https://www.sos.mo.gov/images/archives/deathcerts/<year>/<file>.PDF\`, and downloads with a plain GET (verified live).
- Pre-1910 search posts to \`https://s1.sos.mo.gov/records/archives/ArchivesMVC/birthdeath/\` with \`BirthCounty\` / \`BirthNameSearch\` / \`BirthSubmit\` or \`DeathCounty\` / \`DeathNameSearch\` / \`DeathSubmit\` (\`-- All Counties --\` for all counties). Death columns: Name, Age, Sex, Color, Date Of Death, County, Details. Birth columns: Name, Place, County, Date, Father, Mother, Attendant, Details. Details links are \`Detail?id=<n>\` on the same path; the detail page gives county, roll number, page, number, dates, birthplace, cause of death, and related fields.
- MDH Advanced Search is hosted at https://mdh.deepwebaccess.com/mdh/ (linked from the MDH home page). No stable GET search URL for it was verified; do not invent one. The MDH digital collections run on CONTENTdm (\`cdm16795.contentdm.oclc.org\`); a direct request to its \`dmwebservices\` query endpoint returned 403 (Cloudflare) on 2026-11-24, so the CLI does not use it.
- Inferred, not verified: the county lists in the forms are taken as given by the site; the CLI passes any county string through and lets the site validate it.

## What is searchable online

- Missouri Death Certificates, 1910-1975: https://s1.sos.mo.gov/records/Archives/ArchivesMvc/DeathCertificates/. Search by first, middle, and last name, county, year, and month. Digitized images of the original certificates link directly from the results. Spouse, father, and mother name search is available for 1953-1975 (the page says 1953-1975 in one place and 1954-1975 in another; try both ranges when searching parents). Death certificates are closed for 50 years before transfer to the Archives, which is why the online run advances one year at a time. A certificate typically gives date and place of birth, parents' names, spouse, cause of death, occupation, funeral home, and burial place.
- Missouri Birth and Death Records Database, Pre-1910: https://s1.sos.mo.gov/records/archives/ArchivesMVC/birthdeath/. An abstract of birth, stillbirth, and death records recorded before 1909, transcribed by volunteers from microfilm. Over 185,000 records from 87 counties. Coverage is incomplete because statewide reporting was not required before 1910. Search by all or part of a name; the site recommends entering just the last name. A birth search can match on a parent's name as well as the child's, so check the Father and Mother columns before counting a hit. All records for a county can be listed by selecting the county and leaving the name blank. For a death before 1910, this is the first check; for a birth, remember the abstract gives date, place, parents, and attendant, not a certificate image.
- Soldiers' Records, War of 1812-World War I. Nearly 1.5 million pages of service cards, muster rolls, special orders, and reports. Also on MDH: World War I Biography and Service Records. Browser only.
- Land Patent Records, 1820-1969 (the Archives' land patents run 1831-1969 in some listings; use the database's own date range when searching). Browser only.
- Naturalization Records, 1816-1955. Browser only.
- Coroner's Inquest Database, Judicial Records, Supreme Court Historical Records, Missouri State Penitentiary records, and Census Records and Tax Lists. Browser only; the death-certificate and pre-1910 databases above are the two whose URLs and machine interfaces were verified live.
- Missouri County History Project, Missouri County Plat Books, Missouri City Directories, and Missouri Newspapers, all through MDH. Plat books show landowner names on each parcel and place a family on the map between censuses. The Local Records Program's County and Municipal Records Database tells which county books are available on microfilm at the Archives. Browser only.

## What is in-person or order-only

- The Archives cannot issue certified copies of vital records. For certified copies of births or deaths filed after 1909, contact the Missouri Bureau of Vital Records at 573-751-6387.
- County records on microfilm, court files, and un-digitized collections require a visit or a reference request to archref@sos.mo.gov.
- The State Historical Society of Missouri (SHSMO, shsmo.org, digital collections at digital.shsmo.org) holds Missouri newspapers from about 1800, manuscripts, maps, and finding aids. Its research centers are FamilySearch Affiliate Libraries, giving in-person visitors access to otherwise restricted FamilySearch collections. Check SHSMO when MDH has no newspaper or manuscript hit.

## Research workflow

1. For a Missouri death between 1910 and 1975, search the Death Certificates database by surname, county if known, and year range. Open the linked certificate PDF and record parents' names, birthplace, spouse, burial place, and informant; the informant is often a close relative.
2. For a death or birth before 1910, search the pre-1910 Birth and Death Records database by surname only, then fetch the detail abstract with \`kinloom mo-archives detail <id>\` to confirm county, microfilm roll, and page before ordering microfilm or visiting. Note the pre-1910 index can list the same person twice from overlapping abstracts; check the detail page before counting two entries as two people.
3. For landowners, follow up in the Land Patent Records and Missouri County Plat Books on MDH in the browser, and cross-check federal patents with \`kinloom guide blm-glo\`.

## Kinloom Research Package workflow

Never edit \`data/*.yaml\` directly from a research session. Follow Kinloom's staged **Research Package** workflow and **Living Privacy Rule** (never include living people's portraits, exact birth dates, street addresses, or pronunciations in public archives):

1. Discover research targets with \`kinloom status --missing-biography\` or \`kinloom status --end-of-line\`.
2. Gather privacy-fenced context with \`kinloom context <person_id> --include-family\`.
3. Prepare downloaded scans with \`kinloom prep-scan\` (for example \`kinloom prep-scan crop --redact-orig\`) and run \`kinloom ocr\` as needed, then stage scans under \`research/people/<person_id>/scans/\`.
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
