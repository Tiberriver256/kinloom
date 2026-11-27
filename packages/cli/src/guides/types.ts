import type { RecordCommandCategory } from '../commands/records/registry.js';

export type GuideCategory = RecordCommandCategory | 'ops';

export interface GuideCategoryInfo {
  readonly id: GuideCategory;
  readonly heading: string;
}

export interface EmbeddedGuide {
  readonly id: string;
  readonly command: string;
  readonly aliases?: readonly string[];
  readonly category: GuideCategory;
  readonly summary: string;
  readonly body: string;
  readonly subguides?: Readonly<Record<string, string>>;
}
