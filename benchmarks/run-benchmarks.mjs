#!/usr/bin/env node
/**
 * Deterministic, reproducible Kinloom hot-path benchmark suite (#19).
 *
 * Generates a realistic seeded synthetic archive (600 people across 6 branches
 * and 10 generations, 2,400 events including 1,200 residence anchors, 240 places,
 * 300 sources, 1,100+ kinship edges, 300 media items, 150 Markdown narratives,
 * and a shared pronunciation lexicon) and measures median / p95 wall-clock
 * latency across all core, server/worker D1+R2, CLI ops, and UI tree/bundle
 * hot paths.
 *
 * Usage:
 *   npm run bench
 *   npm run bench -- --json-out benchmarks/latest.json --compare benchmarks/baseline.json
 */
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  runAuditCommand,
  runPronounceAuditCommand,
  runStatusCommand,
  runVerifyCommand,
  writeArchiveDataDir,
} from '@kinloom/cli';
import {
  asBatchId,
  compileArchive,
  deriveKinshipEdgeId,
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  patchCompiledBundle,
  resolveEffectiveLiving,
  sanitizeEventForWrite,
  sanitizePersonForWrite,
  serializeEventsYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
  stringifyYaml,
} from '@kinloom/core';
import { BundleReadService, FixedClock, WikiWriteService } from '@kinloom/server';
import { D1ArchiveRepository, R2IncrementalPatchBundleCache } from '@kinloom/worker';
import { Miniflare } from 'miniflare';
import {
  buildArchivalTreeModel,
  computeArchivalDiagramLayout,
  computeLineageSpotlight,
  searchTreePeople,
} from '../packages/ui/dist/lib/archivalTreeModel.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..');
const DEMO_DIST_DIR = path.join(REPO_ROOT, 'examples', 'demo', 'dist');
const INITIAL_D1_MIGRATION = fs.readFileSync(
  path.join(REPO_ROOT, 'packages', 'worker', 'migrations', '0001_initial.sql'),
  'utf8'
);

const SYNTHETIC_BRANCHES = [
  { id: 'alder', surname: 'Alder', label: 'Alder Line', phonetic: 'AWL-der', ipa: '/ˈɔːldər/' },
  { id: 'mercer', surname: 'Mercer', label: 'Mercer Line', phonetic: 'MUR-ser', ipa: '/ˈmɜːrsər/' },
  { id: 'bramwell', surname: 'Bramwell', label: 'Bramwell Line', phonetic: 'BRAM-wel', ipa: '/ˈbræmwɛl/' },
  { id: 'vance', surname: 'Vance', label: 'Vance Line', phonetic: 'VANS', ipa: '/væns/' },
  { id: 'hale', surname: 'Hale', label: 'Hale Line', phonetic: 'HAYL', ipa: '/heɪl/' },
  { id: 'linden', surname: 'Linden', label: 'Linden Line', phonetic: 'LIN-den', ipa: '/ˈlɪndən/' },
];

const GIVEN_NAMES_M = [
  ['Henry', 'HEN-ree', '/ˈhɛnri/'],
  ['Arthur', 'AR-thur', '/ˈɑːrθər/'],
  ['Thomas', 'TOM-us', '/ˈtɒməs/'],
  ['Walter', 'WAWL-ter', '/ˈwɔːltər/'],
  ['Edward', 'ED-werd', '/ˈɛdwərd/'],
  ['Samuel', 'SAM-yoo-ul', '/ˈsæmjuəl/'],
  ['Charles', 'CHARLZ', '/tʃɑːrlz/'],
  ['George', 'JORJ', '/dʒɔːrdʒ/'],
  ['Frederick', 'FRED-rik', '/ˈfrɛdrɪk/'],
  ['caleb', 'KAY-lub', '/ˈkeɪləb/'].map((v, i) => (i === 0 ? 'Caleb' : v)),
];

const LIVING_GIVEN_NAMES = [
  ['Jordan', 'JOR-dun', '/ˈdʒɔːrdən/'],
  ['Taylor', 'TAY-ler', '/ˈteɪlər/'],
  ['Morgan', 'MOR-gun', '/ˈmɔːrɡən/'],
  ['Casey', 'KAY-see', '/ˈkeɪsi/'],
  ['Riley', 'RY-lee', '/ˈraɪli/'],
  ['Avery', 'AY-vree', '/ˈeɪvri/'],
  ['Quinn', 'KWIN', '/kwɪn/'],
  ['Cameron', 'KAM-run', '/ˈkæmrən/'],
  ['Rowan', 'ROH-un', '/ˈroʊən/'],
  ['Devon', 'DEV-un', '/ˈdɛvən/'],
];

const GIVEN_NAMES_F = [
  ['Clara', 'KLAIR-uh', '/ˈklɛərə/'],
  ['Eleanor', 'EL-uh-nor', '/ˈɛlənɔːr/'],
  ['Margaret', 'MAR-gret', '/ˈmɑːrɡrət/'],
  ['Martha', 'MAR-thuh', '/ˈmɑːrθə/'],
  ['Hannah', 'HAN-uh', '/ˈhænə/'],
  ['Lydia', 'LID-ee-uh', '/ˈlɪdiə/'],
  ['Ruth', 'ROOTH', '/ruːθ/'],
  ['Edith', 'EE-dith', '/ˈiːdɪθ/'],
  ['Miriam', 'MIR-ee-um', '/ˈmɪriəm/'],
  ['Ada', 'AY-duh', '/ˈeɪdə/'],
];

const TINY_JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0xff, 0xd9,
]);

function createPrng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad(num, width) {
  return String(num).padStart(width, '0');
}

