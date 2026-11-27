import React from 'react';
import type {
  DiagramGenBand,
  DiagramHangingGridRail,
  DiagramOrthogonalBus,
  DiagramUnionHub,
} from '../../lib/archivalTreeModel.js';
import { toRomanNumeral } from '../../lib/archivalTreeModel.js';

export const GenBandsLayer: React.FC<{
  readonly genBands: readonly DiagramGenBand[];
  readonly maxX: number;
}> = React.memo(({ genBands, maxX }) => (
  // biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative SVG generation bands
  <g className={'tree-gen-bands'} aria-hidden="true">
    {genBands.map((band) => (
      <g key={band.gen}>
        <line
          x1={16}
          y1={band.y + 26}
          x2={maxX - 16}
          y2={band.y + 26}
          stroke="var(--border-decorative)"
          strokeWidth="1"
          strokeDasharray="4 4"
        />
        <rect
          x={14}
          y={band.y + 11}
          width={114}
          height={28}
          rx={3}
          fill="var(--surface-card)"
          stroke="var(--border-control)"
        />
        <text
          x={71}
          y={band.y + 29}
          textAnchor="middle"
          fontSize="10.5"
          fontWeight="600"
          fontFamily="var(--font-mono)"
          fill="var(--text-secondary)"
        >
          {band.label} · {band.yearRange}
        </text>
      </g>
    ))}
  </g>
));

export const OrthogonalBusItem: React.FC<{
  readonly bus: DiagramOrthogonalBus;
  readonly highlightedIds: ReadonlySet<string> | null;
  readonly isUnionLit: boolean;
}> = React.memo(({ bus, highlightedIds, isUnionLit }) => {
  const hasSelection = highlightedIds !== null;
  const stemLit = isUnionLit;

  const railPath = `M ${bus.railMinX} ${bus.busY} H ${bus.railMaxX}`;
  const stemPath = `M ${bus.hubX} ${bus.hubY} V ${bus.busY}`;

  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative SVG connector lines
    <g
      className={`tree-bus-group${bus.isDirect ? ' is-direct' : ''}${stemLit ? ' is-lit' : ''}`}
      aria-hidden="true"
    >
      <path
        className={`tree-edge tree-bus-stem${bus.isDirect ? ' is-direct' : ''}${stemLit ? ' is-lit' : ''}`}
        d={stemPath}
        fill="none"
        stroke={
          stemLit ? 'var(--accent-primary)' : bus.isDirect ? 'var(--surface-header)' : 'var(--border-control)'
        }
        strokeWidth={stemLit ? 2.6 : bus.isDirect ? 2.2 : 1.3}
        strokeLinecap="square"
      />
      {bus.railMaxX > bus.railMinX && (
        <path
          className={`tree-edge tree-bus-rail${bus.isDirect ? ' is-direct' : ''}${stemLit ? ' is-lit' : ''}`}
          d={railPath}
          fill="none"
          stroke={
            stemLit
              ? 'var(--accent-primary)'
              : bus.isDirect
                ? 'var(--surface-header)'
                : 'var(--border-control)'
          }
          strokeWidth={stemLit ? 2.4 : bus.isDirect ? 2 : 1.25}
          strokeLinecap="square"
        />
      )}
      {bus.childDrops.map((drop) => {
        const dropLit = Boolean(
          hasSelection &&
            highlightedIds.has(drop.childId) &&
            bus.parentIds.some((pid) => highlightedIds.has(pid))
        );
        return (
          <path
            key={`${bus.unionId}-${drop.childId}`}
            className={`tree-edge tree-bus-drop${drop.isDirect ? ' is-direct' : ''}${dropLit ? ' is-lit' : ''}`}
            d={`M ${drop.x} ${bus.busY} V ${drop.toY}`}
            fill="none"
            stroke={
              dropLit
                ? 'var(--accent-primary)'
                : drop.isDirect
                  ? 'var(--surface-header)'
                  : 'var(--border-control)'
            }
            strokeWidth={dropLit ? 2.6 : drop.isDirect ? 2.2 : 1.25}
            strokeLinecap="square"
          />
        );
      })}
    </g>
  );
});

export const HangingRailItem: React.FC<{
  readonly rail: DiagramHangingGridRail;
  readonly highlightedIds: ReadonlySet<string> | null;
}> = React.memo(({ rail, highlightedIds }) => {
  const anyChildLit = Boolean(highlightedIds && rail.childIds.some((cid) => highlightedIds.has(cid)));
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative SVG hanging rail
    <g className={`tree-hanging-rail${anyChildLit ? ' is-lit' : ''}`} aria-hidden="true">
      <path
        className={`tree-edge${anyChildLit ? ' is-lit' : ''}`}
        d={`M ${rail.spineX} ${rail.topY} V ${rail.bottomY}`}
        fill="none"
        stroke={anyChildLit ? 'var(--accent-primary)' : 'var(--border-control)'}
        strokeWidth={anyChildLit ? 2 : 1.25}
      />
      {rail.ticks.map((tick) => {
        const tickLit = Boolean(highlightedIds?.has(tick.childId));
        return (
          <path
            key={`${rail.unionId}-tick-${tick.childId}`}
            className={`tree-edge${tickLit ? ' is-lit' : ''}`}
            d={`M ${rail.spineX} ${tick.y} H ${tick.toX}`}
            fill="none"
            stroke={tickLit ? 'var(--accent-primary)' : 'var(--border-control)'}
            strokeWidth={tickLit ? 2 : 1.2}
          />
        );
      })}
    </g>
  );
});

export const UnionHubItem: React.FC<{
  readonly hub: DiagramUnionHub;
  readonly isLit: boolean;
}> = React.memo(({ hub, isLit }) => {
  const isRemarriage = hub.union.totalMarriagesForPrimary > 1;
  const strokeColor = 'var(--accent-primary)';
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: decorative SVG union hub
    <g
      className={`tree-couple tree-union-hub${isLit ? ' is-lit' : ''}`}
      data-union-id={hub.union.id}
      aria-hidden="true"
    >
      {hub.union.kind === 'couple' && (
        <line
          x1={hub.leftX}
          y1={hub.connectorY}
          x2={hub.rightX}
          y2={hub.connectorY}
          stroke={strokeColor}
          strokeWidth={isLit ? 2.6 : 2}
        />
      )}
      <circle
        cx={hub.x}
        cy={hub.y}
        r={isRemarriage ? 9 : 6}
        fill={isLit ? 'var(--accent-primary)' : 'var(--surface-card)'}
        stroke={strokeColor}
        strokeWidth={isLit ? 2.2 : 1.8}
      />
      {isRemarriage && (
        <text
          x={hub.x}
          y={hub.y + 3.2}
          textAnchor="middle"
          fontSize="8.5"
          fontWeight="700"
          fontFamily="var(--font-mono)"
          fill={isLit ? 'var(--text-inverse)' : 'var(--accent-primary)'}
        >
          {toRomanNumeral(hub.union.marriageOrder)}
        </text>
      )}
    </g>
  );
});
