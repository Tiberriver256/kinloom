import type { EntityPayload, EntityType } from '@kinloom/core';
import { deriveKinshipEdgeId, isEditSummaryValid } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { cx } from '../../lib/cx.js';
import { handleTablistKeyDown } from '../../lib/keyboardNav.js';
import { useDialogFocusTrap } from '../../lib/useDialogFocusTrap.js';
import cssMod2 from '../../pages/IndexPage.module.css';
import cssMod0 from '../SourceReaderDrawer.module.css';
import {
  buildPersonCreatePayload,
  CREATABLE_KIND_ORDER,
  ENTITY_CREATE_FORM_REGISTRY,
  LinkExistingRelativeFields,
  PersonCreateFields,
} from './entityForms/createRegistry.js';
import type {
  CreatableKind,
  CreateEntityDraft,
  PersonLineageGroup,
  PersonSex,
  RelativeCreateContext,
  RelativeModalTab,
  RelativeRelation,
} from './entityForms/fieldTypes.js';
import {
  buildUniquePersonIdentity,
  createInitialEntityDraft,
  RELATIVE_RELATION_SPECS,
} from './entityForms/fieldTypes.js';
import { CitationBadge } from './WikiBadges.js';
import cssMod1_0 from './WikiChrome.module.css';
import cssMod1_2 from './WikiForms.module.css';
import cssMod1_1 from './WikiPanels.module.css';

export type { CreatableKind, PersonLineageGroup, PersonSex, RelativeCreateContext, RelativeRelation };
export { buildUniquePersonIdentity };

const uiStyles: Readonly<Record<string, string>> = {
  ...cssMod0,
  ...cssMod1_0,
  ...cssMod1_1,
  ...cssMod1_2,
  ...cssMod2,
};

export interface CreateEntityModalProps {
  open: boolean;
  defaultKind?: CreatableKind;
  defaultPersonId?: string;
  relativeContext?: RelativeCreateContext;
  onClose: () => void;
  onCreated?: (entityType: EntityType, entity: EntityPayload) => void;
}