function createSyntheticDataset(seed = 20260019) {
  const rand = createPrng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  // 1. Places hierarchy: 4 countries -> 16 states -> 40 counties -> 180 towns/homesteads = 240 places
  const places = [];
  const townIds = [];
  for (let c = 0; c < 4; c += 1) {
    const cid = `plc_country_${pad(c + 1, 2)}`;
    places.push({
      id: cid,
      slug: `country-region-${c + 1}`,
      name: `Region ${c + 1}`,
      full_name: `Region ${c + 1}`,
      place_type: 'country',
      parent_id: null,
      lat: 38.0 + c * 2.5,
      lng: -88.0 + c * 3.5,
      has_primary_source: true,
    });
  }
  for (let s = 0; s < 16; s += 1) {
    const sid = `plc_state_${pad(s + 1, 2)}`;
    const parentId = `plc_country_${pad((s % 4) + 1, 2)}`;
    places.push({
      id: sid,
      slug: `province-${s + 1}`,
      name: `Province ${s + 1}`,
      full_name: `Province ${s + 1}, Region ${(s % 4) + 1}`,
      place_type: 'state',
      parent_id: parentId,
      lat: 37.5 + (s % 4) * 2.5 + Math.floor(s / 4) * 0.6,
      lng: -89.0 + (s % 4) * 3.5 + Math.floor(s / 4) * 0.7,
      has_primary_source: true,
    });
  }
  for (let k = 0; k < 40; k += 1) {
    const kid = `plc_county_${pad(k + 1, 3)}`;
    const stateIdx = (k % 16) + 1;
    const parentId = `plc_state_${pad(stateIdx, 2)}`;
    places.push({
      id: kid,
      slug: `county-${k + 1}`,
      name: `Aldervale County ${k + 1}`,
      full_name: `Aldervale County ${k + 1}, Province ${stateIdx}`,
      place_type: 'county',
      parent_id: parentId,
      lat: 37.2 + (k % 8) * 0.9,
      lng: -89.4 + Math.floor(k / 8) * 1.4,
      has_primary_source: true,
    });
  }
  for (let t = 0; t < 180; t += 1) {
    const tid = `plc_town_${pad(t + 1, 3)}`;
    const countyIdx = Math.floor(t / 5) + 1;
    const clampedCounty = Math.min(40, countyIdx);
    const parentId = `plc_county_${pad(clampedCounty, 3)}`;
    // Cluster nearby towns within 5-12 miles so 15-mile Haversine span merging executes heavily
    const baseLat = 37.2 + ((clampedCounty - 1) % 8) * 0.9;
    const baseLng = -89.4 + Math.floor((clampedCounty - 1) / 8) * 1.4;
    const offsetLat = ((t % 5) - 2) * 0.04;
    const offsetLng = ((t % 3) - 1) * 0.05;
    places.push({
      id: tid,
      slug: `haven-town-${t + 1}`,
      name: `Haven ${t + 1}`,
      full_name: `Haven ${t + 1}, Aldervale County ${clampedCounty}`,
      place_type: t % 4 === 0 ? 'homestead' : 'town',
      parent_id: parentId,
      lat: Number((baseLat + offsetLat).toFixed(5)),
      lng: Number((baseLng + offsetLng).toFixed(5)),
      has_primary_source: true,
    });
    townIds.push(tid);
  }

  // 2. Sources: 300 primary/secondary sources
  const sources = [];
  for (let s = 0; s < 300; s += 1) {
    sources.push({
      id: `src_bench_${pad(s + 1, 4)}`,
      citation: `Aldervale Civil & Parish Register Vol. ${(s % 25) + 1}, Folio ${s + 10} (${1760 + (s % 160)})`,
      author: 'County Registrar',
      publisher: 'Aldervale Historical Society',
      source_type: s % 3 === 0 ? 'census' : s % 3 === 1 ? 'vital_record' : 'land_deed',
      repository: 'State Archives',
      url: `https://example.org/sources/${s + 1}`,
      has_primary_source: true,
    });
  }

  // 3. People & Kinship: 10 generations x 60 people = 600 people (generations 0..8 deceased, generation 9 living)
  const people = [];
  const kinship = [];
  const genBuckets = Array.from({ length: 10 }, () => []);
  const lexicon = {};

  for (const b of SYNTHETIC_BRANCHES) {
    lexicon[b.surname] = {
      phonetic: b.phonetic,
      ipa: b.ipa,
      source_label: 'Family oral tradition',
    };
  }
  for (const [gn, ph, ipa] of [...GIVEN_NAMES_M, ...GIVEN_NAMES_F]) {
    lexicon[gn] = {
      phonetic: ph,
      ipa,
      source_label: 'Standard English lexicon',
    };
  }

  let personCounter = 0;
  for (let gen = 0; gen < 10; gen += 1) {
    const baseBirthYear = 1735 + gen * 25;
    for (let idx = 0; idx < 60; idx += 1) {
      personCounter += 1;
      const branch = SYNTHETIC_BRANCHES[idx % SYNTHETIC_BRANCHES.length];
      const sex = idx % 2 === 0 ? 'M' : 'F';
      const isLivingGen = gen === 9;
      const [first, firstPh, firstIpa] = isLivingGen
        ? LIVING_GIVEN_NAMES[idx % 10]
        : sex === 'M'
          ? GIVEN_NAMES_M[idx % 10]
          : GIVEN_NAMES_F[idx % 10];
      const [middle] = isLivingGen
        ? LIVING_GIVEN_NAMES[(idx + 3 + Math.floor(idx / 10)) % 10]
        : sex === 'M'
          ? GIVEN_NAMES_M[(idx + 3 + gen) % 10]
          : GIVEN_NAMES_F[(idx + 3 + gen) % 10];
      const givenName = `${first} ${middle}`;
      const surname = branch.surname;
      const fullName = `${givenName} ${surname}`;
      const id = `per_bench_${pad(personCounter, 4)}`;
      const birthYear = baseBirthYear + (idx % 9);
      const isLiving = gen === 9;
      const deathYear = isLiving ? null : birthYear + 62 + (idx % 18);
      const birthEdtf =
        idx % 5 === 0 ? `${birthYear}~` : `${birthYear}-${pad((idx % 12) + 1, 2)}-${pad((idx % 27) + 1, 2)}`;
      const deathEdtf =
        deathYear === null
          ? ''
          : idx % 7 === 0
            ? `${deathYear}/${deathYear + 1}`
            : `${deathYear}-${pad(((idx + 4) % 12) + 1, 2)}-${pad(((idx + 9) % 27) + 1, 2)}`;

      const lineageGroup =
        gen === 8 && idx === 0
          ? 'pivot_ancestor'
          : idx < 12
            ? 'direct_ancestor'
            : idx % 4 === 0
              ? 'spouse_in_law'
              : 'collateral';

      const person = {
        id,
        slug: `${surname.toLowerCase()}-${first.toLowerCase()}-${pad(personCounter, 4)}`,
        full_name: fullName,
        given_name: givenName,
        surname,
        alt_names: idx % 4 === 0 ? [`${first} ${surname}`] : [],
        sex,
        is_living: isLiving,
        lineage_group: lineageGroup,
        branch: branch.id,
        birth_edtf: birthEdtf,
        death_edtf: deathEdtf,
        portrait_url: null,
        has_primary_source: true,
        ...(!isLiving && idx % 10 === 0
          ? {
              pronunciation: {
                phonetic: `${firstPh} ${branch.phonetic}`,
                ipa: `${firstIpa.slice(0, -1)} ${branch.ipa.slice(1)}`,
                source_label: 'Branch family bible note',
              },
            }
          : {}),
      };
      people.push(person);
      genBuckets[gen].push(person);
    }
  }

  // Pair couples in each generation and wire children from generation g to couples in generation g - 1
  for (let gen = 0; gen < 10; gen += 1) {
    const members = genBuckets[gen];
    for (let pair = 0; pair < 24; pair += 1) {
      const a = members[pair * 2];
      const b = members[pair * 2 + 1];
      if (a && b) {
        kinship.push({
          from: a.id,
          to: b.id,
          relation: 'spouse',
          family_xref: `@F_${gen}_${pair}@`,
        });
      }
    }
    if (gen > 0) {
      const prevMembers = genBuckets[gen - 1];
      for (let idx = 0; idx < members.length; idx += 1) {
        const child = members[idx];
        const coupleIdx = idx % 24;
        const father = prevMembers[coupleIdx * 2];
        const mother = prevMembers[coupleIdx * 2 + 1];
        if (father) {
          kinship.push({
            from: father.id,
            to: child.id,
            relation: 'parent',
            family_xref: `@F_${gen - 1}_${coupleIdx}@`,
          });
        }
        if (mother && idx % 6 !== 5) {
          kinship.push({
            from: mother.id,
            to: child.id,
            relation: 'parent',
            family_xref: `@F_${gen - 1}_${coupleIdx}@`,
          });
        }
      }
    }
  }

  // 4. Events: 2,400 events (4 per person: birth, 2 residence anchors, marriage/milestone/death)
  const events = [];
  let eventCounter = 0;
  for (let i = 0; i < people.length; i += 1) {
    const p = people[i];
    const gen = Math.floor(i / 60);
    const baseYear = 1735 + gen * 25 + (i % 9);
    const townA = townIds[(i * 3) % townIds.length];
    const townB = townIds[(i * 3 + 1) % townIds.length];
    const townC = townIds[(i * 3 + 7) % townIds.length];
    const srcA = sources[(i * 2) % sources.length].id;
    const srcB = sources[(i * 2 + 1) % sources.length].id;

    // Event 1: Birth point_event
    eventCounter += 1;
    events.push({
      id: `evt_bench_${pad(eventCounter, 4)}`,
      title: `Birth of ${p.is_living ? 'Family Member' : p.full_name}`,
      scope: 'personal',
      event_kind: 'point_event',
      category: 'birth',
      edtf_date: p.birth_edtf,
      place_id: townA,
      summary: p.is_living
        ? 'Recorded in local parish register.'
        : `${p.full_name} was born in ${townA} according to parish records.`,
      participants: [{ person_id: p.id, role: 'principal' }],
      sources: [{ source_id: srcA, confidence: 'high', citation_detail: `Entry ${eventCounter}` }],
      has_primary_source: true,
    });

    // Event 2: First residence_anchor (age ~20)
    eventCounter += 1;
    events.push({
      id: `evt_bench_${pad(eventCounter, 4)}`,
      title: `Household enumeration (${baseYear + 20})`,
      scope: 'family',
      event_kind: 'residence_anchor',
      category: 'census',
      edtf_date: `${Math.min(2024, baseYear + 20)}-06-01`,
      place_id: townA,
      summary: p.is_living
        ? 'Enumerated in household schedule.'
        : `Enumerated at ${townA} in the ${Math.min(2024, baseYear + 20)} schedule.`,
      participants: [{ person_id: p.id, role: 'head' }],
      sources: [{ source_id: srcB, confidence: 'high', citation_detail: `Sheet ${(i % 40) + 1}` }],
      ...(i % 8 === 0
        ? {
            alternate_dates: [
              { edtf_date: `${Math.min(2024, baseYear + 21)}`, source_id: srcA, note: 'Tax roll year' },
            ],
          }
        : {}),
      has_primary_source: true,
    });

    // Event 3: Second residence_anchor (age ~35, nearby townB for Haversine merge!)
    eventCounter += 1;
    events.push({
      id: `evt_bench_${pad(eventCounter, 4)}`,
      title: `Decennial schedule (${Math.min(2025, baseYear + 35)})`,
      scope: 'family',
      event_kind: 'residence_anchor',
      category: 'census',
      edtf_date: `${Math.min(2025, baseYear + 35)}-04-15`,
      place_id: i % 2 === 0 ? townB : townC,
      summary: p.is_living
        ? 'Recorded at agricultural homestead.'
        : `${p.full_name} farmed 80 acres near ${townB}.`,
      participants: [{ person_id: p.id, role: 'resident' }],
      sources: [{ source_id: srcA, confidence: 'medium', citation_detail: `Line ${(i % 50) + 1}` }],
      has_primary_source: true,
    });

    // Event 4: Third residence_anchor or death event
    eventCounter += 1;
    if (!p.is_living) {
      events.push({
        id: `evt_bench_${pad(eventCounter, 4)}`,
        title: `Later residence of ${p.full_name}`,
        scope: 'personal',
        event_kind: 'residence_anchor',
        category: 'residence',
        edtf_date: `${baseYear + 50}-09-10`,
        place_id: townB,
        summary: `${p.full_name} remained in ${townB} through autumn ${baseYear + 50}.`,
        participants: [{ person_id: p.id, role: 'resident' }],
        sources: [{ source_id: srcB, confidence: 'high', citation_detail: `Deed ${eventCounter}` }],
        has_primary_source: true,
      });
    } else {
      events.push({
        id: `evt_bench_${pad(eventCounter, 4)}`,
        title: 'Family reunion gathering',
        scope: 'family',
        event_kind: 'point_event',
        category: 'milestone',
        edtf_date: '2020-07-04',
        place_id: townC,
        summary: 'Annual regional family gathering.',
        participants: [{ person_id: p.id, role: 'attendee' }],
        sources: [{ source_id: srcA, confidence: 'high' }],
        has_primary_source: true,
      });
    }
  }

  // 5. Media: 300 deceased portraits & document scans
  const media = [];
  for (let m = 0; m < 300; m += 1) {
    const p = people[m]; // strictly deceased (indices 0..299 are gens 0..4)
    const ev = events[m * 4];
    const src = sources[m % sources.length];
    media.push({
      id: `med_bench_${pad(m + 1, 4)}`,
      kind: m % 3 === 0 ? 'portrait' : m % 3 === 1 ? 'document_scan' : 'headstone',
      source_id: src.id,
      person_id: p.id,
      person_ids: [p.id],
      event_id: ev.id,
      file: `media/bench_${pad(m + 1, 4)}.jpg`,
      caption: `Archival photograph for ${p.full_name}`,
      date_edtf: p.birth_edtf,
      provenance: 'Aldervale Family Collection',
      mime_type: 'image/jpeg',
      has_primary_source: true,
    });
  }

  // 6. Narratives: 150 Markdown biographies with inline citations (for deceased ancestors)
  const narratives = [];
  for (let n = 0; n < 150; n += 1) {
    const p = people[n * 2]; // indices 0..298 (gens 0..4, deceased)
    const ev1 = events[n * 8];
    const ev2 = events[n * 8 + 1];
    const src1 = sources[n % sources.length];
    const src2 = sources[(n + 1) % sources.length];
    const town = pick(townIds);
    narratives.push({
      id: `nar_bench_${pad(n + 1, 4)}`,
      slug: `biography-${p.slug}`,
      kind: 'biography',
      subject_person_id: p.id,
      title: `Life and Homestead of ${p.full_name}`,
      summary: `Documented biography of ${p.full_name} across Aldervale County schedules.`,
      body_md: [
        `## Early Years`,
        ``,
        `${p.full_name} was born in ${p.birth_edtf} and raised in the ${p.branch} settlement [cite:${src1.id}].`,
        ``,
        `## Settlement and Agriculture`,
        ``,
        `By adulthood, county tax and decennial schedules place the household in ${town}, where ${p.given_name} maintained timber and orchard parcels [cite:${src2.id}].`,
      ].join('\n'),
      date_edtf: p.death_edtf,
      person_ids: [p.id],
      place_ids: [town],
      event_ids: [ev1.id, ev2.id],
      source_ids: [src1.id, src2.id],
      has_primary_source: true,
    });
  }

  const pivotPerson = genBuckets[8][0];
  const configObj = {
    schemaVersion: 1,
    site: {
      title: 'Alder & Mercer Synthetic Benchmark Archive',
      familyName: 'Alder & Mercer',
      gedcomSourceName: 'ALDER_BENCH',
      description: 'Deterministic synthetic archive for Kinloom performance benchmarking.',
    },
    defaultBranchId: 'alder',
    branches: SYNTHETIC_BRANCHES.map((b) => ({
      id: b.id,
      label: b.label,
      surnames: [b.surname],
      lineageGroups: ['pivot_ancestor', 'direct_ancestor', 'collateral', 'spouse_in_law'],
      supportsDirectMode: true,
    })),
    lineageSections: SYNTHETIC_BRANCHES.map((b) => ({
      id: `sec_${b.id}`,
      title: b.label,
      branchId: b.id,
      lineageGroups: ['pivot_ancestor', 'direct_ancestor', 'collateral'],
    })),
    featuredKinshipPairs: [
      {
        fromId: genBuckets[0][0].id,
        toId: pivotPerson.id,
        label: 'Founder to Pivot',
      },
    ],
    privacy: {
      livingCutoffYears: 101,
      referenceYear: 2026,
      privateModeShowsBirthYear: true,
      stripLivingPortraits: true,
      stripLivingResidenceSpans: true,
      markGedcomLivingConfidential: true,
    },
  };

  const configYaml = stringifyYaml(configObj);
  const siteConfig = parseKinloomConfigYaml(configYaml);

  return {
    configYaml,
    siteConfig,
    lexicon,
    people,
    events,
    places,
    sources,
    kinship,
    media,
    narratives,
  };
}

