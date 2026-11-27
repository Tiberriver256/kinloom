import type { Narrative, Person } from '@kinloom/core';
import type React from 'react';
import { initialsOf, resolveAssetUrl } from '../components/Atoms.js';
import {
  type ActiveNarrativeAudioTrack,
  type NarrativeAudioPluginOptions,
  NarrativeAudioProvider,
  type NarrativeAudioTrackMeta,
} from './narrativeAudio/audioContext.js';
import { NarrativeAudioDock, NarrativeAudioMarginBar } from './narrativeAudio/NarrativeAudioPlayers.js';
import type { KinloomUiPlugin, KinloomUiPluginSlotContext } from './types.js';

export type { ActiveNarrativeAudioTrack, NarrativeAudioPluginOptions, NarrativeAudioTrackMeta };

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
  return {
    file,
    duration_seconds: durationSeconds,
    editor_notes_start_seconds:
      notesStart !== undefined && (durationSeconds === undefined || notesStart < durationSeconds)
        ? notesStart
        : undefined,
    story_voice: asNonEmptyString(record.story_voice),
    notes_voice: asNonEmptyString(record.notes_voice),
  };
}

function isLivingPerson(person: Person | undefined): boolean {
  if (!person) {
    return false;
  }
  return person.is_living || person.full_name === 'Living';
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
    provider: NarrativeAudioProvider,
    slots: {
      narrativeHeader: renderNarrativeHeader,
      appShell: () => <NarrativeAudioDock />,
    },
  };
}
