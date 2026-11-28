import type { ArchivalMediaKind, PronunciationCoverage, SearchResultKind } from '@kinloom/core';

/**
 * Canonical DDD Ubiquitous Language for Kinloom UI surfaces.
 * See `docs/ubiquitous-language.md` for definitions and deprecated synonyms.
 */
export const MEDIA_KIND_LABELS: Readonly<Record<ArchivalMediaKind, string>> = {
  portrait: 'Portrait',
  family_photo: 'Family Photo',
  headstone: 'Headstone',
  record_scan: 'Record Scan',
  document_scan: 'Document Scan',
  milestone: 'Milestone Photo',
  video_story: 'Video Story',
  audio_oral_history: 'Oral History',
};

export const LINEAGE_GROUP_LABELS: Readonly<Record<string, string>> = {
  pivot_ancestor: 'Focus Ancestor',
  ancestor: 'Ancestor',
  colonial_sibling: 'Sibling Line',
  descendant: 'Descendant',
  descendant_spouse: 'Spouse',
  spouse: 'Spouse',
  collateral: 'Extended Relative',
  extended: 'Extended Relative',
};

export const SEARCH_KIND_LABELS: Readonly<Record<SearchResultKind, string>> = {
  person: 'People',
  place: 'Places',
  event: 'Events',
  reading: 'Source Pages',
};