function computeStats(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const p95Idx = Math.min(n - 1, Math.ceil(n * 0.95) - 1);
  const mean = sorted.reduce((acc, v) => acc + v, 0) / n;
  return {
    runs: n,
    medianMs: Number(median.toFixed(2)),
    p95Ms: Number(sorted[p95Idx].toFixed(2)),
    meanMs: Number(mean.toFixed(2)),
    minMs: Number(sorted[0].toFixed(2)),
    maxMs: Number(sorted[n - 1].toFixed(2)),
  };
}

async function measureAsync(name, category, warmupRuns, measuredRuns, fn) {
  for (let i = 0; i < warmupRuns; i += 1) {
    await fn(i, true);
  }
  const samples = [];
  for (let i = 0; i < measuredRuns; i += 1) {
    const t0 = performance.now();
    await fn(i, false);
    samples.push(performance.now() - t0);
  }
  return {
    id: name,
    category,
    ...computeStats(samples),
  };
}

async function applySqlScript(db, sqlScript) {
  const withoutComments = sqlScript
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line))
    .join('\n');
  const statements = withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  if (statements.length > 0) {
    await db.batch(statements.map((s) => db.prepare(s)));
  }
}

function measureDemoBundleSizes() {
  if (!fs.existsSync(DEMO_DIST_DIR)) {
    return null;
  }
  const indexHtml = fs.readFileSync(path.join(DEMO_DIST_DIR, 'index.html'), 'utf8');
  const assetRefs = new Set();
  for (const match of indexHtml.matchAll(/(?:src|href)="\/?assets\/([^"]+\.js)"/g)) {
    assetRefs.add(match[1]);
  }
  const assetsDir = path.join(DEMO_DIST_DIR, 'assets');
  const allJsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  let initialJsBytes = 0;
  for (const file of assetRefs) {
    const full = path.join(assetsDir, file);
    if (fs.existsSync(full)) {
      initialJsBytes += fs.statSync(full).size;
    }
  }
  let totalJsBytes = 0;
  let largestChunkBytes = 0;
  let largestChunkName = '';
  for (const file of allJsFiles) {
    const sz = fs.statSync(path.join(assetsDir, file)).size;
    totalJsBytes += sz;
    if (file.endsWith('.js') && sz > largestChunkBytes) {
      largestChunkBytes = sz;
      largestChunkName = file;
    }
  }
  return {
    initialEntryChunks: [...assetRefs],
    initialJsBytes,
    initialJsKiB: Number((initialJsBytes / 1024).toFixed(2)),
    totalJsBytes,
    totalJsKiB: Number((totalJsBytes / 1024).toFixed(2)),
    largestChunkName,
    largestChunkKiB: Number((largestChunkBytes / 1024).toFixed(2)),
  };
}

