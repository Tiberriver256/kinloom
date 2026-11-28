import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  compileArchive,
  type InspectedPersonPronunciationToken,
  type KinloomSiteConfig,
  type KinshipEdge,
  type MediaItem,
  type Narrative,
  type Place,
  type Pronunciation,
  parseKinloomConfig,
  parseKinloomConfigYaml,
  parsePeopleYaml,
  type RawEvent,
  type RawPerson,
  type SourceRecord,
  serializeEventsYaml,
  serializeKinloomConfigYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
} from '@kinloom/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliValidationError } from '../../errors.js';
import type { KinloomAuditCheckContext, KinloomCliPlugin, KinloomVerifyCheckContext } from '../../plugins.js';
import { computeLifespan, parseAuditEdtf, runChronologyCheck } from './audit/chronology.js';
import { runUncitedSentenceCheck, splitParagraphIntoSentences } from './audit/citations.js';
import { runAuditHygieneRegressionCheck } from './audit/hygiene.js';
import { runScanInventoryCheck } from './audit/scans.js';
import { runAuditCommand } from './audit.js';
import { formatAuditBatchTextReport } from './auditOverlaps/report.js';
import type { AuditBatchResult } from './auditOverlaps/types.js';
import { resolveAncestryContext } from './context/ancestry.js';
import { formatPersonContextMarkdown, renderPersonContext } from './context/formatter.js';
import {
  buildRelativesSummary,
  collectPersonEventsAndReferences,
  collectPersonMedia,
  collectRelativeArchiveMedia,
  resolveImmediateKinship,
  scanTargetAndUnknownYearEvents,
} from './context/graph.js';
import {
  type LivingPrivacyState,
  type LooseYamlRecord,
  type PersonContextPayload,
  REDACTED_RELATIVE_LABEL,
} from './context/types.js';
import { runContextCommand } from './context.js';
import { runPronounceDeduplicateCommand } from './pronounce/deduplicate.js';
import {
  buildLookupCachePath,
  type CachedLookupPayload,
  defaultSleep,
  fetchJsonWithRetry,
  getPronounceCacheDir,
  readLookupCache,
  writeLookupCache,
} from './pronounce/lookupCache.js';
import {
  buildCommonsAudioUrl,
  buildWikiTargets,
  extractMediaWikiPronunciations,
  formatWikiSourceLabel,
} from './pronounce/mediaWiki.js';
import { runPronunciationAuditCheck, runPronunciationVerifyCheck } from './pronunciation-checks.js';
import {
  derivePlaceScopeHint,
  detectHomonymousPlaceCollisions,
  detectLivingPronunciationLeaks,
  evaluatePersonOverrideRedundancy,
  extractPromotableTokenFromPerson,
  formatAuditText,
  hasPronunciationValues,
  inspectNonTrivialPlaceReason,
  inspectPronunciationQuality,
  type PronounceAuditResult,
  type PronounceQualityWarning,
} from './shared/pronunciation/index.js';
import {
  cleanExtractedIpa,
  cleanExtractedPhonetic,
  extractAlignedTokenSegment,
  matchesComposedTokenSequence,
  normalizeIpaComparable,
  normalizeIpaForConflictCheck,
  normalizePhoneticComparable,
  normalizeWhitespace,
} from './shared/pronunciation/tokenAlignment.js';
import { loadStagedPackage, loadStagedScanEntries } from './shared/stagedOverlaps/loader.js';
import { analyzeTreeHygiene } from './treeHygiene/checks.js';
import {
  isMoreThanOneYearAfter,
  isStrictlyAfterDate,
  maxPossibleAgeYears,
  parseEdtfRange,
} from './treeHygiene/dates.js';
import {
  findDuplicateResidenceSpans,
  scanPublicLivingNames,
  validatePlaceCoordinates,
} from './verify/checks.js';
import { verifyMediaFilesOnDisk } from './verify/mediaCheck.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env['KINLOOM_PRONOUNCE_CACHE_DIR'];
  delete process.env['KINLOOM_ANCESTRY_FACTS_DIR'];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function makePngBuffer(width: number, height: number, padBytes = 0): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR', 'ascii');
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const crc = Buffer.alloc(4);
  const pad = padBytes > 0 ? Buffer.alloc(padBytes, 0x20) : Buffer.alloc(0);
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crc, pad]);
}

function makePerson(overrides: Partial<RawPerson> & { id: string }): RawPerson {
  return {
    slug: overrides.id,
    full_name: 'Martin Vance',
    given_name: 'Martin',
    surname: 'Vance',
    alt_names: [],
    sex: 'M',
    birth_edtf: '1880-05-10',
    death_edtf: '1950-08-12',
    is_living: false,
    lineage_group: 'paternal',
    portrait_url: null,
    ...overrides,
  };
}

