import { PLACEHOLDER_EVENT_PREFIX, type TreeHygieneWarning } from './types.js';

function isSubsetOf(candidate: readonly string[], superset: ReadonlySet<string>): boolean {
  for (const item of candidate) {
    if (!superset.has(item)) {
      return false;
    }
  }
  return true;
}

function parentChildSubkind(message: string): string {
  if (message.includes('was born after mother')) {
    return 'after_mother_death';
  }
  if (message.includes('was born more than 1 year after')) {
    return 'after_parent_death';
  }
  return 'young_parent';
}

function warningTouchesScope(
  warning: TreeHygieneWarning,
  touchedPersonIds: ReadonlySet<string>,
  touchedEventIds: ReadonlySet<string>
): boolean {
  if (warning.personIds.some((id) => touchedPersonIds.has(id))) {
    return true;
  }
  if ((warning.eventIds ?? []).some((id) => touchedEventIds.has(id))) {
    return true;
  }
  return false;
}

function isPreExistingHygieneWarning(
  postWarning: TreeHygieneWarning,
  preWarnings: readonly TreeHygieneWarning[]
): boolean {
  switch (postWarning.category) {
    case 'duplicate_vital_event': {
      const postPeopleKey = postWarning.personIds.join(',');
      const postEvents = postWarning.eventIds ?? [];
      if (postEvents.length === 0) {
        return false;
      }
      return preWarnings.some((pre) => {
        if (pre.category !== 'duplicate_vital_event') {
          return false;
        }
        if (pre.personIds.join(',') !== postPeopleKey) {
          return false;
        }
        return isSubsetOf(postEvents, new Set(pre.eventIds ?? []));
      });
    }
    case 'excess_parents': {
      const postChildId = postWarning.personIds[0] ?? '';
      const postParents = postWarning.personIds.slice(1);
      return preWarnings.some((pre) => {
        if (pre.category !== 'excess_parents' || pre.personIds[0] !== postChildId) {
          return false;
        }
        return isSubsetOf(postParents, new Set(pre.personIds.slice(1)));
      });
    }
    case 'child_marriage': {
      const postPeopleKey = postWarning.personIds.join(',');
      const postEventsKey = (postWarning.eventIds ?? []).join(',');
      return preWarnings.some(
        (pre) =>
          pre.category === 'child_marriage' &&
          pre.personIds.join(',') === postPeopleKey &&
          (pre.eventIds ?? []).join(',') === postEventsKey
      );
    }
    case 'parent_child_chronology': {
      const postPeopleKey = postWarning.personIds.join(',');
      const postSubkind = parentChildSubkind(postWarning.message);
      return preWarnings.some(
        (pre) =>
          pre.category === 'parent_child_chronology' &&
          pre.personIds.join(',') === postPeopleKey &&
          parentChildSubkind(pre.message) === postSubkind
      );
    }
    case 'placeholder_event': {
      const postEventsKey = (postWarning.eventIds ?? []).join(',');
      return preWarnings.some(
        (pre) => pre.category === 'placeholder_event' && (pre.eventIds ?? []).join(',') === postEventsKey
      );
    }
    default: {
      const _exhaustive: never = postWarning.category;
      return _exhaustive;
    }
  }
}

export function diffTreeHygieneWarnings(input: {
  preWarnings: readonly TreeHygieneWarning[];
  postWarnings: readonly TreeHygieneWarning[];
  touchedPersonIds: ReadonlySet<string>;
  touchedEventIds: ReadonlySet<string>;
}): TreeHygieneWarning[] {
  return input.postWarnings.filter(
    (warning) =>
      warningTouchesScope(warning, input.touchedPersonIds, input.touchedEventIds) &&
      !isPreExistingHygieneWarning(warning, input.preWarnings)
  );
}

export function formatAuditHygieneWarningMessage(warning: TreeHygieneWarning): string {
  const detail = warning.message.replace(/\.$/, '');
  switch (warning.category) {
    case 'duplicate_vital_event':
      return `Staged patch introduces duplicate vital event (${detail}); update the existing event ID in place or include it in remove_event_ids.`;
    case 'child_marriage':
      return `Staged patch introduces child marriage warning (${detail}); verify the birth/marriage dates or participant roles.`;
    case 'parent_child_chronology':
      return `Staged patch introduces parent-child chronology anomaly (${detail}); verify parent/child dates or kinship edges.`;
    case 'excess_parents':
      return `Staged patch introduces excess non-adoptive parents (${detail}); verify kinship edges or mark adoptive links.`;
    case 'placeholder_event':
      return `Staged patch introduces placeholder event (${detail}); replace the generic "${PLACEHOLDER_EVENT_PREFIX}" title with a descriptive title.`;
    default: {
      const _exhaustive: never = warning.category;
      return _exhaustive;
    }
  }
}
