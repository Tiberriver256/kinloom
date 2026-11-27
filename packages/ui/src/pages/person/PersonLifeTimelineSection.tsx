import type { ArchiveEvent, CoPresenceItem, Person, Place, SourceRecord } from '@kinloom/core';
import type React from 'react';
import { Link } from 'react-router-dom';
import { EmptyStateNotice } from '../../components/Atoms.js';
import { MilestoneStoryCard } from '../../components/MilestoneStoryCard.js';
import { scrollBehaviorForMotion } from '../../hooks/keyboardNav.js';
import { cx, joinClasses } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import personStyles from '../PersonPage.module.css';
import type { TimelineScrubberTick } from './personViewModel.js';

export interface PersonLifeTimelineSectionProps {
  readonly person: Person;
  readonly personEvents: readonly ArchiveEvent[];
  readonly activeEvent: ArchiveEvent | null;
  readonly scrubberItems: readonly TimelineScrubberTick[];
  readonly placesById: ReadonlyMap<string, Place>;
  readonly sourcesById: Map<string, SourceRecord>;
  readonly alsoHere: readonly CoPresenceItem[];
  readonly canEdit: boolean;
  readonly cardRefs: React.RefObject<Map<string, HTMLElement>>;
  readonly onSelectEventId: (eventId: string) => void;
  readonly onPivotPerson: (item: CoPresenceItem) => void;
  readonly onOpenEdit: () => void;
}

export const PersonLifeTimelineSection: React.FC<PersonLifeTimelineSectionProps> = ({
  person,
  personEvents,
  activeEvent,
  scrubberItems,
  placesById,
  sourcesById,
  alsoHere,
  canEdit,
  cardRefs,
  onSelectEventId,
  onPivotPerson,
  onOpenEdit,
}) => {
  if (personEvents.length === 0) {
    return (
      <EmptyStateNotice
        title={`${KINLOOM_VOCABULARY.person.emptyEventsPrefix} ${person.full_name}.`}
        action={
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Link
              to={`/tree?focus=${person.slug}`}
              className={cx(controlStyles, 'pill-btn')}
              style={{ textDecoration: 'none' }}
            >
              Open Family Tree →
            </Link>
            {canEdit && (
              <button type="button" className={cx(controlStyles, 'pill-btn')} onClick={onOpenEdit}>
                Edit Profile
              </button>
            )}
          </div>
        }
      />
    );
  }

  return (
    <section
      id="person-timeline"
      className={'person-timeline-section'}
      aria-label={KINLOOM_VOCABULARY.person.lifeTimelineAria}
    >
      <h2
        className={joinClasses(
          cx(controlStyles, 'section-heading'),
          cx(personStyles, 'person-timeline-heading')
        )}
      >
        Life Timeline
      </h2>
      <div className={cx(personStyles, `timeline-layout${scrubberItems.length === 0 ? ' no-spine' : ''}`)}>
        {scrubberItems.length > 0 && (
          <nav className={cx(personStyles, 'timeline-spine')} aria-label="Jump to decade">
            <div className={cx(personStyles, 'scrubber-list')}>
              {scrubberItems.map((t) => {
                const isAct =
                  activeEvent?.year !== null &&
                  activeEvent?.year !== undefined &&
                  Math.floor(activeEvent.year / 10) * 10 === t.decade;
                return (
                  <button
                    key={t.decade}
                    type="button"
                    className={cx(personStyles, `scrubber-tick ${isAct ? 'active' : ''}`)}
                    aria-current={isAct ? 'true' : undefined}
                    onClick={() => {
                      onSelectEventId(t.eventId);
                      cardRefs.current.get(t.eventId)?.scrollIntoView({
                        behavior: scrollBehaviorForMotion(),
                        block: 'start',
                      });
                    }}
                  >
                    {t.decade}s
                  </button>
                );
              })}
            </div>
          </nav>
        )}

        <div className={cx(personStyles, 'story-stream')}>
          {personEvents.map((ev) => (
            <MilestoneStoryCard
              key={ev.id}
              event={ev}
              place={ev.place_id ? placesById.get(ev.place_id) : undefined}
              isActive={activeEvent?.id === ev.id}
              sourcesById={sourcesById}
              alsoHere={activeEvent?.id === ev.id ? [...alsoHere] : []}
              onPivotPerson={onPivotPerson}
              onSelect={() => {
                onSelectEventId(ev.id);
              }}
              cardRef={(el) => {
                if (el) {
                  cardRefs.current.set(ev.id, el);
                } else {
                  cardRefs.current.delete(ev.id);
                }
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
};
