import type { Person } from '@kinloom/core';
import type {
  ArchivalDiagramLayout,
  DiagramEarlyLossStrip,
  DiagramGenBand,
  DiagramHangingGridRail,
  DiagramOrthogonalBus,
  DiagramPlacedNode,
  DiagramSiblingToggle,
  DiagramUnionHub,
  LineageSpotlight,
  SemanticZoomLevel,
} from '../../lib/archivalTreeModel.js';
import React, { useMemo } from 'react';
import {
  formatCardLifespan,
  formatEarlyLossAgeLabel,
  toRomanNumeral,
} from '../../lib/archivalTreeModel.js';
import { formatTreeCardName } from '../../lib/treeNodeDisplay.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import { initialsOf, resolveAssetUrl } from '../Atoms.js';

export interface TreeOrthogonalCanvasProps {
  readonly layout: ArchivalDiagramLayout;
  readonly spotlight: LineageSpotlight | null;
  readonly selectedPersonId: string | null;
  readonly semanticZoom: SemanticZoomLevel;
  readonly activeBranchLabel: string;
  readonly personThumbMap: ReadonlyMap<string, string>;
  readonly baseUrl: string;
  readonly onSelectPerson: (person: Person, fromKeyboard: boolean) => void;
  readonly onToggleUnionSiblings: (unionId: string) => void;
}

