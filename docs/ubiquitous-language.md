# Kinloom ubiquitous language

This reference defines the shared vocabulary across Kinloom. Use the canonical term in user interfaces, CLI help text, documentation, and new domain code.

Keep reader copy direct, warm, and free of internal developer jargon or dark euphemisms. Preserve existing URL routes, query parameters, YAML field names, and exported TypeScript symbols for backward compatibility.

## Reader experience

| Canonical Term | Meaning | Where Used | Avoid (Deprecated Synonyms) |
| --- | --- | --- | --- |
| **Archive** | A family history site and its underlying YAML, media, and source collection. | UI, CLI, Docs, Code | Build, Bundle (in reader copy), Instance |
| **Person** | An individual recorded in `data/people.yaml`. Plural: **People**. | UI, CLI, Docs, Code | Archived relative (in generic lists), Individual (in reader copy) |
| **Person Profile** | The detail page (`/person/:slug`) for one person, containing vital dates, family links, biography, family stories, photos and documents, and life timeline. | UI, Docs | Dossier, Person dossier, Individual dossier, Person timeline (when naming the whole page) |
| **Place** | A town, county, state, country, or homestead in `data/places.yaml`. Plural: **Places**. | UI, CLI, Docs, Code | Community (as a blanket substitute for all place types) |
| **Place Profile** | The detail page (`/place/:slug`) for one place, showing the survey map, historical profile, residents over time, and local history. | UI, Docs | Place dossier, Place timeline (when naming the whole page) |
| **Life Timeline** | The chronological stream of events on a Person Profile. | UI, Docs | Biographical timeline, Story stream (in reader copy) |
| **Time** | The year-by-year snapshot view (`/time`) showing where family members were in a selected year. | UI, Docs | Era view |
| **Alive in [Year]** | A person who was living during a historical year shown on `/time`. Distinct from the **Living** privacy status. | UI, Docs | Living relative (when referring to a historical year such as 1860) |
| **Migration Map** | The interactive historical map (`/map`) tracing family routes and stops across time. | UI, Docs | Archival migration map, Geo map |
| **Kinship Finder** | The relationship and life-overlap view (`/kinship`) showing the shortest family path between two people. | UI, Docs | Kinship & Life-Overlap Finder (use short canonical heading), Relationship calculator |
| **Search** | Global archive search modal (`/` or `Cmd+K`) covering people, places, events, and source pages. | UI, Docs | Find (in top bar), Global lookup |

## Family tree

| Canonical Term | Meaning | Where Used | Avoid (Deprecated Synonyms) |
| --- | --- | --- | --- |
| **Family Tree** | The interactive genealogy view (`/tree`) showing ancestors, couples, and descendants. | UI, Docs | 2D Tree, 2D Family Tree, Family lineage tree |
| **Direct Line** | Lineage scope showing direct ancestors and descendants along the core family line (`mode: 'spine'`). | UI, Docs | Direct Spine, Direct Mode, Main Line, Living Spine |
| **Full Tree** | Lineage scope showing all people in the active branch, including extended relatives (`mode: 'full'`). | UI, Docs | Complete graph, Full graph |
| **List View** | Vertical, generation-by-generation card view on `/tree` (`surface: 'roll'`). Toolbar short label: **List**. | UI, Docs | Pedigree Roll, Portrait Roll, Vertical Roll |
| **Chart View** | Pan-and-zoom two-dimensional family tree chart on `/tree` (`surface: 'diagram'`). Toolbar short label: **Chart**. | UI, Docs | Orthogonal Diagram, 2D Canvas, Hierarchical 2D canvas |
| **Family Branch** | A configured surname or lineage grouping in `kinloom.config.yaml` (filterable on `/tree`). | UI, CLI, Docs, Code | Subtree, Wing |
| **Focus Ancestor** | The central anchor ancestor for a branch or archive (`lineage_group: 'pivot_ancestor'`). | UI, Docs | Pivot Ancestor, Root node |
| **Extended Relative** | A relative outside the direct ancestor-descendant line (`lineage_group: 'collateral' \| 'extended'`). | UI, Docs | Collateral Relative, Side branch |
| **Marriage** | A couple pairing connecting two partners and their children on the tree (`Marriage I`, `Marriage II` for remarriages). Internal layout model may use `TreeUnion`. | UI, Docs | Union hub, Marriage hub, Couple node (in reader copy) |
| **Other Children** | Collapsed children under a parent couple unit, expandable via `+N other children (M in direct line below)` in Direct Line or `+N other children (M shown below)` in Full Tree (or `+N children` when none appear below). Search tag: **Other children**. | UI, Docs | Sibling tray, Hanging grid, Collateral siblings, Hide N siblings |
| **Died young** | Plain-English, non-dark label for children who died at age 5 or younger. Tooltip: `Children who died at age 5 or younger`. | UI, Docs | Remembered early, Early-loss cohort, Infant loss (in reader badges) |
| **Living** | A person who is living today (`is_living: true` or within the living-cutoff window). Strictly redacted in public archives. | UI, CLI, Docs, Code | Private person, Active person |
| **Focus Drawer** | The detail panel shown when a reader selects a person on `/tree`, linking directly to their Person Profile. | UI, Docs | Node popover, Preview card |
| **Lineage Spotlight** | Highlighting a selected person's direct ancestors, descendants, and immediate family while dimming unrelated cards. | UI, Docs | Active selection glow |

