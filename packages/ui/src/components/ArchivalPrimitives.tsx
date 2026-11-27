import type React from 'react';
import { useId, useRef } from 'react';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap.js';
import { cx, joinClasses } from '../lib/cx.js';
import primitiveStyles from './ArchivalPrimitives.module.css';

export type ArchivalCardGridProps = React.HTMLAttributes<HTMLDivElement>;

export const ArchivalCardGrid: React.FC<ArchivalCardGridProps> = ({ className, children, ...rest }) => (
  <div className={joinClasses(cx(primitiveStyles, 'archival-card-grid'), className)} {...rest}>
    {children}
  </div>
);

export interface ArchivalFilterBarProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly actions?: React.ReactNode;
}

export const ArchivalFilterBar: React.FC<ArchivalFilterBarProps> = ({
  actions,
  className,
  children,
  ...rest
}) => (
  <div className={joinClasses(cx(primitiveStyles, 'archival-filter-bar'), className)} {...rest}>
    <div className={cx(primitiveStyles, 'archival-filter-controls')}>{children}</div>
    {actions && <div className={cx(primitiveStyles, 'archival-filter-actions')}>{actions}</div>}
  </div>
);

export interface ArchivalTabItem {
  readonly id: string;
  readonly label: string;
  readonly badge?: string | number;
}

export interface ArchivalTabsProps {
  readonly ariaLabel: string;
  readonly tabs: readonly ArchivalTabItem[];
  readonly activeTabId: string;
  readonly onSelectTab: (tabId: string) => void;
  readonly className?: string;
}

export const ArchivalTabs: React.FC<ArchivalTabsProps> = ({
  ariaLabel,
  tabs,
  activeTabId,
  onSelectTab,
  className,
}) => {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number): void => {
    if (tabs.length === 0) {
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = tabs.length - 1;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const targetTab = tabs[nextIndex];
    if (targetTab) {
      onSelectTab(targetTab.id);
      tabRefs.current[nextIndex]?.focus();
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={joinClasses(cx(primitiveStyles, 'archival-tablist'), className)}
    >
      {tabs.map((tab, idx) => {
        const isSelected = tab.id === activeTabId;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[idx] = el;
            }}
            type="button"
            role="tab"
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            className={cx(primitiveStyles, 'archival-tab')}
            onClick={() => {
              onSelectTab(tab.id);
            }}
            onKeyDown={(e) => {
              handleKeyDown(e, idx);
            }}
          >
            <span>{tab.label}</span>
            {tab.badge !== undefined && (
              <span className={cx(primitiveStyles, 'archival-tab-badge')}>{tab.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export interface ArchivalTagPillProps {
  readonly label: string;
  readonly active?: boolean;
  readonly onClick?: () => void;
  readonly onRemove?: () => void;
  readonly className?: string;
}

export const ArchivalTagPill: React.FC<ArchivalTagPillProps> = ({
  label,
  active,
  onClick,
  onRemove,
  className,
}) => {
  if (onClick && !onRemove) {
    return (
      <button
        type="button"
        aria-pressed={active}
        className={joinClasses(cx(primitiveStyles, 'archival-tag-pill'), className)}
        onClick={onClick}
      >
        {label}
      </button>
    );
  }

  return (
    <span className={joinClasses(cx(primitiveStyles, 'archival-tag-pill'), className)}>
      <span>{label}</span>
      {onRemove && (
        <button
          type="button"
          className={cx(primitiveStyles, 'archival-tag-remove')}
          aria-label={`Remove ${label}`}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </span>
  );
};

export interface ArchivalToastProps {
  readonly message: string;
  readonly tone?: 'info' | 'success' | 'error';
  readonly onDismiss?: () => void;
  readonly className?: string;
}

export const ArchivalToast: React.FC<ArchivalToastProps> = ({
  message,
  tone = 'info',
  onDismiss,
  className,
}) => {
  const toneClass =
    tone === 'error'
      ? 'archival-toast-error'
      : tone === 'success'
        ? 'archival-toast-success'
        : 'archival-toast-info';
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      className={joinClasses(cx(primitiveStyles, `archival-toast ${toneClass}`), className)}
    >
      <span>{message}</span>
      {onDismiss && (
        <button
          type="button"
          className={cx(primitiveStyles, 'archival-toast-dismiss')}
          onClick={onDismiss}
          aria-label="Dismiss notice"
        >
          Dismiss
        </button>
      )}
    </div>
  );
};

export interface ArchivalEmptyStateProps {
  readonly title: string;
  readonly description?: string;
  readonly action?: React.ReactNode;
  readonly className?: string;
}

export const ArchivalEmptyState: React.FC<ArchivalEmptyStateProps> = ({
  title,
  description,
  action,
  className,
}) => (
  <div className={joinClasses(cx(primitiveStyles, 'archival-empty-state'), className)}>
    <h2 className={cx(primitiveStyles, 'archival-empty-title')}>{title}</h2>
    {description && <p className={cx(primitiveStyles, 'archival-empty-body')}>{description}</p>}
    {action && <div className={cx(primitiveStyles, 'archival-empty-action')}>{action}</div>}
  </div>
);

export interface ArchivalOverlayProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly closeLabel?: string;
  readonly children: React.ReactNode;
  readonly className?: string;
}

const ArchivalOverlayBase: React.FC<ArchivalOverlayProps & { readonly mode: 'modal' | 'drawer' }> = ({
  open,
  title,
  onClose,
  closeLabel = 'Close',
  children,
  className,
  mode,
}) => {
  const headingId = useId();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useDialogFocusTrap<HTMLDialogElement>({
    open,
    onClose,
    initialFocusRef: closeBtnRef,
  });

  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      aria-labelledby={headingId}
      className={joinClasses(
        cx(
          primitiveStyles,
          mode === 'drawer' ? 'archival-overlay-dialog archival-overlay-drawer' : 'archival-overlay-dialog'
        ),
        className
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        className={joinClasses(cx(primitiveStyles, 'archival-overlay-backdrop'), 'lightbox-backdrop-close')}
        aria-label={`Close ${title}`}
        onClick={onClose}
      />
      <div
        className={cx(primitiveStyles, mode === 'drawer' ? 'archival-drawer-panel' : 'archival-modal-panel')}
      >
        <div className={cx(primitiveStyles, 'archival-overlay-header')}>
          <h2 id={headingId} className={cx(primitiveStyles, 'archival-overlay-title')}>
            {title}
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            className={cx(primitiveStyles, 'archival-overlay-close')}
            onClick={onClose}
          >
            {closeLabel}
          </button>
        </div>
        <div className={cx(primitiveStyles, 'archival-overlay-body')}>{children}</div>
      </div>
    </dialog>
  );
};

export const ArchivalModal: React.FC<ArchivalOverlayProps> = (props) => (
  <ArchivalOverlayBase {...props} mode="modal" />
);

export const ArchivalDrawer: React.FC<ArchivalOverlayProps> = (props) => (
  <ArchivalOverlayBase {...props} mode="drawer" />
);