function makePlace(overrides: Partial<Place> & { id: string }): Place {
  return {
    slug: overrides.id,
    name: 'Oakville',
    full_name: 'Oakville, Ohio, USA',
    lat: 41.2,
    lng: -82.3,
    place_type: 'town',
    parent_id: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<RawEvent> & { id: string }): RawEvent {
  return {
    title: 'Residence in Oakville',
    scope: 'personal',
    event_kind: 'point_event',
    edtf_date: '1910-04-15',
    place_id: null,
    summary: 'Martin Vance resided in Oakville.',
    participants: [],
    sources: [],
    ...overrides,
  };
}

function makeSiteConfig(pronunciations?: Record<string, Pronunciation>): KinloomSiteConfig {
  return parseKinloomConfig({
    site: {
      title: 'Vance Family Archive',
      shortName: 'Vance',
      familyName: 'Vance',
      gedcomSourceName: 'VANCE_ARCHIVE',
      baseUrl: 'https://archive.example.test',
    },
    privacy: {
      livingCutoffYears: 110,
      referenceYear: 2026,
    },
    ...(pronunciations ? { pronunciations } : {}),
  });
}

function makeToken(
  overrides: Partial<InspectedPersonPronunciationToken> & { text: string }
): InspectedPersonPronunciationToken {
  return {
    kind: 'token',
    role: 'given',
    lexiconKey: overrides.entry ? overrides.text : null,
    entry: null,
    ...overrides,
  };
}

describe('pronunciation tokenAlignment behavioral edge cases', () => {
  it('normalizes whitespace, IPA delimiters, and empty/punctuation-only values', () => {
    expect(normalizeWhitespace('  MAR-tin   VAHNS  ')).toBe('MAR-tin VAHNS');
    expect(normalizeWhitespace(null)).toBe('');
    expect(normalizeIpaComparable('  /ˈmɑr.tɪn/  ')).toBe('ˈmɑr.tɪn');
    expect(normalizeIpaComparable('   ')).toBe('');
    expect(normalizeIpaComparable(undefined)).toBe('');
    expect(cleanExtractedPhonetic('  "MAR - tin", ')).toBe('MAR-tin');
    expect(cleanExtractedPhonetic('---')).toBeNull();
    expect(cleanExtractedIpa('  [/ˈvɑns/], ')).toBe('ˈvɑns');
    expect(cleanExtractedIpa('///')).toBeNull();
    expect(normalizePhoneticComparable('  MAR-tin. ')).toBe('mar-tin');
    expect(normalizePhoneticComparable('...')).toBe('');
    expect(normalizeIpaForConflictCheck('/ˈvɑːns/')).toBe('vɑːns');
    expect(normalizeIpaForConflictCheck('   ')).toBe('');
  });

  it('extracts aligned phonetic and IPA segments across hyphens, punctuation, initials, and relaxed IPA', () => {
    const annaTok = makeToken({
      text: 'Anna',
      entry: { phonetic: 'AH-nah', ipa: '/ˈɑnɑ/' },
    });
    const marieHyphenMissing = makeToken({
      text: 'Marie',
      entry: null,
      joinWithHyphen: true,
    });
    const vanceTok = makeToken({
      text: 'Vance',
      role: 'surname',
      entry: { phonetic: 'VAHNS', ipa: '/ˈvɑns/' },
    });
    const vanceHyphenTok = makeToken({
      text: 'Vance',
      role: 'surname',
      entry: { phonetic: 'VAHNS', ipa: '/ˈvɑns/' },
      joinWithHyphen: true,
    });

    // Empty fullValue returns null
    expect(
      extractAlignedTokenSegment({
        fullValue: '   ',
        beforeTokens: [],
        missingToken: marieHyphenMissing,
        afterTokens: [],
        mode: 'phonetic',
      })
    ).toBeNull();

    // Missing phonetic on a beforeToken returns null
    expect(
      extractAlignedTokenSegment({
        fullValue: 'AH-nah mah-REE',
        beforeTokens: [makeToken({ text: 'Anna', entry: { ipa: '/ˈɑnɑ/' } })],
        missingToken: marieHyphenMissing,
        afterTokens: [],
        mode: 'phonetic',
      })
    ).toBeNull();

    // Hyphenated phonetic prefix stripping
    expect(
      extractAlignedTokenSegment({
        fullValue: 'AH-nah-mah-REE',
        beforeTokens: [annaTok],
        missingToken: marieHyphenMissing,
        afterTokens: [],
        mode: 'phonetic',
      })
    ).toBe('mah-REE');

    // Non-matching prefix returns null
    expect(
      extractAlignedTokenSegment({
        fullValue: 'KLAR-ah mah-REE',
        beforeTokens: [annaTok],
        missingToken: marieHyphenMissing,
        afterTokens: [],
        mode: 'phonetic',
      })
    ).toBeNull();

    // Relaxed IPA hyphenated prefix stripping (stress mark absent in fullValue)
    expect(
      extractAlignedTokenSegment({
        fullValue: '/ɑnɑ-mɑˈri/',
        beforeTokens: [annaTok],
        missingToken: marieHyphenMissing,
        afterTokens: [],
        mode: 'ipa',
      })
    ).toBe('/mɑˈri/');

    // Relaxed IPA hyphenated prefix with empty right side returns null
    expect(
      extractAlignedTokenSegment({
        fullValue: '/ɑnɑ-/',
        beforeTokens: [annaTok],
        missingToken: marieHyphenMissing,
        afterTokens: [],
        mode: 'ipa',
      })
    ).toBeNull();

    // After-token missing piece returns null
    expect(
      extractAlignedTokenSegment({
        fullValue: 'AH-nah VAHNS',
        beforeTokens: [],
        missingToken: makeToken({ text: 'Anna' }),
        afterTokens: [makeToken({ text: 'Vance', entry: { ipa: '/ˈvɑns/' } })],
        mode: 'phonetic',
      })
    ).toBeNull();

    // After-token phonetic with trailing punctuation
    expect(
      extractAlignedTokenSegment({
        fullValue: 'AH-nah VAHNS,',
        beforeTokens: [],
        missingToken: makeToken({ text: 'Anna' }),
        afterTokens: [vanceTok],
        mode: 'phonetic',
      })
    ).toBe('AH-nah');

    // After-token phonetic with joinWithHyphen
    expect(
      extractAlignedTokenSegment({
        fullValue: 'AH-nah-VAHNS',
        beforeTokens: [],
        missingToken: makeToken({ text: 'Anna' }),
        afterTokens: [vanceHyphenTok],
        mode: 'phonetic',
      })
    ).toBe('AH-nah');

    // After-token relaxed IPA space-delimited suffix (stress mark omitted in fullValue)
    expect(
      extractAlignedTokenSegment({
        fullValue: '/ˈɑnɑ vɑns/',
        beforeTokens: [],
        missingToken: makeToken({ text: 'Anna' }),
        afterTokens: [vanceTok],
        mode: 'ipa',
      })
    ).toBe('/ˈɑnɑ/');

    // After-token relaxed IPA hyphenated suffix
    expect(
      extractAlignedTokenSegment({
        fullValue: '/ˈɑnɑ-vɑns/',
        beforeTokens: [],
        missingToken: makeToken({ text: 'Anna' }),
        afterTokens: [vanceHyphenTok],
        mode: 'ipa',
      })
    ).toBe('/ˈɑnɑ/');

    // After-token IPA non-matching returns null
    expect(
      extractAlignedTokenSegment({
        fullValue: '/ˈɑnɑ doʊ/',
        beforeTokens: [],
        missingToken: makeToken({ text: 'Anna' }),
        afterTokens: [vanceTok],
        mode: 'ipa',
      })
    ).toBeNull();

    // Remaining cleans to empty after stripping suffix
    expect(
      extractAlignedTokenSegment({
        fullValue: '--- VAHNS',
        beforeTokens: [],
        missingToken: makeToken({ text: 'Anna' }),
        afterTokens: [vanceTok],
        mode: 'phonetic',
      })
    ).toBeNull();

    // Unmatched adjacent initial before missing token refuses absorbing expanded middle word
    const unmatchedInitial = makeToken({ kind: 'initial', text: 'J.' });
    const emptyKeyInitial = makeToken({ kind: 'initial', text: '...' });
    const unknownDeco = makeToken({ kind: 'decoration', text: 'VII' });

    expect(
      extractAlignedTokenSegment({
        fullValue: 'JAYMZ VAHNS',
        beforeTokens: [unmatchedInitial],
        missingToken: makeToken({ text: 'Vance' }),
        afterTokens: [],
        mode: 'phonetic',
      })
    ).toBeNull();

    // Empty initial key and unknown decoration and punctuation-only candidate all safely fail non-token match and extract remaining token
    expect(
      extractAlignedTokenSegment({
        fullValue: '--- VAHNS',
        beforeTokens: [emptyKeyInitial, unknownDeco],
        missingToken: makeToken({ text: 'Vance' }),
        afterTokens: [],
        mode: 'phonetic',
      })
    ).toBe('VAHNS');
  });

  it('matches composed token sequences for phonetic trailing punctuation, relaxed IPA, and optional trailing decorations', () => {
    const janeTok = makeToken({ text: 'Jane', entry: { phonetic: 'JAYN', ipa: '/ˈdʒeɪn/' } });
    const vanceTok = makeToken({
      text: 'Vance',
      role: 'surname',
      entry: { phonetic: 'VAHNS', ipa: '/ˈvɑns/' },
    });
    const jrDeco = makeToken({ kind: 'decoration', text: 'Jr.' });

    expect(matchesComposedTokenSequence({ value: '', tokens: [janeTok], mode: 'phonetic' })).toBe(false);
    expect(matchesComposedTokenSequence({ value: 'JAYN', tokens: [], mode: 'phonetic' })).toBe(false);
    expect(
      matchesComposedTokenSequence({
        value: 'JAYN',
        tokens: [makeToken({ text: 'Jane', entry: { ipa: '/ˈdʒeɪn/' } })],
        mode: 'phonetic',
      })
    ).toBe(false);

    // Trailing punctuation on final phonetic token (allowFullConsume=true)
    expect(
      matchesComposedTokenSequence({
        value: 'JAYN VAHNS.',
        tokens: [janeTok, vanceTok],
        mode: 'phonetic',
      })
    ).toBe(true);

    // Relaxed IPA full consume on final token (stress omitted)
    expect(
      matchesComposedTokenSequence({
        value: '/dʒeɪn vɑns/',
        tokens: [janeTok, vanceTok],
        mode: 'ipa',
      })
    ).toBe(true);

    // Optional trailing decoration when remaining is already empty
    expect(
      matchesComposedTokenSequence({
        value: 'JAYN',
        tokens: [janeTok, jrDeco],
        mode: 'phonetic',
      })
    ).toBe(true);
  });
});

describe('pronounce deduplicate command and rules behavioral coverage', () => {
  it('validates missing repo directory and missing kinloom.config.yaml', async () => {
    const missingBase = await makeTempDir('kinloom-dedupe-missing-');
    const missingDir = path.join(missingBase, 'does-not-exist');
    expect(() => runPronounceDeduplicateCommand({ repoDir: missingDir })).toThrow(CliValidationError);

    const emptyRepo = await makeTempDir('kinloom-dedupe-noconfig-');
    expect(() => runPronounceDeduplicateCommand({ repoDir: emptyRepo })).toThrow(CliValidationError);
  });

  it('evaluates variant-only, unique audio, and differing IPA overrides and promotion guards', () => {
    const lexicon: Record<string, Pronunciation> = {
      Jane: { phonetic: 'JAYN', ipa: '/ˈdʒeɪn/', source_label: 'Wiktionary' },
      Vance: { phonetic: 'VAHNS', ipa: '/ˈvɑns/', source_label: 'Wiktionary' },
    };

    // Variant-only explicit pronunciation triggers has_unique_variants
    const variantOnlyPerson = makePerson({
      id: 'p_var',
      full_name: 'Jane Vance',
      given_name: 'Jane',
      surname: 'Vance',
      pronunciation: {
        variants: [{ label: 'Regional', phonetic: 'JAYN VAHNS', ipa: '/ˈdʒeɪn ˈvɑns/' }],
      },
    });
    expect(evaluatePersonOverrideRedundancy(variantOnlyPerson, lexicon)).toEqual({
      kind: 'keep',
      reason: 'has_unique_variants',
      detail: 'Override carries unique pronunciation variants.',
    });

    // Custom audio_url triggers has_unique_audio
    const audioPerson = makePerson({
      id: 'p_audio',
      full_name: 'Jane Vance',
      given_name: 'Jane',
      surname: 'Vance',
      pronunciation: {
        phonetic: 'JAYN VAHNS',
        ipa: '/ˈdʒeɪn ˈvɑns/',
        audio_url: 'https://archive.example.test/jane.ogg',
      },
    });
    expect(evaluatePersonOverrideRedundancy(audioPerson, lexicon)).toEqual({
      kind: 'keep',
      reason: 'has_unique_audio',
      detail: 'Override carries a custom audio_url.',
    });

    // Matching phonetic but differing IPA triggers pronunciation_differs
    const diffIpaPerson = makePerson({
      id: 'p_ipa',
      full_name: 'Jane Vance',
      given_name: 'Jane',
      surname: 'Vance',
      pronunciation: {
        phonetic: 'JAYN VAHNS',
        ipa: '/ˈdʒeɪn ˈvæns/',
      },
    });
    const ipaDecision = evaluatePersonOverrideRedundancy(diffIpaPerson, lexicon);
    expect(ipaDecision?.kind).toBe('keep');
    if (ipaDecision?.kind === 'keep') {
      expect(ipaDecision.reason).toBe('pronunciation_differs');
      expect(ipaDecision.detail).toContain('IPA differs');
    }

    // extractPromotableTokenFromPerson: no pronunciation -> null
    expect(
      extractPromotableTokenFromPerson(makePerson({ id: 'p_none', full_name: 'Clara Vance' }), lexicon)
    ).toBeNull();

    // extractPromotableTokenFromPerson: phonetic aligns but IPA fails alignment -> null
    const badIpaAlignPerson = makePerson({
      id: 'p_bad_ipa',
      full_name: 'Clara Vance',
      given_name: 'Clara',
      surname: 'Vance',
      pronunciation: {
        phonetic: 'KLAR-ah VAHNS',
        ipa: '/ˈklɑrə ˈdoʊ/',
      },
    });
    expect(extractPromotableTokenFromPerson(badIpaAlignPerson, lexicon)).toBeNull();

    // extractPromotableTokenFromPerson: note-only pronunciation -> null
    const noteOnlyPerson = makePerson({
      id: 'p_note_only',
      full_name: 'Clara Vance',
      given_name: 'Clara',
      surname: 'Vance',
      pronunciation: {
        note: 'Family oral tradition only.',
      },
    });
    expect(extractPromotableTokenFromPerson(noteOnlyPerson, lexicon)).toBeNull();
  });

  it('runs deduplicate dry-run, apply, text formatting, promotion filtering, and no-op modes end-to-end', async () => {
    const repoDir = await makeTempDir('kinloom-dedupe-e2e-');
    await mkdir(path.join(repoDir, 'data'), { recursive: true });

    const config = makeSiteConfig({
      Vance: { phonetic: 'VAHNS', ipa: '/ˈvɑns/', source_label: 'Wiktionary' },
      Jane: { phonetic: 'JAYN', ipa: '/ˈdʒeɪn/', source_label: 'Wiktionary' },
    });
    await writeFile(path.join(repoDir, 'kinloom.config.yaml'), serializeKinloomConfigYaml(config), 'utf8');

    const people: RawPerson[] = [
      // Living person whose single-word name collides with a promotable token ("Alder")
      makePerson({
        id: 'p_living_alder',
        full_name: 'Alder',
        given_name: 'Alder',
        surname: '',
        birth_edtf: '1995-01-01',
        death_edtf: '',
        is_living: true,
      }),
      // Deceased person with no explicit override (exercises skipped decision loop)
      makePerson({
        id: 'p_no_override',
        full_name: 'Jane Vance',
        given_name: 'Jane',
        surname: 'Vance',
      }),
      // Deceased person promoting "Alder" -> skipped due to living_collision
      makePerson({
        id: 'p_alder_coll',
        full_name: 'Alder Vance',
        given_name: 'Alder',
        surname: 'Vance',
        pronunciation: { phonetic: 'AWL-der VAHNS', ipa: '/ˈɔldər ˈvɑns/' },
      }),
      // Deceased person promoting "Bram" with IPA glyph inside phonetic -> skipped due to ipa_in_phonetic
      makePerson({
        id: 'p_bram_ipa',
        full_name: 'Bram Vance',
        given_name: 'Bram',
        surname: 'Vance',
        pronunciation: { phonetic: 'ˈbrɑm VAHNS', ipa: '/ˈbrɑm ˈvɑns/' },
      }),
      // Two candidates for "Clara": one IPA-only with stress, one phonetic-only -> exercises fallback merging
      makePerson({
        id: 'p_clara_ipa_only',
        full_name: 'Clara Vance',
        given_name: 'Clara',
        surname: 'Vance',
        pronunciation: { ipa: '/ˈklɑrə ˈvɑns/' },
      }),
      makePerson({
        id: 'p_clara_phon_only',
        full_name: 'Clara Vance',
        given_name: 'Clara',
        surname: 'Vance',
        pronunciation: { phonetic: 'KLAR-ah VAHNS' },
      }),
      // Two candidates for "Eleanor": one IPA-only without stress mark, one phonetic-only -> exercises unstressed IPA fallback
      makePerson({
        id: 'p_eleanor_ipa_only',
        full_name: 'Eleanor Vance',
        given_name: 'Eleanor',
        surname: 'Vance',
        pronunciation: { ipa: '/ɛlənɔr vɑns/' },
      }),
      makePerson({
        id: 'p_eleanor_phon_only',
        full_name: 'Eleanor Vance',
        given_name: 'Eleanor',
        surname: 'Vance',
        pronunciation: { phonetic: 'EL-eh-nor VAHNS' },
      }),
      // Candidate for "Martin" with phonetic+IPA but no source_label (exercises 3rd priority find)
      makePerson({
        id: 'p_martin_nosrc',
        full_name: 'Martin Vance',
        given_name: 'Martin',
        surname: 'Vance',
        pronunciation: { phonetic: 'MAR-tin VAHNS', ipa: '/ˈmɑrtɪn ˈvɑns/' },
      }),
      // Kept override (unique note)
      makePerson({
        id: 'p_jane_note',
        full_name: 'Jane Vance',
        given_name: 'Jane',
        surname: 'Vance',
        pronunciation: {
          phonetic: 'JAYN VAHNS',
          ipa: '/ˈdʒeɪn ˈvɑns/',
          note: 'Preferred local stress on surname.',
        },
      }),
    ];
    await writeFile(path.join(repoDir, 'data', 'people.yaml'), serializePeopleYaml(people), 'utf8');

    // 1. Dry-run with promoteTokens=true and text rendering
    const dryRes = runPronounceDeduplicateCommand({
      repoDir,
      promoteTokens: true,
      apply: false,
      json: false,
    });
    expect(dryRes.applied).toBe(false);
    expect(dryRes.files_written).toEqual([]);
    expect(dryRes.promoted_tokens.map((t) => t.term)).toEqual(['Clara', 'Eleanor', 'Martin']);
    const claraPromoted = dryRes.promoted_tokens.find((t) => t.term === 'Clara');
    expect(claraPromoted?.phonetic).toBe('KLAR-ah');
    expect(claraPromoted?.ipa).toBe('/ˈklɑrə/');
    const eleanorPromoted = dryRes.promoted_tokens.find((t) => t.term === 'Eleanor');
    expect(eleanorPromoted?.phonetic).toBe('EL-eh-nor');
    expect(eleanorPromoted?.ipa).toBe('/ɛlənɔr/');
    expect(dryRes.skipped_promotions).toEqual([
      { term: 'Alder', reason: 'living_collision', source_person_ids: ['p_alder_coll'] },
      { term: 'Bram', reason: 'ipa_in_phonetic', source_person_ids: ['p_bram_ipa'] },
    ]);
    expect(dryRes.removable_overrides.map((r) => r.id).sort()).toEqual([
      'p_clara_ipa_only',
      'p_clara_phon_only',
      'p_eleanor_ipa_only',
      'p_eleanor_phon_only',
      'p_martin_nosrc',
    ]);
    expect(dryRes.kept_overrides.map((k) => k.id)).toContain('p_jane_note');
    expect(dryRes.rendered).toContain('Pronunciation Deduplicate (DRY RUN)');
    expect(dryRes.rendered).toContain('Shared tokens to promote (3):');
    expect(dryRes.rendered).toContain('Skipped token promotions (2):');
    expect(dryRes.rendered).toContain('Redundant per-person overrides (5):');
    expect(dryRes.rendered).toContain('Kept per-person overrides (3):');
    expect(dryRes.rendered).toContain('Dry run: no files were modified. Pass --apply to write changes.');

    // 2. Apply with promoteTokens=true -> writes both files
    const appliedRes = runPronounceDeduplicateCommand({
      repoDir,
      promoteTokens: true,
      apply: true,
      json: false,
    });
    expect(appliedRes.applied).toBe(true);
    expect(appliedRes.files_written).toEqual(['kinloom.config.yaml', 'data/people.yaml']);
    expect(appliedRes.rendered).toContain('Pronunciation Deduplicate (APPLIED)');
    expect(appliedRes.rendered).toContain('Updated files: kinloom.config.yaml, data/people.yaml');

    const updatedConfig = parseKinloomConfigYaml(
      fs.readFileSync(path.join(repoDir, 'kinloom.config.yaml'), 'utf8')
    );
    expect(updatedConfig.pronunciations?.['Clara']).toEqual({ phonetic: 'KLAR-ah', ipa: '/ˈklɑrə/' });
    expect(updatedConfig.pronunciations?.['Martin']).toEqual({ phonetic: 'MAR-tin', ipa: '/ˈmɑrtɪn/' });

    const updatedPeople = parsePeopleYaml(fs.readFileSync(path.join(repoDir, 'data', 'people.yaml'), 'utf8'));
    expect(updatedPeople.find((p) => p.id === 'p_martin_nosrc')?.pronunciation).toBeUndefined();
    expect(updatedPeople.find((p) => p.id === 'p_jane_note')?.pronunciation?.note).toBe(
      'Preferred local stress on surname.'
    );

    // 3. Re-run dry-run and apply when nothing remains to change
    const noopDry = runPronounceDeduplicateCommand({
      repoDir,
      promoteTokens: false,
      apply: false,
      json: false,
    });
    expect(noopDry.rendered).toContain('Nothing to deduplicate.');
    const noopApply = runPronounceDeduplicateCommand({
      repoDir,
      promoteTokens: false,
      apply: true,
      json: false,
    });
    expect(noopApply.files_written).toEqual([]);
    expect(noopApply.rendered).toContain('No files changed.');
  });
});

describe('pronounce mediaWiki parsing and lookupCache retry/persistence', () => {
  it('parses nested templates, wikilinks, named audio params, language-prefixed audio, and filters noise', () => {
    const wikitext = [
      '* {{IPA|en|pron|note={{small|US}}|link=[[Oakville|Oak]]|En-Oakville.ogg|/ˈoʊk.vɪl/|audio=En-Oakville-alt.ogg}}',
      '* {{IPA|locally|us|<!-- ignored --><ref>fn</ref>|/ˈrɪv.ər.bɛnd/}}',
      `* {{IPA|en|${'a'.repeat(130)}}}`,
      '* {{pron|En-IgnoreAudioAsIpa.ogg|en}}',
      '* {{de-IPA|also|/ˈmaʁtiːn/}}',
      '* {{audio|En-Direct.ogg}}',
      '* {{audio-nl|Nl-Alderbrook.ogg}}',
      '* {{sv-audio|Sv-Riverbend.ogg}}',
    ].join('\n');

    const enResult = extractMediaWikiPronunciations(wikitext, { targetLang: 'en', wikiLang: 'en' });
    expect(enResult.ipa).toEqual(['/ˈoʊk.vɪl/', '/ˈrɪv.ər.bɛnd/']);
    expect(enResult.audioFiles).toEqual([
      { filename: 'En-Oakville-alt.ogg', language: 'en' },
      { filename: 'En-Oakville.ogg', language: 'en' },
      { filename: 'En-Direct.ogg', language: 'en' },
    ]);

    const anyLangResult = extractMediaWikiPronunciations(wikitext, { targetLang: null, wikiLang: 'en' });
    expect(anyLangResult.ipa).toContain('/ˈmaʁtiːn/');
    expect(anyLangResult.audioFiles.map((a) => a.filename)).toEqual(
      expect.arrayContaining(['Nl-Alderbrook.ogg', 'Sv-Riverbend.ogg'])
    );

    expect(buildCommonsAudioUrl('File:En Oakville.ogg')).toBe(
      'https://commons.wikimedia.org/wiki/Special:FilePath/En_Oakville.ogg'
    );

    const nlTargets = buildWikiTargets('nl');
    expect(nlTargets.map((t) => t.host)).toEqual([
      'nl.wiktionary.org',
      'en.wiktionary.org',
      'nl.wikipedia.org',
      'en.wikipedia.org',
    ]);
    const enTargets = buildWikiTargets('en');
    expect(enTargets.map((t) => t.host)).toEqual(['en.wiktionary.org', 'en.wikipedia.org']);
    expect(formatWikiSourceLabel(nlTargets[0]!, 'nl')).toBe('Wiktionary (Dutch IPA)');
    expect(formatWikiSourceLabel(enTargets[1]!, 'zz')).toBe('Wikipedia (zz IPA)');
  });

  it('handles lookupCache persistence, corrupt cache recovery, env dir, sleep, and fetch retries', async () => {
    await defaultSleep(1);

    const cacheDir = await makeTempDir('kinloom-lookup-cache-');
    process.env['KINLOOM_PRONOUNCE_CACHE_DIR'] = cacheDir;
    expect(getPronounceCacheDir()).toBe(path.resolve(cacheDir));

    const cachePath = buildLookupCachePath({
      cacheDir,
      term: 'Oakville',
      normalizedLang: 'en',
      normalizedRegion: 'us',
      hasForvoKey: false,
    });
    expect(readLookupCache(cachePath)).toBeNull();

    // Corrupt JSON on disk recovers cleanly to null
    await writeFile(cachePath, '{not valid json', 'utf8');
    expect(readLookupCache(cachePath)).toBeNull();

    // Schema-invalid JSON recovers cleanly to null
    await writeFile(cachePath, JSON.stringify({ ok: false }), 'utf8');
    expect(readLookupCache(cachePath)).toBeNull();

    const validPayload: CachedLookupPayload = {
      ok: true,
      term: 'Oakville',
      lang: 'en',
      verified: true,
      corroborated: false,
      sourceCount: 1,
      highestTier: 'native_speaker',
      native_speaker_verified: true,
      verification_note: null,
      ipa: ['/ˈoʊk.vɪl/'],
      primary_ipa: '/ˈoʊk.vɪl/',
      audio_files: [],
      source_url: 'https://en.wiktionary.org/wiki/Oakville',
      source_label: 'Wiktionary (English IPA)',
      sources: [],
      fetched_at: '2026-01-01T00:00:00.000Z',
    };
    writeLookupCache(cachePath, validPayload);
    expect(readLookupCache(cachePath)).toEqual(validPayload);

    const sleeps: number[] = [];
    const recordSleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };

    // 404 returns null immediately
    const fetch404 = vi.fn<typeof fetch>(async () => new Response('not found', { status: 404 }));
    expect(
      await fetchJsonWithRetry({
        url: 'https://archive.example.test/404',
        fetchImpl: fetch404,
        timeoutMs: 500,
        sleepFn: recordSleep,
      })
    ).toBeNull();

    // 400 non-retryable returns null immediately
    const fetch400 = vi.fn<typeof fetch>(async () => new Response('bad request', { status: 400 }));
    expect(
      await fetchJsonWithRetry({
        url: 'https://archive.example.test/400',
        fetchImpl: fetch400,
        timeoutMs: 500,
        sleepFn: recordSleep,
      })
    ).toBeNull();

    // 429 with HTTP-date Retry-After, then 503 with unparseable Retry-After, then 200
    let seqCalls = 0;
    const futureHttpDate = new Date(Date.now() + 2000).toUTCString();
    const fetchRetryOk = vi.fn<typeof fetch>(async () => {
      seqCalls += 1;
      if (seqCalls === 1) {
        return new Response('rate limit', { status: 429, headers: { 'retry-after': futureHttpDate } });
      }
      if (seqCalls === 2) {
        return new Response('unavailable', { status: 503, headers: { 'retry-after': 'not-a-date' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const retryRes = await fetchJsonWithRetry({
      url: 'https://archive.example.test/retry-ok',
      fetchImpl: fetchRetryOk,
      timeoutMs: 500,
      sleepFn: recordSleep,
    });
    expect(retryRes).toEqual({ ok: true });
    expect(seqCalls).toBe(3);
    expect(sleeps.length).toBe(2);

    // 500 on all 4 attempts throws HTTP 500
    const fetch500 = vi.fn<typeof fetch>(async () => new Response('boom', { status: 500 }));
    await expect(
      fetchJsonWithRetry({
        url: 'https://archive.example.test/500',
        fetchImpl: fetch500,
        timeoutMs: 500,
        sleepFn: recordSleep,
      })
    ).rejects.toThrow('HTTP 500 from https://archive.example.test/500');
    expect(fetch500).toHaveBeenCalledTimes(4);

    // Network rejection retries and succeeds
    let netCalls = 0;
    const fetchNetFlaky = vi.fn<typeof fetch>(async () => {
      netCalls += 1;
      if (netCalls < 3) {
        throw new Error('ECONNRESET');
      }
      return new Response(JSON.stringify({ recovered: true }), { status: 200 });
    });
    expect(
      await fetchJsonWithRetry({
        url: 'https://archive.example.test/flaky',
        fetchImpl: fetchNetFlaky,
        timeoutMs: 500,
        sleepFn: recordSleep,
      })
    ).toEqual({ recovered: true });

    // Timeout aborts via AbortController
    const fetchTimeout = vi.fn<typeof fetch>(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('Aborted by timeout'));
        });
      });
    });
    await expect(
      fetchJsonWithRetry({
        url: 'https://archive.example.test/slow',
        fetchImpl: fetchTimeout,
        timeoutMs: 10,
        sleepFn: recordSleep,
      })
    ).rejects.toThrow('Aborted by timeout');
  });
});

