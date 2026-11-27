import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockBookPublisherAdapter, inspectPdfPrepress } from '@kinloom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import { writeArchiveDataDir } from '../commands/dataFiles.js';
import { EXIT_OK, EXIT_USAGE } from '../errors.js';
import { BOOK_PUBLISHING_CLI_PLUGIN_ID, createBookPublishingCliPlugin } from './bookPublishing.js';
import { createPlaywrightPdfRenderer } from './bookPublishingPdf.js';

const tempDirs: string[] = [];

async function makeTempArchive(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-book-cli-'));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, 'kinloom.config.yaml'),
    [
      'schemaVersion: 1',
      'site:',
      '  title: Cedar Creek Family Archive',
      '  familyName: Cedar Family',
      '  gedcomSourceName: CEDAR_BOOK_CLI_TEST',
      'privacy:',
      '  livingCutoffYears: 101',
      '  referenceYear: 2026',
      '',
    ].join('\n'),
    'utf8'
  );
  await writeArchiveDataDir(path.join(dir, 'data'), {
    people: [
      {
        id: 'p-elias',
        slug: 'elias-cedar',
        full_name: 'Elias Cedar',
        given_name: 'Elias',
        surname: 'Cedar',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'direct',
        birth_edtf: '1835',
        death_edtf: '1908',
        portrait_url: null,
      },
      {
        id: 'p-living-casey',
        slug: 'casey-cedar',
        full_name: 'Casey LivingHidden Cedar',
        given_name: 'Casey',
        surname: 'Cedar',
        alt_names: [],
        sex: 'X',
        is_living: true,
        lineage_group: 'direct',
        birth_edtf: '1995',
        death_edtf: '',
        portrait_url: '/media/casey.jpg',
      },
    ],
    events: [
      {
        id: 'ev-1',
        title: 'Homestead Settlement',
        scope: 'personal',
        event_kind: 'point_event',
        edtf_date: '1865',
        place_id: 'pl-1',
        summary: 'Elias Cedar settled along Cedar Creek.',
        participants: [{ person_id: 'p-elias', role: 'subject' }],
        sources: [{ source_id: 'src-1', confidence: 'high' }],
      },
    ],
    places: [
      {
        id: 'pl-1',
        slug: 'cedar-creek',
        name: 'Cedar Creek',
        full_name: 'Cedar Creek, Iowa',
        place_type: 'town',
        parent_id: null,
        lat: 41.5868,
        lng: -93.625,
      },
    ],
    sources: [
      {
        id: 'src-1',
        citation: '1870 Iowa State Census, Cedar Creek Township.',
        source_type: 'census',
      },
    ],
    kinship: [{ from: 'p-elias', to: 'p-living-casey', relation: 'parent' }],
    media: [
      {
        id: 'med-living',
        kind: 'portrait',
        person_id: 'p-living-casey',
        file: 'media/casey-private.jpg',
        caption: 'Private living portrait of Casey LivingHidden Cedar',
      },
    ],
    narratives: [],
  });
  return dir;
}

function makeCaptureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    },
    out,
    err,
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('createBookPublishingCliPlugin (off-by-default CLI book publishing)', () => {
  it('stays completely absent from default CLI invocations and supports enabled:false no-op', async () => {
    const cap = makeCaptureIo();
    const exit = await runCli(['book', 'build'], { io: cap.io });
    expect(exit).toBe(EXIT_USAGE);
    expect(cap.err.join('\n')).toContain("Unknown command 'book'");

    const disabled = createBookPublishingCliPlugin({ enabled: false });
    expect(disabled.id).toBe(BOOK_PUBLISHING_CLI_PLUGIN_ID);
    expect(disabled.commands).toEqual([]);
  });

  it('builds print-ready landscape interior + cover PDFs with living redaction, then quotes, dry-run submits, and polls status', async () => {
    const repoDir = await makeTempArchive();
    const outDir = path.join(repoDir, 'dist-book');
    const addressPath = path.join(repoDir, 'shipping.json');
    await writeFile(
      addressPath,
      JSON.stringify({
        name: 'Avery Cedar',
        street1: '42 Oak Trail',
        city: 'Des Moines',
        stateCode: 'IA',
        countryCode: 'US',
        postalCode: '50309',
        phoneNumber: '+15555550199',
      }),
      'utf8'
    );

    const mockPublisher = createMockBookPublisherAdapter({ nowIso: () => '2026-11-27T12:00:00.000Z' });
    const plugin = createBookPublishingCliPlugin({
      publisherProvider: mockPublisher,
      nowIso: () => '2026-11-27T12:00:00.000Z',
    });

    // 1. Help
    const helpCap = makeCaptureIo();
    expect(await runCli(['book', '--help'], { cwd: repoDir, io: helpCap.io, plugins: [plugin] })).toBe(
      EXIT_OK
    );
    expect(helpCap.out.join('\n')).toContain('kinloom book');

    // 2. Build local PDFs & report
    const buildCap = makeCaptureIo();
    const buildExit = await runCli(['book', 'build', '--out', outDir, '--trim', 'a4-landscape', '--json'], {
      cwd: repoDir,
      io: buildCap.io,
      plugins: [plugin],
    });
    expect(buildExit).toBe(EXIT_OK);
    const buildJson = JSON.parse(buildCap.out.join('\n')) as {
      report: { counts: { includedPeople: number; excludedLivingPeople: number; finalPageCount: number } };
      pdfVerification: { interiorValid: boolean; interiorPages: number; coverValid: boolean };
    };
    expect(buildJson.report.counts.includedPeople).toBe(1);
    expect(buildJson.report.counts.excludedLivingPeople).toBe(1);
    expect(buildJson.report.counts.finalPageCount).toBe(24);
    expect(buildJson.pdfVerification.interiorValid).toBe(true);
    expect(buildJson.pdfVerification.interiorPages).toBe(24);
    expect(buildJson.pdfVerification.coverValid).toBe(true);

    // Inspect actual PDF bytes on disk for living-person redaction
    const interiorBytes = new Uint8Array(await readFile(path.join(outDir, 'interior.pdf')));
    const inspected = inspectPdfPrepress(interiorBytes);
    expect(inspected.rawText).toContain('Elias Cedar');
    expect(inspected.rawText).not.toContain('Casey LivingHidden Cedar');
    expect(inspected.rawText).not.toContain('casey-private.jpg');

    // 3. Quote
    const quoteCap = makeCaptureIo();
    const quoteExit = await runCli(
      ['book', 'quote', '--pages', '100', '--qty', '2', '--postal', '50309', '--country', 'US', '--json'],
      { cwd: repoDir, io: quoteCap.io, plugins: [plugin] }
    );
    expect(quoteExit).toBe(EXIT_OK);
    const quoteJson = JSON.parse(quoteCap.out.join('\n')) as { quote: { totalCostCents: number } };
    expect(quoteJson.quote.totalCostCents).toBeGreaterThan(0);

    // 4. Dry-run submit
    const dryCap = makeCaptureIo();
    const dryExit = await runCli(
      ['book', 'submit', '--dir', outDir, '--address-file', addressPath, '--dry-run', '--json'],
      { cwd: repoDir, io: dryCap.io, plugins: [plugin] }
    );
    expect(dryExit).toBe(EXIT_OK);
    const dryJson = JSON.parse(dryCap.out.join('\n')) as { dryRun: boolean };
    expect(dryJson.dryRun).toBe(true);

    // 5. Production without --confirm-production fails closed
    const prodBlockedCap = makeCaptureIo();
    const prodBlockedExit = await runCli(
      ['book', 'submit', '--dir', outDir, '--address-file', addressPath, '--production'],
      { cwd: repoDir, io: prodBlockedCap.io, plugins: [plugin] }
    );
    expect(prodBlockedExit).toBe(EXIT_USAGE);
    expect(prodBlockedCap.err.join('\n')).toContain('--confirm-production');

    // 6. Sandbox submit + status poll
    const submitCap = makeCaptureIo();
    const submitExit = await runCli(
      ['book', 'submit', '--dir', outDir, '--address-file', addressPath, '--sandbox', '--json'],
      { cwd: repoDir, io: submitCap.io, plugins: [plugin] }
    );
    expect(submitExit).toBe(EXIT_OK);
    const submitJson = JSON.parse(submitCap.out.join('\n')) as { job: { jobId: string } };
    expect(submitJson.job.jobId).toBe('mock-job-1');

    const statusCap = makeCaptureIo();
    const statusExit = await runCli(['book', 'status', '--job-id', submitJson.job.jobId, '--json'], {
      cwd: repoDir,
      io: statusCap.io,
      plugins: [plugin],
    });
    expect(statusExit).toBe(EXIT_OK);
    const statusJson = JSON.parse(statusCap.out.join('\n')) as { status: string };
    expect(statusJson.status).toBe('ready_for_production');
  });

  it('supports injectable Playwright PDF renderer without launching live Chromium', async () => {
    const repoDir = await makeTempArchive();
    const outDir = path.join(repoDir, 'dist-pw');
    const renderedWidths: string[] = [];

    const pwRenderer = createPlaywrightPdfRenderer({
      browserFactory: async () => ({
        async newPage() {
          return {
            async setContent() {},
            async pdf(opts) {
              renderedWidths.push(opts.width);
              return new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n');
            },
            async close() {},
          };
        },
        async close() {},
      }),
    });

    const plugin = createBookPublishingCliPlugin({
      pdfRenderer: pwRenderer,
      nowIso: () => '2026-11-27T12:00:00.000Z',
    });

    const cap = makeCaptureIo();
    const exit = await runCli(['book', 'build', '--out', outDir], {
      cwd: repoDir,
      io: cap.io,
      plugins: [plugin],
    });
    expect(exit).toBe(EXIT_OK);
    expect(renderedWidths).toHaveLength(2);
    expect(cap.out.join('\n')).toContain('Built archival landscape book');

    // Missing playwright module throws actionable error
    const missingPw = createPlaywrightPdfRenderer({
      importer: async () => {
        throw new Error('MODULE_NOT_FOUND');
      },
    });
    await expect(
      missingPw.renderInterior({
        report: {
          interiorGeometry: { bleedWidthIn: 11.25, bleedHeightIn: 8.75 },
        } as never,
        pages: [],
        indexEntries: [],
        interiorHtml: '<html></html>',
        coverHtml: '<html></html>',
      })
    ).rejects.toThrow(/playwright-core/);
  });
});
