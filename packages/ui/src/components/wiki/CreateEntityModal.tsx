import type { EntityPayload, EntityType } from '@kinloom/core';
import { deriveKinshipEdgeId, isEditSummaryValid } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { handleTablistKeyDown } from '../../hooks/keyboardNav.js';
import { useDialogFocusTrap } from '../../hooks/useDialogFocusTrap.js';
import { cx } from '../../lib/cx.js';
import { useKinloomPlugins } from '../../plugins/PluginContext.js';
import controlStyles from '../../styles/Controls.module.css';
import overlayStyles from '../../styles/Overlays.module.css';
import {
  buildPersonCreatePayload,
  ENTITY_CREATE_FORM_REGISTRY,
  LinkExistingRelativeFields,
  PersonCreateFields,
  resolveCreateFormRegistry,
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
import wikiChromeStyles from './WikiChrome.module.css';
import wikiFormStyles from './WikiForms.module.css';
import wikiPanelStyles from './WikiPanels.module.css';

export type { CreatableKind, PersonLineageGroup, PersonSex, RelativeCreateContext, RelativeRelation };
export { buildUniquePersonIdentity };

export interface CreateEntityModalProps {
  open: boolean;
  defaultKind?: EntityType;
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
  const { entityCreateForms } = useKinloomPlugins();
  const createRegistry = useMemo(() => resolveCreateFormRegistry(entityCreateForms), [entityCreateForms]);
  const anchorId = relativeContext?.anchorPersonId ?? null;
  const anchorRelation = relativeContext?.relation ?? null;

  const resolveSupportedKind = useCallback(
    (requested: EntityType): EntityType => {
      if (createRegistry.entries[requested]) {
        return requested;
      }
      return createRegistry.order[0] ?? 'person';
    },
    [createRegistry]
  );

  const [kind, setKind] = useState<EntityType>(() => resolveSupportedKind(defaultKind));
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
    setKind(resolveSupportedKind(defaultKind));
    setRelativeTab('create_new');
    setSummary('');
    setHasPrimarySource(true);
    setError(null);
    setDraft(createInitialEntityDraft(defaultPersonId, anchorRelation));
  }, [open, defaultKind, defaultPersonId, anchorId, anchorRelation, resolveSupportedKind]);

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
  const resolvedKind = resolveSupportedKind(kind);
  const activeCreateEntry = createRegistry.entries[resolvedKind] ?? ENTITY_CREATE_FORM_REGISTRY.person;
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
    const targetKind = activeCreateEntry.kind;
    try {
      const res = await dataSource.createEntity(targetKind, {
        entity_id: built.entityId,
        data: built.payload,
        summary: trimmedSummary,
        has_primary_source: hasPrimarySource,
      });
      reloadArchive();
      onCreated?.(targetKind, res.entity);
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
      className={cx(overlayStyles, 'lightbox-backdrop')}
      aria-label={modalTitle}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx(overlayStyles, 'lightbox-backdrop-close')}
        aria-label="Close create record modal"
        onClick={onClose}
      />
      <div className={cx(wikiFormStyles, 'wiki-modal-card')}>
        <div className={cx(wikiFormStyles, 'wiki-modal-header')}>
          <h2>{modalTitle}</h2>
          <button ref={closeBtnRef} type="button" className={cx(controlStyles, 'pill-btn')} onClick={onClose}>
            Close
          </button>
        </div>

        {relativeContext ? (
          <div
            className={cx(controlStyles, 'filter-bar')}
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
                className={cx(controlStyles, `pill-btn ${relativeTab === tabId ? 'active' : ''}`)}
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
            className={cx(controlStyles, 'filter-bar')}
            role="tablist"
            aria-label="Record type to create"
            onKeyDown={(event) => {
              handleTablistKeyDown(event, createRegistry.order, resolvedKind, (next) => {
                setKind(next);
                setError(null);
              });
            }}
          >
            {createRegistry.order.map((id) => {
              const entry = createRegistry.entries[id];
              if (!entry) {
                return null;
              }
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  tabIndex={resolvedKind === id ? 0 : -1}
                  aria-selected={resolvedKind === id}
                  className={cx(controlStyles, `pill-btn ${resolvedKind === id ? 'active' : ''}`)}
                  onClick={() => {
                    setKind(id);
                    setError(null);
                  }}
                >
                  {entry.tabLabel}
                </button>
              );
            })}
          </div>
        )}

        {error && (
          <div className={cx(wikiPanelStyles, 'wiki-status-banner is-error')} role="alert">
            {error}
          </div>
        )}

        <form
          className={cx(wikiFormStyles, 'wiki-edit-form')}
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
        >
          {relativeContext && relativeSpec ? (
            relativeTab === 'create_new' ? (
              <PersonCreateFields draft={draft} updateDraft={updateDraft} people={people} places={places} />
            ) : (
              <LinkExistingRelativeFields
                linkHint={relativeSpec.linkHint(relativeContext.anchorPersonName)}
                existingQuery={draft.existingQuery}
                existingPersonId={draft.existingPersonId}
                candidates={filteredExistingCandidates}
                onQueryChange={(value) => {
                  updateDraft('existingQuery', value);
                }}
                onPersonIdChange={(value) => {
                  updateDraft('existingPersonId', value);
                }}
              />
            )
          ) : (
            <ActiveFields draft={draft} updateDraft={updateDraft} people={people} places={places} />
          )}

          <label className={cx(wikiFormStyles, 'wiki-checkbox-row')}>
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

          <label className={cx(wikiFormStyles, 'wiki-field')}>
            <span className={cx(wikiFormStyles, 'wiki-field-label')}>Note about this addition</span>
            <input
              type="text"
              className={cx(wikiFormStyles, 'wiki-input')}
              required
              minLength={3}
              placeholder="e.g. From family photo album or 1880 census"
              value={summary}
              onChange={(e) => {
                setSummary(e.target.value);
              }}
            />
          </label>

          <div className={cx(wikiPanelStyles, 'wiki-form-actions')}>
            <button
              type="submit"
              className={cx(wikiChromeStyles, 'wiki-btn-primary wiki-btn-sm')}
              disabled={submitting || !isEditSummaryValid(summary)}
            >
              {submitLabel}
            </button>
            <button type="button" className={cx(controlStyles, 'pill-btn')} onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
};