export const KINLOOM_VOCABULARY = {
  nav: {
    people: 'People',
    places: 'Places',
    time: 'Time',
    tree: 'Tree',
    map: 'Map',
    kinship: 'Kinship',
    kinshipFull: 'Kinship Finder',
    evidence: 'Evidence',
    evidenceFull: 'Evidence & Sources',
    sources: 'Reading Room',
    searchDesktop: 'Search (/)',
    searchAria: 'Search archive',
    searchTooltip: 'Search people, places, events, and source pages (/ or ⌘K)',
    signInToEdit: 'Sign in to edit',
    recentChanges: 'Revision History',
    siteSettings: 'Site Administration',
    signOut: 'Sign Out',
    signingOut: 'Signing out…',
    archiveMenu: 'Archive menu',
    accountOptions: 'Account options',
  },
  tree: {
    pageTitleSuffix: 'Family Tree',
    loading: 'Loading family tree…',
    toolbarAria: 'Family tree view controls',
    branchSelectAria: 'Select family branch',
    allBranches: 'All Branches',
    scopeGroupAria: 'Lineage scope',
    directLine: 'Direct Line',
    fullTree: 'Full Tree',
    layoutGroupAria: 'Tree layout',
    listViewShort: 'List',
    chartViewShort: 'Chart',
    loomViewShort: 'Loom',
    listRegionSuffix: 'generation list',
    chartCanvasSuffix: 'family tree chart',
    addPerson: '+ Add Person',
    findPersonPlaceholder: 'Find person…',
    findPersonMobilePlaceholder: 'Find person by name or year…',
    findPersonLabel: 'Find person in family tree',
    findPersonButtonAria: 'Find person in tree',
    noMatchingPeoplePrefix: 'No matching people for',
    moreSiblingsTag: 'Other children',
    otherSiblingsAria: 'Other children',
    otherChildrenAria: 'Other children',
    diedYoung: 'Died young',
    diedYoungTooltip: 'Children who died at age 5 or younger',
    marriageLabel: 'Marriage',
    livingBadge: 'Living',
    primaryPlaceLabel: 'Primary place:',
    unrecordedPlace: 'Unrecorded',
    openProfileCta: 'Open Profile →',
    clearFocus: 'Clear focus',
    zoomControlsAria: 'Chart zoom controls',
  },
  person: {
    notFoundHeading: 'Person Not Found',
    returnToPeople: 'Return to people',
    biographyHeading: 'Biography',
    familyStoriesHeading: 'Family Stories',
    photosAndDocumentsHeading: 'Photos & Documents',
    photosAndDocumentsAria: 'Photos and documents',
    readFullBiography: 'Read full biography',
    showLess: 'Show less',
    readStory: 'Read story',
    hideStory: 'Hide story',
    lifeTimelineAria: 'Life timeline',
    emptyEventsPrefix: 'No dated events recorded yet for',
    exportGedcom: 'Export GEDCOM',
    addPronunciation: '+ Add pronunciation',
    editPronunciation: 'Edit',
    alsoRecordedAs: 'Also recorded as:',
    immediateFamilyAria: 'Immediate family connections',
    residencesAria: 'Documented residence spans',
    mediaLightboxAria: 'Photo and document lightbox',
  },
  place: {
    notFoundHeading: 'Place Not Found',
    returnToPlaces: 'Return to places',
    placesFilterAll: 'All Places',
    placeProfileCta: 'Place Profile →',
    openMigrationMapCta: 'Open Migration Map →',
    migrationMapCta: 'Migration Map →',
    historicalProfileHeading: 'Historical Profile',
    whoPassedThroughHeading: 'Who Passed Through',
    localHistoryHeading: 'Local History',
    localHistoryEmpty: 'No archived local weather records or newspaper notices for this place and decade.',
    emptyPlacesFilter: 'No documented places match that filter.',
    filterPlaceholder: 'Filter town, county, or person…',
    filterAria: 'Filter places by name or person',
  },
  time: {
    lead: 'Slide the year to see where each relative alive in this year stood, their age, and what the wider world was reporting.',
    unlocatedHeadingPrefix: 'Also Alive in',
    unlocatedHeadingSuffix: 'Place Unrecorded',
    unlocatedAria: 'Relatives alive in this year without a documented place',
    emptyStatePrefix: 'No archived people have a documented place in',
    localHistoryHeading: 'Local weather and news',
    milestoneYearsTitle: 'Milestone years',
    widerWorldLabel: 'Wider world',
  },
  map: {
    title: 'Migration Map',
    loading: 'Loading migration map…',
    errorHeading: 'Unable to load migration map',
    filterByPersonAria: 'Filter migration map by person',
    filterByEraAria: 'Filter migration map by migration stage',
    allEras: 'All Stages',
    byPersonMode: 'By person',
    chronologicalMode: 'Chronological',
    placeProfileCta: 'Place Profile →',
    playRoute: '▶ Play Route',
    pauseRoute: '❚❚ Pause',
  },
  kinship: {
    heading: 'Kinship Finder',
    lead: 'Select any two people in the archive to trace their shortest documented kinship path, overlapping years alive, and shared places.',
    familyTreeCta: 'Family Tree →',
    migrationMapCta: 'Migration Map →',
    shortestPathHint: 'Documented family line:',
    sharedPlacesHeading: 'SHARED PLACES:',
  },
  evidence: {
    heading: 'Evidence & Sources',
    loading: 'Loading evidence and sources…',
    tablistAria: 'Evidence and sources sections',
    discrepanciesTab: 'Source Discrepancies',
    sourcesTab: 'Sources & Citations',
    needsCitationTab: 'Needs Citation',
    mediaTab: 'Photos & Documents',
    sourceRegistryHeading: 'Source Registry',
    unverifiedHeading: 'Entries Needing Primary Citation',
    mediaGalleryHeading: 'Photos & Documents',
    allMediaItems: 'All Items',
    loadMoreMedia: 'Load More Items',
    mediaSearchPlaceholder: 'Search photos & documents…',
    mediaSearchAria: 'Search photos and documents',
    mediaEmpty: 'No photos or documents match your search.',
    openProfileCta: 'Open Profile →',
  },
  sources: {
    inspectorAria: 'Source Inspector',
    readerAria: 'Source Reader',
    readerFallbackTitle: 'Source Reader',
    openReaderCta: 'Open Source Reader →',
    readSourceCta: 'Read Source →',
    inspectSourceCta: 'Inspect Source →',
    viewInEvidenceCta: 'View in Evidence & Sources →',
    previewScanCta: 'Preview Record Scan',
    hideScanCta: 'Hide Record Scan',
    viewRecordScanCta: 'View Record Scan ↗',
    copyCitationCta: 'Copy Citation',
    copiedCta: 'Copied',
    textMode: 'Text',
    splitMode: 'Side-by-Side',
    scanMode: 'Original Scan',
  },
  search: {
    dialogAria: 'Search archive',
    inputAria: 'Search the archive',
    placeholder: 'Search people, places, or events…',
    emptyPrefix: 'No matching people, places, events, or source pages for',
  },
  pronunciation: {
    surnameScopePrefix: 'Surname',
    partialScopePrefix: 'Partial',
    variantsAria: 'Pronunciation variants',
    defaultSourceLabel: 'Source',
  },
  wiki: {
    backToProfile: '← Back to Profile',
    editPage: 'Edit Page',
    addPhoto: 'Add Photo',
    familyNotes: 'Family Notes',
    history: 'History',
    citedBadge: 'Cited',
    familyMemoryBadge: 'Family memory',
    editConflictBadge: 'Conflict',
    livingPrivacyRuleTitle: 'Living Privacy Rule:',
    uploadDialogTitle: 'Add a Photo or Document',
    uploadDialogAria: 'Upload photo or document',
  },
  epistemic: {
    legendTitle: 'How we weigh evidence',
    citedLabel: 'Cited',
    inferredLabel: 'Family memory / Inferred',
    openQuestionLabel: 'Discrepancy / Open question',
    inspectRegistryCta: 'Inspect full Source Registry →',
  },
  stewardship: {
    completenessPrefix: 'Archival completeness',
    markReviewed: 'Mark as Reviewed',
    markingReviewed: 'Saving review…',
    clearReview: 'Undo',
    clearReviewAria: 'Clear steward review stamp',
    needsReviewLabel: 'Needs review',
    fieldReportsHeading: 'Revision History',
  },
} as const;

