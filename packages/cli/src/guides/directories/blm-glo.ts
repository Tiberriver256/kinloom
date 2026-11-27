import type { EmbeddedGuide } from '../types.js';

export const BLM_GLO_GUIDE: EmbeddedGuide = {
  id: 'blm-glo',
  command: 'blm-glo',
  category: 'directories-guides',
  summary: 'Research guide for BLM General Land Office federal land patents',
  body: `# BLM GLO Records (General Land Office)

**Guide-only: there is no automated CLI query for this source.** See "Why no CLI" below. All work goes through the website at \`https://glorecords.blm.gov/\`.

- **What it holds:** federal land patents, the first transfer of public land from the U.S. government to a private owner, from 1788 to the present: more than five million title records, plus survey plats, field notes, land status records, and control document index records. Patent types include Cash Entry, Homestead, and Military Warrant.
- **What a patent gives you:** patentee name (plus assignee, warrantee, widow, or heir where applicable), issue (signature) date, acreage, the authority under which the land was taken (e.g. Homestead Act), the full legal land description (state, meridian, township, range, section, aliquot parts), the land office, and the document/accession number.
- **Coverage limit:** the site indexes only patented or completed land entries. It does not index cancelled entries or expired leases, and it does not contain every federal title record issued. The original 13 states, Vermont, Kentucky, Tennessee, Maine, West Virginia, Texas, and Hawaii are not public-land states: their early land records are state records, not GLO patents.
- **Access:** no account is needed for general searching. A Login.gov account is only needed to save searches.

## Website search (verified live 2026-11-24)

The site was rebuilt and relaunched July 13, 2026 as the "GLO Portal" (Salesforce-based). Worked steps on the new site, per BLM's own help pages:

1. Go to \`https://glorecords.blm.gov/\` and choose **Search Documents**, then **Patents**.
2. Search by **name** (last name alone often works best; try spelling variants) or by **legal description**: state, principal meridian, township, range, and section. Enter township and range as three-digit numbers (e.g. township \`009\`, range \`002\`). A section search lists every patent ever issued in that section.
3. **Ohio:** the map search does not currently work for Ohio records. Use **Advanced Search**: on the General tab choose Ohio (click update), add a county if known, and enter the name (in quotation marks for an exact name).
4. Open a result to the Patent Details page. Download/print the patent image: it shows the patentee, date, acreage, authority, and full legal description. The details page also shows the section on a current map.
5. Cite the patent by **accession/document number, state, and signature date**. Do not cite a glorecords.blm.gov URL: old record links died in the July 2026 rebuild and now land on the portal home page.

### Search tips

- Search the surname alone first, then narrow by state/county; exact-name search (quotes) helps once you know the spelling the index uses.
- The \`%\` wildcard worked on the old site's patent search; it is not verified on the new portal, so treat wildcard behavior as unconfirmed.
- If no patent appears, the ancestor may have bought from a private party (second or later transfer, recorded at the county, not the GLO), taken land under a state grant, or had a cancelled entry (not indexed). Check county deed books next.

## From the patent to the NARA case file

The patent is the end of the process. The underlying land-entry case file, held by the National Archives (Record Group 49, Records of the Bureau of Land Management, at Archives 1 in Washington, DC), holds the application and, for a homestead, proof of residence, witnesses, and citizenship papers. Request it on **NATF Form 84** (see the NARA "Accessing Land Entry Records" page, \`https://www.archives.gov/research/land/accessing-land-entry-files\`):

- **Pre-July 1908 homestead claims:** give the homesteader's name, the state, the approximate date of entry, and *either* the legal description *or* the land office name plus the land entry file number. The legal description and land office come from the GLO patent. (Exception: Kansas, Nebraska, and Oklahoma file numbers are not on the GLO site.)
- **Post-July 1908 claims:** give the name, the state, and the approximate date of entry. Files are arranged numerically by patent number.
- **Already digitized:** homestead case files completed by 1908 for Alaska, Arizona, Indiana, Illinois, Iowa, Nebraska, Nevada, Ohio, Utah, and Wyoming are searchable free through Homestead National Historical Park / the University of Nebraska-Lincoln / Family History Centers, and on Fold3 and Ancestry with a subscription. All other case files must be requested from NARA.
- Use \`kinloom nara\` (see \`kinloom guide nara\`) to check whether a file (or its series) is already digitized in the National Archives Catalog before ordering.

## Why no CLI (verified live 2026-11-24)

- The old GLO reference documentation (\`glorecords.blm.gov/reference/default.aspx\`, including the "Web Services and Bulk Data" section) now returns the new portal's single-page-app shell; the documented SOAP web services and the bulk-data downloads (\`/BulkData/default.aspx\`, now 401) are gone with the July 2026 rebuild.
- The portal's backend host \`glo-entry-prod.blm.gov\` returns 418 at its root and exposes no documented public API. No public API, WSDL, or stable search-URL pattern was found.
- Old search URLs (\`/search/default.aspx\`) redirect to the portal home (\`/s/\`). There is no verified machine interface to build a CLI against, so this guide ships website-only rather than inventing endpoints.

## Environment variables

- None. No key or account is needed for searching.

## Research workflow notes

- Record the exact township, range, and section from every patent: that triple is what NARA needs for the case file, and it is what pins the parcel on a modern map.
- Public-land states (such as Illinois, Missouri, Michigan, and Kansas) typically show early purchases as Cash Entry, Homestead, or Military Warrant patents. California land is trickier: much of it passed through Spanish or Mexican ranchos and state grants rather than federal patents, so a missing GLO patent in California is expected and is not evidence of no land.
- Pair each patent with a GNIS lookup (\`kinloom gnis\`; see \`kinloom guide gnis\`) for the modern place name and coordinates of the township's features.

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
