# First-Time User Onboarding, Empty States, and Plugin Seam

Kinloom guides new visitors, editors, and administrators without blocking navigation or adding invasive telemetry.

## Role-Tailored Journeys

`resolveOnboardingRole` maps each session into three canonical audiences:

| Audience | Persistence | Checklist Surface | Primary Focus |
| :--- | :--- | :--- | :--- |
| `viewer` (`anonymous` or `invite_viewer`) | Browser `localStorage` (`kinloom.onboarding.v1:<origin>`) | `IndexPage` (`/`) | Explore the tree, open a person dossier, trace the map or timeline, and open the quick guide. |
| `editor` (signed-in member) | D1 `user_onboarding_state` via `/api/auth/me/onboarding` | `IndexPage` (`/`) | Add or edit a record, review primary sources, upload a scan, and inspect revision history. |
| `admin` (signed-in administrator) | D1 `user_onboarding_state` via `/api/auth/me/onboarding` | `AdminPage` (`/admin`) | Verify system diagnostics, confirm initial records, create a family invite link, and review plugin settings or backup tokens. |

## Persistence and First-Login Detection

- Migration `packages/worker/migrations/0008_user_onboarding.sql` adds the `user_onboarding_state` table.
- `AuthService.resolveOrEnrollUser` captures first login (`priorLastLoginAt === null` or newly enrolled user) **before** updating `users.last_login_at`, recording `first_login_pending = 1`.
- `GET /api/auth/me/onboarding` returns `{ state, is_first_login, should_auto_open_tutorial_modal }` for signed-in users and a default unpersisted state for anonymous or invite viewers.
- `PUT /api/auth/me/onboarding` enforces authentication (`401` otherwise) and CSRF origin validation, applying idempotent set unions to `completed_step_ids`, `skipped_step_ids`, and `completed_chapter_ids`.

## Guide Menu and Re-Entry

`ExplorerTopBar` provides a persistent **Guide** menu (desktop pill and mobile Archive Menu group) with:

1. **Quick Archive Guide / Interactive Tutorials** (delegates to any tutorial launcher registered via `registerTutorialLauncher` for `#53`).
2. **Getting Started Checklist** (re-opens the checklist even after dismissal or completion).
3. **Keyboard Shortcuts** (accessible dialog using `useDialogFocusTrap`).
4. **Reset Onboarding Progress** (clears completed steps/chapters and re-opens the checklist).

## Contextual Empty States

All six primary views (`IndexPage`, `TreePage`, `MapPage`, `TimePage`, `EvidencePage`, and `AdminPage`) reuse `EmptyStateNotice` and distinguish two cases:

- **Unseeded archive (`totalCount === 0`):** Explains what belongs on the view and renders role-appropriate creation or orientation actions.
- **Active filter mismatch (`totalCount > 0 && visibleCount === 0`):** Explains the active filter and renders a one-click reset action.

## Registering Plugin Onboarding Steps

Plugins extend `KinloomUiPlugin` with either static `onboardingSteps` (validated fail-fast at startup) or dynamic `getOnboardingSteps(ctx)` (fault-isolated at render time):

```ts
import type { KinloomUiPlugin } from '@kinloom/ui';

export const myPlugin: KinloomUiPlugin = {
  id: 'kinloom-example',
  name: 'Example Plugin',
  onboardingSteps: [
    {
      id: 'kinloom-example:first-step',
      title: 'Try the example feature',
      description: 'Open the example view to explore records contributed by this plugin.',
      minRole: 'editor',
      order: 200,
      targetRoute: '/example',
    },
  ],
};
```

Validation rules enforced in `validateAndCompileUiPlugins`:

- Step `id` must be non-empty, globally unique, and must **not** start with the reserved `core:` prefix.
- `title` (`<= 100` chars) and `description` (`<= 280` chars) are required.
- `targetRoute` and `action.kind === 'route'` targets must be safe internal paths starting with `/` (rejecting `//` and `javascript:`).
- At most 5 primary steps render inline; extra plugin steps collapse cleanly under `"More plugin guides (+N)"`.
