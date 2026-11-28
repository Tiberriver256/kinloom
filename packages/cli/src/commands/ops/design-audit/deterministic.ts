import fs from 'node:fs';
import path from 'node:path';
import { calcApcaLc, calcWcag2Contrast, parseCssRgbTuple } from './apca.js';
import { DESIGN_AUDIT_INVARIANTS, resolveDesignAuditArchetype } from './archetypes.js';
import type {
  DesignAuditCaptureRecord,
  DesignAuditDisplayTextSample,
  DesignAuditFinding,
  DesignAuditManifest,
  DesignAuditTelemetry,
} from './types.js';

export function evaluateCaptureTelemetry(
  cap: DesignAuditCaptureRecord,
  tel: DesignAuditTelemetry,
  findings: DesignAuditFinding[]
): void {
  const arch = resolveDesignAuditArchetype(cap.archetype).metrics;
  const inv = DESIGN_AUDIT_INVARIANTS;

  // Metric 01: Above-the-fold yield & firstContentY placement
  if (
    cap.uiState === 'ideal' &&
    tel.aboveFoldMainRatio > 0 &&
    tel.aboveFoldMainRatio < arch.aboveFoldContentMinRatio
  ) {
    findings.push({
      ruleId: 'DA-01-LOW-ABOVE-FOLD-YIELD',
      metricId: '01',
      pillar: 'I',
      provenance: 'deterministic',
      severity: 'warning',
      confidence: 1.0,
      route: cap.route,
      viewport: cap.viewport,
      theme: cap.theme,
      uiState: cap.uiState,
      message: `Above-the-fold <main> yield is ${(tel.aboveFoldMainRatio * 100).toFixed(1)}%, below ${(arch.aboveFoldContentMinRatio * 100).toFixed(0)}% archetype floor.`,
      measuredValue: tel.aboveFoldMainRatio,
      thresholdValue: arch.aboveFoldContentMinRatio,
      evidence: { screenshotUri: cap.screenshotUri, pairwiseVerdict: 'n/a' },
      masterCitations: ['Luke Wroblewski — Mobile First', 'Jakob Nielsen — Scrolling and Attention'],
      remediationHint:
        'Collapse stacked header/filter chrome or shorten hero intro height so primary content owns the first screen.',
    });
  }

  if (
    cap.uiState === 'ideal' &&
    typeof tel.firstContentY === 'number' &&
    Number.isFinite(tel.firstContentY) &&
    tel.firstContentY > arch.maxFirstContentYPx
  ) {
    const yieldPct =
      typeof tel.aboveFoldContentYieldRatio === 'number' && Number.isFinite(tel.aboveFoldContentYieldRatio)
        ? ` (content-to-chrome yield ${(tel.aboveFoldContentYieldRatio * 100).toFixed(1)}%)`
        : '';
    findings.push({
      ruleId: 'DA-01-ABOVE-THE-FOLD-YIELD',
      metricId: '01',
      pillar: 'I',
      provenance: 'deterministic',
      severity: 'warning',
      confidence: 1.0,
      route: cap.route,
      viewport: cap.viewport,
      theme: cap.theme,
      uiState: cap.uiState,
      message: `Primary content starts at y=${tel.firstContentY}px, exceeding the ${arch.maxFirstContentYPx}px ${cap.archetype} firstContentY cap${yieldPct}.`,
      measuredValue: tel.firstContentY,
      thresholdValue: arch.maxFirstContentYPx,
      ...(tel.firstContentSelector ? { physicalLocation: { selector: tel.firstContentSelector } } : {}),
      evidence: { screenshotUri: cap.screenshotUri, pairwiseVerdict: 'n/a' },
      masterCitations: ['Luke Wroblewski — Mobile First', 'Jakob Nielsen — Scrolling and Attention'],
      remediationHint:
        'Reduce top chrome, hero padding, or stacked filter bars so primary content starts above the archetype firstContentY threshold.',
    });
  }

  // Metric 02: Top-level nav saturation
  if (cap.uiState === 'ideal' && tel.navLinkCount > arch.maxTopLevelNavLinks) {
    findings.push({
      ruleId: 'DA-02-NAV-OVERFLOW',
      metricId: '02',
      pillar: 'I',
      provenance: 'deterministic',
      severity: 'warning',
      confidence: 1.0,
      route: cap.route,
      viewport: cap.viewport,
      theme: cap.theme,
      uiState: cap.uiState,
      message: `Detected ${tel.navLinkCount} top-level navigation links (archetype cap: ${arch.maxTopLevelNavLinks}).`,
      measuredValue: tel.navLinkCount,
      thresholdValue: arch.maxTopLevelNavLinks,
      evidence: { screenshotUri: cap.screenshotUri, pairwiseVerdict: 'n/a' },
      masterCitations: ['Abby Covert — How to Make Sense of Any Mess', 'Jon Yablonski — Hick Law'],
      remediationHint: 'Group secondary destinations or move to a collapsible sidebar rail.',
    });
  }

  // Metric 10: Horizontal overflow (WCAG 1.4.10 Reflow)
  if (tel.docOverflowX > 1) {
    findings.push({
      ruleId: 'DA-10-HORIZONTAL-OVERFLOW',
      metricId: '10',
      pillar: 'IV',
      provenance: 'deterministic',
      severity: 'error',
      confidence: 1.0,
      route: cap.route,
      viewport: cap.viewport,
      theme: cap.theme,
      uiState: cap.uiState,
      message: `Horizontal overflow of ${tel.docOverflowX}px breaks WCAG 1.4.10 Reflow at ${cap.viewport}.`,
      measuredValue: tel.docOverflowX,
      thresholdValue: 0,
      evidence: { screenshotUri: cap.screenshotUri, pairwiseVerdict: 'n/a' },
      masterCitations: ['Steven Hoober — Mobile Ergonomics', 'WCAG 2.2 SC 1.4.10 Reflow'],
      remediationHint: 'Replace fixed widths with min(100%, ...) or overflow-x: auto scroll-snap containers.',
    });
  }

  if (tel.h1Truncated) {
    findings.push({
      ruleId: 'DA-10-H1-TRUNCATED',
      metricId: '10',
      pillar: 'IV',
      provenance: 'deterministic',
      severity: 'warning',
      confidence: 1.0,
      route: cap.route,
      viewport: cap.viewport,
      theme: cap.theme,
      uiState: cap.uiState,
      message: `Primary <h1> title "${tel.h1Text.slice(0, 40)}" clips horizontally at ${cap.viewport}.`,
      measuredValue: tel.h1Text,
      thresholdValue: 'zero-clipping',
      evidence: {
        screenshotUri: cap.screenshotUri,
        boundingBoxPx: tel.h1Rect ?? undefined,
        pairwiseVerdict: 'n/a',
      },
      masterCitations: ['Steven Hoober — Design for Fingers', 'Brad Frost — Atomic Design'],
      remediationHint: 'Use fluid clamp() heading sizing or drop redundant site prefixes from <h1>.',
    });
  }

  if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/i.test(tel.viewportMeta)) {
    findings.push({
      ruleId: 'DA-10-PINCH-ZOOM-DISABLED',
      metricId: '10',
      pillar: 'IV',
      provenance: 'deterministic',
      severity: 'error',
      confidence: 1.0,
      route: cap.route,
      viewport: cap.viewport,
      theme: cap.theme,
      uiState: cap.uiState,
      message: `Viewport meta suppresses pinch-to-zoom ("${tel.viewportMeta}").`,
      measuredValue: tel.viewportMeta,
      thresholdValue: 'allow-zoom',
      evidence: { screenshotUri: cap.screenshotUri, pairwiseVerdict: 'n/a' },
      masterCitations: ['Josh Clark — Designing for Touch', 'WCAG 2.2 SC 1.4.4 Resize Text'],
      remediationHint:
        'Remove user-scalable=no and maximum-scale=1; use CSS touch-action: manipulation instead.',
    });
  }

  // Metric 10: Touch target size floor (mobile viewports)
  if (cap.viewport.startsWith('360x') || cap.viewport.startsWith('390x') || cap.viewport.startsWith('393x')) {
    const tiny = tel.interactives.filter(
      (el) => el.rect[2] < inv.touchTarget.wcag22LegalMinPx || el.rect[3] < inv.touchTarget.wcag22LegalMinPx
    );
    if (tiny.length > 0) {
      const sample = tiny[0];
      if (sample)
        findings.push({
          ruleId: 'DA-10-TOUCH-TARGET-BELOW-24PX',
          metricId: '10',
          pillar: 'IV',
          provenance: 'deterministic',
          severity: 'error',
          confidence: 1.0,
          route: cap.route,
          viewport: cap.viewport,
          theme: cap.theme,
          uiState: cap.uiState,
          message: `${tiny.length} interactive controls fall below the 24x24px WCAG 2.2 AA minimum (sample: "${sample.text || sample.tag}").`,
          measuredValue: `${sample.rect[2]}x${sample.rect[3]}`,
          thresholdValue: '24x24 (44x44 recommended)',
          evidence: { screenshotUri: cap.screenshotUri, boundingBoxPx: sample.rect, pairwiseVerdict: 'n/a' },
          masterCitations: ['Steven Hoober — Design for Fingers', 'WCAG 2.2 SC 2.5.8 Target Size'],
          remediationHint:
            'Expand interactive hit areas to at least 44x44px with >= 8px gap between adjacent controls.',
        });
    }
  }

  // Metric 07: Focus occlusion & missing focus indicator
  for (const fi of tel.focusIssues ?? []) {
    findings.push({
      ruleId: fi.type === 'focus-occluded' ? 'DA-07-FOCUS-OCCLUDED' : 'DA-07-FOCUS-INDICATOR-MISSING',
      metricId: '07',
      pillar: 'III',
      provenance: 'deterministic',
      severity: 'error',
      confidence: 1.0,
      route: cap.route,
      viewport: cap.viewport,
      theme: cap.theme,
      uiState: 'focus',
      message:
        fi.type === 'focus-occluded'
          ? `Focused control "${fi.target}" is occluded by sticky/fixed <${fi.occluder ?? 'chrome'}> (WCAG 2.4.11).`
          : `Focused control "${fi.target}" has no visible outline or focus ring (WCAG 2.4.13).`,
      evidence: {
        screenshotUri: cap.screenshotUri,
        boundingBoxPx: [fi.rect[0], fi.rect[1], fi.rect[2] - fi.rect[0], fi.rect[3] - fi.rect[1]],
        pairwiseVerdict: 'n/a',
      },
      masterCitations: ['Don Norman — Signifiers', 'WCAG 2.2 SC 2.4.11 / 2.4.13'],
      remediationHint:
        'Add scroll-margin-top matching sticky bar height and provide a >= 2px :focus-visible ring with >= 3:1 contrast.',
    });
  }

  // Metric 05: Text spacing clipping (WCAG 1.4.12)
  if (tel.textSpacingClipped && tel.textSpacingClipped.length > 0) {
    const sample = tel.textSpacingClipped[0];
    if (sample)
      findings.push({
        ruleId: 'DA-05-TEXT-SPACING-CLIP',
        metricId: '05',
        pillar: 'II',
        provenance: 'deterministic',
        severity: 'error',
        confidence: 1.0,
        route: cap.route,
        viewport: cap.viewport,
        theme: cap.theme,
        uiState: 'text-spacing',
        message: `${tel.textSpacingClipped.length} text elements clip when WCAG 1.4.12 text-spacing overrides are applied.`,
        measuredValue: tel.textSpacingClipped.length,
        thresholdValue: 0,
        evidence: {
          screenshotUri: cap.screenshotUri,
          boundingBoxPx: sample.rect,
          pairwiseVerdict: 'n/a',
        },
        masterCitations: ['Matthew Butterick — Practical Typography', 'WCAG 2.2 SC 1.4.12 Text Spacing'],
        remediationHint:
          'Replace fixed container height + overflow: hidden with min-height so enlarged text expands cleanly.',
      });
  }

  // Metric 09: APCA Perceptual Contrast + Dark Mode Halation + WCAG 2 check
  let contrastViolations = 0;
  let halationViolations = 0;
  let firstContrastSample: (DesignAuditDisplayTextSample & { absLc: number; wcagRatio: number }) | null =
    null;
  let worstHalationSample: (DesignAuditDisplayTextSample & { absLc: number }) | null = null;

  const seenTextSampleKeys = new Set<string>();
  const combinedSamples: readonly DesignAuditDisplayTextSample[] = [
    ...tel.textSamples,
    ...(tel.displayTextSamples ?? []),
  ];

  for (const s of combinedSamples) {
    const key = `${s.tag}|${s.text}|${s.rect[0]},${s.rect[1]},${s.rect[2]},${s.rect[3]}`;
    if (seenTextSampleKeys.has(key)) {
      continue;
    }
    seenTextSampleKeys.add(key);
    const fg = parseCssRgbTuple(s.color);
    const bg = parseCssRgbTuple(s.backgroundColor);
    if (!fg || !bg) {
      continue;
    }
    const absLc = Math.abs(calcApcaLc(fg, bg));
    const isLarge = s.fontSizePx >= inv.apca.darkModeLargeTextMinPx;
    const minLc = isLarge ? inv.apca.largeHeadlineMinimumLc : inv.apca.bodyMinimumLc;
    const wcagRatio = calcWcag2Contrast(fg, bg);

    if (absLc < minLc || wcagRatio < (isLarge ? 3.0 : 4.5)) {
      contrastViolations += 1;
      if (!firstContrastSample) {
        firstContrastSample = {
          tag: s.tag,
          text: s.text,
          fontSizePx: s.fontSizePx,
          fontWeight: s.fontWeight,
          color: s.color,
          backgroundColor: s.backgroundColor,
          rect: s.rect,
          absLc: Number(absLc.toFixed(1)),
          wcagRatio: Number(wcagRatio.toFixed(2)),
        };
      }
    }

    if (cap.theme === 'dark' && isLarge && absLc > inv.apca.darkModeLargeTextMaxLc) {
      halationViolations += 1;
      const roundedLc = Number(absLc.toFixed(1));
      if (!worstHalationSample || roundedLc > worstHalationSample.absLc) {
        worstHalationSample = {
          tag: s.tag,
          text: s.text,
          fontSizePx: s.fontSizePx,
          fontWeight: s.fontWeight,
          color: s.color,
          backgroundColor: s.backgroundColor,
          rect: s.rect,
          absLc: roundedLc,
        };
      }
    }
  }

  if (contrastViolations > 0 && firstContrastSample) {
    findings.push({
      ruleId: 'DA-09-CONTRAST-BELOW-FLOOR',
      metricId: '09',
      pillar: 'III',
      provenance: 'deterministic',
      severity: 'error',
      confidence: 1.0,
      route: cap.route,
      viewport: cap.viewport,
      theme: cap.theme,
      uiState: cap.uiState,
      message: `${contrastViolations} text nodes fell below APCA/WCAG contrast floors (sample "${firstContrastSample.text.slice(0, 32)}": Lc ${firstContrastSample.absLc}, WCAG ${firstContrastSample.wcagRatio}:1).`,
      measuredValue: `Lc ${firstContrastSample.absLc} / ${firstContrastSample.wcagRatio}:1`,
      thresholdValue: 'Body >= Lc 75 & 4.5:1; Large >= Lc 45 & 3:1 (APCA public-beta WCAG 3 candidate)',
      evidence: {
        screenshotUri: cap.screenshotUri,
        boundingBoxPx: firstContrastSample.rect,
        pairwiseVerdict: 'n/a',
      },
      masterCitations: ['Andrew Somers — Why APCA?', 'Steve Schoger & Adam Wathan — Refactoring UI'],
      remediationHint: 'Adjust semantic foreground/surface tokens independently for light and dark modes.',
    });
  }

  if (halationViolations > 0 && worstHalationSample) {
    findings.push({
      ruleId: 'DA-09-DARK-HALATION',
      metricId: '09',
      pillar: 'III',
      provenance: 'deterministic',
      severity: 'warning',
      confidence: 1.0,
      route: cap.route,
      viewport: cap.viewport,
      theme: cap.theme,
      uiState: cap.uiState,
      message: `${halationViolations} large dark-mode display text nodes (>= ${inv.apca.darkModeLargeTextMinPx}px) exceed APCA |Lc| ${inv.apca.darkModeLargeTextMaxLc} (worst "${worstHalationSample.text.slice(0, 32)}" at ${worstHalationSample.fontSizePx}px: |Lc| ${worstHalationSample.absLc}), risking halation fatigue.`,
      measuredValue: worstHalationSample.absLc,
      thresholdValue: `<= Lc ${inv.apca.darkModeLargeTextMaxLc}`,
      evidence: {
        screenshotUri: cap.screenshotUri,
        boundingBoxPx: worstHalationSample.rect,
        pairwiseVerdict: 'n/a',
      },
      masterCitations: ['Andrew Somers — Realities and Myths of Contrast'],
      remediationHint: 'Soften dark-mode display ink from pure #FFFFFF to a warm/cool off-white token.',
    });
  }
}