## Records & evidence

| Canonical Term | Meaning | Where Used | Avoid (Deprecated Synonyms) |
| --- | --- | --- | --- |
| **Source** | A cataloged historical record, census, vital register, book, or collection in `data/sources.yaml`. | UI, CLI, Docs, Code | Reference record, Proof item |
| **Citation** | A link attaching a Source to an Event, Person, Place, or Narrative, with optional page, roll, or folio detail. | UI, CLI, Docs, Code | Proof, Footnote entry (when referring to structured links) |
| **Sources** | Top-level navigation action (desktop and mobile) that opens the **Source Reader**. | UI, Docs | Primary Sources (in mobile nav when desktop says Sources) |
| **Source Inspector** | The drawer displaying bibliographic metadata, formatted citation, record scan preview, and every archive usage of a Source. | UI, Docs | Source bibliographic inspector |
| **Source Reader** | The drawer for reading transcribed source pages and original scans in **Text**, **Side-by-Side**, or **Original Scan** modes. | UI, Docs | Archival Source Reader, Primary Text Reader |
| **Source Page** | A single transcribed or scanned page inside the Source Reader (`readings.json`). | UI, Docs | Primary Source Page, Reading item |
| **Evidence & Sources** | The audit and catalog page (`/evidence`) with three tabs: **Source Discrepancies**, **Sources & Citations**, and **Photos & Documents**. | UI, Docs | Evidence, Citations & Archival Media Ledger; Proof Ledger |
| **Source Discrepancy** | A preserved difference in date, place, or fact across two or more historical sources. Distinct from a wiki **Edit Conflict**. | UI, Docs | Date & Fact Conflict (prefer Discrepancy for historical records) |
| **Photos & Documents** | The unified reader label for attached portraits, family photos, headstones, record scans, document scans, videos, and oral histories (`data/media.yaml`). | UI, Docs | Digitized Media, Archival Media, Media Gallery, Scans (when used inconsistently) |
| **Record Scan** | A digitized image of an official primary record such as a census sheet or vital certificate (`kind: 'record_scan'`). | UI, Docs | Primary Record Scan |
| **Document Scan** | A digitized page from a book, letter, manuscript, or family document (`kind: 'document_scan'`). | UI, Docs | Manuscript scan |
| **Oral History** | An audio recording of a family interview or spoken account (`kind: 'audio_oral_history'`). | UI, Docs | Audio Oral History |
| **Biography** | An individual life account linked to one subject person (`kind: 'biography'`, `subject_person_id`). Plural: **Biographies**. | UI, CLI, Docs, Code | Bio story, Life narrative (in reader headings) |
| **Family Story** | A multi-person essay or shared family account (`kind: 'family_story' \| 'memoir'`). Plural: **Family Stories**. | UI, Docs | Shared narrative, Story reel |
| **Narrative** | The collective schema and CLI term for any entry in `data/narratives.yaml`. Use **Biography** or **Family Story** in reader UI. | CLI, Docs, Code | Essay (as a schema term) |
| **Event** | A dated or undated life milestone, residence anchor, or historical context item in `data/events.yaml`. | UI, CLI, Docs, Code | Milestones & Dispatches (in search headings) |
| **Local History** | Place-scoped historical weather records and newspaper notices on a Place Profile. | UI, Docs | Local weather anomalies |
| **Cited** | Badge indicating a record or edit is backed by a primary archival source. | UI, Docs, Code | Verified, Proven |
| **Family memory** | Badge indicating a record or edit comes from family knowledge without a primary source citation yet. | UI, Docs, Code | Unverified (for oral family edits) |

