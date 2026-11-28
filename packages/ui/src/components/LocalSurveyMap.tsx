import type { Place } from '@kinloom/core';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { cx as cls } from '../lib/cx.js';
import {
  computeCenterLabelPlacement,
  computeEdgeBadgeLayouts,
  computeSurveyLabelLayout,
  projectAdaptiveSurveyPlaces,
  type SurveyBox,
} from '../lib/surveyMapLayout.js';
import surveyMapStyles from './LocalSurveyMap.module.css';

export interface LocalSurveyMapProps {
  center: Place;
  allPlaces: Place[];
  scopeMode?: 'exact' | 'radius15' | 'county';
  compact?: boolean;
  excludeIds?: Set<string>;
}

const MIN_SVG_HIT_RADIUS = 12; // 24x24px WCAG 2.2 AA minimum target size
const MIN_INTERACTIVE_PIN_SEPARATION = MIN_SVG_HIT_RADIUS * 2 + 8; // >= 24px target + >= 8px spacing

function abbreviateSurveyLabel(text: string): string {
  return text.replace(/\bCounty\b/g, 'Co.');
}

export const LocalSurveyMap: React.FC<LocalSurveyMapProps> = ({
  center,
  allPlaces,
  scopeMode = 'radius15',
  compact = false,
  excludeIds,
}) => {
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [isNarrow, setIsNarrow] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth <= 480
  );

  useEffect(() => {
    if (compact || typeof window === 'undefined') {
      return undefined;
    }
    const el = wrapRef.current;
    const update = (): void => {
      const measured = el ? el.getBoundingClientRect().width : window.innerWidth;
      if (measured > 0) {
        setIsNarrow(measured <= 480);
      }
    };
    update();
    if (typeof ResizeObserver === 'undefined' || !el) {
      window.addEventListener('resize', update);
      return (): void => {
        window.removeEventListener('resize', update);
      };
    }
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return (): void => {
      observer.disconnect();
    };
  }, [compact]);

  const width = compact ? 280 : isNarrow ? 360 : 720;
  const height = compact ? 116 : isNarrow ? 190 : 200;
  let nominalMaxRadiusMiles = 42;
  if (scopeMode === 'county') {
    nominalMaxRadiusMiles = 65;
  } else if (scopeMode === 'exact') {
    nominalMaxRadiusMiles = 28;
  }
  const highlightRadiusMiles = scopeMode === 'county' ? 35 : 15;

  const projection = useMemo(
    () =>
      projectAdaptiveSurveyPlaces({
        center,
        allPlaces,
        width,
        height,
        maxRadiusMiles: nominalMaxRadiusMiles,
        highlightRadiusMiles,
        limit: compact ? 6 : 12,
        maxEdgeIndicators: compact ? 2 : 4,
        excludeIds,
      }),
    [center, allPlaces, width, height, nominalMaxRadiusMiles, highlightRadiusMiles, compact, excludeIds]
  );

  const markers = projection.inBoundsMarkers;
  const edgeIndicators = projection.edgeIndicators;
  const effectiveMaxRadiusMiles = projection.effectiveMaxRadiusMiles;

  const cx = width / 2;
  const cy = height / 2;
  const usableH = height - 20;
  const radiusPx = Math.min(
    usableH * 0.44,
    (highlightRadiusMiles / Math.max(1, effectiveMaxRadiusMiles)) * (usableH / 2)
  );

  const compassBox = useMemo<SurveyBox>(() => ({ x1: width - 34, x2: width - 2, y1: 2, y2: 34 }), [width]);

  const edgeBadgeFontSize = compact ? 9.5 : isNarrow ? 9.5 : 10.5;
  const edgeBadgeLayouts = useMemo(
    () =>
      computeEdgeBadgeLayouts({
        edgeIndicators,
        width,
        height,
        fontSize: edgeBadgeFontSize,
        compassBox,
      }),
    [edgeIndicators, width, height, edgeBadgeFontSize, compassBox]
  );

  const edgeBadgeBoxes = useMemo(() => edgeBadgeLayouts.map((b) => b.box), [edgeBadgeLayouts]);

  const centerPlacement = useMemo(
    () =>
      computeCenterLabelPlacement({
        centerName: center.name,
        markers,
        edgeBadgeBoxes,
        compassBox,
        cx,
        cy,
        width,
        height,
        compact,
        isNarrow,
        scopeMode,
        radiusPx,
      }),
    [
      center.name,
      markers,
      edgeBadgeBoxes,
      compassBox,
      cx,
      cy,
      width,
      height,
      compact,
      isNarrow,
      scopeMode,
      radiusPx,
    ]
  );

  const labelPlacement = useMemo(
    () =>
      computeSurveyLabelLayout({
        markers,
        centerPlacement,
        edgeBadgeBoxes,
        compassBox,
        cx,
        cy,
        width,
        height,
        compact,
        isNarrow,
        scopeMode,
        radiusPx,
      }),
    [
      markers,
      centerPlacement,
      edgeBadgeBoxes,
      compassBox,
      cx,
      cy,
      width,
      height,
      compact,
      isNarrow,
      scopeMode,
      radiusPx,
    ]
  );

  // Enforce >= 8px spacing between 24x24px interactive SVG marker hit areas; crowded secondary pins
  // remain visible as decorative dots and fully navigable via the Nearby link strip below the map.
  const interactiveMarkerIds = useMemo(() => {
    const selected = new Set<string>();
    const acceptedPoints: { readonly x: number; readonly y: number }[] = [];
    for (const m of markers) {
      const tooClose = acceptedPoints.some(
        (pt) => Math.hypot(pt.x - m.x, pt.y - m.y) < MIN_INTERACTIVE_PIN_SEPARATION
      );
      if (!tooClose) {
        selected.add(m.place.id);
        acceptedPoints.push({ x: m.x, y: m.y });
      }
    }
    return selected;
  }, [markers]);

  const insideCount = markers.filter((m) => m.inRadius).length;
  const totalNeighborCount = markers.length + edgeIndicators.length;
  const scaleSuffix = projection.didAutoScale ? ` · scaled to ${effectiveMaxRadiusMiles} mi` : '';

  let scopeLabel = `15-mi radius · ${insideCount} inside${scaleSuffix}`;
  if (scopeMode === 'exact') {
    scopeLabel = `Exact parcel/town${scaleSuffix}`;
  } else if (scopeMode === 'county') {
    scopeLabel = `County corridor · ${totalNeighborCount} neighbors${scaleSuffix}`;
  }

  const placedEdgeIds = useMemo(
    () => new Set(edgeBadgeLayouts.map((b) => b.indicator.place.id)),
    [edgeBadgeLayouts]
  );

  const nearbyLinks = useMemo(() => {
    const items: { readonly place: Place; readonly distanceMiles: number }[] = [];
    const seen = new Set<string>();
    for (const m of markers) {
      if (interactiveMarkerIds.has(m.place.id)) {
        continue;
      }
      if (!seen.has(m.place.id)) {
        seen.add(m.place.id);
        items.push({ place: m.place, distanceMiles: m.distanceMiles });
      }
    }
    for (const ind of edgeIndicators) {
      if (placedEdgeIds.has(ind.place.id)) {
        continue;
      }
      if (!seen.has(ind.place.id)) {
        seen.add(ind.place.id);
        items.push({ place: ind.place, distanceMiles: ind.distanceMiles });
      }
    }
    return items.slice(0, 6);
  }, [markers, edgeIndicators, interactiveMarkerIds, placedEdgeIds]);

  return (
    <div ref={wrapRef} className={cls(surveyMapStyles, 'local-survey-wrap')}>
      <svg
        className={'local-survey-svg'}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{
          display: 'block',
          background: 'var(--surface-canvas)',
          border: '1px solid var(--border-decorative)',
          borderRadius: 'var(--radius-sm)',
        }}
        role="group"
        aria-label={`Geographic survey map centered on ${center.full_name} with ${totalNeighborCount} nearby archived places`}
      >
        {Array.from({ length: compact || isNarrow ? 3 : 5 }).map((_, i) => {
          const x = ((i + 1) / (compact || isNarrow ? 4 : 6)) * width;
          return (
            <line
              key={`vx-${x}`}
              x1={x}
              y1={0}
              x2={x}
              y2={height}
              stroke="var(--surface-muted)"
              strokeWidth="1"
            />
          );
        })}
        {Array.from({ length: compact ? 2 : 3 }).map((_, i) => {
          const y = ((i + 1) / (compact ? 3 : 4)) * height;
          return (
            <line
              key={`hz-${y}`}
              x1={0}
              y1={y}
              x2={width}
              y2={y}
              stroke="var(--surface-muted)"
              strokeWidth="1"
            />
          );
        })}

        <line x1={cx} y1={0} x2={cx} y2={height} stroke="var(--border-decorative)" strokeDasharray="3 3" />
        <line x1={0} y1={cy} x2={width} y2={cy} stroke="var(--border-decorative)" strokeDasharray="3 3" />

        {scopeMode === 'county' && (
          <rect
            x={cx - radiusPx * 1.45}
            y={cy - radiusPx}
            width={radiusPx * 2.9}
            height={radiusPx * 2}
            fill="var(--surface-survey-ring-fill)"
            stroke="var(--accent-secondary)"
            strokeWidth="1.4"
            strokeDasharray="6 4"
          />
        )}
        {scopeMode === 'radius15' && (
          <circle
            cx={cx}
            cy={cy}
            r={radiusPx}
            fill="var(--surface-survey-ring-fill)"
            stroke="var(--accent-secondary)"
            strokeWidth="1.4"
            strokeDasharray="5 3"
          />
        )}

        {/* Decorative radial spokes rendered outside interactive marker groups */}
        <g pointerEvents="none">
          {markers.map((m) => (
            <line
              key={`spoke-${m.place.id}`}
              x1={cx}
              y1={cy}
              x2={m.x}
              y2={m.y}
              stroke={m.inRadius ? 'var(--accent-primary)' : 'var(--border-control)'}
              strokeWidth={m.inRadius ? 1.1 : 0.75}
              strokeDasharray="2 3"
              opacity={0.7}
            />
          ))}
        </g>

        {markers.map((m) => {
          const lbl = labelPlacement.get(m.place.id);
          const isInteractive = interactiveMarkerIds.has(m.place.id);
          if (!isInteractive) {
            return (
              <g key={m.place.id} pointerEvents="none">
                <circle
                  cx={m.x}
                  cy={m.y}
                  r={compact ? 3.2 : 4.5}
                  fill={m.inRadius ? 'var(--accent-secondary)' : 'var(--surface-card)'}
                  stroke={m.inRadius ? 'var(--surface-card)' : 'var(--text-secondary)'}
                  strokeWidth="1.2"
                />
              </g>
            );
          }
          return (
            <g
              key={m.place.id}
              role="button"
              className={'survey-neighbor-pin'}
              tabIndex={0}
              aria-label={`${m.place.full_name}, ${m.distanceMiles} miles away`}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                void navigate(`/place/${m.place.slug}`);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void navigate(`/place/${m.place.slug}`);
                }
              }}
            >
              <title>{`${m.place.full_name} (${m.distanceMiles} mi) — Open Place Profile`}</title>
              <circle
                className={'survey-pin-hit-area'}
                cx={m.x}
                cy={m.y}
                r={MIN_SVG_HIT_RADIUS}
                fill="transparent"
              />
              {!compact && lbl?.leader && (
                <line
                  className={'survey-label-leader'}
                  x1={lbl.leader.x1}
                  y1={lbl.leader.y1}
                  x2={lbl.leader.x2}
                  y2={lbl.leader.y2}
                  stroke="var(--border-control)"
                  strokeWidth="0.8"
                  opacity={0.85}
                />
              )}
              <circle
                cx={m.x}
                cy={m.y}
                r={compact ? 3.2 : 4.5}
                fill={m.inRadius ? 'var(--accent-secondary)' : 'var(--surface-card)'}
                stroke={m.inRadius ? 'var(--surface-card)' : 'var(--text-secondary)'}
                strokeWidth="1.2"
              />
              {!compact && lbl && (
                <text
                  className={'survey-neighbor-label'}
                  x={lbl.lx}
                  y={lbl.ly}
                  textAnchor={lbl.anchor}
                  fontSize={isNarrow ? '10.5' : '11.5'}
                  fontFamily="var(--font-ui)"
                  fill={m.inRadius ? 'var(--surface-header)' : 'var(--text-secondary)'}
                  paintOrder="stroke"
                  stroke="var(--surface-canvas)"
                  strokeWidth="4"
                  strokeLinejoin="round"
                >
                  {abbreviateSurveyLabel(lbl.text)}
                </text>
              )}
            </g>
          );
        })}

        {edgeBadgeLayouts.map((badge) => (
          <g
            key={`edge-${badge.indicator.place.id}`}
            role="button"
            className={'survey-edge-badge'}
            tabIndex={0}
            aria-label={`${badge.indicator.place.full_name}, ${badge.indicator.distanceMiles} miles ${badge.indicator.cardinal}`}
            style={{ cursor: 'pointer' }}
            onClick={() => {
              void navigate(`/place/${badge.indicator.place.slug}`);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void navigate(`/place/${badge.indicator.place.slug}`);
              }
            }}
          >
            <title>{`${badge.indicator.place.full_name} (${badge.indicator.distanceMiles} mi ${badge.indicator.cardinal}) — Open Place Profile`}</title>
            <rect
              x={badge.rectX}
              y={badge.rectY}
              width={badge.rectW}
              height={badge.rectH}
              rx={4}
              fill="var(--surface-card)"
              stroke="var(--border-control)"
              strokeWidth="1"
            />
            <text
              x={badge.textX}
              y={badge.textY}
              fontSize={edgeBadgeFontSize}
              fontFamily="var(--font-ui)"
              fill="var(--surface-header)"
            >
              {abbreviateSurveyLabel(badge.text)}
            </text>
          </g>
        ))}

        <circle
          cx={cx}
          cy={cy}
          r={compact ? 5 : 6.5}
          fill="var(--accent-primary)"
          stroke="var(--surface-card)"
          strokeWidth="1.8"
        />
        <text
          className={'local-survey-center-label'}
          x={centerPlacement.x}
          y={centerPlacement.titleY}
          textAnchor={centerPlacement.anchor}
          fontSize={compact ? '11.5' : isNarrow ? '11.5' : '12'}
          fontWeight="700"
          fontFamily="var(--font-ui)"
          fill="var(--surface-header)"
          paintOrder="stroke"
          stroke="var(--surface-canvas)"
          strokeWidth="4"
          strokeLinejoin="round"
        >
          {abbreviateSurveyLabel(center.name)}
        </text>

        {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative SVG compass rose */}
        <g transform={`translate(${width - 18}, 16)`} aria-hidden="true">
          <path d="M 0 -7 L 3 2 L 0 0 L -3 2 Z" fill="var(--surface-header)" />
          <text
            x="0"
            y="10"
            textAnchor="middle"
            fontSize="7.5"
            fontWeight="700"
            fontFamily="var(--font-mono)"
            fill="var(--surface-header)"
          >
            N
          </text>
        </g>
      </svg>

      <div className={cls(surveyMapStyles, 'local-survey-caption')}>{scopeLabel}</div>

      {!compact && nearbyLinks.length > 0 && (
        <nav
          className={cls(surveyMapStyles, 'local-survey-nearby-strip')}
          aria-label={`Nearby places around ${center.name}`}
        >
          <span className={cls(surveyMapStyles, 'local-survey-nearby-label')}>Nearby:</span>
          {nearbyLinks.map((m) => (
            <Link
              key={m.place.id}
              to={`/place/${m.place.slug}`}
              className={cls(surveyMapStyles, 'local-survey-nearby-link')}
            >
              {m.place.name} ({m.distanceMiles} mi)
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
};