export function evaluateBundleDeterministic(
  manifest: DesignAuditManifest,
  bundleDir: string
): DesignAuditFinding[] {
  const findings: DesignAuditFinding[] = [];

  for (const cap of manifest.captures) {
    if (cap.uiState === 'reduced-motion' && (cap.runningAnimationsUnderReducedMotion ?? 0) > 0) {
      findings.push({
        ruleId: 'DA-12-REDUCED-MOTION-ACTIVE',
        metricId: '12',
        pillar: 'IV',
        provenance: 'deterministic',
        severity: 'error',
        confidence: 1.0,
        route: cap.route,
        viewport: cap.viewport,
        theme: cap.theme,
        uiState: 'reduced-motion',
        message: `${cap.runningAnimationsUnderReducedMotion} animations remained running under prefers-reduced-motion: reduce.`,
        measuredValue: cap.runningAnimationsUnderReducedMotion,
        thresholdValue: 0,
        evidence: { screenshotUri: cap.screenshotUri, pairwiseVerdict: 'n/a' },
        masterCitations: ['Val Head — Reduced Motion In The Wild'],
        remediationHint:
          'Wrap spatial animations in @media (prefers-reduced-motion: no-preference) and fall back to opacity cross-fades.',
      });
      continue;
    }

    if (!cap.telemetryUri) {
      continue;
    }
    const telemetryPath = path.join(bundleDir, cap.telemetryUri);
    if (!fs.existsSync(telemetryPath)) {
      continue;
    }
    const tel = JSON.parse(fs.readFileSync(telemetryPath, 'utf8')) as DesignAuditTelemetry;
    evaluateCaptureTelemetry(cap, tel, findings);
  }

  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'track-a-deterministic.json'), JSON.stringify(findings, null, 2));
  return findings;
}
