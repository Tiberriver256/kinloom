import type {
  ArchiveBundle,
  ArchiveCapabilities,
  ArchiveSessionState,
  ChangelogEntry,
  EntityType,
  KinloomSiteConfig,
  MediaItem,
  Narrative,
  Person,
  Place,
  PluginDocumentation,
  PluginRuntimeStatus,
} from '@kinloom/core';
import type React from 'react';
import type {
  EntityCreateFormEntry,
  EntityEditFormEntry,
} from '../components/wiki/entityForms/fieldTypes.js';

export type KinloomUiPluginNavMinRole = 'public' | 'viewer' | 'editor' | 'admin';

export interface KinloomUiPluginRoute {
  readonly path: string;
  readonly navLabel?: string;
  /** Prefix used to keep the top-bar nav pill active across nested sub-routes (for example '/recipes'). */
  readonly navMatchPrefix?: string;
  /** Optional short aria-hidden icon rendered next to navLabel. */
  readonly navIcon?: React.ReactNode;
  /** Optional numeric sort order among plugin nav items (ascending, ties preserve registration order). */
  readonly navOrder?: number;
  /** Optional minimum visibility role for showing this link in navigation chrome. Defaults to 'public'. */
  readonly navMinRole?: KinloomUiPluginNavMinRole;
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
  /** Widget shelf rendered on IndexPage below indexHero and above the people filter bar. */
  readonly indexWidgets?: KinloomUiPluginSlotRenderer;
  readonly personDetail?: KinloomUiPluginSlotRenderer;
  /** Related-content panel rendered on PersonPage below PersonMediaSection (strictly deceased people only). */
  readonly personRelated?: KinloomUiPluginSlotRenderer;
  readonly narrativeHeader?: KinloomUiPluginSlotRenderer;
  readonly placeDetail?: KinloomUiPluginSlotRenderer;
  readonly sourceReaderFooter?: KinloomUiPluginSlotRenderer;
  readonly evidenceExtra?: KinloomUiPluginSlotRenderer;
  /** Persistent shell-level slot rendered as a sibling to routes (survives navigation). */
  readonly appShell?: KinloomUiPluginSlotRenderer;
  /** Optional inline slot inside the primary ExplorerTopBar navigation bar. */
  readonly topBarNav?: KinloomUiPluginSlotRenderer;
  /** Optional mobile menu item slot inside the ExplorerTopBar responsive Archive Menu. */
  readonly topBarMobileMenu?: KinloomUiPluginSlotRenderer;
  /** Optional inline slot inside the KinloomFooter navigation bar. */
  readonly footer?: KinloomUiPluginSlotRenderer;
  /** Admin-only settings slot rendered inside AdminSettingsShell alongside Core Application Settings. */
  readonly adminSettings?: KinloomUiPluginSlotRenderer;
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
  readonly version?: string;
  readonly status?: PluginRuntimeStatus;
  readonly changelog?: readonly ChangelogEntry[];
  readonly documentation?: PluginDocumentation;
  /** Optional React provider wrapping the app shell so plugin slots share persistent state across routes. */
  readonly provider?: React.ComponentType<{ children: React.ReactNode }>;
  readonly routes?: readonly KinloomUiPluginRoute[];
  readonly slots?: KinloomUiPluginSlots;
  readonly mediaRenderers?: readonly KinloomMediaRenderer[];
  readonly entityEditForms?: Readonly<Partial<Record<EntityType, EntityEditFormEntry>>>;
  readonly entityCreateForms?: Readonly<Partial<Record<EntityType, EntityCreateFormEntry>>>;
}