describe('pronunciation-checks, auditReport, and auditRules behavioral coverage', () => {
  it('audits staged patch pronunciation deletions, living leaks, variant IPA-in-phonetic, partial coverage, and places', async () => {
    const repoDir = await makeTempDir('kinloom-pron-check-');
    const siteConfig = makeSiteConfig({
      Vance: { phonetic: 'VAHNS', ipa: '/ˈvɑns/', source_label: 'Wiktionary' },
    });

    const ctx: KinloomAuditCheckContext = {
      repoDir,
      personId: 'p_martin',
      packageDir: path.join(repoDir, 'research', 'people', 'p_martin'),
      siteConfig,
      dossierText: '',
      targetPerson: null,
      livePeople: [
        {
          id: 'p_martin',
          full_name: 'Bramwell Vance',
          birth_edtf: '1880',
          death_edtf: '1950',
          pronunciation: { phonetic: 'BRAM-wel VAHNS', source_label: 'Wiktionary' },
        },
      ],
      mergedPeople: [],
      patch: {
        person_updates: {
          full_name: 'Bramwell Vance',
          given_name: 'Bramwell',
          surname: 'Vance',
          birth_edtf: '1880',
          death_edtf: '1950',
          pronunciation: null,
        },
        people: [
          'ignored-non-record',
          { full_name: 'Missing Id' },
          {
            id: 'p_living',
            full_name: 'Living',
            pronunciation: {
              variants: [{ label: 'VariantOnly', phonetic: 'VAHNS' }],
            },
          },
          {
            id: 'p_clara',
            full_name: 'Clara Vance',
            given_names: 'Clara',
            surname: 'Vance',
            sex: 'F',
            birth_edtf: '1885',
            death_edtf: '1960',
            pronunciation: {
              phonetic: 'KLAR-ah VAHNS',
              variants: [
                { label: 'NoteOnly', note: 'Variant without phonetic' },
                { label: 'Local', phonetic: 'ˈklɑrə' },
              ],
            },
          },
        ],
        places: [
          'ignored-non-record',
          {},
          {
            id: 'plc_county',
            name: 'Alder County',
            full_name: 'Alder County, Ohio, USA',
            place_type: 'county',
            lat: 41.0,
            lng: -82.0,
            pronunciation: {
              phonetic: 'AWL-der',
              variants: [{ label: 'Local', phonetic: 'ˈɔldər' }],
            },
          },
          {
            id: 'plc_uncovered',
            name: 'Riverbend',
            full_name: 'Riverbend, Ohio, USA',
            place_type: 'town',
            lat: 41.5,
            lng: -82.5,
          },
        ],
      },
    };

    const result = runPronunciationAuditCheck(ctx);
    expect(result.errors).toEqual([
      'Living person record in staged patch contains a pronunciation entry (redacted for privacy).',
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "person_updates removes existing live pronunciation on 'p_martin'",
        "Deceased person 'Bramwell Vance' (p_martin) has only partial pronunciation coverage (missing: Bramwell).",
        "Staged pronunciation on person 'p_clara' is missing provenance (source_url or source_label).",
        expect.stringContaining("Staged pronunciation variant 'Local' on person 'p_clara'"),
        "Staged pronunciation on place 'Alder County, Ohio, USA' is missing provenance (source_url or source_label).",
        expect.stringContaining("Staged pronunciation variant 'Local' on place 'Alder County, Ohio, USA'"),
        "Staged place 'Riverbend, Ohio, USA' (plc_uncovered) has no pronunciation coverage.",
      ])
    );
    expect(result.details).toMatchObject({
      livingLeaks: 1,
      partialPeople: ['p_martin'],
      missingPlaces: ['plc_uncovered'],
      deletedLivePronunciation: true,
    });
  });

  it('runs verify pronunciation check against archive with leaks, partial coverage, homonyms, and unsourced entries', async () => {
    const repoDir = await makeTempDir('kinloom-pron-verify-');
    await mkdir(path.join(repoDir, 'data'), { recursive: true });

    const siteConfig = makeSiteConfig({
      Vance: { phonetic: 'VAHNS', ipa: '/ˈvɑns/' }, // unsourced
      Oakville: { phonetic: 'OHK-vil', ipa: '/ˈoʊk.vɪl/', source_label: 'Wiktionary' }, // homonymous bare key
    });
    const people: RawPerson[] = [
      makePerson({
        id: 'p_living_leak',
        full_name: 'Living Relative',
        given_name: 'Living',
        surname: 'Relative',
        birth_edtf: '1992',
        death_edtf: '',
        is_living: true,
        pronunciation: { phonetic: 'REL-ah-tiv' },
      }),
      makePerson({
        id: 'p_partial',
        full_name: 'Arthur Vance',
        given_name: 'Arthur',
        surname: 'Vance',
      }),
    ];
    const places: Place[] = [
      makePlace({ id: 'plc_oak_oh', name: 'Oakville', full_name: 'Oakville, Ohio, USA' }),
      makePlace({ id: 'plc_oak_tx', name: 'Oakville', full_name: 'Oakville, Texas, USA' }),
      makePlace({ id: 'plc_river', name: 'Riverbend', full_name: 'Riverbend, Ohio, USA' }),
    ];

    await writeFile(
      path.join(repoDir, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml(siteConfig),
      'utf8'
    );
    await writeFile(path.join(repoDir, 'data', 'people.yaml'), serializePeopleYaml(people), 'utf8');
    await writeFile(path.join(repoDir, 'data', 'places.yaml'), serializePlacesYaml(places), 'utf8');

    const verifyCtx: KinloomVerifyCheckContext = {
      repoDir,
      dataDir: path.join(repoDir, 'data'),
      siteConfig,
      people,
      events: [],
      places,
      sources: [],
      kinship: [],
      media: [],
      narratives: [],
      strictHygiene: false,
      strictPronunciation: true,
    };

    const verifyRes = runPronunciationVerifyCheck(verifyCtx);
    expect(verifyRes.errors).toEqual([
      'data/people.yaml record #1: Living person record contains a pronunciation entry (redacted for privacy).',
    ]);
    expect(verifyRes.warnings).toEqual(
      expect.arrayContaining([
        "Deceased person 'Arthur Vance' (p_partial) has partial pronunciation coverage (missing: Arthur).",
        "Place 'Riverbend, Ohio, USA' (plc_river) is missing pronunciation coverage (missing pronunciation entry).",
        'Unsourced pronunciation [lexicon] Vance.',
        "Homonymous bare lexicon key 'Oakville' matches multiple places.",
      ])
    );
  });

  it('formats full auditReport sections including >25 / >20 truncation ellipsis and checks auditRules edge cases', () => {
    const makeIds = (prefix: string, count: number): string[] =>
      Array.from({ length: count }, (_, idx) => `${prefix}_${idx + 1}`);

    const syntheticReport: Omit<PronounceAuditResult, 'rendered'> = {
      ok: false,
      strictOk: false,
      repo: '/tmp/synthetic-repo',
      summary: {
        deceasedTotal: 60,
        deceasedFullCoverage: 8,
        deceasedPartialOnly: 26,
        deceasedMissing: 26,
        livingLeaks: 1,
        placesTotal: 26,
        placesCovered: 0,
        placesMissing: 26,
        lexicon_entries: 5,
        deceased_people: 60,
        living_people_excluded: 2,
        places: 26,
        missing_surnames: 21,
        missing_non_trivial_places: 2,
        unsourced_entries: 26,
        homonymous_place_collisions: 1,
        ipa_quality_warnings: 1,
        redundant_person_overrides: 26,
      },
      living_leaks: [{ scope: 'person', location: 'data/people.yaml record #1', reason: 'Living leak' }],
      coverage_gaps: {
        people_missing: makeIds('pm', 26).map((id) => ({ id, full_name: `Person ${id}`, surname: 'Doe' })),
        people_partial: makeIds('pp', 26).map((id, i) => ({
          id,
          full_name: `Partial ${id}`,
          coverage: 'partial' as const,
          matched_part: 'Vance',
          missing_parts: i === 0 ? ['Arthur'] : [],
        })),
        places: makeIds('pl', 26).map((id) => ({
          id,
          name: `Town ${id}`,
          full_name: `Town ${id}, Ohio, USA`,
          reason: 'missing pronunciation entry',
        })),
        surnames: makeIds('Sur', 21).map((surname) => ({ surname, deceased_count: 2 })),
      },
      homonymous_place_collisions: [
        {
          lexicon_key: 'Oakville',
          places: [
            { id: 'plc_1', name: 'Oakville', full_name: 'Oakville, Ohio, USA', scope_hint: 'Ohio, USA' },
            { id: 'plc_2', name: 'Oakville', full_name: 'Oakville, Texas, USA', scope_hint: 'Texas, USA' },
          ],
          recommendation: 'Use qualified keys',
        },
      ],
      ipa_quality_warnings: [
        { scope: 'lexicon', key: 'Vance', code: 'malformed_ipa', message: 'Malformed IPA' },
      ],
      redundant_person_overrides: makeIds('ro', 26).map((id) => ({
        id,
        full_name: `Redundant ${id}`,
        composed_phonetic: 'JAYN VAHNS',
      })),
      unsourced_entries: makeIds('us', 26).map((key, idx) => ({
        scope: 'lexicon' as const,
        key,
        label: key,
        missing_note: idx % 2 === 0,
      })),
    };

    const text = formatAuditText(syntheticReport);
    expect(text).toContain('LIVING PRONUNCIATION LEAKS (1) [FAIL]:');
    expect(text).toContain('Deceased people missing pronunciation (26):');
    expect(text).toContain('Deceased people with Surname Pronunciation or Partial Pronunciation (26):');
    expect(text).toContain('pp_1: Partial pp_1 [partial] (missing: Arthur)');
    expect(text).toContain('Places missing pronunciation (26):');
    expect(text).toContain('Redundant per-person overrides (26');
    expect(text).toContain('Unsourced entries (26):');
    expect(text).toContain('Missing deceased surnames (21):');
    expect(text.match(/\.\.\. and 1 more\./g)?.length).toBe(6);

    // auditRules direct edge cases
    expect(
      inspectNonTrivialPlaceReason(
        makePlace({ id: 'plc_nonascii', name: 'Malmö', full_name: 'Malmö, Region' })
      )
    ).toBe('non-ASCII orthography');
    expect(
      inspectNonTrivialPlaceReason(
        makePlace({ id: 'plc_plain', name: 'Oakville', full_name: 'Oakville, Ohio, USA' })
      )
    ).toBeNull();
    expect(
      derivePlaceScopeHint(makePlace({ id: 'plc_single', name: 'Oakville', full_name: 'Oakville' }))
    ).toBe('Oakville');

    const warnings: PronounceQualityWarning[] = [];
    inspectPronunciationQuality('lexicon', 'Vance', { ipa: '/VAHNS/' }, warnings);
    expect(warnings[0]?.code).toBe('malformed_ipa');

    expect(hasPronunciationValues({ variants: [{ label: 'Alt', note: 'Spoken locally' }] })).toBe(true);

    const livingLeaks = detectLivingPronunciationLeaks(
      [
        {
          index: 1,
          person: makePerson({
            id: 'p_living_key',
            full_name: 'Evelyn Vance',
            is_living: true,
            birth_edtf: '1990',
            death_edtf: '',
          }),
        },
      ],
      [],
      new Map([
        ['p_living_key', 'p_living_key'],
        ['evelyn vance', 'Evelyn Vance'],
      ])
    );
    expect(livingLeaks).toHaveLength(2);
    expect(livingLeaks.map((l) => l.scope)).toEqual(['lexicon', 'lexicon']);

    // Homonymous check skips blank name and same-scope duplicate
    const sameScopeCollisions = detectHomonymousPlaceCollisions(
      [
        makePlace({ id: 'plc_blank', name: '   ', full_name: '' }),
        makePlace({ id: 'plc_a', name: 'Oakville', full_name: 'Oakville, Ohio, USA' }),
        makePlace({ id: 'plc_b', name: 'Oakville', full_name: 'Oakville, Ohio, USA' }),
      ],
      { Oakville: { phonetic: 'OHK-vil' } }
    );
    expect(sameScopeCollisions).toEqual([]);
  });
});