const GenBandsLayer: React.FC<{
  readonly genBands: readonly DiagramGenBand[];
  readonly maxX: number;
}> = React.memo(({ genBands, maxX }) => (
  <g className="tree-gen-bands" aria-hidden="true">
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
          fontSize="10"
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

const OrthogonalBusItem: React.FC<{
  readonly bus: DiagramOrthogonalBus;
  readonly highlightedIds: ReadonlySet<string> | null;
  readonly isUnionLit: boolean;
}> = React.memo(({ bus, highlightedIds, isUnionLit }) => {
  const hasSelection = highlightedIds !== null;
  const stemLit = isUnionLit;

  const railPath = `M ${bus.railMinX} ${bus.busY} H ${bus.railMaxX}`;
  const stemPath = `M ${bus.hubX} ${bus.hubY} V ${bus.busY}`;

  return (
    <g
      className={`tree-bus-group${bus.isDirect ? ' is-direct' : ''}${stemLit ? ' is-lit' : ''}`}
      aria-hidden="true"
    >
      <path
        className={`tree-edge tree-bus-stem${bus.isDirect ? ' is-direct' : ''}${stemLit ? ' is-lit' : ''}`}
        d={stemPath}
        fill="none"
        stroke={
          stemLit
            ? 'var(--accent-primary)'
            : bus.isDirect
              ? 'var(--surface-header)'
              : 'var(--border-control)'
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
            bus.parentIds.some((pid) => highlightedIds.has(pid)),
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

const HangingRailItem: React.FC<{
  readonly rail: DiagramHangingGridRail;
  readonly highlightedIds: ReadonlySet<string> | null;
}> = React.memo(({ rail, highlightedIds }) => {
  const anyChildLit = Boolean(
    highlightedIds && rail.childIds.some((cid) => highlightedIds.has(cid)),
  );
  return (
    <g
      className={`tree-hanging-rail${anyChildLit ? ' is-lit' : ''}`}
      aria-hidden="true"
    >
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

const UnionHubItem: React.FC<{
  readonly hub: DiagramUnionHub;
  readonly isLit: boolean;
}> = React.memo(({ hub, isLit }) => {
  const isRemarriage = hub.union.totalMarriagesForPrimary > 1;
  const strokeColor = isLit ? 'var(--accent-primary)' : 'var(--accent-primary)';
  return (
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

const DiagramNodeCard: React.FC<{
  readonly node: DiagramPlacedNode;
  readonly displayName: string;
  readonly surnameOrGiven: string;
  readonly lifespan: string;
  readonly thumbUrl: string | null;
  readonly initials: string;
  readonly isSelected: boolean;
  readonly isLit: boolean;
  readonly semanticZoom: SemanticZoomLevel;
  readonly onSelect: (person: Person, fromKeyboard: boolean) => void;
}> = React.memo(
  ({
    node,
    displayName,
    surnameOrGiven,
    lifespan,
    thumbUrl,
    initials,
    isSelected,
    isLit,
    semanticZoom,
    onSelect,
  }) => {
    const { person } = node;
    let stroke = 'var(--border-control)';
    let strokeWidth = 1.15;
    if (isSelected) {
      stroke = 'var(--accent-primary)';
      strokeWidth = 2.6;
    } else if (isLit) {
      stroke = 'var(--accent-primary)';
      strokeWidth = 2.1;
    } else if (node.isDirect) {
      stroke = 'var(--surface-header)';
      strokeWidth = 1.9;
    }

    const fill = isSelected ? 'var(--surface-header)' : 'var(--surface-card)';
    const primaryTextFill = isSelected ? 'var(--text-inverse)' : 'var(--surface-header)';
    const secondaryTextFill = isSelected ? 'var(--surface-linen)' : 'var(--text-secondary)';
    const clipId = `tree-avatar-clip-${person.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    return (
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- SVG <g> requires role="button" with keyboard Enter/Space support
      <g
        role="button"
        className={`tree-node-card${node.isDirect ? ' is-direct' : ' is-collateral'}${isSelected ? ' is-selected' : ''}${isLit ? ' is-lit' : ''}`}
        tabIndex={0}
        aria-label={`Inspect ${person.full_name}`}
        aria-pressed={isSelected}
        transform={`translate(${node.x}, ${node.y})`}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(person, false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSelect(person, true);
          } else if (e.key === ' ') {
            e.preventDefault();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ') {
            e.preventDefault();
            onSelect(person, true);
          }
        }}
      >
        <title>{person.full_name}</title>
        <rect
          width={node.width}
          height={node.height}
          rx={3}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray={node.isDirect || isSelected || isLit ? undefined : '4 2'}
        />

        {node.isDirect && !isSelected && (
          <rect
            x={0}
            y={0}
            width={4}
            height={node.height}
            rx={1}
            fill={isLit ? 'var(--accent-primary)' : 'var(--surface-header)'}
          />
        )}

        {semanticZoom === 'overview' ? (
          <g>
            <text
              x={node.width / 2}
              y={node.height / 2 + 5}
              textAnchor="middle"
              fontSize="13.5"
              fontWeight="700"
              fontFamily="var(--font-serif)"
              fill={primaryTextFill}
            >
              {surnameOrGiven}
            </text>
          </g>
        ) : semanticZoom === 'compact' ? (
          <g>
            <text
              x={14}
              y={22}
              fontSize="11.5"
              fontWeight="700"
              fontFamily="var(--font-serif)"
              fill={primaryTextFill}
            >
              {displayName}
            </text>
            <text
              x={14}
              y={39}
              fontSize="9.5"
              fontFamily="var(--font-mono)"
              fill={secondaryTextFill}
            >
              {lifespan}
            </text>
          </g>
        ) : (
          <g>
            {thumbUrl && (
              <defs>
                <clipPath id={clipId}>
                  <circle cx={24} cy={26} r={13} />
                </clipPath>
              </defs>
            )}
            <circle
              cx={24}
              cy={26}
              r={13}
              fill={isSelected ? 'var(--accent-primary)' : 'var(--surface-linen)'}
              stroke={node.isDirect || isLit ? 'var(--accent-primary)' : 'var(--border-control)'}
              strokeWidth="1.2"
            />
            {thumbUrl ? (
              <image
                href={thumbUrl}
                x={11}
                y={13}
                width={26}
                height={26}
                preserveAspectRatio="xMidYMid slice"
                clipPath={`url(#${clipId})`}
              />
            ) : (
              <text
                x={24}
                y={29.5}
                textAnchor="middle"
                fontSize="9"
                fontWeight="700"
                fontFamily="var(--font-mono)"
                fill={isSelected ? 'var(--text-inverse)' : 'var(--accent-primary)'}
              >
                {initials}
              </text>
            )}
            <text
              x={44}
              y={22}
              fontSize="11"
              fontWeight="700"
              fontFamily="var(--font-serif)"
              fill={primaryTextFill}
            >
              {displayName}
            </text>
            <text
              x={44}
              y={38}
              fontSize="9"
              fontFamily="var(--font-mono)"
              fill={secondaryTextFill}
            >
              {lifespan}
            </text>
          </g>
        )}
      </g>
    );
  },
);

const EarlyLossStripLayer: React.FC<{
  readonly strip: DiagramEarlyLossStrip;
  readonly selectedPersonId: string | null;
  readonly highlightedIds: ReadonlySet<string> | null;
  readonly onSelect: (person: Person, fromKeyboard: boolean) => void;
}> = React.memo(({ strip, selectedPersonId, highlightedIds, onSelect }) => {
  const anyLit = Boolean(
    highlightedIds &&
      (strip.parentIds.some((pid) => highlightedIds.has(pid)) ||
        strip.chips.some((chip) => highlightedIds.has(chip.person.id))),
  );
  return (
      <g
        className={`tree-diagram-early-strip${anyLit ? ' is-lit' : ''}`}
        data-union-id={strip.unionId}
      >
        <title>{KINLOOM_VOCABULARY.tree.diedYoungTooltip}</title>
        <path
          className={`tree-edge${anyLit ? ' is-lit' : ''}`}
          d={`M ${strip.stemFromX} ${strip.stemFromY} V ${strip.y}`}
          fill="none"
          stroke={anyLit ? 'var(--accent-primary)' : 'var(--border-control)'}
          strokeWidth="1.2"
          strokeDasharray="2 2"
        />
        <rect
          x={strip.x}
          y={strip.y}
          width={strip.width}
          height={strip.height}
          rx={4}
          fill="var(--surface-linen)"
          stroke="var(--border-decorative)"
          strokeWidth="1"
        />
        <text
          x={strip.x + 12}
          y={strip.y + 13}
          fontSize="8.5"
          fontWeight="600"
          fontFamily="var(--font-mono)"
          fill="var(--text-secondary)"
        >
          {KINLOOM_VOCABULARY.tree.diedYoung} ({strip.chips.length})
        </text>
      {strip.chips.map((chip) => {
        const isSelected = selectedPersonId === chip.person.id;
        const isLit = Boolean(highlightedIds?.has(chip.person.id));
        return (
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- SVG interactive chip
          <g
            key={chip.person.id}
            role="button"
            tabIndex={0}
            className={`tree-node-card tree-diagram-early-chip${isSelected ? ' is-selected' : ''}${isLit ? ' is-lit' : ''}`}
            aria-label={`Inspect ${chip.person.full_name}`}
            aria-pressed={isSelected}
            transform={`translate(${chip.x}, ${chip.y})`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(chip.person, false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onSelect(chip.person, true);
              } else if (e.key === ' ') {
                e.preventDefault();
              }
            }}
            onKeyUp={(e) => {
              if (e.key === ' ') {
                e.preventDefault();
                onSelect(chip.person, true);
              }
            }}
          >
            <title>{chip.person.full_name}</title>
            <rect
              width={chip.width}
              height={chip.height}
              rx={3}
              fill={isSelected ? 'var(--surface-header)' : 'var(--surface-card)'}
              stroke={isSelected || isLit ? 'var(--accent-primary)' : 'var(--border-control)'}
              strokeWidth={isSelected ? 1.8 : 1}
            />
            <text
              x={8}
              y={13}
              fontSize="9.2"
              fontWeight="600"
              fontFamily="var(--font-serif)"
              fill={isSelected ? 'var(--text-inverse)' : 'var(--text-primary)'}
            >
              {formatTreeCardName(chip.person.given_name || chip.person.full_name, 13)}
            </text>
            <text
              x={8}
              y={24}
              fontSize="8"
              fontFamily="var(--font-mono)"
              fill={isSelected ? 'var(--surface-linen)' : 'var(--text-secondary)'}
            >
              {formatEarlyLossAgeLabel(chip.person)}
            </text>
          </g>
        );
      })}
    </g>
  );
});

const SiblingToggleItem: React.FC<{
  readonly toggle: DiagramSiblingToggle;
  readonly isLit: boolean;
  readonly onToggle: (unionId: string) => void;
}> = React.memo(({ toggle, isLit, onToggle }) => {
  const label = toggle.isExpanded
    ? `▾ Hide ${toggle.totalCollateralCount} ${toggle.totalCollateralCount === 1 ? 'sibling' : 'siblings'}`
    : `▸ +${toggle.hiddenCount} ${toggle.hiddenCount === 1 ? 'sibling' : 'siblings'}`;

  return (
    <g className={`tree-diagram-sibling-toggle${isLit ? ' is-lit' : ''}`}>
      <path
        className={`tree-edge${isLit ? ' is-lit' : ''}`}
        d={`M ${toggle.stemFromX} ${toggle.stemFromY} V ${toggle.y}`}
        fill="none"
        stroke={isLit ? 'var(--accent-primary)' : 'var(--border-control)'}
        strokeWidth="1.2"
        strokeDasharray="3 2"
      />
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- SVG disclosure trigger */}
      <g
        role="button"
        tabIndex={0}
        className="tree-diagram-sibling-btn"
        aria-expanded={toggle.isExpanded}
        aria-label={
          toggle.isExpanded
            ? `Hide ${toggle.totalCollateralCount} other siblings`
            : `Show ${toggle.hiddenCount} more siblings`
        }
        transform={`translate(${toggle.x}, ${toggle.y})`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(toggle.unionId);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onToggle(toggle.unionId);
          } else if (e.key === ' ') {
            e.preventDefault();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ') {
            e.preventDefault();
            onToggle(toggle.unionId);
          }
        }}
      >
        <rect
          width={toggle.width}
          height={toggle.height}
          rx={14}
          fill={toggle.isExpanded ? 'var(--accent-primary)' : 'var(--surface-card)'}
          stroke="var(--accent-primary)"
          strokeWidth="1.5"
        />
        <text
          x={toggle.width / 2}
          y={toggle.height / 2 + 3.5}
          textAnchor="middle"
          fontSize="10"
          fontWeight="600"
          fontFamily="var(--font-mono)"
          fill={toggle.isExpanded ? 'var(--text-inverse)' : 'var(--accent-primary)'}
        >
          {label}
        </text>
      </g>
    </g>
  );
});

export const TreeOrthogonalCanvas: React.FC<TreeOrthogonalCanvasProps> = ({
  layout,
  spotlight,
  selectedPersonId,
  semanticZoom,
  activeBranchLabel,
  personThumbMap,
  baseUrl,
  onSelectPerson,
  onToggleUnionSiblings,
}) => {
  const highlightedIds = spotlight?.highlightedPersonIds ?? null;
  const highlightedUnionIds = spotlight?.highlightedUnionIds ?? null;
  const hasSelection = highlightedIds !== null;

  const preparedNodes = useMemo(
    () =>
      layout.nodes.map((node) => {
        const p = node.person;
        const rawThumb = personThumbMap.get(p.id) || p.portrait_url;
        return {
          node,
          displayName: formatTreeCardName(p.full_name, 19),
          surnameOrGiven: formatTreeCardName(p.given_name || p.surname || p.full_name, 13),
          lifespan: formatCardLifespan(p),
          thumbUrl: rawThumb ? resolveAssetUrl(rawThumb, baseUrl) : null,
          initials: initialsOf(p.full_name),
        };
      }),
    [layout.nodes, personThumbMap, baseUrl],
  );

  return (
    <svg
      className={`tree-canvas tree-canvas-${semanticZoom}${hasSelection ? ' has-selection' : ''}`}
      width={layout.bounds.maxX}
      height={layout.bounds.maxY}
      viewBox={`${layout.bounds.minX} ${layout.bounds.minY} ${layout.bounds.maxX - layout.bounds.minX} ${layout.bounds.maxY - layout.bounds.minY}`}
      role="img"
      aria-label={`${activeBranchLabel} ${KINLOOM_VOCABULARY.tree.chartCanvasSuffix}`}
    >
      <GenBandsLayer genBands={layout.genBands} maxX={layout.bounds.maxX} />

      <g className="tree-layer-buses">
        {layout.buses.map((bus) => (
          <OrthogonalBusItem
            key={bus.unionId}
            bus={bus}
            highlightedIds={highlightedIds}
            isUnionLit={Boolean(highlightedUnionIds?.has(bus.unionId))}
          />
        ))}
      </g>

      <g className="tree-layer-hanging-rails">
        {layout.hangingRails.map((rail) => (
          <HangingRailItem
            key={`rail-${rail.unionId}`}
            rail={rail}
            highlightedIds={highlightedIds}
          />
        ))}
      </g>

      <g className="tree-layer-early-strips">
        {layout.earlyLossStrips.map((strip) => (
          <EarlyLossStripLayer
            key={`early-${strip.unionId}`}
            strip={strip}
            selectedPersonId={selectedPersonId}
            highlightedIds={highlightedIds}
            onSelect={onSelectPerson}
          />
        ))}
      </g>

      <g className="tree-layer-sibling-toggles">
        {layout.siblingToggles.map((toggle) => (
          <SiblingToggleItem
            key={`toggle-${toggle.unionId}`}
            toggle={toggle}
            isLit={Boolean(highlightedUnionIds?.has(toggle.unionId))}
            onToggle={onToggleUnionSiblings}
          />
        ))}
      </g>

      <g className="tree-layer-hubs">
        {layout.hubs.map((hub) => (
          <UnionHubItem
            key={`hub-${hub.union.id}`}
            hub={hub}
            isLit={Boolean(
              highlightedUnionIds?.has(hub.union.id) ||
                (highlightedIds && hub.union.partnerIds.some((pid) => highlightedIds.has(pid))),
            )}
          />
        ))}
      </g>

      <g className="tree-layer-nodes">
        {preparedNodes.map((prepared) => {
          const pid = prepared.node.person.id;
          return (
            <DiagramNodeCard
              key={pid}
              node={prepared.node}
              displayName={prepared.displayName}
              surnameOrGiven={prepared.surnameOrGiven}
              lifespan={prepared.lifespan}
              thumbUrl={prepared.thumbUrl}
              initials={prepared.initials}
              isSelected={selectedPersonId === pid}
              isLit={Boolean(highlightedIds?.has(pid))}
              semanticZoom={semanticZoom}
              onSelect={onSelectPerson}
            />
          );
        })}
      </g>
    </svg>
  );
};
