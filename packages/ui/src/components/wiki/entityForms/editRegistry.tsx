import { type EntityPayload, EntityPayloadSchema, type EntityType } from '@kinloom/core';
import type React from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { cx } from '../../../lib/cx.js';
import { cleanPronunciation } from '../pronunciation/pronunciationDraft.js';
import formStyles from '../WikiForms.module.css';
import type { EntityEditFieldProps, EntityEditFormEntry } from './fieldTypes.js';
import { asString, asStringArray } from './fieldTypes.js';

const PersonEditFields: React.FC<EntityEditFieldProps> = ({
  draft,
  isBusy,
  uiStyles = formStyles,
  updateField,
}) => (
  <>
    <div className={cx(uiStyles, 'wiki-field-grid')}>
      <label className={cx(uiStyles, 'wiki-field')}>
        <span className={cx(uiStyles, 'wiki-field-label')}>Full name</span>
        <input
          type="text"
          className={cx(uiStyles, 'wiki-input')}
          value={asString(draft.full_name)}
          onChange={(e) => {
            updateField('full_name', e.target.value);
          }}
          disabled={isBusy}
        />
      </label>
      <label className={cx(uiStyles, 'wiki-field')}>
        <span className={cx(uiStyles, 'wiki-field-label')}>Given name</span>
        <input
          type="text"
          className={cx(uiStyles, 'wiki-input')}
          value={asString(draft.given_name)}
          onChange={(e) => {
            updateField('given_name', e.target.value);
          }}
          disabled={isBusy}
        />
      </label>
      <label className={cx(uiStyles, 'wiki-field')}>
        <span className={cx(uiStyles, 'wiki-field-label')}>Surname</span>
        <input
          type="text"
          className={cx(uiStyles, 'wiki-input')}
          value={asString(draft.surname)}
          onChange={(e) => {
            updateField('surname', e.target.value);
          }}
          disabled={isBusy}
        />
      </label>
      <label className={cx(uiStyles, 'wiki-field')}>
        <span className={cx(uiStyles, 'wiki-field-label')}>Birth date</span>
        <input
          type="text"
          className={cx(uiStyles, 'wiki-input')}
          placeholder="e.g. 1850-04-12 or 1850"
          value={asString(draft.birth_edtf)}
          onChange={(e) => {
            updateField('birth_edtf', e.target.value);
          }}
          disabled={isBusy}
        />
      </label>
      <label className={cx(uiStyles, 'wiki-field')}>
        <span className={cx(uiStyles, 'wiki-field-label')}>Death date</span>
        <input
          type="text"
          className={cx(uiStyles, 'wiki-input')}
          placeholder="Leave blank if living or unknown"
          value={asString(draft.death_edtf)}
          onChange={(e) => {
            updateField('death_edtf', e.target.value);
          }}
          disabled={isBusy}
        />
      </label>
      <label className={cx(uiStyles, 'wiki-field')}>
        <span className={cx(uiStyles, 'wiki-field-label')}>Nicknames or maiden names</span>
        <input
          type="text"
          className={cx(uiStyles, 'wiki-input')}
          placeholder="Separate multiple names with commas"
          value={asStringArray(draft.alt_names).join(', ')}
          onChange={(e) => {
            const list = e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            updateField('alt_names', list);
          }}
          disabled={isBusy}
        />
      </label>
    </div>
    <label className={cx(uiStyles, 'wiki-checkbox-row')}>
      <input
        type="checkbox"
        checked={Boolean(draft.is_living)}
        onChange={(e) => {
          updateField('is_living', e.target.checked);
        }}
        disabled={isBusy}
      />
      <span>Living person (strictly hides portraits, street addresses, and exact birth dates)</span>
    </label>
  </>
);

const PlaceEditFields: React.FC<EntityEditFieldProps> = ({
  draft,
  isBusy,
  uiStyles = formStyles,
  updateField,
}) => (
  <div className={cx(uiStyles, 'wiki-field-grid')}>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Short name</span>
      <input
        type="text"
        className={cx(uiStyles, 'wiki-input')}
        value={asString(draft.name)}
        onChange={(e) => {
          updateField('name', e.target.value);
        }}
        disabled={isBusy}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Full hierarchical name</span>
      <input
        type="text"
        className={cx(uiStyles, 'wiki-input')}
        value={asString(draft.full_name)}
        onChange={(e) => {
          updateField('full_name', e.target.value);
        }}
        disabled={isBusy}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Latitude</span>
      <input
        type="number"
        step="any"
        className={cx(uiStyles, 'wiki-input')}
        value={typeof draft.lat === 'number' ? draft.lat : 0}
        onChange={(e) => {
          updateField('lat', Number(e.target.value));
        }}
        disabled={isBusy}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Longitude</span>
      <input
        type="number"
        step="any"
        className={cx(uiStyles, 'wiki-input')}
        value={typeof draft.lng === 'number' ? draft.lng : 0}
        onChange={(e) => {
          updateField('lng', Number(e.target.value));
        }}
        disabled={isBusy}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field wiki-field-full')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Historical profile</span>
      <textarea
        className={cx(uiStyles, 'wiki-textarea')}
        rows={5}
        value={asString(draft.summary)}
        onChange={(e) => {
          updateField('summary', e.target.value);
        }}
        disabled={isBusy}
      />
    </label>
  </div>
);