describe('context ancestry, graph, and formatter behavioral coverage', () => {
  it('resolves ancestry JSON via fullName index, redacts living subjects/facts, collects disk record images, and skips invalid entries', async () => {
    const ancestryDir = await makeTempDir('kinloom-ancestry-ctx-');
    const recordImagesDir = path.join(ancestryDir, 'record_images');
    await mkdir(recordImagesDir, { recursive: true });

    // Disk record images for target (pid 4001) and deceased relative (pid 4002)
    const imgTarget = path.join(recordImagesDir, '4001_img_census.jpg');
    const imgParent = path.join(recordImagesDir, '4002_img_deed.jpg');
    await writeFile(imgTarget, makePngBuffer(10, 10));
    await writeFile(imgParent, makePngBuffer(10, 10));

    // Target ancestry JSON matched via fullName (no gedcom_xref on targetPerson)
    await writeFile(
      path.join(ancestryDir, '4001.json'),
      JSON.stringify({
        fullName: 'Martin Vance',
        personDbId: '4001',
        personCard: {
          FullName: 'Martin Vance',
          LifeRange: '1880&ndash;1950',
          BirthDate: '10 May 1880',
          BirthPlace: 'Oakville, Ohio',
          DeathDate: '12 Aug 1950',
          DeathPlace: 'Riverbend, Ohio',
        },
        factsUrl: 'https://archive.example.test/facts/4001',
        facts: [
          'skip-non-record',
          {
            TypeString: 'Marriage',
            Date: '1905',
            Place: 'Oakville',
            Value: 'First marriage',
            Description: 'Married Clara Vance',
            SourceCitationCount: 2,
            FactTargetPerson: {
              Id: 4003,
              FullName: 'Clara Vance',
              LifeRange: '1882&ndash;1960',
              IsLiving: false,
            },
          },
          {
            TypeString: 'Birth of child',
            FactTargetPerson: { Id: 4099, FullName: 'Private Child', IsLiving: true },
          },
        ],
        sources: [
          'skip-non-record',
          {
            Title: '1910 Census',
            Detail: 'Sheet 4A',
            CitationId: 11,
            DatabaseId: 22,
            RecordId: 33,
            RecordImageId: 'img_census',
          },
        ],
        recordImages: [
          'skip-non-record',
          { local: path.join(recordImagesDir, 'does_not_exist.jpg'), RecordImageId: 'missing' },
        ],
      }),
      'utf8'
    );

    // Deceased parent (4002) with valid source + non-record source + disk record image
    await writeFile(
      path.join(ancestryDir, '4002.json'),
      JSON.stringify({
        fullName: 'Arthur Vance',
        personDbId: '4002',
        sources: ['skip-non-record', { Title: 'County Deed Book', RecordImageId: 'img_deed' }],
      }),
      'utf8'
    );

    // Deceased spouse whose ancestry file is marked isLiving: true -> skipped
    await writeFile(
      path.join(ancestryDir, '4004.json'),
      JSON.stringify({
        fullName: 'Eleanor Vance',
        personDbId: '4004',
        isLiving: true,
      }),
      'utf8'
    );

    const privacyState: LivingPrivacyState = {
      livingIds: new Set<string>(),
      livingAncestryPids: new Set<string>(),
      livingNamePattern: null,
      privacy: { livingCutoffYears: 110, referenceYear: 2026 },
    };

    const peopleById = new Map<string, LooseYamlRecord>([
      [
        'p_parent',
        {
          id: 'p_parent',
          full_name: 'Arthur Vance',
          birth_edtf: '1850',
          death_edtf: '1920',
          gedcom_xref: '@I4002@',
        },
      ],
      [
        'p_spouse_live_json',
        {
          id: 'p_spouse_live_json',
          full_name: 'Eleanor Vance',
          birth_edtf: '1882',
          death_edtf: '1955',
          gedcom_xref: '@I4004@',
        },
      ],
      [
        'p_sibling_no_xref',
        { id: 'p_sibling_no_xref', full_name: 'No Match Sibling', birth_edtf: '1883', death_edtf: '1940' },
      ],
    ]);

    const res = await resolveAncestryContext({
      ancestryDir,
      targetPerson: { id: 'p_martin', full_name: 'Martin Vance' },
      relativeIds: {
        parentIds: new Set(['p_parent']),
        spouseIds: new Set(['p_spouse_live_json']),
        childIds: new Set(),
        siblingIds: new Set(['p_sibling_no_xref']),
      },
      includeFamily: true,
      peopleById,
      privacyState,
    });

    expect(res.ancestry).not.toBeNull();
    expect(res.ancestry?.redacted).toBeFalsy();
    if (res.ancestry && !res.ancestry.redacted) {
      expect(res.ancestry.matchMode).toBe('fullName');
      expect(res.ancestry.redactedLivingFactsCount).toBe(1);
      expect(res.ancestry.facts).toEqual([
        {
          type: 'Marriage',
          date: '1905',
          place: 'Oakville',
          value: 'First marriage',
          description: 'Married Clara Vance',
          sourceCount: 2,
          targetPerson: { name: 'Clara Vance', lifeRange: '1882-1960', pid: '4003' },
        },
      ]);
      expect(res.ancestry.sources).toEqual([
        {
          title: '1910 Census',
          detail: 'Sheet 4A',
          citationId: '11',
          databaseId: '22',
          recordId: '33',
          recordImageId: 'img_census',
        },
      ]);
      expect(res.ancestry.recordImages).toHaveLength(1);
      expect(res.ancestry.recordImages[0]?.sourceTitle).toBe('1910 Census');
    }

    expect(res.relativeRecordImages).toHaveLength(1);
    expect(res.relativeRecordImages[0]).toMatchObject({
      relativeId: 'p_parent',
      relation: 'parent',
      recordImageId: 'img_deed',
      sourceTitle: 'County Deed Book',
    });

    // Redacted target person (ancestry JSON has isLiving: true)
    const redactedRes = await resolveAncestryContext({
      ancestryDir,
      targetPerson: { id: 'p_eleanor', full_name: 'Eleanor Vance', gedcom_xref: '@I4004@' },
      relativeIds: { parentIds: new Set(), spouseIds: new Set(), childIds: new Set(), siblingIds: new Set() },
      includeFamily: false,
      peopleById,
      privacyState,
    });
    expect(redactedRes.ancestry).toEqual({
      matchMode: 'fullName',
      jsonPath: path.join(ancestryDir, '4004.json'),
      redacted: true,
      note: REDACTED_RELATIVE_LABEL,
    });

    // Target person with blank full_name and no alt_names returns null ancestry
    const blankNameRes = await resolveAncestryContext({
      ancestryDir,
      targetPerson: { id: 'p_blank', full_name: '   ', alt_names: [] },
      relativeIds: { parentIds: new Set(), spouseIds: new Set(), childIds: new Set(), siblingIds: new Set() },
      includeFamily: false,
      peopleById,
      privacyState,
    });
    expect(blankNameRes.ancestry).toBeNull();
  });

  it('handles context graph edge cases (no parents, undated people events, missing relative, extension sources, living media exclusion, relative archive media)', () => {
    // No parents -> collectSiblingIds early returns empty
    const noParents = resolveImmediateKinship([], 'p_solo', true);
    expect(noParents.relativeIds.siblingIds.size).toBe(0);

    // Undated person across 2 event blocks + non-string id person skipped
    const eventBlocks = [
      '- id: evt_1\n  edtf_date: "1910"\n  participants:\n    - person_id: p_undated\n      role: subject\n',
      '- id: evt_2\n  edtf_date: "1920"\n  participants:\n    - person_id: p_undated\n      role: subject\n',
    ];
    const scanRes = scanTargetAndUnknownYearEvents(eventBlocks, 'p_martin', [
      { id: 123 },
      { id: 'p_undated', full_name: 'Undated Person', is_living: false, birth_edtf: '', death_edtf: '' },
    ]);
    expect(scanRes.unknownYearEventsByPerson.get('p_undated')).toEqual([
      { edtf_date: '1910' },
      { edtf_date: '1920' },
    ]);

    const privacyState: LivingPrivacyState = {
      livingIds: new Set(['p_living']),
      livingAncestryPids: new Set(),
      livingNamePattern: null,
      privacy: { livingCutoffYears: 110, referenceYear: 2026 },
    };

    // Missing relative in peopleById returns placeholder entry
    const relSummary = buildRelativesSummary(
      {
        parentIds: new Set(['p_missing']),
        spouseIds: new Set(['p_living']),
        childIds: new Set(),
        siblingIds: new Set(),
      },
      new Map(),
      privacyState
    );
    expect(relSummary.parents).toEqual([
      { id: 'p_missing', full_name: '(missing in people.yaml)', lifespan: '? - ?', gedcom_xref: null },
    ]);
    expect(relSummary.spouses).toEqual([REDACTED_RELATIVE_LABEL]);

    // targetPerson.extensions.sources collects both string and { source_id } entries
    const evRefs = collectPersonEventsAndReferences(
      [],
      {
        id: 'p_martin',
        extensions: {
          sources: ['src_ext_str', { source_id: 'src_ext_obj' }],
        },
      },
      privacyState
    );
    expect([...evRefs.referencedSourceIds].sort()).toEqual(['src_ext_obj', 'src_ext_str']);

    // collectPersonMedia excludes media also linked to a living person
    const mediaBlocks = [
      '- id: med_living\n  person_ids:\n    - p_martin\n    - p_living\n  file: /media/living.jpg\n',
      '- id: med_ok\n  person_id: p_martin\n  source_id: src_m1\n  file: /media/ok.jpg\n',
    ];
    const refSources = new Set<string>();
    const ownMedia = collectPersonMedia({
      mediaBlocks,
      personId: 'p_martin',
      personEventIds: new Set(),
      referencedSourceIds: refSources,
      privacyState,
    });
    expect(ownMedia.map((m) => m['id'])).toEqual(['med_ok']);
    expect(refSources.has('src_m1')).toBe(true);

    // collectRelativeArchiveMedia: empty deceased relatives -> []
    expect(
      collectRelativeArchiveMedia({
        includeFamily: true,
        relativeIds: {
          parentIds: new Set(['p_living']),
          spouseIds: new Set(),
          childIds: new Set(),
          siblingIds: new Set(),
        },
        peopleById: new Map(),
        privacyState,
        mediaBlocks: [],
        eventBlocks: [],
        ownMediaIds: new Set(),
      })
    ).toEqual([]);

    // collectRelativeArchiveMedia: duplicate relative across groups, duplicate media id, unrelated link, missing file
    const relMediaBlocks = [
      '- id: med_rel_1\n  person_ids:\n    - p_unrelated\n    - p_parent\n  file: /media/parent.jpg\n  caption: Parent portrait\n',
      '- id: med_rel_1\n  person_id: p_parent\n  file: /media/parent-dup.jpg\n',
      '- id: med_no_rel_link\n  person_id: p_unrelated\n  caption: mentions p_parent in text only\n  file: /media/other.jpg\n',
      '- id: med_no_file\n  person_id: p_parent\n  caption: Missing file\n',
    ];
    const relArchiveMedia = collectRelativeArchiveMedia({
      includeFamily: true,
      relativeIds: {
        parentIds: new Set(['p_parent']),
        spouseIds: new Set(['p_parent']),
        childIds: new Set(),
        siblingIds: new Set(),
      },
      peopleById: new Map([
        ['p_parent', { id: 'p_parent', full_name: 'Arthur Vance', birth_edtf: '1850', death_edtf: '1920' }],
      ]),
      privacyState,
      mediaBlocks: relMediaBlocks,
      eventBlocks: [],
      ownMediaIds: new Set(),
    });
    expect(relArchiveMedia).toEqual([
      {
        id: 'med_rel_1',
        file: '/media/parent.jpg',
        caption: 'Parent portrait',
        relation: 'parent',
        relativeId: 'p_parent',
      },
    ]);
  });

  it('formats person context markdown and JSON with empty collections, narratives, and redacted ancestry', () => {
    const payload: PersonContextPayload = {
      repoDir: '/tmp/vance-archive',
      person: {
        id: 'p_martin',
        slug: 'martin-vance',
        full_name: 'Martin Vance',
        birth_edtf: '1880',
        death_edtf: '1950',
      },
      relatives: { parents: [], spouses: [], children: [] },
      kinship: [],
      pronunciation: null,
      events: [],
      places: [],
      sources: [],
      media: [],
      narratives: [
        {
          id: 'nar_1',
          kind: 'biography',
          title: 'Early Life in Oakville',
          slug: 'early-life',
          subject_person_id: 'p_martin',
          source_ids: ['src_1'],
          summary: 'Overview of Martin Vance.',
          body_md: 'Martin Vance lived in Oakville.[^src_1]',
        },
      ],
      ancestry: {
        matchMode: 'gedcom_xref',
        jsonPath: '/tmp/ancestry/4001.json',
        redacted: true,
        note: REDACTED_RELATIVE_LABEL,
      },
      relativeRecordImages: [],
      relativeArchiveMedia: [],
    };

    const md = formatPersonContextMarkdown(payload);
    expect(md).toContain('# Person Context: Martin Vance (`p_martin`)');
    expect(md).toContain('### Parents (0)\n- None');
    expect(md).toContain('## 3. Existing Events (0)\n- None');
    expect(md).toContain('## 4. Referenced Places (0)\n- None');
    expect(md).toContain('## 5. Referenced Sources (0)\n- None');
    expect(md).toContain('### `nar_1` (biography): Early Life in Oakville');
    expect(md).toContain('- summary: Overview of Martin Vance.');
    expect(md).toContain('Martin Vance lived in Oakville.[^src_1]');
    expect(md).toContain(`- Match: \`/tmp/ancestry/4001.json\` (${REDACTED_RELATIVE_LABEL})`);

    const renderedJson = renderPersonContext(payload, true);
    expect(JSON.parse(renderedJson)).toMatchObject({ repoDir: '/tmp/vance-archive' });
    expect(renderPersonContext(payload, false)).toBe(md);
  });

  it('rejects missing ancestry directory gracefully in runContextCommand', async () => {
    const repoDir = await makeTempDir('kinloom-ctx-cmd-');
    await mkdir(path.join(repoDir, 'data'), { recursive: true });
    await writeFile(
      path.join(repoDir, 'data', 'people.yaml'),
      serializePeopleYaml([makePerson({ id: 'p_martin', full_name: 'Martin Vance' })]),
      'utf8'
    );
    const res = await runContextCommand({
      repoDir,
      personId: 'p_martin',
      ancestryDir: path.join(repoDir, 'nonexistent-ancestry'),
      json: false,
    });
    expect(res.context.ancestry).toBeNull();
    expect(res.rendered).toContain('- No matching external facts JSON found.');
  });
});

