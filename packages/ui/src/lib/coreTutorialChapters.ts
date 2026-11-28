import { type ArchiveBundle, type KinloomTutorialChapter, KinloomTutorialChapterSchema } from '@kinloom/core';
import type { CompiledKinloomTutorialChapter } from '../plugins/validatePlugins.js';
import { pickFeaturedDossierPerson } from './onboardingModel.js';

const RAW_CORE_TUTORIAL_CHAPTERS: readonly KinloomTutorialChapter[] = [
  KinloomTutorialChapterSchema.parse({
    id: 'core-navigation-search',
    title: 'Navigating the Archive & Global Search',
    summary: 'Move across People, Places, Time, Family Tree, Migration Map, and instant Global Search.',
    minRole: 'viewer',
    order: 10,
    estimatedSeconds: 50,
    steps: [
      {
        id: 'nav-top-bar-axes',
        title: 'Switch across primary archival views',
        instructions:
          'Use the top navigation bar to switch between People, Places, Evidence & Sources, Time, Family Tree, and Migration Map.',
        transcript:
          'The top navigation bar organizes your archive into core axes: People, Places, Evidence and Sources, Time, Family Tree, and Migration Map. You can switch views at any time without losing your place.',
        targetRoute: '/',
        targetRouteLabel: 'Browse People',
        highlights: [
          'People lists relatives by generation, surname, or family branch.',
          'Places groups towns, counties, and historic residences.',
          'Reading Room opens primary record transcriptions from any page.',
        ],
      },
      {
        id: 'nav-global-search',
        title: 'Find any record with Global Search',
        instructions:
          'Press / or Cmd/Ctrl+K from anywhere in Kinloom to search people, places, dated events, and primary source pages.',
        transcript:
          'Press the slash key or Command K anywhere in the archive to open Global Search. Type a surname, town, year, or source phrase to jump straight to the matching Person Profile or record page.',
        targetRoute: '/evidence',
        targetRouteLabel: 'Open Evidence & Sources',
        highlights: [
          'Matches alternate spellings and maiden names automatically.',
          'Searches both structured records and full-text source pages.',
          'Press Escape at any time to close the search modal and return focus.',
        ],
      },
    ],
  }),
  KinloomTutorialChapterSchema.parse({
    id: 'core-person-dossier',
    title: 'Reading Person Profiles, Citations & Audio',
    summary:
      'Read vital facts, inspect original scans in the Source Reader, and play Pronunciation Guides or narrated biographies.',
    minRole: 'viewer',
    order: 20,
    estimatedSeconds: 75,
    steps: [
      {
        id: 'profile-facts-and-timeline',
        title: 'Read vital facts, evidence badges, and Life Timeline',
        instructions:
          'Open any Person Profile to review birth and death dates, immediate family links, Cited vs. Family memory badges, and the chronological Life Timeline.',
        transcript:
          'Each Person Profile collects documented life events in chronological order. Green Cited badges mark facts backed by primary records, while amber Family memory badges indicate oral tradition still awaiting a document.',
        targetRoute: '/',
        targetRouteLabel: 'Open a Person Profile',
        highlights: [
          'Cited badges link directly to primary records and page citations.',
          'Family memory badges distinguish oral history from verified documents.',
          'Immediate family links let you pivot smoothly between parents, spouses, and children.',
        ],
      },
      {
        id: 'profile-source-reader',
        title: 'Inspect original scans in the Source Reader',
        instructions:
          'Select any citation pill to open the Source Inspector or Source Reader and compare transcriptions alongside original document scans.',
        transcript:
          'Select any citation badge on a milestone to open the Source Inspector. From there, launch the Source Reader to inspect high-resolution scans side by side with transcribed text.',
        targetRoute: '/evidence?tab=citations',
        targetRouteLabel: 'Open Evidence & Sources',
        highlights: [
          'Switch between Text, Side-by-Side, and Original Scan modes.',
          'Copy formatted archival citations with a single click.',
          'Open Photos & Documents to browse portraits, headstones, and record scans.',
        ],
      },
      {
        id: 'profile-pronunciations-and-audio',
        title: 'Play Pronunciation Guides and narrated biographies',
        instructions:
          'Play inline Pronunciation Guides next to historic names and listen to narrated biographies where audio is available.',
        transcript:
          'When a historic surname or given name has a recorded Pronunciation Guide, select the speaker button beside the title to hear how the family pronounced it, or play a narrated biography while you browse.',
        targetRoute: '/evidence?tab=media',
        targetRouteLabel: 'Open Photos & Documents',
        highlights: [
          'Pronunciation Guides include IPA notation and spoken audio clips.',
          'Narrated biographies keep playing in a compact bottom dock as you navigate.',
        ],
      },
    ],
  }),
  KinloomTutorialChapterSchema.parse({
    id: 'core-tree-pedigree',
    title: 'Exploring the Family Tree',
    summary: 'Switch between Chart View and List View, filter by branch, and spotlight direct lineage paths.',
    minRole: 'viewer',
    order: 30,
    estimatedSeconds: 60,
    steps: [
      {
        id: 'tree-chart-and-list',
        title: 'Switch between Chart View and List View',
        instructions:
          'Open Family Tree in the top bar and use the Chart and List buttons to move between the pan-and-zoom pedigree diagram and the generation card list.',
        transcript:
          'Open Family Tree in the top bar to view ancestors, marriages, and descendants across generations. Use the Chart and List buttons to switch between the pan-and-zoom diagram and a generation-by-generation card list.',
        targetRoute: '/tree',
        targetRouteLabel: 'Open Family Tree',
        highlights: [
          'Chart View supports pan, zoom, and keyboard navigation across generations.',
          'List View provides a scannable, screen-reader-friendly generation roll.',
        ],
      },
      {
        id: 'tree-branches-and-spotlight',
        title: 'Filter branches and open the Focus Drawer',
        instructions:
          'Filter by Family Branch, toggle Direct Line vs. Full Tree, expand Other Children, and select any person card to spotlight their lineage in the Focus Drawer.',
        transcript:
          'Narrow large trees with the Family Branch selector and toggle between Direct Line and Full Tree. Select any relative to highlight their lineage path and inspect vital dates in the Focus Drawer.',
        targetRoute: '/tree',
        targetRouteLabel: 'Explore Tree Controls',
        highlights: [
          'Use Find person to jump directly to any relative on the canvas.',
          'Expand Other Children chips to reveal sibling branches on demand.',
        ],
      },
    ],
  }),
  KinloomTutorialChapterSchema.parse({
    id: 'core-map-timeline',
    title: 'Tracing the Migration Map & Time View',
    summary: 'Animate documented family migrations on the map and scrub historical years on the Time view.',
    minRole: 'viewer',
    order: 40,
    estimatedSeconds: 55,
    steps: [
      {
        id: 'map-migration-routes',
        title: 'Play migration routes and filter historical eras',
        instructions:
          'Open Migration Map to inspect geocoded residences, filter by person or historical era, and play chronological movement across stops.',
        transcript:
          'Open the Migration Map to follow where generations settled over time. Filter by an individual or historical era, then press Play Route to step chronologically through every geocoded stop.',
        targetRoute: '/map',
        targetRouteLabel: 'Open Migration Map',
        highlights: [
          'Toggle between By person and Chronological route playback.',
          'Click any mapped town to open its Place Profile and who passed through.',
        ],
      },
      {
        id: 'time-year-scrubber',
        title: 'Scrub historical years on the Time view',
        instructions:
          'Use the year slider or milestone buttons on Time to see every relative alive in a chosen year, their ages, and contemporaneous local history.',
        transcript:
          'On the Time view, drag the year slider or pick a milestone year to take a snapshot of the entire family. Kinloom calculates each relative’s age and location alongside wider historical notices.',
        targetRoute: '/time',
        targetRouteLabel: 'Open Time View',
        highlights: [
          'Shows co-present relatives living in the same town in any year.',
          'Groups relatives without a recorded residence under Place Unrecorded.',
        ],
      },
    ],
  }),
  KinloomTutorialChapterSchema.parse({
    id: 'core-editing-records',
    title: 'Editing Records, Citations & Uploading Scans',
    summary:
      'Add or edit cited records, resolve optimistic edit conflicts, inspect Revision History, and upload archival scans safely.',
    minRole: 'editor',
    order: 50,
    estimatedSeconds: 85,
    steps: [
      {
        id: 'edit-record-and-citations',
        title: 'Create or edit records with source attribution',
        instructions:
          'Use Edit Page or + Add Person to update people, places, or events, attaching a primary citation or marking oral history as Family memory.',
        transcript:
          'Editors can open Edit Page on any Person Profile, Place Profile, or event to refine dates, biographies, and Family Notes. Attach a primary source citation whenever available, or label unverified oral history as Family memory.',
        targetRoute: '/',
        targetRouteLabel: 'Open People Directory',
        highlights: [
          'Every edit requires a brief summary note for future stewards.',
          'Attach existing sources or create new citations inline.',
        ],
      },
      {
        id: 'edit-conflicts-and-history',
        title: 'Resolve Edit Conflicts and review Revision History',
        instructions:
          'If two editors save the same record simultaneously, use the Conflict Merge dialog to compare versions, and review or revert any change in Revision History.',
        transcript:
          'Kinloom uses optimistic concurrency to protect against accidental overwrites. If another editor saves while you are working, compare both versions side by side in the Conflict Merge dialog. Every saved change is recorded in Revision History and can be reverted.',
        targetRoute: '/changes',
        targetRouteLabel: 'Open Revision History',
        highlights: [
          'Field-level diffs highlight additions and removals in high contrast.',
          'Revision History tracks both human editors and scoped agent updates.',
        ],
      },
      {
        id: 'edit-upload-photos-and-privacy',
        title: 'Upload Photos & Documents under the Living Privacy Rule',
        instructions:
          'Upload portraits, headstones, or document scans from a Person Profile. Remember that portraits for living relatives are blocked by the Living Privacy Rule.',
        transcript:
          'Select Add Photo on a deceased ancestor’s Person Profile to upload portraits, headstones, or document scans. To protect living family members, Kinloom enforces the Living Privacy Rule and prevents publishing portraits or private residence details for living people.',
        targetRoute: '/evidence?tab=media',
        targetRouteLabel: 'Inspect Photos & Documents',
        highlights: [
          'Categorize uploads as Portrait, Family Photo, Headstone, or Record Scan.',
          'Living Privacy Rule automatically strips living portraits from public views.',
        ],
      },
    ],
  }),
  KinloomTutorialChapterSchema.parse({
    id: 'core-admin-settings',
    title: 'Managing Members, Invites & Archive Settings',
    summary:
      'Run System Diagnostics, read built-in Admin Docs and Changelogs, manage Family Invites, and configure plugins or backup tokens.',
    minRole: 'admin',
    roles: ['admin'],
    order: 60,
    estimatedSeconds: 80,
    steps: [
      {
        id: 'admin-diagnostics-and-docs',
        title: 'Check System Diagnostics and Admin Docs',
        instructions:
          'Open Site Administration to verify D1, R2, and plugin health probes in System Diagnostics and read built-in module Docs & Changelogs.',
        transcript:
          'In Site Administration, start with System Diagnostics to confirm database, media storage, and active plugin health. Expand the built-in Docs and Changelogs panels whenever you need version notes or configuration references.',
        targetRoute: '/admin#diagnostics',
        targetRouteLabel: 'Open System Diagnostics',
        highlights: [
          'Live health probes surface binding issues before readers encounter errors.',
          'Module changelogs stay synchronized with installed package versions.',
        ],
      },
      {
        id: 'admin-invites-and-members',
        title: 'Issue Family Invites and enroll Editors',
        instructions:
          'Create revocable read-only Family Invite links for relatives to explore private archives, and assign Editor or Admin roles to trusted contributors.',
        transcript:
          'Create labeled Family Invite links to give relatives read-only access without requiring an editor account, and revoke any link immediately if needed. Assign Editor roles to family stewards who will help transcribe and cite records.',
        targetRoute: '/admin#invites',
        targetRouteLabel: 'Manage Family Invites',
        highlights: [
          'Set optional expiration dates and track invite usage counts.',
          'Promote or demote members cleanly in the Members directory.',
        ],
      },
      {
        id: 'admin-plugins-and-tokens',
        title: 'Configure Plugin Settings and scoped Agent Tokens',
        instructions:
          'Adjust installed Plugin Settings and create least-privilege Agent Tokens (read_backup or write_batch) for automated backups and research workflows.',
        transcript:
          'Use Plugin Settings to customize installed modules without redeploying code. When connecting CLI backups or research scripts, generate scoped Agent Tokens with only the permissions each automation requires.',
        targetRoute: '/admin#plugin-settings',
        targetRouteLabel: 'Open Plugin Settings',
        highlights: [
          'read_backup tokens allow safe offline archival exports.',
          'Revoke any token immediately from Site Administration.',
        ],
      },
    ],
  }),
];

export const CORE_TUTORIAL_CHAPTERS: readonly CompiledKinloomTutorialChapter[] =
  RAW_CORE_TUTORIAL_CHAPTERS.map((chapter) => ({
    ...chapter,
    source: 'core',
  }));

/**
 * Returns core tutorial chapters with dynamic profile deep-links hydrated to a real
 * public deceased ancestor when an archive bundle is loaded.
 */
export function buildCoreTutorialChapters(
  bundle: ArchiveBundle | null
): readonly CompiledKinloomTutorialChapter[] {
  const featuredPerson = pickFeaturedDossierPerson(bundle);
  if (!featuredPerson) {
    return CORE_TUTORIAL_CHAPTERS;
  }
  const personRoute = `/person/${featuredPerson.slug}`;
  return CORE_TUTORIAL_CHAPTERS.map((chapter) => {
    if (chapter.id !== 'core-person-dossier') {
      return chapter;
    }
    return {
      ...chapter,
      steps: chapter.steps.map((step, index) =>
        index === 0
          ? {
              ...step,
              targetRoute: personRoute,
              targetRouteLabel: `Open ${featuredPerson.full_name}`,
            }
          : step
      ),
    };
  });
}
