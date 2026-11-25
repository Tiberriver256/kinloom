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

function isValidRasterImage(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, header, 0, 12, 0);
    if (bytesRead < 4) {
      return false;
    }
    const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const isPng =
      header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
    const isGif = header.subarray(0, 4).toString('ascii') === 'GIF8';
    const isWebp =
      bytesRead >= 12 &&
      header.subarray(0, 4).toString('ascii') === 'RIFF' &&
      header.subarray(8, 12).toString('ascii') === 'WEBP';
    return isJpeg || isPng || isGif || isWebp;
  } finally {
    fs.closeSync(fd);
  }
}

function verifyAllReferencedMedia(bundle, readings) {
  const refs = new Set();
  for (const person of bundle.people) {
    if (person.portrait_url) {
      refs.add(person.portrait_url);
    }
  }
  for (const place of bundle.places) {
    if (place.photo_url) {
      refs.add(place.photo_url);
    }
  }
  for (const ev of bundle.events) {
    if (ev.photo_url) {
      refs.add(ev.photo_url);
    }
    for (const src of ev.sources ?? []) {
      if (src.scan_url) {
        refs.add(src.scan_url);
      }
    }
  }
  for (const item of bundle.media ?? []) {
    if (item.file) {
      refs.add(item.file);
    }
  }
  for (const doc of Object.values(readings.documents ?? {})) {
    for (const page of doc.pages ?? []) {
      if (page.image_url) {
        refs.add(page.image_url);
      }
    }
  }

  const broken = [];
  for (const url of refs) {
    if (!url.startsWith('/media/')) {
      continue;
    }
    const absPath = path.join(publicDir, url.slice(1));
    if (!fs.existsSync(absPath)) {
      broken.push(`${url} (missing file)`);
      continue;
    }
    if (!isValidRasterImage(absPath)) {
      broken.push(`${url} (invalid image header)`);
    }
  }
  if (broken.length > 0) {
    throw new Error(`Broken or invalid demo media references:\n  - ${broken.join('\n  - ')}`);
  }
  return refs.size;
}

// 1. Copy canonical Kinloom favicon from repo brand/
fs.copyFileSync(
  path.join(repoRoot, 'brand', 'favicon.svg'),
  path.join(publicDir, 'favicon.svg'),
);

// 2. Parse YAML inputs via @kinloom/core and compile archive.json
const siteConfig = parseKinloomConfigYaml(readText('kinloom.config.yaml'));
const people = parsePeopleYaml(readText('people.yaml'));
const places = parsePlacesYaml(readText('places.yaml'));
const sources = parseSourcesYaml(readText('sources.yaml'));
const kinship = parseKinshipYaml(readText('kinship.yaml'));
const events = parseEventsYaml(readText('events.yaml'));
const media = parseMediaYaml(readText('media.yaml'));
const narratives = parseNarrativesYaml(readText('narratives.yaml'));
const readingsText = readText('readings.json');
const readings = JSON.parse(readingsText);

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
  version: '0.2.0-demo',
  generatedAt: '2026-11-24T00:00:00.000Z',
  mediaExists: (fileUrl) => {
    if (!fileUrl.startsWith('/media/')) {
      return true;
    }
    return fs.existsSync(path.join(publicDir, fileUrl.slice(1)));
  },
});

const verifiedMediaCount = verifyAllReferencedMedia(bundle, readings);

fs.writeFileSync(
  path.join(publicDataDir, 'archive.json'),
  `${JSON.stringify(bundle, null, 2)}\n`,
  'utf8',
);

fs.writeFileSync(path.join(publicDataDir, 'readings.json'), readingsText, 'utf8');

fs.writeFileSync(
  path.join(generatedDir, 'siteConfig.ts'),
  `import type { KinloomSiteConfig } from '@kinloom/core';\n\nexport const demoSiteConfig: KinloomSiteConfig = ${JSON.stringify(siteConfig, null, 2)};\n`,
  'utf8',
);

console.log(
  `Built demo archive: ${bundle.meta.counts.people} people (${bundle.meta.counts.living_redacted} living redacted), ${bundle.meta.counts.events} events, ${bundle.meta.counts.residence_spans} residence spans, ${bundle.meta.counts.places} places, ${bundle.meta.counts.sources} sources, ${bundle.meta.counts.media ?? 0} media (${verifiedMediaCount} verified raster assets), ${bundle.meta.counts.narratives ?? 0} narratives (${reviewFlags.length} review flags).`,
);