describe('treeHygiene dates and checks behavioral coverage', () => {
  it('parses EDTF decades, intervals, fallback years, and evaluates strict/1-year date comparisons', () => {
    expect(parseEdtfRange('   ')).toBeNull();
    expect(parseEdtfRange('188X')).toEqual({
      minYear: 1880,
      maxYear: 1889,
      minDate: { year: 1880, month: null, day: null },
      maxDate: { year: 1889, month: null, day: null },
    });
    expect(parseEdtfRange('1880-03/1885-06')).toEqual({
      minYear: 1880,
      maxYear: 1885,
      minDate: { year: 1880, month: 3, day: null },
      maxDate: { year: 1885, month: 6, day: null },
    });
    expect(parseEdtfRange('/1885')).toEqual({
      minYear: null,
      maxYear: 1885,
      minDate: null,
      maxDate: { year: 1885, month: null, day: null },
    });
    expect(parseEdtfRange('bad/interval')).toBeNull();
    expect(parseEdtfRange('c. 1875')).toEqual({
      minYear: 1875,
      maxYear: 1875,
      minDate: { year: 1875, month: null, day: null },
      maxDate: { year: 1875, month: null, day: null },
    });
    expect(parseEdtfRange('undated')).toBeNull();

    const openRange = parseEdtfRange('/1885');
    const exact1890May = parseEdtfRange('1890-05-10');
    const exact1890Mar = parseEdtfRange('1890-03-10');
    const exact1890May20 = parseEdtfRange('1890-05-20');
    const year1890Only = parseEdtfRange('1890');
    const month1890May = parseEdtfRange('1890-05');
    const exact1891May20 = parseEdtfRange('1891-05-20');
    const exact1891May05 = parseEdtfRange('1891-05-05');
    const exact1891Jul01 = parseEdtfRange('1891-07-01');
    const year1891Only = parseEdtfRange('1891');
    const month1891May = parseEdtfRange('1891-05');

    expect(openRange && exact1890May && maxPossibleAgeYears(openRange, exact1890May)).toBeNull();
    expect(openRange && exact1890May && isStrictlyAfterDate(openRange, exact1890May)).toBe(false);
    expect(exact1890May && year1890Only && isStrictlyAfterDate(exact1890May, year1890Only)).toBe(false);
    expect(exact1890May && exact1890Mar && isStrictlyAfterDate(exact1890May, exact1890Mar)).toBe(true);
    expect(exact1890Mar && exact1890May && isStrictlyAfterDate(exact1890Mar, exact1890May)).toBe(false);
    expect(exact1890May20 && exact1890May && isStrictlyAfterDate(exact1890May20, exact1890May)).toBe(true);
    expect(month1890May && exact1890May && isStrictlyAfterDate(month1890May, exact1890May)).toBe(false);

    expect(openRange && exact1890May && isMoreThanOneYearAfter(openRange, exact1890May)).toBe(false);
    expect(year1891Only && exact1890May && isMoreThanOneYearAfter(year1891Only, exact1890May)).toBe(false);
    expect(exact1891Jul01 && exact1890May && isMoreThanOneYearAfter(exact1891Jul01, exact1890May)).toBe(true);
    expect(exact1891May20 && exact1890May && isMoreThanOneYearAfter(exact1891May20, exact1890May)).toBe(true);
    expect(exact1891May05 && exact1890May && isMoreThanOneYearAfter(exact1891May05, exact1890May)).toBe(
      false
    );
    expect(month1891May && exact1890May && isMoreThanOneYearAfter(month1891May, exact1890May)).toBe(false);
  });

  it('handles adoption events, multi-participant placeholder events, multiple parent family_xrefs, undated children, and undated marriage spouses', () => {
    const people: RawPerson[] = [
      makePerson({
        id: 'p_bio_dad',
        full_name: 'Arthur Vance',
        sex: 'M',
        birth_edtf: '1850',
        death_edtf: '1920',
      }),
      makePerson({
        id: 'p_bio_mom',
        full_name: 'Clara Vance',
        sex: 'F',
        birth_edtf: '1855',
        death_edtf: '1930',
      }),
      makePerson({
        id: 'p_adopt_dad',
        full_name: 'Henry Doe',
        sex: 'M',
        birth_edtf: '1875',
        death_edtf: '1940',
      }),
      makePerson({ id: 'p_child', full_name: 'Jane Doe', sex: 'F', birth_edtf: '1880', death_edtf: '1950' }),
      makePerson({ id: 'p_undated_child', full_name: 'Sam Doe', sex: 'M', birth_edtf: '', death_edtf: '' }),
      makePerson({ id: 'p_undated_spouse', full_name: 'Pat Doe', sex: 'F', birth_edtf: '', death_edtf: '' }),
    ];

    const kinship: KinshipEdge[] = [
      { from: 'p_bio_dad', to: 'p_child', relation: 'parent', family_xref: 'F20' },
      { from: 'p_child', to: 'p_bio_dad', relation: 'child', family_xref: 'F10' },
      { from: 'p_bio_mom', to: 'p_child', relation: 'parent', family_xref: 'F10' },
      { from: 'p_adopt_dad', to: 'p_child', relation: 'parent', family_xref: 'F30' },
      { from: 'p_bio_dad', to: 'p_undated_child', relation: 'parent' },
    ];

    const events: RawEvent[] = [
      // Adoption event links p_adopt_dad and p_child -> prevents excess_parents & age-5 chronology warning
      makeEvent({
        id: 'evt_adopt',
        title: 'Adoption of Jane Doe',
        category: 'adoption',
        edtf_date: '1885',
        participants: [
          { person_id: 'p_adopt_dad', role: 'adoptive_parent' },
          { person_id: 'p_child', role: 'adopted_child' },
        ],
      }),
      // Placeholder event with 2 participants (sorts personIds)
      makeEvent({
        id: 'evt_placeholder',
        title: 'Recorded event for Jane Doe',
        edtf_date: '1895',
        participants: [
          { person_id: 'p_child', role: 'subject' },
          { person_id: 'p_bio_dad', role: 'witness' },
        ],
      }),
      // Marriage event with empty date -> skipped
      makeEvent({
        id: 'evt_marr_nodate',
        title: 'Marriage of Jane Doe',
        edtf_date: '',
        participants: [
          { person_id: 'p_child', role: 'bride' },
          { person_id: 'p_undated_spouse', role: 'groom' },
        ],
      }),
      // Marriage event with dated marriage but one spouse missing birth date -> skips undated spouse
      makeEvent({
        id: 'evt_marr_undated_spouse',
        title: 'Marriage of Jane Doe and Pat Doe',
        edtf_date: '1902',
        participants: [
          { person_id: 'p_child', role: 'bride' },
          { person_id: 'p_undated_spouse', role: 'groom' },
        ],
      }),
    ];

    const summary = analyzeTreeHygiene({ people, events, kinship });
    expect(summary.counts.excess_parents).toBe(0);
    expect(summary.counts.parent_child_chronology).toBe(0);
    expect(summary.counts.child_marriage).toBe(0);
    expect(summary.counts.duplicate_vital_event).toBe(1);
    expect(summary.counts.placeholder_event).toBe(1);
    const placeholderWarning = summary.warnings.find((w) => w.category === 'placeholder_event');
    expect(placeholderWarning?.personIds).toEqual(['p_bio_dad', 'p_child']);
  });
});

