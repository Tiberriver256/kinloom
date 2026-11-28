import { getSessionCookieName, signSessionToken } from '@kinloom/server';
import { expect, test } from '@playwright/test';
import { type LiveWikiTestHarness, startLiveWikiTestServer } from './helpers/wikiTestServer.js';

const SESSION_SECRET = 'kinloom-e2e-test-session-secret-0123456789abcdef';

test.describe('Issue #54 Onboarding checklist, Guide menu, and 360px mobile overflow verification', () => {
  let wiki: LiveWikiTestHarness;

  test.beforeEach(async () => {
    wiki = await startLiveWikiTestServer();
  });

  test.afterEach(async () => {
    await wiki.close();
  });

  test('viewer checklist on / has zero overflow at 360px and 1280px, persists dismissal, and reopens via Guide menu', async ({
    page,
  }) => {
    // 1. Mobile 360x800 check on live invite_viewer /
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${wiki.baseUrl}/api/auth/invite/${wiki.inviteToken}`, {
      waitUntil: 'networkidle',
    });
    const card = page.getByTestId('onboarding-checklist-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Listen to a narrated story');

    const mobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(mobileOverflow).toBeLessThanOrEqual(1);

    // Mobile Archive Menu contains Guide & Tutorials controls and opens real interactive TutorialModal
    await page.getByRole('button', { name: 'Archive menu' }).click();
    await expect(page.getByRole('button', { name: 'Interactive Tutorials' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Getting Started Checklist' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keyboard Shortcuts' })).toBeVisible();
    await page.getByRole('button', { name: 'Interactive Tutorials' }).click();

    const tutorialModal = page.getByTestId('tutorial-modal');
    await expect(tutorialModal).toBeVisible();
    await expect(tutorialModal).toContainText('Kinloom Archive Guide');
    await expect(tutorialModal).not.toContainText('Person Dossiers');

    // Verify full-width subtitle (never squeezed beside buttons) and visible action footer at 360x800
    const mobileMetrics = await tutorialModal.evaluate((dialog) => {
      const shell = dialog.querySelector('[class*="tutorial-shell"]');
      const desc = dialog.querySelector('[class*="tutorial-desc"]');
      const footer = dialog.querySelector('footer');
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        shellWidth: shell ? shell.getBoundingClientRect().width : 0,
        descWidth: desc ? desc.getBoundingClientRect().width : 0,
        footerBottom: footer ? footer.getBoundingClientRect().bottom : 0,
        viewportHeight: window.innerHeight,
      };
    });
    expect(mobileMetrics.overflow).toBeLessThanOrEqual(1);
    expect(mobileMetrics.descWidth).toBeGreaterThanOrEqual(mobileMetrics.shellWidth - 40);
    expect(mobileMetrics.footerBottom).toBeLessThanOrEqual(mobileMetrics.viewportHeight);

    // Interactive chapter picker + Try it now route navigation at 390x844
    await page.setViewportSize({ width: 390, height: 844 });
    await tutorialModal.getByRole('button', { name: /Chapters \(/ }).click();
    await tutorialModal.getByRole('button', { name: /Exploring the Family Tree/ }).click();
    await expect(tutorialModal).toContainText('Switch between Chart View and List View');
    await tutorialModal.getByRole('button', { name: /Try it now:/ }).click();
    await expect(tutorialModal).toHaveCount(0);
    await expect(page).toHaveURL(/\/tree$/);

    // Return to / for desktop checks
    await page.goto(`${wiki.baseUrl}/`, { waitUntil: 'networkidle' });

    // 2. Desktop 1280x800 check: mark step, dismiss, reload, reopen via Guide menu, open shortcuts, reset
    await page.setViewportSize({ width: 1280, height: 800 });
    const desktopOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(desktopOverflow).toBeLessThanOrEqual(1);

    // Opening Interactive Tutorials already auto-completed the guide step (1 of 5).
    await page.getByRole('button', { name: 'Mark "Explore the family tree" as completed' }).click();
    await expect(card).toContainText('2 of 5 steps completed');
    await page.getByRole('button', { name: 'Mark "Open a Person Profile" as completed' }).click();
    await expect(card).toContainText('3 of 5 steps completed');
    await expect(card).toContainText('Have family photos or corrections to share?');

    await page.getByRole('button', { name: 'Dismiss checklist' }).click();
    await expect(card).toHaveCount(0);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByTestId('onboarding-checklist-card')).toHaveCount(0);

    const guideBtn = page.getByRole('button', { name: 'Guide', exact: true });
    await guideBtn.click();
    await page.getByRole('menuitem', { name: 'Getting Started Checklist' }).click();
    await expect(page.getByTestId('onboarding-checklist-card')).toBeVisible();

    await guideBtn.click();
    await page.getByRole('menuitem', { name: 'Keyboard Shortcuts' }).click();
    await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toHaveCount(0);

    await guideBtn.click();
    await page.getByRole('menuitem', { name: 'Reset Tutorial & Onboarding Progress' }).click();
    await expect(page.getByTestId('onboarding-checklist-card')).toContainText('0 of 5 steps completed');
  });

  test('signed-in admin /admin renders Admin Setup Checklist with zero overflow at 360px and persists via API', async ({
    page,
  }) => {
    const cookieName = getSessionCookieName(false);
    const token = await signSessionToken({
      secret: SESSION_SECRET,
      clock: wiki.ports.clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email: wiki.adminEmail,
        display_name: 'Archive Admin',
        role: 'admin',
      },
    });
    await page.context().addCookies([
      {
        name: cookieName,
        value: token,
        url: wiki.baseUrl,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    for (const vp of [
      { width: 360, height: 800 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(vp);
      await page.goto(`${wiki.baseUrl}/admin`, { waitUntil: 'networkidle' });
      const card = page.getByTestId('onboarding-checklist-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText('Verify your Kinloom archive');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `/admin overflow @ ${vp.width}px`).toBeLessThanOrEqual(1);
    }

    // Complete a step and verify persistence across reload via GET/PUT /api/auth/me/onboarding
    const card = page.getByTestId('onboarding-checklist-card');
    const settingsBtn = page.getByRole('button', {
      name: 'Mark "Review plugin settings and backup tokens" as completed',
    });
    if ((await settingsBtn.count()) > 0 && (await settingsBtn.isEnabled())) {
      await settingsBtn.click();
    }
    await page.waitForTimeout(150);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(card).toContainText('Verify your Kinloom archive');
    await expect(
      page.getByRole('button', { name: 'Review plugin settings and backup tokens completed' })
    ).toBeDisabled();
  });
});
