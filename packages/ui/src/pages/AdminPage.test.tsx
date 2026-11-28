/** @vitest-environment jsdom */
import type {
  AdminDataSource,
  ArchiveBundle,
  ArchiveDataSource,
  InviteRecord,
  KinloomSiteConfig,
  PublicAgentTokenRecord,
  UserRecord,
} from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { AdminPage } from './AdminPage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const siteConfig: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Synthetic Admin Archive',
    familyName: 'Vance Family',
    gedcomSourceName: 'ADMIN_SEAM_TEST',
  },
});

const { bundle: testBundle }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig,
  mode: 'private',
  people: [],
  places: [],
  events: [],
  sources: [],
  kinship: [],
});

describe('AdminPage AdminDataSource capability seam', () => {
  it('operates via a plain ArchiveDataSource.admin without HttpWikiDataSource inheritance', async () => {
    const users: UserRecord[] = [
      {
        email: 'admin@example.com',
        display_name: 'Site Admin',
        role: 'admin',
        added_by: 'system',
        added_at: '2026-01-01T00:00:00Z',
        last_login_at: '2026-06-01T00:00:00Z',
      },
      {
        email: 'editor@example.com',
        display_name: 'Archive Editor',
        role: 'editor',
        added_by: 'admin@example.com',
        added_at: '2026-02-01T00:00:00Z',
        last_login_at: '2026-06-02T00:00:00Z',
      },
    ];
    const invites: InviteRecord[] = [];
    const tokens: PublicAgentTokenRecord[] = [];
    const roleUpdates: Array<{ email: string; role: string }> = [];

    const customAdmin: AdminDataSource = {
      listUsers: async () => [...users],
      updateUserRole: async (email, input) => {
        roleUpdates.push({ email, role: input.role });
        const idx = users.findIndex((u) => u.email === email);
        const existing = users[idx];
        if (!existing) throw new Error('User not found');
        const updated = { ...existing, role: input.role };
        users[idx] = updated;
        return updated;
      },
      listInvites: async () => [...invites],
      createInvite: async (input) => {
        const record: InviteRecord = {
          token: 'inv_synthetic_123',
          label: input.label,
          created_by: 'admin@example.com',
          expires_at: '2026-12-31T00:00:00Z',
          revoked_at: null,
          uses: 0,
          last_used_at: null,
          created_at: '2026-06-03T00:00:00Z',
        };
        invites.push(record);
        return { invite: record, invite_url: '/?invite=inv_synthetic_123' };
      },
      revokeInvite: async () => {},
      listAgentTokens: async () => [...tokens],
      createAgentToken: async (input) => {
        const record: PublicAgentTokenRecord = {
          token_id: 'tok_1',
          label: input.label,
          scope: input.scope,
          created_by: 'admin@example.com',
          revoked_at: null,
          created_at: '2026-06-03T00:00:00Z',
        };
        tokens.push(record);
        return {
          token_id: record.token_id,
          label: record.label,
          scope: record.scope,
          plaintext_secret: 'kl_synthetic_secret_once',
        };
      },
      revokeAgentToken: async () => {},
    };

    const plainDataSource: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: testBundle, etag: '"r1"', notModified: false }),
      loadReadings: async () => null,
      admin: customAdmin,
    };

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/admin']}>
          <ArchiveProvider
            siteConfig={siteConfig}
            initialBundle={testBundle}
            dataSource={plainDataSource}
            session={{
              authenticated: true,
              principal_kind: 'user',
              email: 'admin@example.com',
              displayName: 'Site Admin',
              role: 'admin',
            }}
            capabilities={{ canEdit: true, canManageSite: true, canUploadMedia: true }}
          >
            <AdminPage />
          </ArchiveProvider>
        </MemoryRouter>
      );
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(container.textContent).toContain('Archive Editor');
    expect(container.textContent).toContain('Site Admin');

    const promoteBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Promote to Admin')
    );
    expect(promoteBtn).toBeDefined();

    await act(async () => {
      promoteBtn?.click();
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(roleUpdates).toEqual([{ email: 'editor@example.com', role: 'admin' }]);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