describe('audit hygiene, chronology, citations, scans, overlaps report, and audit command', () => {
  it('checks audit hygiene regressions with malformed/partial inputs and field updates', () => {
    const warnings = runAuditHygieneRegressionCheck({
      personId: 'p_child',
      livePeople: [
        { full_name: 'Missing ID' },
        { id: 'p_dad', full_name: 'Arthur Vance', sex: 'M', birth_edtf: '1860', death_edtf: '1920' },
        { id: 'p_child', full_name: 'Martin Vance', sex: 'M', birth_edtf: '1885', death_edtf: '1950' },
      ],
      liveEvents: [
        { title: 'Missing ID Event' },
        { id: 'evt_bad_parts', title: 'Bad parts', edtf_date: '1900', participants: 'not-an-array' },
        {
          id: 'evt_birth_1',
          title: 'Birth of Martin Vance',
          edtf_date: '1885',
          participants: [
            'bad',
            { person_id: '  ' },
            { person_id: 'p_dad', role: 'father' },
            { person_id: 'p_child', role: 'birth_subject' },
          ],
        },
      ],
      liveKinship: [{ from: 'p_dad', to: 'p_child', relation: 'invalid_rel' }],
      patch: {
        people: [
          'bad',
          {
            id: 'p_dad',
            full_name: 'Arthur J. Vance',
            sex: 'M',
            lineage_group: 'paternal_updated',
            birth_edtf: '1880',
          },
        ],
        events: [
          'bad',
          {
            id: 'evt_birth_1',
            title: 'Birth of Martin Vance',
            edtf_date: '1885',
            participants: [{ person_id: 'p_child', role: 'birth_subject' }],
          },
          {
            id: 'evt_birth_2',
            title: 'Second Birth of Martin Vance',
            edtf_date: '1885',
            participants: [{ person_id: 'p_child', role: 'birth_subject' }],
          },
        ],
        remove_kinship: ['bad', { from: 'p_dad', to: 'p_child', relation: 'cousin' }],
        kinship: [
          'bad',
          { from: 'p_dad', to: 'p_child', relation: 'cousin' },
          { from: 'p_dad', to: 'p_child', relation: 'parent' },
        ],
      },
    });

    const categories = warnings.map((w) => w.category);
    expect(categories).toContain('duplicate_vital_event');
    expect(categories).toContain('parent_child_chronology');
  });

  it('checks chronology errors and warnings for inverted/implausible lifespans, staged relatives, and labeled census/context events', () => {
    expect(computeLifespan(null, parseAuditEdtf('1950'))).toEqual({
      exact: false,
      years: null,
      days: null,
      totalDays: null,
      label: null,
    });

    const res = runChronologyCheck(
      { id: 'p_martin', birth_edtf: '1920', death_edtf: '1900' },
      {
        person_id: 'p_martin',
        people: [
          'skip-non-record',
          { id: 'p_elder', birth_edtf: '1750', death_edtf: '1900' },
          { id: 'p_inverted', birth_edtf: '1930', death_edtf: '1910' },
        ],
        events: [
          {
            id: 'evt_census_unlabeled',
            title: '1910 Federal Census',
            edtf_date: '1910',
            participants: [{ person_id: 'p_martin', role: 'subject' }],
          },
          {
            id: 'evt_census_prebirth',
            title: 'Father in 1910 Census',
            edtf_date: '1910',
            participants: [{ person_id: 'p_martin', role: 'subject' }],
          },
          {
            id: 'evt_family_prebirth',
            title: 'Parents settled before birth',
            edtf_date: '1912',
            participants: [{ person_id: 'p_martin', role: 'subject' }],
          },
          {
            id: 'evt_census_postmortem',
            title: '1910 Census widow listing',
            edtf_date: '1910',
            participants: [{ person_id: 'p_martin', role: 'subject' }],
          },
        ],
      },
      []
    );

    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        'Birth (1920) is after death (1900).',
        'Implausible lifespan: ~-20 years (1920 to 1900).',
        '[p_elder] Implausible lifespan: ~150 years (1750 to 1900).',
        '[p_inverted] Birth (1930) is after death (1910).',
        'Event evt_census_unlabeled (1910): census predates birth (1920) without context label.',
      ])
    );
    expect(res.warnings).toEqual(
      expect.arrayContaining([
        'Event evt_census_prebirth (1910): labeled pre-birth census context before birth (1920).',
        'Event evt_family_prebirth (1912): pre-birth family context before birth (1920).',
        'Event evt_census_postmortem (1910): labeled post-mortem census entry after death (1900).',
      ])
    );

    // Open-start birth bound exercises auditLowerMs non-finite branch
    const openBirthRes = runChronologyCheck(
      { id: 'p_open', birth_edtf: '/1900', death_edtf: '1950' },
      {
        person_id: 'p_open',
        events: [
          {
            id: 'evt_1',
            title: 'Event',
            edtf_date: '1890',
            participants: [{ person_id: 'p_open', role: 'subject' }],
          },
        ],
      },
      []
    );
    expect(openBirthRes.ok).toBe(true);
  });

  it('checks sentence splitting with backticks/empty strings and uncited bullets/headings', () => {
    expect(splitParagraphIntoSentences('   ')).toEqual([]);
    expect(
      splitParagraphIntoSentences('He saved `file.v1!?.txt` in Oakville. She moved to Riverbend.')
    ).toEqual(['He saved `file.v1!?.txt` in Oakville.', 'She moved to Riverbend.']);

    const citRes = runUncitedSentenceCheck({
      narratives: [
        'skip-non-record',
        { id: 'nar_empty', body_md: '' },
        {
          id: 'nar_prose',
          body_md: [
            '**Early Childhood:**',
            '- Short bullet.',
            '- Heading bullet:',
            '- Martin Vance purchased forty acres near Oakville along the river road.',
            'Martin Vance married Clara Vance in Oakville in 1905.[^src_marr]',
          ].join('\n'),
        },
      ],
    });
    expect(citRes.ok).toBe(false);
    expect(citRes.totalSentences).toBe(2);
    expect(citRes.citedSentences).toBe(1);
    expect(citRes.uncitedCount).toBe(1);
    expect(citRes.uncitedSentences[0]?.narrative_id).toBe('nar_prose');
  });

  it('audits scan inventory across repo_media, duplicates, empty files, huge sparse files, missing files, subdirs, and unreferenced files', async () => {
    const repoDir = await makeTempDir('kinloom-scans-repo-');
    const pkgDir = path.join(repoDir, 'research', 'people', 'p_martin');
    const scansDir = path.join(pkgDir, 'scans');
    const archiveMediaDir = path.join(repoDir, 'archive-media', 'media');
    await mkdir(scansDir, { recursive: true });
    await mkdir(archiveMediaDir, { recursive: true });
    await mkdir(path.join(scansDir, 'forbidden_subdir'), { recursive: true });

    // Empty 0-byte scan
    await writeFile(path.join(scansDir, 'empty.png'), Buffer.alloc(0));
    // Huge >10MB sparse valid PNG scan
    const hugePath = path.join(scansDir, 'huge.png');
    await writeFile(hugePath, makePngBuffer(640, 480));
    fs.truncateSync(hugePath, 10 * 1024 * 1024 + 4096);
    // Repo media file
    await writeFile(path.join(archiveMediaDir, 'existing_repo.png'), makePngBuffer(200, 200, 12_000));
    // Unreferenced scan file
    await writeFile(path.join(scansDir, 'stray.png'), makePngBuffer(100, 100, 12_000));

    const scanRes = runScanInventoryCheck(repoDir, pkgDir, {
      media: [
        { id: 'med_no_file' },
        { id: 'med_empty', file: '/media/empty.png' },
        { id: 'med_huge_1', file: '/media/huge.png' },
        { id: 'med_huge_dup', file: '/media/huge.png' },
        { id: 'med_repo', file: '/media/existing_repo.png' },
        { id: 'med_missing', file: '/media/missing.png' },
      ],
    });

    expect(scanRes.ok).toBe(false);
    expect(scanRes.unreferencedScans).toEqual(['stray.png']);
    expect(scanRes.files.find((f) => f.media_id === 'med_repo')?.source).toBe('repo_media');
    expect(scanRes.errors).toEqual(
      expect.arrayContaining([
        "Media entry 'med_no_file' missing 'file' field.",
        expect.stringContaining('Empty (0 byte) scan file:'),
        "Missing scan for media 'med_missing': '/media/missing.png' not found in scans/ or repo media.",
        'Forbidden subdirectory inside scans/: forbidden_subdir',
      ])
    );
    expect(scanRes.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Huge scan (> 10 MB'),
        'Unreferenced file in scans/: stray.png',
      ])
    );
  });

  it('formats audit-overlaps batch text reports for empty pending sets and every overlap section', () => {
    const emptyBatch: Omit<AuditBatchResult, 'rendered'> = {
      ok: true,
      strictOk: true,
      repo: '/tmp/repo',
      people: [],
      skippedAlreadyIntegrated: ['p_done'],
      skippedDrifted: ['p_drifted'],
      duration_ms: 12,
      summary: {
        people: 0,
        passed: 0,
        failed: 0,
        strictPassed: 0,
        scanFileCollisions: 0,
        differingScanCollisions: 0,
        mediaFileCollisions: 0,
        conflictingMediaFileCollisions: 0,
        sharedMediaIds: 0,
        sharedSourceIds: 0,
        sharedEventOverlaps: 0,
        sharedEventFieldDiffs: 0,
        sharedPersonOverlaps: 0,
        conflictingPersonOverlaps: 0,
        personSlugCollisions: 0,
        conflictingPersonSlugCollisions: 0,
        liveMediaFileCollisions: 0,
        kinshipAddRemoveConflicts: 0,
      },
      overlaps: {
        scanFileCollisions: [],
        mediaFileCollisions: [],
        sharedMediaIds: [],
        sharedSourceIds: [],
        sharedEventOverlaps: [],
        sharedPersonOverlaps: [],
        personSlugCollisions: [],
        liveMediaFileCollisions: [],
        kinshipAddRemoveConflicts: [],
      },
    };
    const emptyText = formatAuditBatchTextReport(emptyBatch);
    expect(emptyText).toContain('(1 already integrated skipped, 1 drifted legacy skipped)');
    expect(emptyText).toContain('Skipped already integrated (1): p_done');
    expect(emptyText).toContain('Skipped drifted legacy (1): p_drifted');
    expect(emptyText).toContain('No pending staged packages remain to audit.');

    const fullBatch: Omit<AuditBatchResult, 'rendered'> = {
      ...emptyBatch,
      ok: false,
      strictOk: false,
      skippedAlreadyIntegrated: [],
      skippedDrifted: [],
      summary: { ...emptyBatch.summary, people: 1, failed: 1 },
      people: [
        {
          ok: false,
          strictOk: false,
          repo: '/tmp/repo',
          person_id: 'p_martin',
          package_dir: '/tmp/repo/research/people/p_martin',
          duration_ms: 5,
          zeroCoordinatePlaces: [],
          hygieneWarnings: [],
          checks: {
            chronology: {
              ok: true,
              birth_edtf: null,
              death_edtf: null,
              lifespan: { exact: false, years: null, days: null, totalDays: null, label: null },
              checkedEvents: 0,
              errors: [],
              warnings: [],
            },
            privacy: {
              ok: true,
              livingPeopleChecked: 0,
              livingNameHits: [],
              ssnHits: [],
              phoneHits: [],
              emDashCount: 0,
              emDashHits: [],
              errors: [],
              warnings: [],
            },
            citations: {
              ok: true,
              totalSentences: 0,
              citedSentences: 0,
              uncitedCount: 0,
              uncitedSentences: [],
            },
            scans: { ok: true, checkedCount: 0, unreferencedScans: [], files: [], errors: [], warnings: [] },
            dryRun: {
              ok: true,
              durationMs: 1,
              inlineCitationCount: 0,
              reviewFlags: 0,
              livingLeaks: 0,
              counts: null,
              error: null,
            },
            pronunciation: {
              pluginId: 'builtin',
              id: 'pronunciation',
              name: 'Pronunciation',
              ok: true,
              strictOk: true,
              errors: [],
              warnings: [],
              strictFailures: [],
              durationMs: 1,
            },
          },
          pluginChecks: [],
          errors: ['chronology: synthetic error'],
          warnings: [],
        },
      ],
      overlaps: {
        scanFileCollisions: [],
        mediaFileCollisions: [],
        sharedMediaIds: [],
        sharedSourceIds: [],
        sharedEventOverlaps: [],
        sharedPersonOverlaps: [
          {
            id: 'p_shared_same',
            fieldDiffs: [],
            packages: [
              {
                person_id: 'p_a',
                slug: 'clara-vance',
                full_name: 'Clara Vance',
                given_name: 'Clara',
                surname: 'Vance',
                sex: 'F',
                birth_edtf: null,
                death_edtf: null,
                lineage_group: null,
                branch: null,
              },
            ],
          },
          {
            id: 'p_shared_diff',
            fieldDiffs: ['birth_edtf'],
            packages: [
              {
                person_id: 'p_a',
                slug: 'arthur-vance',
                full_name: 'Arthur Vance',
                given_name: 'Arthur',
                surname: 'Vance',
                sex: 'M',
                birth_edtf: '1850',
                death_edtf: '1920',
                lineage_group: null,
                branch: null,
              },
            ],
          },
        ],
        personSlugCollisions: [
          {
            slug: 'martin-vance',
            personIdsConflict: true,
            entries: [{ package_person_id: 'p_a', person_id: 'p_1', slug: 'martin-vance' }],
          },
        ],
        liveMediaFileCollisions: [
          {
            file: '/media/census.jpg',
            live_media_id: 'med_live_1',
            staged: [{ person_id: 'p_a', media_id: 'med_new_1', file: '/media/census.jpg' }],
          },
        ],
        kinshipAddRemoveConflicts: [
          {
            from: 'p_dad',
            to: 'p_child',
            relation: 'parent',
            addedBy: ['p_a'],
            removedBy: ['p_b'],
          },
        ],
      },
    };
    const fullText = formatAuditBatchTextReport(fullBatch);
    expect(fullText).toContain('ERROR: chronology: synthetic error');
    expect(fullText).toContain('  Scan files: none');
    expect(fullText).toContain('  Media files: none');
    expect(fullText).toContain('  Shared source ids: none');
    expect(fullText).toContain('  Shared events: none');
    expect(fullText).toContain('  Person p_shared_same: same fields');
    expect(fullText).toContain('  Person p_shared_diff: differs in birth_edtf');
    expect(fullText).toContain('  Person slug martin-vance: conflicting person ids');
    expect(fullText).toContain('  Live media file /media/census.jpg: live id med_live_1');
    expect(fullText).toContain('  Kinship p_dad -> p_child (parent): added by p_a; removed by p_b');
  });

  it('validates audit command errors and integrates zero-coord places, chronology warnings, pronunciation errors, and plugin checks', async () => {
    const repoDir = await makeTempDir('kinloom-audit-cmd-');

    await expect(runAuditCommand({ repoDir, personId: '   ' })).rejects.toThrow(CliValidationError);
    await expect(runAuditCommand({ repoDir, personId: 'bad/id' })).rejects.toThrow(CliValidationError);
    await expect(runAuditCommand({ repoDir, personId: 'p_martin' })).rejects.toThrow(CliValidationError);

    const pkgDir = path.join(repoDir, 'research', 'people', 'p_martin');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(path.join(pkgDir, 'patch.json'), JSON.stringify([]), 'utf8');
    // Missing data/people.yaml
    await expect(runAuditCommand({ repoDir, personId: 'p_martin' })).rejects.toThrow(CliValidationError);

    await mkdir(path.join(repoDir, 'data'), { recursive: true });
    await writeFile(
      path.join(repoDir, 'data', 'people.yaml'),
      serializePeopleYaml([
        makePerson({ id: 'p_martin', full_name: 'Martin Vance', birth_edtf: '1880', death_edtf: '1950' }),
        makePerson({ id: 'p_clara', full_name: 'Clara Vance', birth_edtf: '1885', death_edtf: '1960' }),
      ]),
      'utf8'
    );
    // patch.json is JSON array -> throws CliValidationError
    await expect(runAuditCommand({ repoDir, personId: 'p_martin' })).rejects.toThrow(CliValidationError);

    await writeFile(
      path.join(repoDir, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml(
        makeSiteConfig({
          Martin: { phonetic: 'MAR-tin', ipa: '/ˈmɑrtɪn/', source_label: 'Wiktionary' },
          Vance: { phonetic: 'VAHNS', ipa: '/ˈvɑns/', source_label: 'Wiktionary' },
        })
      ),
      'utf8'
    );
    await writeFile(path.join(repoDir, 'data', 'events.yaml'), serializeEventsYaml([]), 'utf8');
    await writeFile(path.join(repoDir, 'data', 'places.yaml'), serializePlacesYaml([]), 'utf8');
    await writeFile(path.join(repoDir, 'data', 'sources.yaml'), serializeSourcesYaml([]), 'utf8');
    await writeFile(path.join(repoDir, 'data', 'kinship.yaml'), serializeKinshipYaml([]), 'utf8');
    await writeFile(path.join(repoDir, 'data', 'media.yaml'), serializeMediaYaml([]), 'utf8');
    await writeFile(path.join(repoDir, 'data', 'narratives.yaml'), serializeNarrativesYaml([]), 'utf8');

    await writeFile(
      path.join(pkgDir, 'patch.json'),
      JSON.stringify({
        person_id: 'p_martin',
        people: [
          'skip-non-record',
          { id: 'p_clara', full_name: 'Clara J. Vance', birth_edtf: '1885', death_edtf: '1960' },
          {
            id: 'p_live_staged',
            full_name: 'Living',
            is_living: true,
            pronunciation: { phonetic: 'LEAK' },
          },
        ],
        places: [{ id: 'plc_zero', name: 'Null Island', full_name: 'Null Island', lat: 0, lng: 0 }],
        events: [
          {
            id: 'evt_prebirth_ctx',
            title: 'Father settled before birth',
            edtf_date: '1870',
            participants: [{ person_id: 'p_martin', role: 'subject' }],
          },
        ],
      }),
      'utf8'
    );

    const customPlugin: KinloomCliPlugin = {
      id: 'synthetic-plugin',
      name: 'Synthetic Plugin',
      auditChecks: [
        {
          id: 'custom_rule',
          name: 'Custom Rule',
          run: () => ({
            errors: ['synthetic plugin error'],
            warnings: ['synthetic plugin warning'],
            strictFailures: ['synthetic plugin warning'],
          }),
        },
      ],
    };

    const auditRes = await runAuditCommand({
      repoDir,
      personId: 'p_martin',
      plugins: [customPlugin],
      json: false,
    });
    expect(auditRes.ok).toBe(false);
    expect(auditRes.strictOk).toBe(false);
    expect(auditRes.zeroCoordinatePlaces).toEqual(['plc_zero']);
    expect(auditRes.errors).toEqual(
      expect.arrayContaining([
        "places: zero or missing coordinates on 'plc_zero'",
        'pronunciation: Living person record in staged patch contains a pronunciation entry (redacted for privacy).',
        'plugin(custom_rule): synthetic plugin error',
      ])
    );
    expect(auditRes.warnings).toEqual(
      expect.arrayContaining([
        'chronology: Event evt_prebirth_ctx (1870): pre-birth family context before birth (1880).',
        'plugin(custom_rule): synthetic plugin warning',
      ])
    );

    // Clean patch with strict-failing plugin verifies strictOk evaluates pluginChecks.every(...)
    await writeFile(
      path.join(pkgDir, 'patch.json'),
      JSON.stringify({
        person_id: 'p_martin',
        events: [],
      }),
      'utf8'
    );
    const strictFailPlugin: KinloomCliPlugin = {
      id: 'strict-only-plugin',
      name: 'Strict Only Plugin',
      auditChecks: [
        {
          id: 'strict_rule',
          name: 'Strict Rule',
          run: () => ({
            errors: [],
            warnings: ['strict-only warning'],
            strictFailures: ['strict-only warning'],
          }),
        },
      ],
    };
    const strictAuditRes = await runAuditCommand({
      repoDir,
      personId: 'p_martin',
      plugins: [strictFailPlugin],
      json: true,
    });
    expect(strictAuditRes.ok).toBe(true);
    expect(strictAuditRes.strictOk).toBe(false);
  });
});

