import fs from 'node:fs';
import path from 'node:path';
import {
  compileArchive,
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
} from '@kinloom/core';

const demoRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(demoRoot, '../..');
const dataDir = path.join(demoRoot, 'data');
const publicDir = path.join(demoRoot, 'public');
const publicDataDir = path.join(publicDir, 'data');
const publicMediaDir = path.join(publicDir, 'media');
const generatedDir = path.join(demoRoot, 'src', 'generated');

fs.mkdirSync(publicDataDir, { recursive: true });
fs.mkdirSync(publicMediaDir, { recursive: true });
fs.mkdirSync(generatedDir, { recursive: true });

function readText(name) {
  return fs.readFileSync(path.join(dataDir, name), 'utf8');
}

function makePortraitSvg(initials, name, years, accent) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 400" width="320" height="400" role="img" aria-label="${name}">
  <rect width="320" height="400" fill="#F5EFE2"/>
  <rect x="14" y="14" width="292" height="372" fill="#FCF9F2" stroke="#D6CEBE" stroke-width="2"/>
  <rect x="24" y="24" width="272" height="272" fill="#EAE1CE" stroke="#827A6A" stroke-width="1"/>
  <circle cx="160" cy="134" r="54" fill="${accent}" opacity="0.16"/>
  <circle cx="160" cy="134" r="46" fill="#FCF9F2" stroke="${accent}" stroke-width="2.5"/>
  <text x="160" y="148" text-anchor="middle" font-family="Georgia, serif" font-size="38" font-weight="700" fill="#1B2A41">${initials}</text>
  <path d="M92 268 C100 214, 220 214, 228 268 Z" fill="#1B2A41" opacity="0.14"/>
  <line x1="48" y1="318" x2="272" y2="318" stroke="#D6CEBE" stroke-width="1"/>
  <text x="160" y="344" text-anchor="middle" font-family="Georgia, serif" font-size="18" font-weight="700" fill="#1B2A41">${name}</text>
  <text x="160" y="368" text-anchor="middle" font-family="monospace" font-size="13" fill="#4E4A42">${years}</text>
</svg>
`;
}

function makeHeadstoneSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 360" width="560" height="360" role="img" aria-label="Oak Ridge Cemetery Monument">
  <rect width="560" height="360" fill="#EAE1CE"/>
  <rect x="16" y="16" width="528" height="328" fill="#FCF9F2" stroke="#827A6A" stroke-width="1.5"/>
  <rect x="64" y="276" width="432" height="28" fill="#D6CEBE" stroke="#4E4A42" stroke-width="1.5"/>
  <path d="M128 276 L128 104 Q280 44 432 104 L432 276 Z" fill="#F5EFE2" stroke="#1B2A41" stroke-width="2"/>
  <line x1="168" y1="138" x2="392" y2="138" stroke="#7A4612" stroke-width="1.5"/>
  <text x="280" y="122" text-anchor="middle" font-family="monospace" font-size="12" letter-spacing="2" fill="#7A4612">OAK RIDGE CEMETERY · SPRINGFIELD, IL</text>
  <text x="280" y="176" text-anchor="middle" font-family="Georgia, serif" font-size="22" font-weight="700" fill="#1B2A41">ABRAHAM LINCOLN</text>
  <text x="280" y="198" text-anchor="middle" font-family="monospace" font-size="13" fill="#4E4A42">1809 — 1865</text>
  <text x="280" y="232" text-anchor="middle" font-family="Georgia, serif" font-size="20" font-weight="700" fill="#1B2A41">MARY ANN TODD LINCOLN</text>
  <text x="280" y="254" text-anchor="middle" font-family="monospace" font-size="13" fill="#4E4A42">1818 — 1882</text>
</svg>
`;
}

function makeCensusScanSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 440" width="640" height="440" role="img" aria-label="1850 Federal Census Springfield Illinois">
  <rect width="640" height="440" fill="#F5EFE2"/>
  <rect x="16" y="16" width="608" height="408" fill="#FCF9F2" stroke="#23272E" stroke-width="1.5"/>
  <text x="320" y="50" text-anchor="middle" font-family="Georgia, serif" font-size="18" font-weight="700" fill="#1B2A41">SCHEDULE I. — Free Inhabitants in Springfield, Sangamon County, Illinois</text>
  <text x="320" y="72" text-anchor="middle" font-family="monospace" font-size="12" fill="#4E4A42">Enumerated 29 August 1850 · Sheet 129A · National Archives M432 Roll 127</text>
  <line x1="36" y1="90" x2="604" y2="90" stroke="#23272E" stroke-width="1.5"/>
  <line x1="36" y1="120" x2="604" y2="120" stroke="#827A6A" stroke-width="1"/>
  <text x="48" y="110" font-family="monospace" font-size="11" font-weight="700" fill="#1B2A41">FAM  NAME</text>
  <text x="275" y="110" font-family="monospace" font-size="11" font-weight="700" fill="#1B2A41">AGE  SEX  OCCUPATION</text>
  <text x="490" y="110" font-family="monospace" font-size="11" font-weight="700" fill="#1B2A41">BIRTHPLACE</text>
  <rect x="36" y="128" width="568" height="116" fill="#F3E4C8" opacity="0.45"/>
  <text x="48" y="156" font-family="Georgia, serif" font-size="15" fill="#23272E">375   Abraham Lincoln</text>
  <text x="275" y="156" font-family="monospace" font-size="13" fill="#23272E">41   M    Lawyer ($3,000)</text>
  <text x="490" y="156" font-family="Georgia, serif" font-size="14" fill="#23272E">Kentucky</text>
  <line x1="36" y1="170" x2="604" y2="170" stroke="#D6CEBE" stroke-width="1"/>
  <text x="48" y="196" font-family="Georgia, serif" font-size="15" fill="#23272E">375   Mary Lincoln</text>
  <text x="275" y="196" font-family="monospace" font-size="13" fill="#23272E">28   F    —</text>
  <text x="490" y="196" font-family="Georgia, serif" font-size="14" fill="#23272E">Kentucky</text>
  <line x1="36" y1="210" x2="604" y2="210" stroke="#D6CEBE" stroke-width="1"/>
  <text x="48" y="236" font-family="Georgia, serif" font-size="15" fill="#23272E">375   Robert Lincoln</text>
  <text x="275" y="236" font-family="monospace" font-size="13" fill="#23272E">7    M    Attended school</text>
  <text x="490" y="236" font-family="Georgia, serif" font-size="14" fill="#23272E">Illinois</text>
  <line x1="36" y1="252" x2="604" y2="252" stroke="#D6CEBE" stroke-width="1"/>
  <text x="48" y="280" font-family="Georgia, serif" font-size="15" fill="#4E4A42">375   Catherine Gordon</text>
  <text x="275" y="280" font-family="monospace" font-size="13" fill="#4E4A42">18   F    Household</text>
  <text x="490" y="280" font-family="Georgia, serif" font-size="14" fill="#4E4A42">Ireland</text>
  <text x="320" y="388" text-anchor="middle" font-family="monospace" font-size="11" fill="#7A4612">PUBLIC-DOMAIN DEMO ARCHIVAL PLATE · KINLOOM</text>
</svg>
`;
}

function makeSpringfieldPlateSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 320" width="560" height="320" role="img" aria-label="Eighth Street Residence Springfield Illinois">
  <rect width="560" height="320" fill="#F5EFE2"/>
  <rect x="14" y="14" width="532" height="292" fill="#FCF9F2" stroke="#D6CEBE" stroke-width="1.5"/>
  <line x1="56" y1="240" x2="504" y2="240" stroke="#4E4A42" stroke-width="2"/>
  <polygon points="120,140 280,68 440,140" fill="#EAE1CE" stroke="#1B2A41" stroke-width="2"/>
  <rect x="136" y="140" width="288" height="100" fill="#F5EFE2" stroke="#1B2A41" stroke-width="2"/>
  <rect x="260" y="182" width="40" height="58" fill="#7A4612" opacity="0.28" stroke="#1B2A41" stroke-width="1.5"/>
  <rect x="166" y="160" width="32" height="42" fill="#FCF9F2" stroke="#1B2A41" stroke-width="1.5"/>
  <rect x="214" y="160" width="32" height="42" fill="#FCF9F2" stroke="#1B2A41" stroke-width="1.5"/>
  <rect x="314" y="160" width="32" height="42" fill="#FCF9F2" stroke="#1B2A41" stroke-width="1.5"/>
  <rect x="362" y="160" width="32" height="42" fill="#FCF9F2" stroke="#1B2A41" stroke-width="1.5"/>
  <text x="280" y="274" text-anchor="middle" font-family="Georgia, serif" font-size="16" font-weight="700" fill="#1B2A41">Eighth &amp; Jackson Streets · Springfield, Illinois</text>
  <text x="280" y="294" text-anchor="middle" font-family="monospace" font-size="11" fill="#4E4A42">Lincoln Residence (1844–1861) · Archival Line Plate</text>
</svg>
`;
}

