import type { Narrative, Person } from '@kinloom/core';
import type React from 'react';
import { initialsOf, resolveAssetUrl } from '../components/Atoms.js';
import { KINLOOM_UI_VERSION } from '../version.js';
import {
  type ActiveNarrativeAudioTrack,
  type NarrativeAudioKind,
  type NarrativeAudioLabels,
  type NarrativeAudioPluginOptions,
  NarrativeAudioProvider,
  type NarrativeAudioTrackMeta,
  resolveNarrativeAudioLabels,
} from './narrativeAudio/audioContext.js';
import { NarrativeAudioDock, NarrativeAudioMarginBar } from './narrativeAudio/NarrativeAudioPlayers.js';
import type {
  KinloomOnboardingContext,
  KinloomOnboardingStep,
  KinloomUiPlugin,
  KinloomUiPluginSlotContext,
} from './types.js';

export type {
  ActiveNarrativeAudioTrack,
  NarrativeAudioKind,
  NarrativeAudioLabels,
  NarrativeAudioPluginOptions,
  NarrativeAudioTrackMeta,
};
export { resolveNarrativeAudioLabels };

function asPositiveFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

/**
 * Resolves the display narrative kind for audio narration controls from explicit `narrative.kind`,
 * falling back to `subject_person_id` / single-person biography heuristics when `kind` is omitted.
 */
export function resolveNarrativeAudioKind(
  narrative: Narrative,
  person: Person | undefined
): NarrativeAudioKind {
  if (
    narrative.kind === 'biography' ||
    narrative.kind === 'family_story' ||
    narrative.kind === 'research_note' ||
    narrative.kind === 'memoir'
  ) {
    return narrative.kind;
  }
  if (person && narrative.subject_person_id === person.id) {
    return 'biography';
  }
  if (
    person &&
    narrative.subject_person_id === undefined &&
    narrative.person_ids.length === 1 &&
    narrative.person_ids[0] === person.id
  ) {
    return 'biography';
  }
  return 'family_story';
}

/**
 * Extracts validated `narrative_audio` metadata from `narrative.extensions`.
 * Returns `null` if the narrative has no attached narration audio.
 */
export function readNarrativeAudioMeta(narrative: Narrative | undefined): NarrativeAudioTrackMeta | null {
  if (!narrative?.extensions) {
    return null;
  }
  const raw = narrative.extensions.narrative_audio ?? narrative.extensions.audio;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const file = asNonEmptyString(record.file);
  if (!file) {
    return null;
  }
  const durationSeconds = asPositiveFiniteNumber(record.duration_seconds);
  const notesStart = asPositiveFiniteNumber(record.editor_notes_start_seconds);
  const label = asNonEmptyString(record.label);
  return {
    file,
    duration_seconds: durationSeconds,
    editor_notes_start_seconds:
      notesStart !== undefined && (durationSeconds === undefined || notesStart < durationSeconds)
        ? notesStart
        : undefined,
    story_voice: asNonEmptyString(record.story_voice),
    notes_voice: asNonEmptyString(record.notes_voice),
    ...(label !== undefined ? { label } : {}),
  };
}

function isLivingPerson(person: Person | undefined): boolean {
  if (!person) {
    return false;
  }
  return person.is_living || person.full_name === 'Living';
}

const NARRATIVE_AUDIO_DOCS = {
  id: 'docs-narrative-audio-ui',
  title: 'Narrative Audio Player',
  summary: 'Persistent audio player and narrative header controls for spoken family stories.',
  sections: [
    {
      id: 'playback',
      heading: 'Audio Playback Across Routes',
      markdown:
        'Adds a listen button to narrative headers and mounts a persistent mini-player in the app shell so visitors can keep listening while navigating the archive.',
    },
  ],
} as const;

function findFirstNarratedPublicPerson(ctx: KinloomOnboardingContext): Person | null {
  const bundle = ctx.bundle;
  if (!bundle) {
    return null;
  }
  const peopleById = new Map(bundle.people.map((person) => [person.id, person]));
  const narratedPersonIds = new Set<string>();
  for (const narrative of bundle.narratives ?? []) {
    if (readNarrativeAudioMeta(narrative) === null) {
      continue;
    }
    if (narrative.subject_person_id) {
      narratedPersonIds.add(narrative.subject_person_id);
    }
    for (const personId of narrative.person_ids) {
      narratedPersonIds.add(personId);
    }
  }
  const candidates: Person[] = [];
  for (const personId of narratedPersonIds) {
    const person = peopleById.get(personId);
    if (person && !isLivingPerson(person)) {
      candidates.push(person);
    }
  }
  if (candidates.length === 0) {
    return null;
  }
  return candidates.toSorted((a, b) => a.full_name.localeCompare(b.full_name))[0] ?? null;
}

export function createNarrativeAudioPlugin(options: NarrativeAudioPluginOptions = {}): KinloomUiPlugin {
  const id = options.id ?? 'kinloom-narrative-audio';
  const defaultStoryVoice = options.defaultStoryVoice ?? 'Charon';
  const defaultNotesVoice = options.defaultNotesVoice ?? 'Kore';

  const renderNarrativeHeader = (ctx: KinloomUiPluginSlotContext): React.ReactNode => {
    if (!ctx.narrative || isLivingPerson(ctx.person)) {
      return null;
    }
    const meta = readNarrativeAudioMeta(ctx.narrative);
    if (!meta) {
      return null;
    }
    const track: ActiveNarrativeAudioTrack = {
      narrativeId: ctx.narrative.id,
      narrativeTitle: ctx.narrative.title,
      narrativeKind: resolveNarrativeAudioKind(ctx.narrative, ctx.person),
      customLabel: meta.label ?? null,
      personName: ctx.person?.full_name ?? null,
      personSlug: ctx.person?.slug ?? null,
      personInitials: ctx.person ? initialsOf(ctx.person.full_name) : '♫',
      src: resolveAssetUrl(meta.file, ctx.baseUrl),
      duration: meta.duration_seconds ?? null,
      editorNotesStart: meta.editor_notes_start_seconds ?? null,
      storyVoice: meta.story_voice ?? defaultStoryVoice,
      notesVoice: meta.notes_voice ?? defaultNotesVoice,
    };
    return <NarrativeAudioMarginBar track={track} />;
  };

  return {
    id,
    name: 'Narrative Audio',
    documentation: NARRATIVE_AUDIO_DOCS,
    version: KINLOOM_UI_VERSION,
    changelog: [
      {
        version: '0.61.0',
        date: '2026-11-28',
        summary: 'Kind-aware Narrative Audio margin bar and persistent playback dock.',
        changes: [
          { category: 'added', text: 'Kind-aware Narrative Audio margin bar and persistent playback dock.' },
        ],
      },
    ],
    status: 'active',
    provider: NarrativeAudioProvider,
    slots: {
      narrativeHeader: renderNarrativeHeader,
      appShell: () => <NarrativeAudioDock />,
    },
    getOnboardingSteps(ctx: KinloomOnboardingContext): readonly KinloomOnboardingStep[] {
      const targetPerson = findFirstNarratedPublicPerson(ctx);
      if (!targetPerson) {
        return [];
      }
      return [
        {
          id: `${id}:listen-biography`,
          title: 'Listen to a narrated story',
          description: `Open ${targetPerson.full_name}'s dossier and play a spoken family biography while you browse.`,
          roles: ['viewer', 'editor'],
          order: 180,
          action: {
            kind: 'route',
            to: `/person/${targetPerson.slug}`,
            label: `Listen on ${targetPerson.full_name}`,
          },
        },
      ];
    },
  };
}