describe('stagedOverlaps loader, verify checks, and verify mediaCheck behavioral coverage', () => {
  it('loads staged packages with validation errors, kinship/remove_kinship entries, and multiple scan entries', async () => {
    const dir = await makeTempDir('kinloom-staged-loader-');

    // Missing patch.json
    expect(() => loadStagedPackage('p_a', dir)).toThrow(CliValidationError);

    // Invalid JSON
    await writeFile(path.join(dir, 'patch.json'), '{bad json', 'utf8');
    expect(() => loadStagedPackage('p_a', dir)).toThrow(CliValidationError);

    // Non-object JSON
    await writeFile(path.join(dir, 'patch.json'), JSON.stringify(['array']), 'utf8');
    expect(() => loadStagedPackage('p_a', dir)).toThrow(CliValidationError);

    // Rich valid patch with mixed valid/invalid rows
    await writeFile(
      path.join(dir, 'patch.json'),
      JSON.stringify({
        sources: ['bad', { id: '  ' }, { id: 'src_1' }],
        events: ['bad', { id: '   ' }, { id: 'evt_1', edtf_date: '1910', title: 'Census' }],
        people: ['bad', { id: '   ' }, { id: 'p_new', full_name: 'Clara Vance', slug: 'clara-vance' }],
        kinship: [
          'bad',
          { from: 'p_a', to: 'p_b', relation: 'cousin' },
          { from: 'p_a', to: 'p_b', relation: 'parent', family_xref: 'F1' },
          { from: 'p_b', to: 'p_a', relation: 'child' },
        ],
        remove_kinship: [
          'bad',
          { from: 'p_a', to: 'p_c', relation: 'cousin' },
          { from: 'p_a', to: 'p_c', relation: 'spouse', family_xref: 'F2', symmetric: false },
        ],
      }),
      'utf8'
    );

    const scansDir = path.join(dir, 'scans');
    await mkdir(scansDir, { recursive: true });
    await writeFile(path.join(scansDir, 'b_scan.png'), makePngBuffer(50, 40));
    await writeFile(path.join(scansDir, 'a_empty.png'), Buffer.alloc(0));

    const pkg = loadStagedPackage('p_a', dir);
    expect(pkg.sources).toEqual([{ id: 'src_1' }]);
    expect(pkg.eventRows).toHaveLength(1);
    expect(pkg.stagedPeople).toHaveLength(1);
    expect(pkg.kinshipAdds).toEqual([
      { from: 'p_a', to: 'p_b', relation: 'parent', family_xref: 'F1' },
      { from: 'p_b', to: 'p_a', relation: 'child', family_xref: null },
    ]);
    expect(pkg.kinshipRemoves).toEqual([{ from: 'p_a', to: 'p_c', relation: 'spouse', family_xref: 'F2' }]);

    const scanEntries = loadStagedScanEntries([pkg]);
    expect(scanEntries.map((e) => e.basename)).toEqual(['a_empty.png', 'b_scan.png']);
    expect(scanEntries[0]).toMatchObject({ bytes: 0, width: null, height: null });
    expect(scanEntries[1]).toMatchObject({ width: 50, height: 40 });
  });

  it('validates place coordinates, detects duplicate residence spans, and scans multiple public narratives for living names', () => {
    const coordRes = validatePlaceCoordinates([
      makePlace({ id: 'plc_nan', lat: Number.NaN, lng: -82 }),
      makePlace({ id: 'plc_oor', lat: 95, lng: 185 }),
      makePlace({ id: 'plc_zero', lat: 0, lng: 0 }),
      makePlace({ id: 'plc_ok', lat: 41.2, lng: -82.3 }),
    ]);
    expect(coordRes.ok).toBe(false);
    expect(coordRes.invalidPlaces).toEqual([
      { id: 'plc_nan', reason: 'non-finite coordinates (NaN, -82)' },
      { id: 'plc_oor', reason: 'coordinates out of range (95, 185)' },
      { id: 'plc_zero', reason: 'forbidden (0, 0) coordinates' },
    ]);

    const people: RawPerson[] = [
      makePerson({ id: 'p_martin', full_name: 'Martin Vance', birth_edtf: '1880', death_edtf: '1950' }),
      makePerson({
        id: 'p_living',
        full_name: 'Evelyn Riverstone',
        given_name: 'Evelyn',
        surname: 'Riverstone',
        birth_edtf: '1992',
        death_edtf: '',
        is_living: true,
      }),
    ];
    const places: Place[] = [
      makePlace({ id: 'plc_oak', name: 'Oakville', full_name: 'Oakville, Ohio, USA' }),
    ];
    const sources: SourceRecord[] = [
      { id: 'src_1', citation: '1910 Census Oakville', source_type: 'census' },
    ];
    const compiled = compileArchive({
      mode: 'private',
      people,
      events: [],
      places,
      sources,
      kinship: [],
      media: [],
      narratives: [],
      siteConfig: makeSiteConfig(),
    });

    const spanA = {
      id: 'span_1',
      person_id: 'p_martin',
      place_id: 'plc_oak',
      time_min: 1900,
      time_max: 1920,
      start_year: 1900,
      end_year: 1920,
      confidence_tier: 'Confirmed' as const,
      from_event_id: 'evt_1',
      to_event_id: 'evt_2',
    };
    const spanDupTuple = { ...spanA, id: 'span_2' };
    const dupBundle = {
      ...compiled.bundle,
      residence_spans: [spanA, spanA, spanDupTuple],
    };
    expect(findDuplicateResidenceSpans(dupBundle, 'private')).toEqual([
      'private:id:span_1',
      'private:span:span_1(p_martin@plc_oak)',
      'private:span:span_2(p_martin@plc_oak)',
    ]);

    const narratives: Narrative[] = [
      {
        id: 'nar_b',
        slug: 'nar-b',
        kind: 'biography',
        title: 'Notes on Martin Vance',
        summary: 'Clean historical summary.',
        body_md: 'Martin Vance lived in Oakville.[^src_1]',
        subject_person_id: 'p_martin',
        person_ids: ['p_martin'],
        event_ids: [],
        place_ids: ['plc_oak'],
        source_ids: ['src_1'],
      },
      {
        id: 'nar_a',
        slug: 'nar-a',
        kind: 'biography',
        title: 'Mentioning Evelyn Riverstone',
        summary: 'Leaks Evelyn Riverstone.',
        body_md: 'Mentions Evelyn Riverstone in modern text.[^src_1]',
        subject_person_id: 'p_martin',
        person_ids: ['p_martin'],
        event_ids: [],
        place_ids: ['plc_oak'],
        source_ids: ['src_1'],
      },
    ];
    const livingScan = scanPublicLivingNames({
      people,
      events: [],
      sources,
      media: [],
      narratives,
      privacy: { livingCutoffYears: 110, referenceYear: 2026 },
    });
    expect(livingScan.ok).toBe(false);
    expect(livingScan.hits.some((h) => h.location === 'narrative:nar_a:title')).toBe(true);
  });

  it('verifies media files on disk including external URLs, traversal segments, directories, empty files, and valid files', async () => {
    const repoDir = await makeTempDir('kinloom-verify-media-');
    const mediaDir = path.join(repoDir, 'media');
    await mkdir(path.join(mediaDir, 'as_dir'), { recursive: true });
    await writeFile(path.join(mediaDir, 'empty.jpg'), Buffer.alloc(0));
    await writeFile(path.join(mediaDir, 'valid.jpg'), makePngBuffer(20, 20));

    const items: MediaItem[] = [
      {
        id: 'm_ext',
        kind: 'family_photo',
        file: 'https://archive.example.test/photo.jpg',
        caption: 'External',
      },
      { id: 'm_bad_prefix', kind: 'family_photo', file: '/assets/photo.jpg', caption: 'Bad prefix' },
      { id: 'm_traversal', kind: 'family_photo', file: '/media/../secret.jpg', caption: 'Traversal' },
      { id: 'm_missing', kind: 'family_photo', file: '/media/missing.jpg', caption: 'Missing' },
      { id: 'm_dir', kind: 'family_photo', file: '/media/as_dir', caption: 'Directory' },
      { id: 'm_empty', kind: 'family_photo', file: '/media/empty.jpg', caption: 'Empty' },
      { id: 'm_valid', kind: 'family_photo', file: '/media/valid.jpg', caption: 'Valid' },
    ];

    const res = verifyMediaFilesOnDisk(repoDir, items);
    expect(res.ok).toBe(false);
    expect(res.mediaLayout).toBe('media');
    expect(res.checkedCount).toBe(6);
    expect(res.missingFiles.map((f) => ({ id: f.id, reason: f.reason }))).toEqual([
      { id: 'm_bad_prefix', reason: "media file path must start with '/media/'" },
      { id: 'm_traversal', reason: 'unsafe path traversal segment' },
      { id: 'm_missing', reason: 'file not found on disk' },
      { id: 'm_dir', reason: 'path is not a regular file' },
      { id: 'm_empty', reason: 'file is empty (0 bytes)' },
    ]);
  });
});