// 1. Write self-hosted SVG archival plates
const mediaPlates = {
  'portrait-abraham-lincoln.svg': makePortraitSvg('AL', 'Abraham Lincoln', '1809 — 1865', '#1B2A41'),
  'portrait-mary-todd.svg': makePortraitSvg('MT', 'Mary Ann Todd', '1818 — 1882', '#7A4612'),
  'portrait-thomas-lincoln.svg': makePortraitSvg('TL', 'Thomas Lincoln', '1778 — 1851', '#2F5245'),
  'portrait-robert-todd-lincoln.svg': makePortraitSvg('RL', 'Robert Todd Lincoln', '1843 — 1926', '#1D4E89'),
  'headstone-oak-ridge-tomb.svg': makeHeadstoneSvg(),
  'scan-census-1850.svg': makeCensusScanSvg(),
  'plate-springfield-home.svg': makeSpringfieldPlateSvg(),
};

for (const [filename, svg] of Object.entries(mediaPlates)) {
  fs.writeFileSync(path.join(publicMediaDir, filename), svg, 'utf8');
}

// 2. Copy canonical Kinloom favicon from repo brand/
fs.copyFileSync(
  path.join(repoRoot, 'brand', 'favicon.svg'),
  path.join(publicDir, 'favicon.svg'),
);

// 3. Parse YAML inputs via @kinloom/core and compile archive.json
const siteConfig = parseKinloomConfigYaml(readText('kinloom.config.yaml'));
const people = parsePeopleYaml(readText('people.yaml'));
const places = parsePlacesYaml(readText('places.yaml'));
const sources = parseSourcesYaml(readText('sources.yaml'));
const kinship = parseKinshipYaml(readText('kinship.yaml'));
const events = parseEventsYaml(readText('events.yaml'));
const media = parseMediaYaml(readText('media.yaml'));
const narratives = parseNarrativesYaml(readText('narratives.yaml'));

const { bundle, reviewFlags } = compileArchive({
  people,
  events,
  places,
  sources,
  kinship,
  media,
  narratives,
  siteConfig,
  mode: 'public',
  version: '0.1.0-demo',
  generatedAt: '2026-11-24T00:00:00.000Z',
  mediaExists: (fileUrl) => {
    if (!fileUrl.startsWith('/media/')) {
      return true;
    }
    return fs.existsSync(path.join(publicDir, fileUrl.slice(1)));
  },
});

fs.writeFileSync(
  path.join(publicDataDir, 'archive.json'),
  `${JSON.stringify(bundle, null, 2)}\n`,
  'utf8',
);

fs.copyFileSync(
  path.join(dataDir, 'readings.json'),
  path.join(publicDataDir, 'readings.json'),
);

fs.writeFileSync(
  path.join(generatedDir, 'siteConfig.ts'),
  `import type { KinloomSiteConfig } from '@kinloom/core';\n\nexport const demoSiteConfig: KinloomSiteConfig = ${JSON.stringify(siteConfig, null, 2)};\n`,
  'utf8',
);

console.log(
  `Built demo archive: ${bundle.meta.counts.people} people (${bundle.meta.counts.living_redacted} living redacted), ${bundle.meta.counts.events} events, ${bundle.meta.counts.residence_spans} residence spans, ${bundle.meta.counts.places} places, ${bundle.meta.counts.sources} sources, ${bundle.meta.counts.media ?? 0} media, ${bundle.meta.counts.narratives ?? 0} narratives (${reviewFlags.length} review flags).`,
);
