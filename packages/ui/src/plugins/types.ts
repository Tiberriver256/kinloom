import type {
  ArchiveBundle,
  ArchiveCapabilities,
  ArchiveSessionState,
  KinloomSiteConfig,
  MediaItem,
  Person,
  Place,
} from '@kinloom/core';
import type React from 'react';

export interface KinloomUiPluginRoute {
  readonly path: string;
  readonly navLabel?: string;
  readonly component: React.ComponentType;
}

export interface KinloomUiPluginSlotContext {
  readonly bundle: ArchiveBundle | null;
  readonly siteConfig: KinloomSiteConfig;
  readonly session: ArchiveSessionState | null;
  readonly capabilities: ArchiveCapabilities;
  readonly person?: Person;
  readonly place?: Place;
}

export type KinloomUiPluginSlotRenderer = (ctx: KinloomUiPluginSlotContext) => React.ReactNode;

export interface KinloomUiPluginSlots {
  readonly indexHero?: KinloomUiPluginSlotRenderer;
  readonly personDetail?: KinloomUiPluginSlotRenderer;
  readonly placeDetail?: KinloomUiPluginSlotRenderer;
  readonly sourceReaderFooter?: KinloomUiPluginSlotRenderer;
  readonly evidenceExtra?: KinloomUiPluginSlotRenderer;
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
  readonly routes?: readonly KinloomUiPluginRoute[];
  readonly slots?: KinloomUiPluginSlots;
  readonly mediaRenderers?: readonly KinloomMediaRenderer[];
}