const EventEditFields: React.FC<EntityEditFieldProps> = ({
  draft,
  isBusy,
  uiStyles = formStyles,
  updateField,
}) => (
  <div className={cx(uiStyles, 'wiki-field-grid')}>
    <label className={cx(uiStyles, 'wiki-field wiki-field-full')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Event title</span>
      <input
        type="text"
        className={cx(uiStyles, 'wiki-input')}
        value={asString(draft.title)}
        onChange={(e) => {
          updateField('title', e.target.value);
        }}
        disabled={isBusy}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Date</span>
      <input
        type="text"
        className={cx(uiStyles, 'wiki-input')}
        value={asString(draft.edtf_date)}
        onChange={(e) => {
          updateField('edtf_date', e.target.value);
        }}
        disabled={isBusy}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field wiki-field-full')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Narrative summary</span>
      <textarea
        className={cx(uiStyles, 'wiki-textarea')}
        rows={5}
        value={asString(draft.summary)}
        onChange={(e) => {
          updateField('summary', e.target.value);
        }}
        disabled={isBusy}
      />
    </label>
  </div>
);

const NarrativeEditFields: React.FC<EntityEditFieldProps> = ({
  draft,
  isBusy,
  uiStyles = formStyles,
  updateField,
}) => (
  <div className={cx(uiStyles, 'wiki-field-grid')}>
    <label className={cx(uiStyles, 'wiki-field wiki-field-full')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Narrative title</span>
      <input
        type="text"
        className={cx(uiStyles, 'wiki-input')}
        value={asString(draft.title)}
        onChange={(e) => {
          updateField('title', e.target.value);
        }}
        disabled={isBusy}
      />
    </label>
    <label className={cx(uiStyles, 'wiki-field wiki-field-full')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Story text</span>
      <textarea
        className={cx(uiStyles, 'wiki-textarea')}
        rows={8}
        value={asString(draft.body_md)}
        onChange={(e) => {
          updateField('body_md', e.target.value);
        }}
        disabled={isBusy}
      />
    </label>
  </div>
);

const JsonFallbackEditFields: React.FC<EntityEditFieldProps> = ({
  draft,
  isBusy,
  uiStyles = formStyles,
  replaceDraft,
}) => {
  const errorId = useId();
  const [rawText, setRawText] = useState<string>(() => JSON.stringify(draft, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const lastEmittedDraftRef = useRef<EntityPayload | null>(null);

  useEffect(() => {
    if (draft === lastEmittedDraftRef.current) {
      return;
    }
    setRawText(JSON.stringify(draft, null, 2));
    setJsonError(null);
  }, [draft]);

  return (
    <label className={cx(uiStyles, 'wiki-field wiki-field-full')}>
      <span className={cx(uiStyles, 'wiki-field-label')}>Record details</span>
      <textarea
        className={cx(uiStyles, 'wiki-textarea wiki-mono')}
        rows={8}
        value={rawText}
        aria-invalid={jsonError ? 'true' : 'false'}
        aria-describedby={jsonError ? errorId : undefined}
        onChange={(e) => {
          const nextText = e.target.value;
          setRawText(nextText);
          let parsed: unknown;
          try {
            parsed = JSON.parse(nextText);
          } catch {
            setJsonError('Enter valid JSON syntax for this record.');
            return;
          }
          const validated = EntityPayloadSchema.safeParse(parsed);
          if (!validated.success) {
            setJsonError('Record details must be a JSON object, not an array or primitive value.');
            return;
          }
          setJsonError(null);
          lastEmittedDraftRef.current = validated.data;
          replaceDraft(validated.data);
        }}
        disabled={isBusy}
      />
      {jsonError && (
        <p id={errorId} className={cx(uiStyles, 'wiki-field-error')} role="alert">
          {jsonError}
        </p>
      )}
    </label>
  );
};

function preparePronunciationDraft(draft: EntityPayload, forceNull: boolean): EntityPayload | null {
  const cleanedPronunciation = forceNull ? null : cleanPronunciation(draft.pronunciation, true);
  if (JSON.stringify(cleanedPronunciation) === JSON.stringify(draft.pronunciation ?? null)) {
    return null;
  }
  return {
    ...draft,
    pronunciation: cleanedPronunciation,
  };
}

export const FALLBACK_EDIT_FORM_ENTRY: EntityEditFormEntry = {
  Fields: JsonFallbackEditFields,
};

export const ENTITY_EDIT_FORM_REGISTRY: Readonly<Partial<Record<EntityType, EntityEditFormEntry>>> = {
  person: {
    Fields: PersonEditFields,
    pronunciationEntityType: 'person',
    supportsPronunciation: (draft) => !draft?.is_living && asString(draft?.full_name) !== 'Living',
    getPronunciationPreviewLabel: (draft, title, entityId) => asString(draft.full_name) || title || entityId,
    prepareSubmitDraft: (draft) => preparePronunciationDraft(draft, Boolean(draft.is_living)),
  },
  place: {
    Fields: PlaceEditFields,
    pronunciationEntityType: 'place',
    supportsPronunciation: () => true,
    getPronunciationPreviewLabel: (draft, title, entityId) =>
      asString(draft.name) || asString(draft.full_name) || title || entityId,
    prepareSubmitDraft: (draft) => preparePronunciationDraft(draft, false),
  },
  event: {
    Fields: EventEditFields,
  },
  narrative: {
    Fields: NarrativeEditFields,
  },
};

export function getEntityEditFormEntry(
  entityType: EntityType,
  overrides?: Readonly<Partial<Record<EntityType, EntityEditFormEntry>>>
): EntityEditFormEntry {
  return overrides?.[entityType] ?? ENTITY_EDIT_FORM_REGISTRY[entityType] ?? FALLBACK_EDIT_FORM_ENTRY;
}
