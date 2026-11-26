import React, { useMemo } from 'react';
import type { Place } from '@kinloom/core';
import { projectNearbyPlaces } from '@kinloom/core';
import { useNavigate } from 'react-router-dom';

export interface LocalSurveyMapProps {
  center: Place;
  allPlaces: Place[];
  scopeMode?: 'exact' | 'radius15' | 'county';
  compact?: boolean;
  excludeIds?: Set<string>;
}

export const LocalSurveyMap: React.FC<LocalSurveyMapProps> = ({
  center,
  allPlaces,
  scopeMode = 'radius15',
  compact = false,
  excludeIds,
}) => {
  const navigate = useNavigate();
  const width = compact ? 280 : 720;
  const height = compact ? 116 : 200;
  let maxRadiusMiles = 42;
  if (scopeMode === 'county') {
    maxRadiusMiles = 65;
  } else if (scopeMode === 'exact') {
    maxRadiusMiles = 28;
  }
  const highlightRadiusMiles = scopeMode === 'county' ? 35 : 15;

  const markers = useMemo(
    () =>
      projectNearbyPlaces({
        center,
        allPlaces,
        width,
        height,
        maxRadiusMiles,
        highlightRadiusMiles,
        limit: compact ? 6 : 12,
        excludeIds,
      }),
    [center, allPlaces, width, height, maxRadiusMiles, highlightRadiusMiles, compact, excludeIds],
  );

  const cx = width / 2;
  const cy = height / 2;
  const usableH = height - 20;
  const radiusPx = Math.min(usableH * 0.44, (highlightRadiusMiles / maxRadiusMiles) * (usableH / 2));

  const labelPlacement = useMemo(() => {
    const map = new Map<string, { lx: number; ly: number; anchor: 'start' | 'end'; extraCount: number }>();
    if (compact) {
      return map;
    }

    const placed: { x1: number; x2: number; y1: number; y2: number }[] = [
      { x1: cx - 12, x2: cx + 175, y1: cy - 18, y2: cy + 20 },
    ];

    const clusterCounts = new Map<string, number>();
    const skippedIds = new Set<string>();
    for (let i = 0; i < markers.length; i += 1) {
      if (skippedIds.has(markers[i].place.id)) {
        continue;
      }
      let extras = 0;
      for (let j = i + 1; j < markers.length; j += 1) {
        if (Math.hypot(markers[i].x - markers[j].x, markers[i].y - markers[j].y) < 7) {
          skippedIds.add(markers[j].place.id);
          extras += 1;
        }
      }
      clusterCounts.set(markers[i].place.id, extras);
    }

    for (const m of markers) {
      if (skippedIds.has(m.place.id)) {
        continue;
      }
      const extras = clusterCounts.get(m.place.id) || 0;
      const textLen = (m.place.name.length + (extras > 0 ? 11 : 8)) * 5.6;

      const preferredRight = m.x >= cx;
      const candidates: { anchor: 'start' | 'end'; lx: number; ly: number }[] = [
        { anchor: preferredRight ? 'start' : 'end', lx: m.x + (preferredRight ? 8 : -8), ly: m.y + 3 },
        { anchor: preferredRight ? 'end' : 'start', lx: m.x + (preferredRight ? -8 : 8), ly: m.y + 3 },
        { anchor: preferredRight ? 'start' : 'end', lx: m.x + (preferredRight ? 8 : -8), ly: m.y - 10 },
        { anchor: preferredRight ? 'start' : 'end', lx: m.x + (preferredRight ? 8 : -8), ly: m.y + 15 },
      ];

      for (const c of candidates) {
        const x1 = c.anchor === 'start' ? c.lx : c.lx - textLen;
        const x2 = c.anchor === 'start' ? c.lx + textLen : c.lx;
        const y1 = c.ly - 10;
        const y2 = c.ly + 4;
        if (x1 < 6 || x2 > width - 26 || y1 < 6 || y2 > height - 4) {
          continue;
        }
        const overlaps = placed.some(
          (b) => !(x2 < b.x1 || x1 > b.x2 || y2 < b.y1 || y1 > b.y2),
        );
        if (!overlaps) {
          placed.push({ x1, x2, y1, y2 });
          map.set(m.place.id, { lx: c.lx, ly: c.ly, anchor: c.anchor, extraCount: extras });
          break;
        }
      }
    }
    return map;
  }, [markers, compact, cx, cy, width, height]);

  let scopeLabel = `15-mi radius · ${markers.filter((m) => m.inRadius).length} inside`;
  if (scopeMode === 'exact') {
    scopeLabel = 'Exact parcel/town';
  } else if (scopeMode === 'county') {
    scopeLabel = `County corridor · ${markers.length} neighbors`;
  }

  return (
    <svg
      className="local-survey-svg"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      style={{
        display: 'block',
        background: '#F4EFE3',
        border: '1px solid #D5CCB8',
        borderRadius: 2,
      }}
      role="img"
      aria-label={`Geographic survey map centered on ${center.full_name} with ${markers.length} nearby archived places`}
    >
      {Array.from({ length: compact ? 3 : 5 }).map((_, i) => {
        const x = ((i + 1) / (compact ? 4 : 6)) * width;
        return <line key={`vx-${x}`} x1={x} y1={0} x2={x} y2={height} stroke="#E2D9C5" strokeWidth="1" />;
      })}
      {Array.from({ length: compact ? 2 : 3 }).map((_, i) => {
        const y = ((i + 1) / (compact ? 3 : 4)) * height;
        return <line key={`hz-${y}`} x1={0} y1={y} x2={width} y2={y} stroke="#E2D9C5" strokeWidth="1" />;
      })}

      <line x1={cx} y1={0} x2={cx} y2={height} stroke="#D5CCB8" strokeDasharray="3 3" />
      <line x1={0} y1={cy} x2={width} y2={cy} stroke="#D5CCB8" strokeDasharray="3 3" />

      {scopeMode === 'county' && (
        <rect
          x={cx - radiusPx * 1.45}
          y={cy - radiusPx}
          width={radiusPx * 2.9}
          height={radiusPx * 2}
          fill="rgba(47, 82, 69, 0.08)"
          stroke="#2F5245"
          strokeWidth="1.4"
          strokeDasharray="6 4"
        />
      )}
      {scopeMode === 'radius15' && (
        <circle
          cx={cx}
          cy={cy}
          r={radiusPx}
          fill="rgba(47, 82, 69, 0.08)"
          stroke="#2F5245"
          strokeWidth="1.4"
          strokeDasharray="5 3"
        />
      )}

      {markers.map((m) => {
        const lbl = labelPlacement.get(m.place.id);
        return (
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- no native button exists inside SVG; this <g> already has tabIndex, aria-label, and Enter/Space handling
          <g
            key={m.place.id}
            role="button"
            className="survey-neighbor-pin"
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
            <line
              x1={cx}
              y1={cy}
              x2={m.x}
              y2={m.y}
              stroke={m.inRadius ? '#7A4612' : '#9E9687'}
              strokeWidth={m.inRadius ? 1.1 : 0.75}
              strokeDasharray="2 3"
              opacity={0.7}
            />
            <circle
              cx={m.x}
              cy={m.y}
              r={compact ? 3.2 : 4.5}
              fill={m.inRadius ? '#2F5245' : '#FCF9F2'}
              stroke={m.inRadius ? '#FCF9F2' : '#4E4A42'}
              strokeWidth="1.2"
            />
            {!compact && lbl && (
              <text
                x={lbl.lx}
                y={lbl.ly}
                textAnchor={lbl.anchor}
                fontSize="9.2"
                fontFamily="IBM Plex Mono, monospace"
                fill={m.inRadius ? '#1B2A41' : '#4E4A42'}
              >
                {m.place.name} ({m.distanceMiles} mi{lbl.extraCount > 0 ? ` +${lbl.extraCount}` : ''})
              </text>
            )}
          </g>
        );
      })}

      <circle cx={cx} cy={cy} r={compact ? 5 : 6.5} fill="#7A4612" stroke="#FCF9F2" strokeWidth="1.8" />
      <text
        x={cx + (compact ? 8 : 11)}
        y={cy - (compact ? 2 : 3)}
        fontSize={compact ? '9.5' : '11.5'}
        fontWeight="700"
        fontFamily="IBM Plex Mono, monospace"
        fill="#1B2A41"
      >
        {center.name}
      </text>
      <text
        x={cx + (compact ? 8 : 11)}
        y={cy + (compact ? 10 : 12)}
        fontSize={compact ? '7.8' : '9'}
        fontFamily="IBM Plex Mono, monospace"
        fill="#4E4A42"
      >
        {scopeLabel}
      </text>

      <g transform={`translate(${width - 18}, 16)`} aria-hidden="true">
        <path d="M 0 -7 L 3 2 L 0 0 L -3 2 Z" fill="#1B2A41" />
        <text x="0" y="10" textAnchor="middle" fontSize="7.5" fontWeight="700" fontFamily="IBM Plex Mono, monospace" fill="#1B2A41">
          N
        </text>
      </g>
    </svg>
  );
};
