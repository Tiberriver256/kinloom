import type { Person, Place, Pronunciation } from '@kinloom/core';
import { resolvePersonPronunciation, resolvePlacePronunciation } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useInRouterContext } from 'react-router-dom';
import { useOptionalArchiveData } from '../context/ArchiveDataContext.js';
import { computeCitationPopoverPosition, type PopoverCoordinates } from './CitationPopover.js';
import { hasPronunciationContent, PronunciationBadge } from './PronunciationBadge.js';

const POPOVER_CLOSE_DELAY_MS = 150;
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export type InlineEntityMentionProps = (
  | {
      kind: 'person';
      person: Person;
      place?: undefined;
    }
  | {
      kind: 'place';
      place: Place;
      person?: undefined;
    }
) & {
  displayText: string;
  baseUrl?: string;
  pronunciations?: Readonly<Record<string, Pronunciation>>;
};

function formatPlaceTypeLabel(placeType?: string | null): string {
  if (!placeType) {
    return 'Place';
  }
  return placeType.replaceAll('_', ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatPersonDates(person: Person): string {
  const birth = person.birth_edtf?.trim() || (person.birth_year ? String(person.birth_year) : '?');
  const death =
    person.death_edtf?.trim() ||
    (person.death_year ? String(person.death_year) : person.is_living ? 'Living' : '?');
  return `${birth} — ${death}`;
}

export const InlineEntityMention: React.FC<InlineEntityMentionProps> = (props) => {
  const { kind, displayText, baseUrl, pronunciations: pronunciationsProp } = props;
  const archiveData = useOptionalArchiveData();
  const lexicon = pronunciationsProp ?? archiveData?.pronunciations;
  const inRouter = useInRouterContext();
  const popoverId = useId();
  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [openMode, setOpenMode] = useState<'closed' | 'hover' | 'focus'>('closed');
  const [coords, setCoords] = useState<PopoverCoordinates>({
    top: 0,
    left: 0,
    placement: 'below',
    maxWidth: 320,
  });

  const isOpen = openMode !== 'closed';
  const isLivingPerson = kind === 'person' && (props.person.is_living || props.person.full_name === 'Living');

  const href = kind === 'person' ? `/person/${props.person.slug}` : `/place/${props.place.slug}`;
  const entityTitle = kind === 'person' ? props.person.full_name : props.place.full_name;
  const personPronunciation =
    !isLivingPerson && kind === 'person' ? resolvePersonPronunciation(props.person, lexicon) : null;
  const placePronunciation = kind === 'place' ? resolvePlacePronunciation(props.place, lexicon) : null;
  const pronunciation = kind === 'person' ? personPronunciation : placePronunciation;
  const pronunciationCoverage = personPronunciation?.coverage;
  const pronunciationMatchedPart = personPronunciation?.matchedPart;
  const pronunciationLabel =
    kind === 'person'
      ? pronunciationCoverage && pronunciationCoverage !== 'full'
        ? pronunciationMatchedPart || props.person.surname || props.person.full_name
        : props.person.full_name
      : props.place.name;
  const showPronunciation = hasPronunciationContent(pronunciation);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closePopover = useCallback(() => {
    clearCloseTimer();
    setOpenMode('closed');
  }, [clearCloseTimer]);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpenMode('closed');
    }, POPOVER_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  const reposition = useCallback(() => {
    if (!anchorRef.current) {
      return;
    }
    const anchorRect = anchorRef.current.getBoundingClientRect();
    const popRect = popoverRef.current?.getBoundingClientRect();
    setCoords(
      computeCitationPopoverPosition({
        anchorRect,
        popoverSize: {
          width: popRect?.width ?? 300,
          height: popRect?.height ?? 160,
        },
        viewport: {
          width: window.innerWidth || 1024,
          height: window.innerHeight || 768,
        },
      })
    );
  }, []);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  useIsoLayoutEffect(() => {
    if (isOpen) {
      reposition();
    }
  }, [isOpen, reposition]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        const focusWasInside = Boolean(
          popoverRef.current && document.activeElement && popoverRef.current.contains(document.activeElement)
        );
        closePopover();
        if (focusWasInside) {
          anchorRef.current?.focus();
        }
      }
    };
    const onOutsidePointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      closePopover();
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onOutsidePointerDown);
    window.addEventListener('scroll', reposition, { capture: true, passive: true });
    window.addEventListener('resize', reposition, { passive: true });
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onOutsidePointerDown);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [isOpen, closePopover, reposition]);

  if (isLivingPerson) {
    return <span>Living</span>;
  }

  const handleMouseEnter = (): void => {
    clearCloseTimer();
    setOpenMode('hover');
  };

  const handleMouseLeave = (): void => {
    scheduleClose();
  };

  const handleFocus = (): void => {
    clearCloseTimer();
    setOpenMode('focus');
  };

  const handleBlur = (event: React.FocusEvent<HTMLElement>): void => {
    const related = event.relatedTarget;
    if (
      related instanceof Node &&
      (popoverRef.current?.contains(related) || anchorRef.current?.contains(related))
    ) {
      return;
    }
    setOpenMode((prev) => (prev === 'focus' ? 'closed' : prev));
  };

  const linkProps = {
    ref: anchorRef,
    className: `inline-entity-link is-${kind}${isOpen ? ' is-active' : ''}`,
    'aria-describedby': isOpen ? popoverId : undefined,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onClick: closePopover,
  };

  const popoverCard = isOpen ? (
    <div
      ref={popoverRef}
      id={popoverId}
      role="dialog"
      aria-label={`${entityTitle} preview`}
      className={`citation-popover entity-popover is-${coords.placement} print-hide`}
      style={{
        top: coords.top,
        left: coords.left,
        maxWidth: coords.maxWidth,
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onBlur={handleBlur}
    >
      <div className="citation-popover-header">
        <div className="citation-popover-header-meta">
          <span className={`entity-popover-kind is-${kind}`}>
            {kind === 'person' ? 'Person' : formatPlaceTypeLabel(props.place.place_type)}
          </span>
        </div>
        <button
          type="button"
          className="citation-popover-close"
          aria-label={`Close ${entityTitle} preview`}
          onClick={closePopover}
        >
          ×
        </button>
      </div>

      <div className="entity-popover-title">{entityTitle}</div>

      <div className="citation-popover-meta">
        {kind === 'person' ? (
          <span>{formatPersonDates(props.person)}</span>
        ) : (
          <span>{formatPlaceTypeLabel(props.place.place_type)}</span>
        )}
      </div>

      {showPronunciation && (
        <div className="entity-popover-pronunciation">
          <PronunciationBadge
            pronunciation={pronunciation}
            label={pronunciationLabel}
            coverage={pronunciationCoverage}
            matchedPart={pronunciationMatchedPart}
            baseUrl={baseUrl}
            compact
          />
        </div>
      )}

      <div className="citation-popover-footer">
        {inRouter ? (
          <Link to={href} className="entity-popover-profile-link" onClick={closePopover}>
            View profile →
          </Link>
        ) : (
          <a href={href} className="entity-popover-profile-link" onClick={closePopover}>
            View profile →
          </a>
        )}
      </div>
    </div>
  ) : null;

  return (
    <span className={`inline-entity-mention is-${kind}`}>
      {inRouter ? (
        <Link to={href} {...linkProps}>
          {displayText}
        </Link>
      ) : (
        <a href={href} {...linkProps}>
          {displayText}
        </a>
      )}
      {showPronunciation && (
        <PronunciationBadge
          pronunciation={pronunciation}
          label={pronunciationLabel}
          baseUrl={baseUrl}
          compact
          iconOnly
          className="inline-entity-pronunciation"
        />
      )}
      {popoverCard &&
        (typeof document !== 'undefined' && document.body
          ? createPortal(popoverCard, document.body)
          : popoverCard)}
    </span>
  );
};