export const CreateEntityModal: React.FC<CreateEntityModalProps> = ({
  open,
  defaultKind = 'person',
  defaultPersonId,
  relativeContext,
  onClose,
  onCreated,
}) => {
  const { dataSource, bundle, reloadArchive } = useArchiveData();
  const anchorId = relativeContext?.anchorPersonId ?? null;
  const anchorRelation = relativeContext?.relation ?? null;

  const [kind, setKind] = useState<CreatableKind>(defaultKind);
  const [relativeTab, setRelativeTab] = useState<RelativeModalTab>('create_new');
  const [summary, setSummary] = useState('');
  const [hasPrimarySource, setHasPrimarySource] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CreateEntityDraft>(() =>
    createInitialEntityDraft(defaultPersonId, anchorRelation)
  );

  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useDialogFocusTrap({
    open,
    onClose,
    initialFocusRef: closeBtnRef,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-initialize form defaults when anchor entity changes
  useEffect(() => {
    if (!open) {
      return;
    }
    setKind(defaultKind);
    setRelativeTab('create_new');
    setSummary('');
    setHasPrimarySource(true);
    setError(null);
    setDraft(createInitialEntityDraft(defaultPersonId, anchorRelation));
  }, [open, defaultKind, defaultPersonId, anchorId, anchorRelation]);

  const updateDraft = useCallback(
    <K extends keyof CreateEntityDraft>(key: K, value: CreateEntityDraft[K]): void => {
      setDraft((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const people = useMemo(() => bundle?.people ?? [], [bundle]);
  const places = useMemo(() => bundle?.places ?? [], [bundle]);

  const filteredExistingCandidates = useMemo(() => {
    if (!relativeContext) {
      return [];
    }
    const q = draft.existingQuery.trim().toLowerCase();
    return people
      .filter((p) => p.id !== relativeContext.anchorPersonId)
      .filter((p) => {
        if (!q) {
          return true;
        }
        const matchFull = p.full_name.toLowerCase().includes(q);
        const matchAlt = (p.alt_names || []).some((alt) => alt.toLowerCase().includes(q));
        return matchFull || matchAlt;
      })
      .toSorted((a, b) => a.full_name.localeCompare(b.full_name));
  }, [people, relativeContext, draft.existingQuery]);

  if (!open) {
    return null;
  }

  const relativeSpec = relativeContext ? RELATIVE_RELATION_SPECS[relativeContext.relation] : null;
  const activeCreateEntry = ENTITY_CREATE_FORM_REGISTRY[kind];
  const ActiveFields = activeCreateEntry.Fields;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!dataSource.createEntity) {
      setError('This archive is in read-only mode.');
      return;
    }
    if (!isEditSummaryValid(summary)) {
      setError('Edit summary must be at least 3 characters.');
      return;
    }

    const trimmedSummary = summary.trim();

    if (relativeContext && relativeSpec) {
      if (relativeTab === 'link_existing') {
        if (!draft.existingPersonId || draft.existingPersonId === relativeContext.anchorPersonId) {
          setError('Choose an existing person to link.');
          return;
        }
        const edge = relativeSpec.buildEdge(relativeContext.anchorPersonId, draft.existingPersonId);
        const edgeId = deriveKinshipEdgeId(edge);
        setSubmitting(true);
        setError(null);
        try {
          const edgeRes = await dataSource.createEntity('kinship_edge', {
            entity_id: edgeId,
            data: edge,
            summary: trimmedSummary,
            has_primary_source: hasPrimarySource,
          });
          reloadArchive();
          onCreated?.('kinship_edge', edgeRes.entity);
          onClose();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setSubmitting(false);
        }
        return;
      }

      const personResult = buildPersonCreatePayload(draft, people, hasPrimarySource);
      if (!personResult.ok) {
        setError(personResult.error);
        return;
      }
      const edge = relativeSpec.buildEdge(relativeContext.anchorPersonId, personResult.entityId);
      const edgeId = deriveKinshipEdgeId(edge);

      setSubmitting(true);
      setError(null);
      let createdPerson = false;
      try {
        const personRes = await dataSource.createEntity('person', {
          entity_id: personResult.entityId,
          data: personResult.payload,
          summary: trimmedSummary,
          has_primary_source: hasPrimarySource,
        });
        createdPerson = true;
        await dataSource.createEntity('kinship_edge', {
          entity_id: edgeId,
          data: edge,
          summary: trimmedSummary,
          has_primary_source: hasPrimarySource,
        });
        reloadArchive();
        onCreated?.('person', personRes.entity);
        onClose();
      } catch (err) {
        if (createdPerson) {
          reloadArchive();
          setError(
            `Person record saved, but linking failed: ${err instanceof Error ? err.message : String(err)}`
          );
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const built = activeCreateEntry.validateAndBuild(draft, { people, hasPrimarySource });
    if (!built.ok) {
      setError(built.error);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await dataSource.createEntity(kind, {
        entity_id: built.entityId,
        data: built.payload,
        summary: trimmedSummary,
        has_primary_source: hasPrimarySource,
      });
      reloadArchive();
      onCreated?.(kind, res.entity);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const modalTitle =
    relativeContext && relativeSpec
      ? `${relativeSpec.headingPrefix} ${relativeContext.anchorPersonName}`
      : 'Add to the Family Archive';

  const submitLabel = submitting
    ? 'Saving…'
    : relativeContext
      ? relativeTab === 'link_existing'
        ? 'Link Relative'
        : 'Save & Link Relative'
      : 'Save to Archive';

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      className={cx(uiStyles, 'lightbox-backdrop')}
      aria-label={modalTitle}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx(uiStyles, 'lightbox-backdrop-close')}
        aria-label="Close create record modal"
        onClick={onClose}
      />
      <div className={cx(uiStyles, 'wiki-modal-card')}>
        <div className={cx(uiStyles, 'wiki-modal-header')}>
          <h2>{modalTitle}</h2>
          <button ref={closeBtnRef} type="button" className={cx(uiStyles, 'pill-btn')} onClick={onClose}>
            Close
          </button>
        </div>

        {relativeContext ? (
          <div
            className={cx(uiStyles, 'filter-bar')}
            role="tablist"
            aria-label="How to add relative"
            onKeyDown={(event) => {
              handleTablistKeyDown(event, ['create_new', 'link_existing'] as const, relativeTab, (next) => {
                setRelativeTab(next);
                setError(null);
              });
            }}
          >
            {(
              [
                ['create_new', 'Create new person'],
                ['link_existing', 'Link existing person'],
              ] as const
            ).map(([tabId, label]) => (
              <button
                key={tabId}
                type="button"
                role="tab"
                tabIndex={relativeTab === tabId ? 0 : -1}
                aria-selected={relativeTab === tabId}
                className={cx(uiStyles, `pill-btn ${relativeTab === tabId ? 'active' : ''}`)}
                onClick={() => {
                  setRelativeTab(tabId);
                  setError(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        ) : (
          <div
            className={cx(uiStyles, 'filter-bar')}
            role="tablist"
            aria-label="Record type to create"
            onKeyDown={(event) => {
              handleTablistKeyDown(event, CREATABLE_KIND_ORDER, kind, (next) => {
                setKind(next);
                setError(null);
              });
            }}
          >
            {CREATABLE_KIND_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                tabIndex={kind === id ? 0 : -1}
                aria-selected={kind === id}
                className={cx(uiStyles, `pill-btn ${kind === id ? 'active' : ''}`)}
                onClick={() => {
                  setKind(id);
                  setError(null);
                }}
              >
                {ENTITY_CREATE_FORM_REGISTRY[id].tabLabel}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className={cx(uiStyles, 'wiki-status-banner is-error')} role="alert">
            {error}
          </div>
        )}

        <form
          className={cx(uiStyles, 'wiki-edit-form')}
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
        >
          {relativeContext && relativeSpec ? (
            relativeTab === 'create_new' ? (
              <PersonCreateFields
                draft={draft}
                updateDraft={updateDraft}
                people={people}
                places={places}
                uiStyles={uiStyles}
              />
            ) : (
              <LinkExistingRelativeFields
                linkHint={relativeSpec.linkHint(relativeContext.anchorPersonName)}
                existingQuery={draft.existingQuery}
                existingPersonId={draft.existingPersonId}
                candidates={filteredExistingCandidates}
                uiStyles={uiStyles}
                onQueryChange={(value) => {
                  updateDraft('existingQuery', value);
                }}
                onPersonIdChange={(value) => {
                  updateDraft('existingPersonId', value);
                }}
              />
            )
          ) : (
            <ActiveFields
              draft={draft}
              updateDraft={updateDraft}
              people={people}
              places={places}
              uiStyles={uiStyles}
            />
          )}

          <label className={cx(uiStyles, 'wiki-checkbox-row')}>
            <input
              type="checkbox"
              checked={hasPrimarySource}
              onChange={(e) => {
                setHasPrimarySource(e.target.checked);
              }}
            />
            <CitationBadge hasPrimarySource={hasPrimarySource} />
            <span>
              {hasPrimarySource
                ? 'Backed by a primary archival source'
                : 'Family memory (uncited until verified)'}
            </span>
          </label>

          <label className={cx(uiStyles, 'wiki-field')}>
            <span className={cx(uiStyles, 'wiki-field-label')}>Note about this addition</span>
            <input
              type="text"
              className={cx(uiStyles, 'wiki-input')}
              required
              minLength={3}
              placeholder="e.g. From family photo album or 1880 census"
              value={summary}
              onChange={(e) => {
                setSummary(e.target.value);
              }}
            />
          </label>

          <div className={cx(uiStyles, 'wiki-form-actions')}>
            <button
              type="submit"
              className={cx(uiStyles, 'wiki-btn-primary wiki-btn-sm')}
              disabled={submitting || !isEditSummaryValid(summary)}
            >
              {submitLabel}
            </button>
            <button type="button" className={cx(uiStyles, 'pill-btn')} onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
};
