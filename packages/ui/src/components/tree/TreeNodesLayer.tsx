import type { Person } from '@kinloom/core';
import React, { useState } from 'react';
import type {
  DiagramEarlyLossStrip,
  DiagramPlacedNode,
  DiagramSiblingToggle,
  SemanticZoomLevel,
} from '../../lib/archivalTreeModel.js';
import { formatEarlyLossAgeLabel, formatUnionOtherChildrenLabel } from '../../lib/archivalTreeModel.js';
import { fitTreeCardNameToWidth } from '../../lib/treeNodeDisplay.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';

export const DiagramNodeCard: React.FC<{
  readonly node: DiagramPlacedNode;
  readonly displayName: string;
  readonly compactName?: string;
  readonly surnameOrGiven: string;
  readonly lifespan: string;
  readonly thumbUrl: string | null;
  readonly initials: string;
  readonly isSelected: boolean;
  readonly isLit: boolean;
  readonly isAnchor?: boolean;
  readonly semanticZoom: SemanticZoomLevel;
  readonly onSelect: (person: Person, fromKeyboard: boolean) => void;
}> = React.memo(
  ({
    node,
    displayName,
    compactName,
    surnameOrGiven,
    lifespan,
    thumbUrl,
    initials,
    isSelected,
    isLit,
    isAnchor = false,
    semanticZoom,
    onSelect,
  }) => {
    const { person } = node;
    const [prevThumbUrl, setPrevThumbUrl] = useState(thumbUrl);
    const [thumbFailed, setThumbFailed] = useState(false);
    if (thumbUrl !== prevThumbUrl) {
      setPrevThumbUrl(thumbUrl);
      setThumbFailed(false);
    }
    const showSvgPortrait = Boolean(thumbUrl && !thumbFailed);
    let stroke = 'var(--border-control)';
    let strokeWidth = 1.15;
    if (isSelected) {
      stroke = 'var(--accent-primary)';
      strokeWidth = 2.6;
    } else if (isAnchor) {
      stroke = 'var(--accent-primary)';
      strokeWidth = 2.4;
    } else if (isLit) {
      stroke = 'var(--accent-primary)';
      strokeWidth = 2.1;
    } else if (node.isDirect) {
      stroke = 'var(--surface-header)';
      strokeWidth = 2;
    }

    const fill = isSelected ? 'var(--surface-action-primary)' : 'var(--surface-card)';
    const primaryTextFill = isSelected ? 'var(--text-on-action-primary)' : 'var(--surface-header)';
    const secondaryTextFill = isSelected ? 'var(--text-on-action-primary-muted)' : 'var(--text-secondary)';
    const safeId = person.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const clipId = `tree-avatar-clip-${safeId}`;
    const cardClipId = `tree-card-clip-${safeId}`;

    return (
      <g
        role="button"
        className={`tree-node-card${node.isDirect ? ' is-direct' : ' is-collateral'}${isSelected ? ' is-selected' : ''}${isLit ? ' is-lit' : ''}${isAnchor ? ' is-anchor' : ''}`}
        data-person-id={person.id}
        data-anchor={isAnchor ? 'true' : undefined}
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
        <defs>
          <clipPath id={cardClipId}>
            <rect x={2} y={2} width={node.width - 4} height={node.height - 4} rx={2} />
          </clipPath>
          {semanticZoom === 'detail' && showSvgPortrait && (
            <clipPath id={clipId}>
              <circle cx={24} cy={26} r={13} />
            </clipPath>
          )}
        </defs>
        <rect
          width={node.width}
          height={node.height}
          rx={4}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray={node.isDirect || isSelected || isLit || isAnchor ? undefined : '4 2'}
        />

        {semanticZoom === 'overview' ? (
          <g clipPath={`url(#${cardClipId})`}>
            <text
              x={node.width / 2}
              y={22}
              textAnchor="middle"
              fontSize="12"
              fontWeight="700"
              fontFamily="var(--font-serif)"
              fill={primaryTextFill}
            >
              {surnameOrGiven}
            </text>
            <text
              x={node.width / 2}
              y={39}
              textAnchor="middle"
              fontSize="10.5"
              fontFamily="var(--font-mono)"
              fill={secondaryTextFill}
            >
              {lifespan}
            </text>
          </g>
        ) : semanticZoom === 'compact' ? (
          <g clipPath={`url(#${cardClipId})`}>
            <text
              x={12}
              y={22}
              fontSize="11.5"
              fontWeight="700"
              fontFamily="var(--font-serif)"
              fill={primaryTextFill}
            >
              {compactName ?? displayName}
            </text>
            <text x={12} y={39} fontSize="10.5" fontFamily="var(--font-mono)" fill={secondaryTextFill}>
              {lifespan}
            </text>
          </g>
        ) : (
          <g clipPath={`url(#${cardClipId})`}>
            <circle
              cx={24}
              cy={26}
              r={13}
              fill={isSelected ? 'var(--accent-primary)' : 'var(--surface-linen)'}
              stroke={node.isDirect || isLit ? 'var(--accent-primary)' : 'var(--border-control)'}
              strokeWidth="1.2"
            />
            {showSvgPortrait && thumbUrl ? (
              <image
                href={thumbUrl}
                x={11}
                y={13}
                width={26}
                height={26}
                preserveAspectRatio="xMidYMid slice"
                clipPath={`url(#${clipId})`}
                onError={() => {
                  setThumbFailed(true);
                }}
              />
            ) : (
              <text
                x={24}
                y={29.5}
                textAnchor="middle"
                fontSize="10"
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
              fontSize="11.5"
              fontWeight="700"
              fontFamily="var(--font-serif)"
              fill={primaryTextFill}
            >
              {displayName}
            </text>
            <text x={44} y={38} fontSize="10.5" fontFamily="var(--font-mono)" fill={secondaryTextFill}>
              {lifespan}
            </text>
          </g>
        )}
      </g>
    );
  }
);

export const EarlyLossStripLayer: React.FC<{
  readonly strip: DiagramEarlyLossStrip;
  readonly selectedPersonId: string | null;
  readonly highlightedIds: ReadonlySet<string> | null;
  readonly onSelect: (person: Person, fromKeyboard: boolean) => void;
}> = React.memo(({ strip, selectedPersonId, highlightedIds, onSelect }) => {
  const anyLit = Boolean(
    highlightedIds &&
      (strip.parentIds.some((pid) => highlightedIds.has(pid)) ||
        strip.chips.some((chip) => highlightedIds.has(chip.person.id)))
  );
  const isStemInsideStrip = strip.stemFromX >= strip.x && strip.stemFromX <= strip.x + strip.width;
  const attachY = Math.round(strip.y + 14);
  const stripConnectorPath = isStemInsideStrip
    ? `M ${strip.stemFromX} ${strip.stemFromY} V ${strip.y}`
    : strip.stemFromX < strip.x
      ? `M ${strip.stemFromX} ${strip.stemFromY} V ${attachY} H ${strip.x}`
      : `M ${strip.stemFromX} ${strip.stemFromY} V ${attachY} H ${strip.x + strip.width}`;
  return (
    <g className={`tree-diagram-early-strip${anyLit ? ' is-lit' : ''}`} data-union-id={strip.unionId}>
      <title>{KINLOOM_VOCABULARY.tree.diedYoungTooltip}</title>
      <path
        className={`tree-edge${anyLit ? ' is-lit' : ''}`}
        d={stripConnectorPath}
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
        fontSize="10"
        fontWeight="600"
        fontFamily="var(--font-mono)"
        fill="var(--text-secondary)"
      >
        {KINLOOM_VOCABULARY.tree.diedYoung} ({strip.chips.length})
      </text>
      {strip.chips.map((chip) => {
        const isSelected = selectedPersonId === chip.person.id;
        const isLit = Boolean(highlightedIds?.has(chip.person.id));
        const safeChipId = chip.person.id.replace(/[^a-zA-Z0-9_-]/g, '_');
        const chipClipId = `tree-early-chip-clip-${safeChipId}`;
        return (
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
            <defs>
              <clipPath id={chipClipId}>
                <rect
                  x={2}
                  y={2}
                  width={Math.max(0, chip.width - 4)}
                  height={Math.max(0, chip.height - 4)}
                  rx={2}
                />
              </clipPath>
            </defs>
            <rect
              width={chip.width}
              height={chip.height}
              rx={3}
              fill={isSelected ? 'var(--surface-action-primary)' : 'var(--surface-card)'}
              stroke={isSelected || isLit ? 'var(--accent-primary)' : 'var(--border-control)'}
              strokeWidth={isSelected ? 1.8 : 1}
            />
            <g clipPath={`url(#${chipClipId})`}>
              <text
                x={8}
                y={13}
                fontSize="10.5"
                fontWeight="600"
                fontFamily="var(--font-serif)"
                fill={isSelected ? 'var(--text-on-action-primary)' : 'var(--text-primary)'}
              >
                {fitTreeCardNameToWidth(
                  chip.person.given_name || chip.person.full_name,
                  chip.width - 16,
                  10.5
                )}
              </text>
              <text
                x={8}
                y={25}
                fontSize="9.5"
                fontFamily="var(--font-mono)"
                fill={isSelected ? 'var(--text-on-action-primary-muted)' : 'var(--text-secondary)'}
              >
                {formatEarlyLossAgeLabel(chip.person)}
              </text>
            </g>
          </g>
        );
      })}
    </g>
  );
});

export const SiblingToggleItem: React.FC<{
  readonly toggle: DiagramSiblingToggle;
  readonly isLit: boolean;
  readonly onToggle: (unionId: string) => void;
}> = React.memo(({ toggle, isLit, onToggle }) => {
  const toggleLabels = formatUnionOtherChildrenLabel({
    hiddenCount: toggle.hiddenCount,
    totalCollateralCount: toggle.totalCollateralCount,
    visibleChildCount: toggle.visibleChildCount,
    isExpanded: toggle.isExpanded,
    mode: toggle.mode,
  });

  const isStemInsideToggle = toggle.stemFromX >= toggle.x && toggle.stemFromX <= toggle.x + toggle.width;
  const toggleAttachY = Math.round(toggle.y + toggle.height / 2);
  const toggleConnectorPath = isStemInsideToggle
    ? `M ${toggle.stemFromX} ${toggle.stemFromY} V ${toggle.y}`
    : toggle.stemFromX < toggle.x
      ? `M ${toggle.stemFromX} ${toggle.stemFromY} V ${toggleAttachY} H ${toggle.x}`
      : `M ${toggle.stemFromX} ${toggle.stemFromY} V ${toggleAttachY} H ${toggle.x + toggle.width}`;

  return (
    <g className={`tree-diagram-sibling-toggle${isLit ? ' is-lit' : ''}`}>
      <path
        className={`tree-edge${isLit ? ' is-lit' : ''}`}
        d={toggleConnectorPath}
        fill="none"
        stroke={isLit ? 'var(--accent-primary)' : 'var(--border-control)'}
        strokeWidth="1.2"
        strokeDasharray="3 2"
      />
      <g
        role="button"
        tabIndex={0}
        className={'tree-diagram-sibling-btn'}
        aria-expanded={toggle.isExpanded}
        aria-label={toggleLabels.ariaLabel}
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
        <title>{toggleLabels.ariaLabel}</title>
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
          {toggleLabels.compactLabel}
        </text>
      </g>
    </g>
  );
});
