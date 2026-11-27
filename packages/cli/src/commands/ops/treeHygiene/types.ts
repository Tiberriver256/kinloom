export type TreeHygieneCategory =
  | 'excess_parents'
  | 'parent_child_chronology'
  | 'child_marriage'
  | 'duplicate_vital_event'
  | 'placeholder_event';

export const TREE_HYGIENE_CATEGORIES: readonly TreeHygieneCategory[] = [
  'excess_parents',
  'parent_child_chronology',
  'child_marriage',
  'duplicate_vital_event',
  'placeholder_event',
];

export interface TreeHygieneWarning {
  category: TreeHygieneCategory;
  personIds: string[];
  eventIds?: string[];
  message: string;
}

export interface TreeHygieneSummary {
  warnings: TreeHygieneWarning[];
  counts: Record<TreeHygieneCategory, number>;
}

export interface ParsedDatePart {
  year: number;
  month: number | null;
  day: number | null;
}

export interface ParsedEdtfRange {
  minYear: number | null;
  maxYear: number | null;
  minDate: ParsedDatePart | null;
  maxDate: ParsedDatePart | null;
}

export const MIN_PARENT_AGE_YEARS = 13;
export const MIN_MARRIAGE_AGE_YEARS = 14;
export const PLACEHOLDER_EVENT_PREFIX = 'Recorded event for ';