export function formatEventCount(count: number): string {
  return `${count} ${count === 1 ? 'event' : 'events'}`;
}

export function formatPhotoDocumentCount(count: number): string {
  return `${count} ${count === 1 ? 'photo or document' : 'photos & documents'}`;
}

export function formatReaderLoadError(rawError: string | null | undefined, fallback: string): string {
  const trimmed = rawError?.trim();
  if (!trimmed) {
    return fallback;
  }
  const lower = trimmed.toLowerCase();
  if (lower.includes('404') || lower.includes('not found')) {
    return fallback;
  }
  if (
    lower.includes('apiclienterror') ||
    /^http\s+\d{3}\b/i.test(trimmed) ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror')
  ) {
    return 'Unable to load archive records right now. Please try again.';
  }
  return trimmed;
}

export function formatPronunciationScopePrefix(coverage?: PronunciationCoverage): string | undefined {
  if (!coverage || coverage === 'full') {
    return undefined;
  }
  if (coverage === 'surname') {
    return KINLOOM_VOCABULARY.pronunciation.surnameScopePrefix;
  }
  if (coverage === 'partial') {
    return KINLOOM_VOCABULARY.pronunciation.partialScopePrefix;
  }
  const _exhaustive: never = coverage;
  return _exhaustive;
}

export function formatPronunciationScopeTitle(
  coverage?: PronunciationCoverage,
  matchedPart?: string
): string | undefined {
  if (!coverage || coverage === 'full') {
    return undefined;
  }
  if (coverage === 'surname') {
    return matchedPart ? `Surname pronunciation only (${matchedPart})` : 'Surname pronunciation only';
  }
  if (coverage === 'partial') {
    return matchedPart ? `Partial pronunciation (${matchedPart})` : 'Partial name pronunciation';
  }
  const _exhaustive: never = coverage;
  return _exhaustive;
}
