import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getSessionCookieName, signSessionToken } from '@kinloom/server';
import { startLiveWikiTestServer, type LiveWikiTestHarness } from './helpers/wikiTestServer.js';

const TINY_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// Valid 1-frame 16x16 VP8 WebM video fixture (548 bytes) for HTTP 206 byte-range verification.
const TINY_WEBM_BYTES = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAH0EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggHe7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDJXQYxMYXZmNjMuMS4xMDJEiYhAWQAAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIie6t9UdySrCcgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QF9eEA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAyc3PVY8CLY8WIie6t9UdySrBnyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuMTAwMDAwMDAwAB9DtnWo54EAo6OBAACAEAIAnQEqEAAQAABHCIWFiIWEiAICAAwNYAD+/6tQgBxTu2uRu4+zgQC3iveBAfGCAbHwgQM=',
  'base64',
);

const STATIC_DEMO_ORIGIN = 'http://127.0.0.1:4173';
const SESSION_SECRET = 'kinloom-e2e-test-session-secret-0123456789abcdef';

let wiki: LiveWikiTestHarness;

test.beforeEach(async () => {
  wiki = await startLiveWikiTestServer();
});

test.afterEach(async () => {
  await wiki.close();
});

async function enrollEditorViaInviteAndMagicLink(
  page: Page,
  email: string,
): Promise<void> {
  await page.goto(`${wiki.baseUrl}/api/auth/invite/${wiki.inviteToken}`);
  const inviteNotice = page.getByRole('region', { name: 'Invite access notice' });
  await expect(inviteNotice).toBeVisible();
  await inviteNotice.getByRole('button', { name: 'Sign in to edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to family archive' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Email address').fill(email);
  await dialog.getByRole('button', { name: 'Email Magic Link' }).click();
  await expect(dialog).toContainText(
    `If ${email} is enrolled in this archive, a one-time sign-in link is on its way`,
  );

  const sent = wiki.ports.emailSender.sentMessages.at(-1);
  expect(sent).toBeDefined();
  expect(sent?.toEmail).toBe(email);

  await page.goto(sent!.magicLinkUrl);
  await expect(page.getByRole('button', { name: /Account menu for/ })).toBeVisible();
}

test('backend modularity: same KinloomApp responds to Static Files vs Live HTTP Wiki capabilities', async ({
  page,
}) => {
  // 1. Static Files backend explicitly reports anonymous session and disabled write capabilities
  await page.goto(`${STATIC_DEMO_ORIGIN}/person/abraham-lincoln-1809`);
  await expect(page.getByRole('heading', { name: 'Abraham Lincoln', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: /Contribute to/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit Page' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /History/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Family Notes/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Photo' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Account menu for/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Invite access notice' })).toHaveCount(0);

  await page.goto(`${STATIC_DEMO_ORIGIN}/admin`);
  await expect(page.getByText('Administrator permissions are required')).toBeVisible();

  // 2. Exact same built KinloomApp on Live HTTP Wiki backend unlocks controls dynamically
  await enrollEditorViaInviteAndMagicLink(page, 'modularity.editor@archive.example');
  await page.goto(`${wiki.baseUrl}/person/abraham-lincoln-1809`);
  await expect(page.getByRole('heading', { name: 'Abraham Lincoln', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Contribute to Abraham Lincoln' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Page' })).toBeVisible();
  await expect(page.getByRole('button', { name: /History/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Family Notes/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Photo' })).toBeVisible();

  await page.getByRole('button', { name: /Account menu for/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Recent Changes' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Site Settings' })).toHaveCount(0);
});

test('1. read-only invite shows viewer banner and magic-link sign-in auto-enrolls strictly as editor', async ({
  page,
}) => {
  await page.goto(`${wiki.baseUrl}/api/auth/invite/${wiki.inviteToken}`);

  const inviteBanner = page.getByRole('region', { name: 'Invite access notice' });
  await expect(inviteBanner).toBeVisible();
  await expect(inviteBanner).toContainText('Family invite (Reunion Cousins)');

  // Invite viewer can read History and Family Notes, while Edit Page and Add Photo stay hidden
  await page.goto(`${wiki.baseUrl}/person/abraham-lincoln-1809`);
  await expect(page.getByRole('button', { name: /History/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Family Notes/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Page' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Photo' })).toHaveCount(0);

  // One-click sign-in upgrade via magic link
  await inviteBanner.getByRole('button', { name: 'Sign in to edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to family archive' });
  await dialog.getByLabel('Email address').fill('cousin.clara@archive.example');
  await dialog.getByRole('button', { name: 'Email Magic Link' }).click();
  await expect(dialog).toContainText(
    'If cousin.clara@archive.example is enrolled in this archive, a one-time sign-in link is on its way',
  );

  const magicEmail = wiki.ports.emailSender.sentMessages.at(-1);
  expect(magicEmail?.magicLinkUrl).toContain('/api/auth/magic-link/verify?token=');
  await page.goto(magicEmail!.magicLinkUrl);

  const accountBtn = page.getByRole('button', { name: /Account menu for/ });
  await expect(accountBtn).toBeVisible();
  await accountBtn.click();
  const accountMenu = page.getByRole('menu', { name: 'Account options' });
  await expect(accountMenu.locator('.wiki-role-chip')).toHaveText('Editor');
  await expect(accountMenu).not.toContainText('Site Settings');

  const meRes = await page.request.get(`${wiki.baseUrl}/api/auth/me`);
  expect(meRes.status()).toBe(200);
  const meBody = (await meRes.json()) as {
    session: { authenticated: boolean; principal_kind: string; role: string; email: string };
    capabilities: { canEdit: boolean; canManageSite: boolean };
  };
  expect(meBody.session.authenticated).toBe(true);
  expect(meBody.session.principal_kind).toBe('user');
  expect(meBody.session.role).toBe('editor');
  expect(meBody.capabilities.canEdit).toBe(true);
  expect(meBody.capabilities.canManageSite).toBe(false);

  const storedUser = await wiki.ports.repository.getUser('cousin.clara@archive.example');
  expect(storedUser?.role).toBe('editor');

  const adminAttempt = await page.request.get(`${wiki.baseUrl}/api/admin/users`);
  expect(adminAttempt.status()).toBe(403);

  await page.goto(`${wiki.baseUrl}/person/abraham-lincoln-1809`);
  await expect(page.getByRole('button', { name: 'Edit Page' })).toBeVisible();
});

test('2. inline edit without primary source renders Family memory badge and persists across reload', async ({
  page,
}) => {
  await enrollEditorViaInviteAndMagicLink(page, 'family.editor@archive.example');
  await page.goto(`${wiki.baseUrl}/person/abraham-lincoln-1809`);

  await page.getByRole('button', { name: 'Edit Page' }).click();
  const drawer = page.getByRole('dialog', { name: /Edit Abraham Lincoln/ });
  await expect(drawer).toBeVisible();

  const altNamesInput = drawer.getByLabel('Nicknames or maiden names');
  await expect(altNamesInput).toBeEnabled();
  await altNamesInput.fill('Abe Lincoln, Rail-Splitter, Honest Abe');

  await drawer.locator('label.wiki-radio-card', { hasText: 'Family memory' }).click();
  await drawer
    .getByLabel(/What did you change/)
    .fill('Record oral family nickname without primary citation');

  await drawer.getByRole('button', { name: 'Save Changes' }).click();
  await expect(drawer).toContainText('Saved revision');
  await drawer.getByRole('button', { name: 'Done' }).click();

  await expect(page.locator('.person-header')).toContainText('Family memory');
  await expect(page.locator('.person-header')).toContainText('Honest Abe');

  await page.reload();
  await expect(page.locator('.person-header')).toContainText('Family memory');
  await expect(page.locator('.person-header')).toContainText('Honest Abe');
});

test('3. optimistic concurrency 409 Conflict shows field diff and Rebase & Save Again preserves both edits', async ({
  page,
}) => {
  await enrollEditorViaInviteAndMagicLink(page, 'editor.one@archive.example');
  await page.goto(`${wiki.baseUrl}/person/mary-ann-todd`);

  await page.getByRole('button', { name: 'Edit Page' }).click();
  const drawer = page.getByRole('dialog', { name: /Edit Mary Ann Todd/ });
  await expect(drawer).toBeVisible();

  const altNamesInput = drawer.getByLabel('Nicknames or maiden names');
  await expect(altNamesInput).toBeEnabled();
  await altNamesInput.fill('Mary Todd Lincoln, Molly Todd');
  await drawer.getByLabel(/What did you change/).fill('Add childhood nickname from family letters');

  // Trigger a concurrent server update to a different field while the drawer stays open
  await wiki.ports.repository.upsertUser({
    email: 'peer.archivist@archive.example',
    display_name: 'Peer Archivist',
    role: 'editor',
    added_by: wiki.adminEmail,
    added_at: wiki.ports.clock.nowIso(),
    last_login_at: null,
  });
  const sessionCookieName = getSessionCookieName(false);
  const peerToken = await signSessionToken({
    secret: SESSION_SECRET,
    clock: wiki.ports.clock,
    ttlSeconds: 3600,
    payload: {
      kind: 'user',
      email: 'peer.archivist@archive.example',
      display_name: 'Peer Archivist',
      role: 'editor',
    },
  });
  const liveEntityRes = await wiki.server.fetch(
    new Request(`${wiki.baseUrl}/api/entities/person/p_mary_todd_lincoln`, {
      headers: { cookie: `${sessionCookieName}=${peerToken}` },
    }),
  );
  const liveEntity = (await liveEntityRes.json()) as {
    entity: Record<string, unknown>;
    current_revision_id: number;
  };
  const concurrentRes = await wiki.server.fetch(
    new Request(`${wiki.baseUrl}/api/entities/person/p_mary_todd_lincoln`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        origin: wiki.baseUrl,
        cookie: `${sessionCookieName}=${peerToken}`,
      },
      body: JSON.stringify({
        expected_parent_revision_id: liveEntity.current_revision_id,
        data: { ...liveEntity.entity, given_name: 'Mary Ann (Todd)' },
        summary: 'Clarify maiden given name formatting',
        has_primary_source: true,
      }),
    }),
  );
  expect(concurrentRes.status).toBe(200);

  // Submit the now-stale draft from the browser drawer
  await drawer.getByRole('button', { name: 'Save Changes' }).click();

  const conflictBox = drawer.getByRole('alert', { name: 'Edit conflict resolution' });
  await expect(conflictBox).toBeVisible();
  await expect(conflictBox).toContainText('Edit Conflict · Server at r');
  await expect(conflictBox).toContainText('Peer Archivist');
  await expect(conflictBox).toContainText('Molly Todd');

  await conflictBox.getByRole('button', { name: 'Rebase & Save Again' }).click();
  await expect(drawer).toContainText('Saved revision');
  await drawer.getByRole('button', { name: 'Done' }).click();

  await page.reload();
  await expect(page.locator('.person-header')).toContainText('Molly Todd');

  const finalEntityRes = await page.request.get(
    `${wiki.baseUrl}/api/entities/person/p_mary_todd_lincoln`,
  );
  const finalEntity = (await finalEntityRes.json()) as {
    entity: { given_name: string; alt_names: string[] };
  };
  expect(finalEntity.entity.given_name).toBe('Mary Ann (Todd)');
  expect(finalEntity.entity.alt_names).toContain('Molly Todd');
});

test('4. History tab renders visual side-by-side diff and one-click Undo / Revert restores prior value', async ({
  page,
}) => {
  await enrollEditorViaInviteAndMagicLink(page, 'historian@archive.example');
  await page.goto(`${wiki.baseUrl}/person/robert-todd-lincoln`);

  await page.getByRole('button', { name: 'Edit Page' }).click();
  const drawer = page.getByRole('dialog', { name: /Edit Robert Todd Lincoln/ });
  const altNamesInput = drawer.getByLabel('Nicknames or maiden names');
  await expect(altNamesInput).toBeEnabled();
  await altNamesInput.fill('Bob Lincoln');
  await drawer.getByLabel(/What did you change/).fill('Add informal family nickname');
  await drawer.getByRole('button', { name: 'Save Changes' }).click();
  await expect(drawer).toContainText('Saved revision');
  await drawer.getByRole('button', { name: 'Done' }).click();

  await expect(page.locator('.person-header')).toContainText('Bob Lincoln');

  await page.getByRole('button', { name: /History/ }).click();
  const historyPanel = page.getByRole('region', { name: 'Revision history' });
  await expect(historyPanel).toBeVisible();
  await expect(historyPanel).toContainText('Add informal family nickname');
  await expect(historyPanel).toContainText('Bob Lincoln');

  const latestItem = historyPanel.locator('article.wiki-revision-item').first();
  await latestItem.getByRole('button', { name: 'Undo / Revert' }).click();
  await expect(historyPanel).toContainText(/Reverted r\d+ in new revision r\d+/);
  await expect(historyPanel.locator('.wiki-action-tag.action-revert').first()).toHaveText('revert');

  await page.getByRole('button', { name: '← Back to Profile' }).click();
  await expect(page.locator('.person-header')).not.toContainText('Bob Lincoln');
});

test('5. soft-delete hides record from active views and restore brings it back cleanly', async ({
  page,
}) => {
  await enrollEditorViaInviteAndMagicLink(page, 'curator@archive.example');
  await page.goto(`${wiki.baseUrl}/person/samuel-lincoln-jr`);
  await expect(page.getByRole('heading', { name: 'Samuel Lincoln Jr.', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Edit Page' }).click();
  const drawer = page.getByRole('dialog', { name: /Edit Samuel Lincoln Jr\./ });
  await expect(drawer.getByLabel('Full name')).toBeEnabled();

  await drawer.getByRole('button', { name: 'Remove from Archive' }).click();
  await drawer
    .getByPlaceholder('Why are you removing this? (at least 3 characters)')
    .fill('Archive duplicate entry pending verification');
  await drawer.getByRole('button', { name: 'Confirm Removal' }).click();

  await expect(page.getByRole('heading', { name: 'Person Not Found' })).toBeVisible();

  await page.goto(`${wiki.baseUrl}/`);
  await expect(page.getByRole('link', { name: /Samuel Lincoln Jr\./ })).toHaveCount(0);

  // Restore via Revision History one-click Revert on the delete revision
  await page.goto(`${wiki.baseUrl}/changes`);
  const deleteRow = page
    .locator('article.wiki-revision-item')
    .filter({ hasText: 'person/p_samuel_lincoln_jr' })
    .filter({ hasText: 'delete' })
    .first();
  await expect(deleteRow).toBeVisible();
  await deleteRow.getByRole('button', { name: 'Revert' }).click();
  await expect(page.locator('.wiki-status-banner.is-success')).toContainText(/Reverted r\d+/);

  await page.goto(`${wiki.baseUrl}/person/samuel-lincoln-jr`);
  await expect(page.getByRole('heading', { name: 'Samuel Lincoln Jr.', exact: true })).toBeVisible();
});

test('6. media upload supports PNG and HTTP 206 WebM video streaming while blocking living-person portrait with 422', async ({
  page,
}) => {
  await enrollEditorViaInviteAndMagicLink(page, 'archivist@archive.example');
  await page.goto(`${wiki.baseUrl}/person/abraham-lincoln-1809`);

  // 1. Upload a valid PNG photograph via UI
  await page.getByRole('button', { name: 'Add Photo' }).click();
  const modal = page.getByRole('dialog', { name: 'Upload archival media' });
  await expect(modal).toBeVisible();

  await modal.locator('input[type="file"]').setInputFiles({
    name: 'springfield-desk.png',
    mimeType: 'image/png',
    buffer: TINY_PNG_BYTES,
  });
  await modal.getByLabel('Caption').fill('Springfield Law Office Desk Scan');
  await modal.getByRole('button', { name: 'Upload Photo' }).click();
  await expect(modal).toContainText('Uploaded and attached media');

  // 2. Upload a valid WebM video fixture via UI
  await modal.getByRole('button', { name: 'Upload Another' }).click();
  await modal.locator('input[type="file"]').setInputFiles({
    name: 'springfield-reel.webm',
    mimeType: 'video/webm',
    buffer: TINY_WEBM_BYTES,
  });
  await modal.getByLabel('Caption').fill('Springfield Oral History Clip');
  await modal.getByRole('button', { name: 'Upload Photo' }).click();
  await expect(modal).toContainText('Uploaded and attached media');
  await modal.getByRole('button', { name: 'Done' }).click();

  // 3. Verify <video> renders on page and GET /media/:key serves HTTP 206 Partial Content with Content-Range
  const showAllBtn = page.getByRole('button', { name: /Show All/ });
  if (await showAllBtn.isVisible()) {
    await showAllBtn.click();
  }
  const videoEl = page.locator('video[aria-label="Springfield Oral History Clip"]');
  await expect(videoEl).toBeVisible();
  const videoSrc = await videoEl.locator('source').getAttribute('src');
  expect(videoSrc).toMatch(/\/media\/[0-9a-f]{64}\.webm$/);

  const rangeRes = await page.request.get(`${wiki.baseUrl}${videoSrc}`, {
    headers: { range: 'bytes=0-127' },
  });
  expect(rangeRes.status()).toBe(206);
  expect(rangeRes.headers()['accept-ranges']).toBe('bytes');
  expect(rangeRes.headers()['content-range']).toBe(`bytes 0-127/${TINY_WEBM_BYTES.byteLength}`);
  expect((await rangeRes.body()).byteLength).toBe(128);

  // 4. Verify living-person portrait upload is blocked in UI and returns HTTP 422 on server without leaking
  await page.getByRole('button', { name: 'Add Photo' }).click();
  const livingModal = page.getByRole('dialog', { name: 'Upload archival media' });
  await livingModal.getByLabel('Who is in this photo? (deceased only)').selectOption('p_jordan_mercer_living');
  await expect(livingModal).toContainText('Living-person privacy rule');
  await livingModal.locator('input[type="file"]').setInputFiles({
    name: 'living-portrait.png',
    mimeType: 'image/png',
    buffer: TINY_PNG_BYTES,
  });
  await livingModal.getByRole('button', { name: 'Upload Photo' }).click();
  await expect(livingModal).toContainText('Upload blocked:');
  await livingModal.getByRole('button', { name: 'Close', exact: true }).click();

  const putsBefore = wiki.ports.mediaStore.putCount;
  const blockedRes = await page.request.post(`${wiki.baseUrl}/api/media/upload`, {
    headers: { origin: wiki.baseUrl },
    multipart: {
      file: {
        name: 'blocked-living.png',
        mimeType: 'image/png',
        buffer: TINY_PNG_BYTES,
      },
      metadata: JSON.stringify({
        kind: 'portrait',
        caption: 'Should be blocked for living person',
        person_ids: ['p_jordan_mercer_living'],
      }),
      summary: 'Attempt living portrait attach',
    },
  });
  expect(blockedRes.status()).toBe(422);
  const blockedBody = (await blockedRes.json()) as { error: { code: string } };
  expect(blockedBody.error.code).toBe('LIVING_MEDIA_FORBIDDEN');
  expect(wiki.ports.mediaStore.putCount).toBe(putsBefore);

  const bundleRes = await page.request.get(`${wiki.baseUrl}/api/bundle`);
  const bundleData = (await bundleRes.json()) as {
    media?: { person_ids?: string[]; person_id?: string | null; caption: string }[];
  };
  const leaked = (bundleData.media ?? []).filter(
    (m) =>
      m.person_id === 'p_jordan_mercer_living' ||
      (m.person_ids ?? []).includes('p_jordan_mercer_living'),
  );
  expect(leaked).toEqual([]);
});

test('7. AI agent batch submit shows Research agent badge in /changes and one-click Batch Revert unwinds in reverse order', async ({
  page,
}) => {
  await enrollEditorViaInviteAndMagicLink(page, 'reviewer@archive.example');

  const batchId = 'wave_e2e_1860_census';
  const batchRes = await page.request.post(`${wiki.baseUrl}/api/batches`, {
    headers: {
      authorization: `Bearer ${wiki.agentWriteToken}`,
      'content-type': 'application/json',
    },
    data: {
      batch_id: batchId,
      summary: 'Import verified 1860 census source and alias',
      has_primary_source: true,
      patches: [
        {
          action: 'create',
          entity_type: 'source',
          entity_id: 'src_e2e_agent_census',
          data: {
            id: 'src_e2e_agent_census',
            citation: '1860 U.S. Federal Census, Coles County, Illinois (Agent Verified)',
            source_type: 'census',
          },
          summary: 'Create 1860 Coles County census citation',
        },
        {
          action: 'update',
          entity_type: 'person',
          entity_id: 'p_thomas_lincoln',
          merge: true,
          data: {
            alt_names: ['Tom Lincoln of Kentucky'],
          },
          summary: 'Attach census alias to Thomas Lincoln',
        },
      ],
    },
  });
  expect(batchRes.status()).toBe(201);

  await page.goto(`${wiki.baseUrl}/person/thomas-lincoln`);
  await expect(page.locator('.person-header')).toContainText('Tom Lincoln of Kentucky');

  await page.goto(`${wiki.baseUrl}/changes`);
  const batchSection = page.locator('section.wiki-batch-group', { hasText: `Batch ${batchId}` });
  await expect(batchSection).toBeVisible();
  await expect(batchSection).toContainText('Research agent · Demo Research Agent');
  await expect(batchSection).toContainText('2 changes');

  await batchSection.getByRole('button', { name: 'Revert Entire Batch' }).click();
  await expect(page.locator('.wiki-status-banner.is-success')).toContainText(
    `Reverted batch ${batchId} across 2 revisions`,
  );

  // Confirm both entities unwound cleanly in reverse order
  await page.goto(`${wiki.baseUrl}/person/thomas-lincoln`);
  await expect(page.locator('.person-header')).not.toContainText('Tom Lincoln of Kentucky');

  const sourceRes = await page.request.get(
    `${wiki.baseUrl}/api/entities/source/src_e2e_agent_census`,
  );
  const sourceBody = (await sourceRes.json()) as { deleted_at: string | null };
  expect(sourceBody.deleted_at).not.toBeNull();
});

test('8. Family Notes panel supports posting a discussion note and soft-deleting it cleanly', async ({
  page,
}) => {
  await enrollEditorViaInviteAndMagicLink(page, 'researcher@archive.example');
  await page.goto(`${wiki.baseUrl}/person/abraham-lincoln-1809`);

  await page.getByRole('button', { name: /Family Notes/ }).click();
  const talkPanel = page.getByRole('region', { name: 'Record discussion' });
  await expect(talkPanel).toBeVisible();

  await talkPanel
    .getByLabel('Add a family note or question')
    .fill('Cross-check 1850 Springfield census dwelling number 442.');
  await talkPanel.getByRole('button', { name: 'Post Note' }).click();
  await expect(talkPanel).toContainText('Cross-check 1850 Springfield census dwelling number 442.');

  await page.reload();
  await page.getByRole('button', { name: /Family Notes/ }).click();
  const reloadedTalk = page.getByRole('region', { name: 'Record discussion' });
  await expect(reloadedTalk).toContainText('Cross-check 1850 Springfield census dwelling number 442.');

  await reloadedTalk.getByRole('button', { name: 'Delete' }).click();
  await expect(reloadedTalk).not.toContainText(
    'Cross-check 1850 Springfield census dwelling number 442.',
  );

  await page.reload();
  await page.getByRole('button', { name: /Family Notes/ }).click();
  await expect(page.getByRole('region', { name: 'Record discussion' })).not.toContainText(
    'Cross-check 1850 Springfield census dwelling number 442.',
  );
});

test('9. KinloomUiPlugin mounts custom /stories/demo-reel route and personDetail slot cleanly', async ({
  page,
}) => {
  await enrollEditorViaInviteAndMagicLink(page, 'plugin.reader@archive.example');
  await page.goto(`${wiki.baseUrl}/person/abraham-lincoln-1809`);

  const slot = page.getByTestId('demo-plugin-person-slot');
  await expect(slot).toBeVisible();
  await expect(slot).toContainText('Archival Story Spotlight: Abraham Lincoln');

  await page.locator('.nav-links a', { hasText: 'Stories' }).click();
  await expect(page).toHaveURL(/\/stories\/demo-reel$/);
  await expect(page.getByTestId('demo-reel-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Archival Story Reel' })).toBeVisible();
});