## Pronunciation & audio

| Canonical Term | Meaning | Where Used | Avoid (Deprecated Synonyms) |
| --- | --- | --- | --- |
| **Pronunciation Guide** | The reader-facing respelling, IPA, source attribution, regional variants, and audio playback control shown for deceased people and places. | UI, CLI, Docs | Phonetic tag, Accent badge |
| **Respelling** | Reader-friendly syllable guide (for example, `MER-ser` or `LAY-den`). Stored in schema field `phonetic`. | UI, CLI, Docs | Phonetic spelling (use Respelling in prose; keep `phonetic` in schema) |
| **IPA** | Verified International Phonetic Alphabet transcription wrapped in `/.../` or `[...]`. Never fabricated when no verified source exists. | UI, CLI, Docs, Code | Phonetic symbols |
| **Pronunciation Lexicon** | Shared archive-level map (`kinloom.config.yaml` `pronunciations` plus live D1 overrides) of reusable given names, surnames, full names, and qualified place names. | UI, CLI, Docs, Code | Pronunciation dictionary, Phonetic map |
| **Full-Name Pronunciation** | A person guide with `coverage: 'full'`, resolved from explicit `person.pronunciation`, an exact full-name or ID lexicon entry, or compositional resolution of every name part. Displays cleanly without a single-word prefix. | UI, CLI, Docs, Code | Complete pronunciation |
| **Surname Pronunciation** | A fallback guide with `coverage: 'surname'` when only the surname resolves in the lexicon. Displays with the `Surname:` prefix so readers know it covers the surname only. | UI, CLI, Docs, Code | Inherited pronunciation, Bare surname fallback |
| **Partial Pronunciation** | A guide with `coverage: 'partial'` where some but not all meaningful name parts resolved. Displays with an explicit scope prefix. | UI, CLI, Docs, Code | Incomplete guide |
| **Pronunciation Variant** | A regional or language-specific alternative pronunciation (for example, Netherlands Dutch vs. West Michigan English). | UI, CLI, Docs, Code | Alternate reading |
| **Pronunciation Audit** | The `kinloom pronounce audit` command that checks 100% deceased full-name coverage, 100% place coverage, homonymous place keys, IPA quality, and 0 living-person leaks. | CLI, Docs | Lexicon check |

## Research & archive operations

| Canonical Term | Meaning | Where Used | Avoid (Deprecated Synonyms) |
| --- | --- | --- | --- |
| **Research Package** | A staged per-person folder (`research/people/<person_id>/patch.json` plus `scans/`) validated by `kinloom audit` and merged by `kinloom integrate`. | CLI, Docs | Patch folder, Agent drop |
| **Revision** | One immutable, numbered change (`r1`, `r2`, ...) in the append-only revision ledger. | UI, CLI, Docs, Code | Version snapshot |
| **Revision History** | The per-record or site-wide (`/changes`) timeline of Revisions. | UI, Docs | Audit log (in reader UI) |
| **Revert** | Action that appends a new Revision restoring a record or batch to its prior state without deleting history. | UI, CLI, Docs, Code | Rollback (in reader UI) |
| **Research Batch** | A grouped multi-entity submission (`batch_id`) from a research agent or CLI sync, revertible as one unit. | UI, CLI, Docs, Code | Agent wave (use Research Batch consistently) |
| **Edit Conflict** | An optimistic concurrency collision (`HTTP 409`) when two editors save the same record simultaneously. Distinct from a historical **Source Discrepancy**. | UI, Docs, Code | Merge failure |
| **Family Notes** | The collaborative discussion thread attached to a Person Profile or Place Profile (internal API/schema name: `talk`). | UI, Docs | Talk page, Record discussion (in visible headings) |
| **Living Privacy Rule** | Policy that strips portraits, exact birth dates, street addresses, residence spans, and pronunciations from living people and redacts them in public builds. | UI, CLI, Docs, Code | Redaction guard |
| **Archive Sync** | The `kinloom sync` operation that diffs and pushes local YAML and R2 media to a live Kinloom deployment. | CLI, Docs | Push, Publish |
