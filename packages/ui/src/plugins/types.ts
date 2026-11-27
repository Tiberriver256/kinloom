import type {
  ArchiveBundle,
  ArchiveCapabilities,
  ArchiveSessionState,
  EntityType,
  KinloomSiteConfig,
  MediaItem,
  Narrative,
  Person,
  Place,
} from '@kinloom/core';
import type React from 'react';
import type {
  EntityCreateFormEntry,
  EntityEditFormEntry,
} from '../components/wiki/entityForms/fieldTypes.js';

export interface KinloomUiPluginRoute {
  readonly path: string;
  readonly navLabel?: string;
  readonly component: React.ComponentType;
}

export interface KinloomUiPluginSlotContext {
  readonly bundle: ArchiveBundle | null;
  readonly siteConfig: KinloomSiteConfig;
  readonly baseUrl: string;
  readonly session: ArchiveSessionState | null;
  readonly capabilities: ArchiveCapabilities;
  readonly person?: Person;
  readonly place?: Place;
  readonly narrative?: Narrative;
}

export type KinloomUiPluginSlotRenderer = (ctx: KinloomUiPluginSlotContext) => React.ReactNode;

export interface KinloomUiPluginSlots {
  readonly indexHero?: KinloomUiPluginSlotRenderer;
  readonly personDetail?: KinloomUiPluginSlotRenderer;
  readonly narrativeHeader?: KinloomUiPluginSlotRenderer;
  readonly placeDetail?: KinloomUiPluginSlotRenderer;
  readonly sourceReaderFooter?: KinloomUiPluginSlotRenderer;
  readonly evidenceExtra?: KinloomUiPluginSlotRenderer;
  /** Persistent shell-level slot rendered as a sibling to routes (survives navigation). */
  readonly appShell?: KinloomUiPluginSlotRenderer;
}

export type KinloomUiPluginSlotName = keyof KinloomUiPluginSlots;

export interface KinloomMediaRendererProps {
  readonly media: MediaItem;
  readonly src: string;
}

export interface KinloomMediaRenderer {
  readonly match: (media: MediaItem) => boolean;
  readonly render: (props: KinloomMediaRendererProps) => React.ReactNode;
}

export interface KinloomUiPlugin {
  readonly id: string;
  readonly name: string;
  /** Optional React provider wrapping the app shell so plugin slots share persistent state across routes. */
  readonly provider?: React.ComponentType<{ children: React.ReactNode }>;
  readonly routes?: readonly KinloomUiPluginRoute[];
  readonly slots?: KinloomUiPluginSlots;
  readonly mediaRenderers?: readonly KinloomMediaRenderer[];
  readonly entityEditForms?: Readonly<Partial<Record<EntityType, EntityEditFormEntry>>>;
  readonly entityCreateForms?: Readonly<Partial<Record<EntityType, EntityCreateFormEntry>>>;
}
