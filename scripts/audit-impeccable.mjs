import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEMO_DIR = path.join(ROOT, 'examples', 'demo');

const STATIC_TARGETS = [
  'packages/ui/src',
  'packages/tokens',
  'examples/demo/src',
  'examples/demo/index.html',
];

const DEMO_ROUTES = [
  '/',
  '/tree',
  '/tree?surface=diagram',
  '/tree?surface=roll',
  '/tree?mode=full&surface=roll',
  '/places',
  '/time',
  '/map',
  '/evidence',
  '/kinship',
  '/changes',
  '/person/abraham-lincoln-1809',
  '/person/robert-todd-lincoln',
  '/place/springfield-illinois',
  '/place/hingham-massachusetts',
  '/does-not-exist',
];

const VIEWPORTS = ['1280x800', '390x844'];

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not determine ephemeral port')));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
    } catch {
      // Server still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for preview server at ${url}`);
}

function parseFindings(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = JSON.parse(trimmed);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (Array.isArray(parsed.findings)) {
    return parsed.findings;
  }
  return [];
}

function runImpeccableDetect(args, label) {
  const res = spawnSync('impeccable', ['detect', '--json', '--no-advisory', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (res.error) {
    throw new Error(`Failed to execute impeccable for ${label}: ${res.error.message}`);
  }
  if (res.status === 1) {
    throw new Error(`Impeccable scan errored for ${label} (exit 1):\n${res.stderr || res.stdout}`);
  }

  const findings = parseFindings(res.stdout).filter((f) => !f.advisory && f.severity !== 'advisory');
  return { status: res.status ?? 0, findings, stderr: res.stderr };
}

function getRuleId(finding) {
  return (
    finding.rule ||
    finding.ruleId ||
    finding.rule_id ||
    finding.pattern ||
    finding.check ||
    finding.type ||
    finding.id ||
    'unknown'
  );
}

function summarizeByRule(findings) {
  const counts = new Map();
  for (const f of findings) {
    const key = getRuleId(f);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

async function main() {
  const staticResult = runImpeccableDetect(STATIC_TARGETS, 'static source');
  console.log(
    `[impeccable] static source: ${staticResult.findings.length} primary finding(s)`,
    staticResult.findings.length > 0 ? JSON.stringify(summarizeByRule(staticResult.findings)) : ''
  );

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const preview = spawn(
    'npx',
    ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: DEMO_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let previewStderr = '';
  preview.stderr.on('data', (chunk) => {
    previewStderr += String(chunk);
  });

  let totalPrimary = staticResult.findings.length;
  const allFindings = [...staticResult.findings];

  try {
    await waitForServer(`${baseUrl}/`);
    const urls = DEMO_ROUTES.map((route) => `${baseUrl}${route}`);

    for (const viewport of VIEWPORTS) {
      const liveResult = runImpeccableDetect(['--viewport', viewport, ...urls], `live ${viewport}`);
      totalPrimary += liveResult.findings.length;
      allFindings.push(...liveResult.findings);
      console.log(
        `[impeccable] live ${viewport} (${urls.length} routes): ${liveResult.findings.length} primary finding(s)`,
        liveResult.findings.length > 0 ? JSON.stringify(summarizeByRule(liveResult.findings)) : ''
      );
    }
  } finally {
    preview.kill('SIGTERM');
    await new Promise((resolve) => {
      preview.once('exit', resolve);
      setTimeout(() => {
        if (!preview.killed) {
          preview.kill('SIGKILL');
        }
        resolve();
      }, 2000);
    });
  }

  if (totalPrimary > 0) {
    console.error('\nImpeccable audit FAILED with primary findings:');
    for (const f of allFindings) {
      const rule = getRuleId(f);
      const target = f.file || f.url || f.target || '';
      const detail = f.message || f.snippet || f.selector || '';
      console.error(`  - [${rule}] ${target} ${detail}`.trim());
    }
    if (previewStderr.trim()) {
      console.error('\nPreview server stderr:\n' + previewStderr.trim());
    }
    process.exit(1);
  }

  console.log('[impeccable] PASS: 0 primary findings across static source and live desktop/mobile routes.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