function parseCliArgs(argv) {
  let jsonOut = null;
  let comparePath = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json-out' && argv[i + 1]) {
      jsonOut = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--compare' && argv[i + 1]) {
      comparePath = argv[i + 1];
      i += 1;
    }
  }
  return { jsonOut, comparePath };
}

async function main() {
  const { jsonOut, comparePath } = parseCliArgs(process.argv.slice(2));
  const dataset = createSyntheticDataset(20260019);

  // Pre-serialize YAML strings once for parse benchmark & temp repo materialization
  const yamlStrings = {
    config: dataset.configYaml,
    people: serializePeopleYaml(dataset.people, { sortById: true }),
    events: serializeEventsYaml(dataset.events, { sortById: true }),
    places: serializePlacesYaml(dataset.places, { sortById: true }),
    sources: serializeSourcesYaml(dataset.sources, { sortById: true }),
    kinship: serializeKinshipYaml(dataset.kinship, { sortDeterministic: true }),
    media: serializeMediaYaml(dataset.media, { sortById: true }),
    narratives: serializeNarrativesYaml(dataset.narratives, { sortById: true }),
    pronunciations: stringifyYaml(dataset.lexicon),
  };

  const results = [];

  // 1. YAML load + Zod schema validation
  results.push(
    await measureAsync('core.yaml_load_validate', '@kinloom/core', 2, 7, () => {
      parseKinloomConfigYaml(yamlStrings.config);
      parsePeopleYaml(yamlStrings.people);
      parseEventsYaml(yamlStrings.events);
      parsePlacesYaml(yamlStrings.places);
      parseSourcesYaml(yamlStrings.sources);
      parseKinshipYaml(yamlStrings.kinship);
      parseMediaYaml(yamlStrings.media);
      parseNarrativesYaml(yamlStrings.narratives);
    })
  );

  // 2. Deterministic YAML canonical serialization
  results.push(
    await measureAsync('core.yaml_serialize', '@kinloom/core', 2, 7, () => {
      serializePeopleYaml(dataset.people, { sortById: true });
      serializeEventsYaml(dataset.events, { sortById: true });
      serializePlacesYaml(dataset.places, { sortById: true });
      serializeSourcesYaml(dataset.sources, { sortById: true });
      serializeKinshipYaml(dataset.kinship, { sortDeterministic: true });
      serializeMediaYaml(dataset.media, { sortById: true });
      serializeNarrativesYaml(dataset.narratives, { sortById: true });
    })
  );

  // 3. Full dual-mode compileArchive (private + public)
  let compiledPrivate = null;
  let compiledPublic = null;
  results.push(
    await measureAsync('core.compile_archive_dual', '@kinloom/core', 2, 7, () => {
      compiledPrivate = compileArchive({
        people: dataset.people,
        events: dataset.events,
        places: dataset.places,
        sources: dataset.sources,
        kinship: dataset.kinship,
        media: dataset.media,
        narratives: dataset.narratives,
        siteConfig: dataset.siteConfig,
        mode: 'private',
        generatedAt: '2026-11-27T00:00:00.000Z',
      });
      compiledPublic = compileArchive({
        people: dataset.people,
        events: dataset.events,
        places: dataset.places,
        sources: dataset.sources,
        kinship: dataset.kinship,
        media: dataset.media,
        narratives: dataset.narratives,
        siteConfig: dataset.siteConfig,
        mode: 'public',
        generatedAt: '2026-11-27T00:00:00.000Z',
      });
    })
  );

  // 4. Incremental patchCompiledBundle (25-mutation mixed batch across private + public bundles)
  const patchMutations = [];
  for (let k = 0; k < 10; k += 1) {
    const targetPerson = dataset.people[k * 12];
    patchMutations.push({
      revision_id: 100 + k,
      entity_type: 'person',
      entity_id: targetPerson.id,
      action: 'update',
      before_json: targetPerson,
      after_json: {
        ...targetPerson,
        alt_names: [...targetPerson.alt_names, `${targetPerson.given_name} Updated`],
      },
      has_primary_source: true,
    });
  }
  for (let k = 0; k < 10; k += 1) {
    const targetEvent = dataset.events[k * 30 + 1];
    patchMutations.push({
      revision_id: 120 + k,
      entity_type: 'event',
      entity_id: targetEvent.id,
      action: 'update',
      before_json: targetEvent,
      after_json: {
        ...targetEvent,
        summary: `${targetEvent.summary} Verified against original folio.`,
      },
      has_primary_source: true,
    });
  }
  for (let k = 0; k < 5; k += 1) {
    const targetNarrative = dataset.narratives[k * 10];
    patchMutations.push({
      revision_id: 140 + k,
      entity_type: 'narrative',
      entity_id: targetNarrative.id,
      action: 'update',
      before_json: targetNarrative,
      after_json: {
        ...targetNarrative,
        summary: `${targetNarrative.summary} Revised archival note.`,
      },
      has_primary_source: true,
    });
  }

  results.push(
    await measureAsync('core.patch_compiled_bundle', '@kinloom/core', 3, 15, () => {
      patchCompiledBundle(compiledPrivate.bundle, patchMutations, dataset.siteConfig, 'private', {
        generatedAt: '2026-11-27T01:00:00.000Z',
        referenceYear: 2026,
      });
      patchCompiledBundle(compiledPublic.bundle, patchMutations, dataset.siteConfig, 'public', {
        generatedAt: '2026-11-27T01:00:00.000Z',
        referenceYear: 2026,
      });
    })
  );

  // 5. Server + Worker D1/R2 batch submit & incremental R2 bundle sync (Miniflare)
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: { DB: 'kinloom-bench-db' },
    r2Buckets: { MEDIA_BUCKET: 'kinloom-bench-bucket' },
  });
  try {
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('MEDIA_BUCKET');
    await applySqlScript(db, INITIAL_D1_MIGRATION);
    const clock = new FixedClock('2026-11-27T12:00:00.000Z');
    const repository = new D1ArchiveRepository(db, { privacyConfig: dataset.siteConfig.privacy, clock });
    const bundleCache = new R2IncrementalPatchBundleCache({
      bucket,
      siteConfig: dataset.siteConfig,
      clock,
      mode: 'private',
    });

    // Seed D1 with the full synthetic archive
    const livingIds = new Set();
    const seedOps = [];
    for (const p of dataset.people) {
      const sanitized = sanitizePersonForWrite(p, dataset.siteConfig.privacy);
      if (resolveEffectiveLiving(sanitized, dataset.siteConfig.privacy, 2026)) {
        livingIds.add(sanitized.id);
      }
      seedOps.push({
        entity_type: 'person',
        entity_id: sanitized.id,
        slug: sanitized.slug,
        action: 'create',
        expected_parent_revision_id: null,
        summary: 'Seed person',
        has_primary_source: true,
        before_json: null,
        after_json: sanitized,
      });
    }
    for (const pl of dataset.places) {
      seedOps.push({
        entity_type: 'place',
        entity_id: pl.id,
        slug: pl.slug,
        action: 'create',
        expected_parent_revision_id: null,
        summary: 'Seed place',
        has_primary_source: true,
        before_json: null,
        after_json: pl,
      });
    }
    for (const s of dataset.sources) {
      seedOps.push({
        entity_type: 'source',
        entity_id: s.id,
        slug: null,
        action: 'create',
        expected_parent_revision_id: null,
        summary: 'Seed source',
        has_primary_source: true,
        before_json: null,
        after_json: s,
      });
    }
    for (const ev of dataset.events) {
      const sanitized = sanitizeEventForWrite(ev, livingIds, dataset.siteConfig.privacy);
      seedOps.push({
        entity_type: 'event',
        entity_id: sanitized.id,
        slug: null,
        action: 'create',
        expected_parent_revision_id: null,
        summary: 'Seed event',
        has_primary_source: true,
        before_json: null,
        after_json: sanitized,
      });
    }
    for (const m of dataset.media) {
      seedOps.push({
        entity_type: 'media',
        entity_id: m.id,
        slug: null,
        action: 'create',
        expected_parent_revision_id: null,
        summary: 'Seed media',
        has_primary_source: true,
        before_json: null,
        after_json: m,
      });
    }
    for (const n of dataset.narratives) {
      seedOps.push({
        entity_type: 'narrative',
        entity_id: n.id,
        slug: n.slug,
        action: 'create',
        expected_parent_revision_id: null,
        summary: 'Seed narrative',
        has_primary_source: true,
        before_json: null,
        after_json: n,
      });
    }
    for (const edge of dataset.kinship) {
      seedOps.push({
        entity_type: 'kinship_edge',
        entity_id: deriveKinshipEdgeId(edge),
        slug: null,
        action: 'create',
        expected_parent_revision_id: null,
        summary: 'Seed kinship',
        has_primary_source: true,
        before_json: null,
        after_json: edge,
      });
    }

    await repository.commitAtomicMutations({
      batch_id: null,
      author: { author_id: 'system:seed', author_name: 'Bench Seed', author_type: 'system_seed' },
      nowIso: clock.nowIso(),
      operations: seedOps,
    });
    const initialSnapshot = await repository.loadActiveSnapshot();
    await bundleCache.rebuildAndStore(initialSnapshot);

    const writeService = new WikiWriteService({
      repository,
      bundleCache,
      clock,
      siteConfig: dataset.siteConfig,
    });
    const readService = new BundleReadService({
      repository,
      bundleCache,
      clock,
      siteConfig: dataset.siteConfig,
    });

    let batchCounter = 0;
    results.push(
      await measureAsync(
        'server_worker.d1_r2_batch_sync',
        '@kinloom/server+@kinloom/worker',
        2,
        7,
        async () => {
          batchCounter += 1;
          const patches = [];
          for (let j = 0; j < 30; j += 1) {
            const ev = dataset.events[j * 20];
            patches.push({
              entity_type: 'event',
              entity_id: ev.id,
              action: 'update',
              merge: true,
              data: {
                id: ev.id,
                summary: `${ev.summary} [rev ${batchCounter}.${j}]`,
              },
            });
          }
          for (let j = 0; j < 10; j += 1) {
            const p = dataset.people[j * 15];
            patches.push({
              entity_type: 'person',
              entity_id: p.id,
              action: 'update',
              merge: true,
              data: {
                id: p.id,
                alt_names: [`${p.given_name} Batch ${batchCounter}`],
              },
            });
          }
          await writeService.submitBatch({
            author: {
              author_id: 'agent:bench',
              author_name: 'Bench Agent',
              author_type: 'agent',
            },
            submission: {
              batch_id: asBatchId(`batch_bench_${pad(batchCounter, 4)}`),
              summary: `Benchmark 40-entity batch ${batchCounter}`,
              has_primary_source: true,
              patches,
            },
          });
          const bundleRes = await readService.getBundle({ ifNoneMatch: null });
          if (bundleRes.status === 'hit' && typeof bundleRes.object.body !== 'string') {
            await bundleRes.object.body.cancel();
          }
        }
      )
    );
  } finally {
    await mf.dispose();
  }

  // 6-9. CLI Ops benchmarks on a materialized synthetic archive repo on disk
  const tempRepo = await mkdtemp(path.join(os.tmpdir(), 'kinloom-bench-repo-'));
  try {
    const dataDir = path.join(tempRepo, 'data');
    await writeArchiveDataDir(dataDir, {
      people: dataset.people,
      events: dataset.events,
      places: dataset.places,
      sources: dataset.sources,
      kinship: dataset.kinship,
      media: dataset.media,
      narratives: dataset.narratives,
    });
    await writeFile(path.join(tempRepo, 'kinloom.config.yaml'), yamlStrings.config, 'utf8');
    await writeFile(path.join(dataDir, 'pronunciations.yaml'), yamlStrings.pronunciations, 'utf8');

    const mediaDir = path.join(tempRepo, 'archive-media', 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    for (let m = 0; m < 300; m += 1) {
      fs.writeFileSync(path.join(mediaDir, `bench_${pad(m + 1, 4)}.jpg`), TINY_JPEG_BYTES);
    }
    const auditTargetPerson = dataset.people[1]; // per_bench_0002 (deceased, no existing biography)
    for (let s = 0; s < 15; s += 1) {
      const target = s === 0 ? auditTargetPerson : dataset.people[s * 10 + 1];
      const stagedDir = path.join(tempRepo, 'research', 'people', target.id);
      fs.mkdirSync(stagedDir, { recursive: true });
      const stagedPatch = {
        person_id: target.id,
        sources: [
          {
            id: `src_staged_${target.id}`,
            citation: `Aldervale Probate Packet for ${target.full_name} (1812)`,
            source_type: 'probate',
            repository: 'Aldervale County Probate Court',
            has_primary_source: true,
          },
        ],
        events: [
          {
            id: `evt_staged_${target.id}`,
            title: `Probate settlement of ${target.full_name}`,
            scope: 'personal',
            event_kind: 'point_event',
            category: 'probate',
            edtf_date: '1798-10-12',
            place_id: 'plc_town_002',
            summary: `Estate inventory filed in Aldervale County for ${target.full_name}.`,
            participants: [{ person_id: target.id, role: 'principal' }],
            sources: [{ source_id: `src_staged_${target.id}`, confidence: 'high' }],
            has_primary_source: true,
          },
        ],
        narratives: [
          {
            id: `nar_staged_${target.id}`,
            slug: `staged-bio-${target.slug}`,
            kind: 'biography',
            subject_person_id: target.id,
            title: `Homestead and Estate of ${target.full_name}`,
            summary: `Archival sketch for ${target.full_name}.`,
            body_md: `${target.full_name} settled in Haven 2 and left a detailed probate inventory [cite:src_staged_${target.id}].`,
            person_ids: [target.id],
            place_ids: ['plc_town_002'],
            event_ids: [`evt_staged_${target.id}`],
            source_ids: [`src_staged_${target.id}`],
            has_primary_source: true,
          },
        ],
      };
      fs.writeFileSync(
        path.join(stagedDir, 'patch.json'),
        `${JSON.stringify(stagedPatch, null, 2)}\n`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(stagedDir, 'dossier.md'),
        `# Research Dossier: ${target.full_name}\n\nVerified probate packet in Aldervale County.\n`,
        'utf8'
      );
    }

    results.push(
      await measureAsync('cli.audit', '@kinloom/cli', 1, 5, async () => {
        const res = await runAuditCommand({
          repoDir: tempRepo,
          personId: auditTargetPerson.id,
          json: true,
          plugins: [],
        });
        if (!res.ok) {
          throw new Error(`Unexpected audit errors: ${res.errors.join('; ')}`);
        }
      })
    );

    results.push(
      await measureAsync('cli.verify', '@kinloom/cli', 1, 5, async () => {
        const res = await runVerifyCommand({ repoDir: tempRepo, json: true, plugins: [] });
        if (!res.checks.places.ok || !res.checks.ssn.ok) {
          throw new Error('Unexpected verify failure on synthetic benchmark repo');
        }
      })
    );

    results.push(
      await measureAsync('cli.status', '@kinloom/cli', 2, 7, async () => {
        await runStatusCommand({ repoDir: tempRepo, sort: 'sparsest', endOfLine: false });
        await runStatusCommand({ repoDir: tempRepo, sort: 'chronological', endOfLine: true });
      })
    );

    results.push(
      await measureAsync('cli.pronounce_audit', '@kinloom/cli', 2, 7, () => {
        runPronounceAuditCommand({ repoDir: tempRepo });
      })
    );
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }

  // 10. UI Tree Model + Orthogonal Diagram Layout + Lineage Spotlight (600 people, 10 gens, 6 branches)
  const placesById = new Map(compiledPrivate.bundle.places.map((p) => [p.id, p]));
  const branchLabelsById = new Map(SYNTHETIC_BRANCHES.map((b) => [b.id, b.label]));
  let latestTreeModel = null;

  results.push(
    await measureAsync('ui.tree_model_and_layout', '@kinloom/ui', 2, 9, () => {
      const model = buildArchivalTreeModel({
        people: compiledPrivate.bundle.people,
        kinship: compiledPrivate.bundle.kinship,
        branchFilter: 'all',
        mode: 'full',
        expandedUnionIds: new Set(),
        placesById,
      });
      latestTreeModel = model;
      computeArchivalDiagramLayout(model);
      if (model.pivotPersonId) {
        computeLineageSpotlight({
          selectedPersonId: model.pivotPersonId,
          model,
          bundle: compiledPrivate.bundle,
          placesById,
        });
      }
    })
  );

  // 11. UI Tree Search INP (20 interactive keystroke queries across 600-person tree)
  const searchQueries = [
    '',
    'a',
    'al',
    'ald',
    'alder',
    'clara',
    'clara alder',
    'mercer',
    'henry mercer',
    'bramwell',
    'vance',
    'hale',
    'linden',
    '178',
    '183',
    '188',
    '191',
    'eleanor',
    'samuel',
    'margaret bramwell',
  ];
  results.push(
    await measureAsync('ui.tree_search_inp_20_queries', '@kinloom/ui', 2, 9, () => {
      for (const q of searchQueries) {
        searchTreePeople({
          query: q,
          people: compiledPrivate.bundle.people,
          buildMode: 'private',
          model: latestTreeModel,
          branchFilter: 'all',
          defaultBranchId: 'alder',
          branchLabelsById,
          limit: 10,
        });
      }
    })
  );

  const bundleMetrics = measureDemoBundleSizes();

  let comparisonById = null;
  if (comparePath && fs.existsSync(comparePath)) {
    const baselineDoc = JSON.parse(fs.readFileSync(comparePath, 'utf8'));
    comparisonById = new Map((baselineDoc.benchmarks ?? []).map((b) => [b.id, b]));
  }

  console.log(
    '\n### Kinloom Hot-Path Benchmark Results (Seed 20260019 — 600 People / 2,400 Events / 240 Places)\n'
  );
  if (comparisonById) {
    console.log(
      '| Benchmark | Workspace | Baseline Median (ms) | Current Median (ms) | p95 (ms) | Reduction | Speedup |'
    );
    console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const row of results) {
      const base = comparisonById.get(row.id);
      const baseMs = base ? base.medianMs : null;
      const reduction = baseMs ? `${(((baseMs - row.medianMs) / baseMs) * 100).toFixed(1)}%` : 'n/a';
      const speedup = baseMs && row.medianMs > 0 ? `${(baseMs / row.medianMs).toFixed(2)}x` : 'n/a';
      console.log(
        `| \`${row.id}\` | \`${row.category}\` | ${baseMs !== null ? baseMs.toFixed(2) : 'n/a'} | ${row.medianMs.toFixed(2)} | ${row.p95Ms.toFixed(2)} | ${reduction} | ${speedup} |`
      );
    }
  } else {
    console.log('| Benchmark | Workspace | Median (ms) | p95 (ms) | Mean (ms) | Min (ms) | Runs |');
    console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const row of results) {
      console.log(
        `| \`${row.id}\` | \`${row.category}\` | ${row.medianMs.toFixed(2)} | ${row.p95Ms.toFixed(2)} | ${row.meanMs.toFixed(2)} | ${row.minMs.toFixed(2)} | ${row.runs} |`
      );
    }
  }

  if (bundleMetrics) {
    console.log('\n### Demo Production Bundle Metrics (`examples/demo/dist`)\n');
    console.log(
      `- Initial entry + modulepreload JS: **${bundleMetrics.initialJsKiB} KiB** (${bundleMetrics.initialEntryChunks.join(', ')})`
    );
    console.log(`- Total production JS/MJS assets: **${bundleMetrics.totalJsKiB} KiB**`);
    console.log(
      `- Largest route/app JS chunk: **${bundleMetrics.largestChunkKiB} KiB** (\`${bundleMetrics.largestChunkName}\`)`
    );
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    seed: 20260019,
    nodeVersion: process.version,
    cpus: os.availableParallelism(),
    datasetCounts: {
      people: dataset.people.length,
      events: dataset.events.length,
      places: dataset.places.length,
      sources: dataset.sources.length,
      kinship: dataset.kinship.length,
      media: dataset.media.length,
      narratives: dataset.narratives.length,
    },
    benchmarks: results,
    bundleMetrics,
  };

  if (jsonOut) {
    const resolvedOut = path.resolve(REPO_ROOT, jsonOut);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`\nWrote JSON benchmark report to ${jsonOut}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
