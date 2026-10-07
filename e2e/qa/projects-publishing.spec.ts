import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  addMember,
  cleanWorld,
  createUser,
  emailFor,
  FILLER_COUNT,
  type Db,
  newDb,
  ROLES,
  seedWorld,
  signedInPage,
  type Role,
  type World,
} from './fixtures';
import { Watcher } from './watcher';

// QA 3 — Projects, approval workflows and publications, through the real UI against the real
// app and a Prisma-seeded organisation (e2e/qa/fixtures.ts). Providers and social platforms are
// never called: object storage is the local stub (e2e/qa/s3-stub.mjs), and the publish worker is
// not running, so a publication stays queued (SCHEDULED / PUBLISHING) after the click.
// Coverage list: e2e/qa/projects-publishing.inventory.md.

const hasDb = Boolean(process.env.DATABASE_URL);
const shotsDir = process.env.E2E_QA_SHOTS;
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3102';

// Publishing hands a job to the BullMQ queue (Redis 5+). E2E_NO_QUEUE=1 says it is unavailable (the
// Redis 3 on a Windows dev box): the click must then fail with a plain message, never a crash.
const queueUp = process.env.E2E_NO_QUEUE !== '1';

/**
 * After a click that enqueues work: the success text (returns true), or - without a queue - a
 * 502 with a translated message that says nothing was kept (returns false; callers then assert
 * that no row was left behind, so a second click is not met with "already scheduled").
 */
async function expectQueued(
  page: Page,
  w: Watcher,
  success: RegExp,
  url: RegExp,
): Promise<boolean> {
  if (queueUp) {
    await expect(page.getByText(success).first()).toBeVisible();
    return true;
  }
  w.expect4xx(url, 502);
  const toast = page.locator('[data-sonner-toast]').first();
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/temporarily unavailable/i);
  await expect(toast).not.toContainText(/redis|bullmq|ioredis/i);
  return false;
}

/**
 * 20.13: a post needs at least five hashtags before it can be published or scheduled. Add tags to
 * one variant's editor until the editor stops asking for more.
 */
async function fillHashtags(variant: Locator): Promise<void> {
  const input = variant.getByPlaceholder('Type a hashtag, then press Enter');
  for (let n = 1; n <= 8; n += 1) {
    if ((await variant.getByText(/still needed/).count()) === 0) return;
    await input.fill(`qa${n}`);
    await input.press('Enter');
  }
}

test.skip(!hasDb, 'DATABASE_URL is not set: the QA specs need the app’s database');
test.describe.configure({ mode: 'serial' });

let db: Db;
let world: World;
const pages = {} as Record<Role | 'empty', Page>;

async function report(w: Watcher): Promise<void> {
  if (w.issues.length) {
    const text = JSON.stringify(w.issues, null, 2);
    process.stdout.write(`QA ISSUES\n${text}\n`);
    await test.info().attach('qa-issues.json', { body: text, contentType: 'application/json' });
  }
  expect(w.issues).toEqual([]);
}

test.beforeAll(async ({ browser, playwright }) => {
  test.setTimeout(300_000);
  db = newDb();
  const request = await playwright.request.newContext({ baseURL });
  const ids = {} as Record<Role | 'empty', string>;
  for (const role of [...ROLES, 'empty'] as const) {
    ids[role] = await createUser(request, db, baseURL, emailFor(role), `QA ${role}`);
  }
  world = await seedWorld(db, ids.owner);
  for (const role of ROLES) await addMember(db, world.orgId, ids[role], role);
  await addMember(db, world.emptyOrgId, ids.empty, 'owner');
  for (const role of [...ROLES, 'empty'] as const) {
    pages[role] = await signedInPage(browser, baseURL, emailFor(role));
  }
  await request.dispose();
});

test.afterAll(async () => {
  for (const page of Object.values(pages)) await page?.context().close();
  await cleanWorld(db, world);
  const emails = [...ROLES, 'empty'].map(emailFor);
  const users = await db.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  await db.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await db.account.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  if (world)
    await db.organization.deleteMany({ where: { id: { in: [world.orgId, world.emptyOrgId] } } });
  await db?.$disconnect();
});

// ---------------------------------------------------------------------------------- Projects

test.describe('projects list', () => {
  test('shows every seeded state, each filter tab and cursor pagination', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit('/projects');
    await expect(page.getByRole('heading', { name: 'Projects' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /QA Review video/ })).toBeVisible();
    await w.shot('projects-list');

    const expectations: Record<string, { present: string[]; absent: string[] }> = {
      'In progress': {
        present: ['QA Queued video', 'QA Rendering video'],
        absent: ['QA Draft video'],
      },
      'To review': {
        present: ['QA Review video', 'QA Quality failed'],
        absent: ['QA Approved video'],
      },
      Drafts: { present: ['QA Draft video'], absent: ['QA Review video'] },
      Published: {
        present: ['QA Published video', 'QA Partly published', 'QA Approved video'],
        absent: ['QA Failed video'],
      },
      Failed: { present: ['QA Failed video', 'QA Rejected video'], absent: ['QA Published video'] },
    };
    for (const [tab, { present, absent }] of Object.entries(expectations)) {
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
      for (const name of present)
        await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible();
      for (const name of absent)
        await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0);
    }

    // Pagination: drafts exceed one page of 20; "Older" then "Newer" return to the first page.
    await page.getByRole('tab', { name: 'Drafts' }).click();
    const rows = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: /QA / }) });
    await expect(rows).toHaveCount(20);
    await page.getByRole('button', { name: 'Older' }).click();
    await expect(rows).toHaveCount(FILLER_COUNT + 1 - 20);
    await expect(page.getByRole('button', { name: 'Older' })).toBeDisabled();
    await page.getByRole('button', { name: 'Newer' }).click();
    await expect(rows).toHaveCount(20);
    await w.check('projects tabs');
    await report(w);
  });

  test('empty organisation shows the empty state with a call to action', async () => {
    const page = pages.empty;
    const w = new Watcher(page, shotsDir);
    await w.visit('/projects');
    await expect(page.getByText('No videos yet')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Make your first video' })).toBeVisible();
    await page.getByRole('tab', { name: 'Failed' }).click();
    await expect(page.getByText('No projects match this filter.')).toBeVisible();
    await w.shot('projects-empty');
    await report(w);
  });

  test('a failed list request shows a retryable error, not a crash', async () => {
    const page = pages.owner;
    await page.route('**/api/studio/projects?*', (r) =>
      r.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"ok":false,"error":{"code":"internal"}}',
      }),
    );
    await page.goto('/projects');
    await expect(page.getByRole('button', { name: /try again|retry/i }).first()).toBeVisible();
    await page.unroute('**/api/studio/projects?*');
    await page
      .getByRole('button', { name: /try again|retry/i })
      .first()
      .click();
    await expect(page.getByRole('link', { name: /QA Review video/ })).toBeVisible();
  });

  test('mobile 375px, dark mode and Arabic RTL have no overflow or errors', async ({ browser }) => {
    const page = await signedInPage(browser, baseURL, emailFor('owner'), {
      viewport: { width: 375, height: 800 },
      locale: 'ar',
    });
    const w = new Watcher(page, shotsDir);
    await w.visit('/projects');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const overflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await w.shot('projects-mobile-rtl');
    await w.visit(`/projects/${world.projects.review}`);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await w.visit('/publications');
    expect(await overflow()).toBeLessThanOrEqual(0);
    await w.visit('/approvals');
    expect(await overflow()).toBeLessThanOrEqual(0);
    await w.shot('approvals-mobile-rtl');
    await page.emulateMedia({ colorScheme: 'dark' });
    await w.visit('/projects');
    await w.shot('projects-dark');
    await report(w);
    await page.context().close();
  });
});

test.describe('projects search and row actions', () => {
  test('search narrows the list, lives in the URL and survives a reload', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit('/projects');
    await page.getByRole('searchbox', { name: 'Search projects' }).fill('Rendering');
    await expect(page).toHaveURL(/\/projects\?q=Rendering$/);
    await expect(page.getByRole('link', { name: /QA Rendering video/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /QA Draft video/ })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('searchbox', { name: 'Search projects' })).toHaveValue('Rendering');
    await expect(page.getByRole('link', { name: /QA Rendering video/ })).toBeVisible();
    // Brief text is searched too (every seeded brief has the hook "Warm bread, no queue").
    await page.getByRole('searchbox', { name: 'Search projects' }).fill('Warm bread');
    await expect(page).toHaveURL(/q=Warm(\+|%20)bread/);
    await expect(page.getByRole('link', { name: /QA Review video/ }).first()).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search projects' }).fill('no-such-thing-xyz');
    await expect(page.getByText('Nothing found')).toBeVisible();
    await w.shot('projects-search-empty');
    await report(w);
  });

  test('duplicate, archive, unarchive and delete (with confirm) from the row menu', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit('/projects');
    await page.getByRole('searchbox', { name: 'Search projects' }).fill('QA Draft video');
    // Wait for the search to settle (URL written, list narrowed) before opening a row menu.
    await expect(page).toHaveURL(/q=QA/);
    await expect(page.getByRole('link', { name: /QA Review video/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /QA Draft video/ })).toBeVisible();
    const row = (name: string) => page.getByRole('listitem').filter({ hasText: name });
    const menu = (name: string) => page.getByRole('button', { name: `Actions for ${name}` });

    await menu('QA Draft video').click();
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(page.getByText('Copy created.').first()).toBeVisible();
    await expect(row('QA Draft video (copy)')).toBeVisible();
    expect(await db.videoProject.count({ where: { name: 'QA Draft video (copy)' } })).toBe(1);

    // Archive the copy: it leaves the default list and shows under Archived.
    await menu('QA Draft video (copy)').click();
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    await expect(page.getByText('Archived.').first()).toBeVisible();
    await expect(row('QA Draft video (copy)')).toHaveCount(0);
    await page.getByRole('radio', { name: 'Archived', exact: true }).click();
    await expect(page).toHaveURL(/filter=archived/);
    await expect(row('QA Draft video (copy)')).toBeVisible();
    await expect(row('QA Draft video (copy)')).toContainText('Archived');

    // Unarchive puts it back where it was.
    await menu('QA Draft video (copy)').click();
    await page.getByRole('menuitem', { name: 'Unarchive' }).click();
    await expect(page.getByText('Restored.').first()).toBeVisible();
    await expect(row('QA Draft video (copy)')).toHaveCount(0);
    await page.getByRole('radio', { name: 'All', exact: true }).click();
    await expect(row('QA Draft video (copy)')).toBeVisible();

    // Delete asks first; keeping it changes nothing, confirming removes it from every list.
    await menu('QA Draft video (copy)').click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Delete this video?');
    await dialog.getByRole('button', { name: 'Keep it' }).click();
    await expect(row('QA Draft video (copy)')).toBeVisible();
    await menu('QA Draft video (copy)').click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('Deleted.').first()).toBeVisible();
    await expect(row('QA Draft video (copy)')).toHaveCount(0);
    expect(
      (await db.videoProject.findFirstOrThrow({ where: { name: 'QA Draft video (copy)' } }))
        .deletedAt,
    ).not.toBeNull();
    await report(w);
  });

  test('a project that is rendering cannot be archived or deleted from the menu', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit('/projects?q=QA%20Rendering%20video');
    await page.getByRole('button', { name: 'Actions for QA Rendering video' }).click();
    await expect(page.getByRole('menuitem', { name: 'Archive' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await report(w);
  });

  test('roles: viewers get no row actions; the API refuses them anyway', async () => {
    const page = pages.viewer;
    const w = new Watcher(page, shotsDir);
    await w.visit('/projects');
    await expect(page.getByRole('link', { name: /QA Review video/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Actions for / })).toHaveCount(0);
    w.expect4xx(/\/archive$/, 403);
    const res = await page.request.post(`/api/studio/projects/${world.projects.draft}/archive`, {
      headers: { origin: baseURL },
      data: {},
    });
    expect(res.status()).toBe(403);
    await report(w);
  });
});

// ----------------------------------------------------------------------------- Project detail

test.describe('project detail', () => {
  test('every tab of a project ready for review', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.review}`);
    await expect(page.getByRole('heading', { name: 'QA Review video' })).toBeVisible();
    await expect(page.getByText('Ready for review').first()).toBeVisible();

    // Variants: a player per render with a signed URL, quality status and a download button.
    await expect(page.getByRole('article', { name: /variant/ })).toHaveCount(2);
    await expect(page.locator('video').first()).toHaveAttribute('src', /^http/);
    await expect(page.getByText('Quality passed').first()).toBeVisible();
    await w.shot('project-variants');

    // Download of the user's own render opens a signed URL in a new tab.
    const popup = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Download MP4' }).first().click();
    expect((await popup).url()).toMatch(/^http:\/\/127\.0\.0\.1:3199\//);

    for (const tab of ['Shots', 'Overlays', 'Script', 'Publish', 'Variants']) {
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
      await w.settle();
      await w.check(`project tab ${tab}`);
      await w.shot(`project-tab-${tab}`);
    }
    await report(w);
  });

  test('script tab: edit narration and save', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.review2}`);
    await page.getByRole('tab', { name: 'Script' }).click();
    await page.getByRole('button', { name: 'Edit script' }).click();
    const narration = page.getByLabel('Shot 1 on-screen text');
    await narration.fill('Fresh bread daily');
    await page.getByRole('button', { name: 'Save script' }).click();
    await expect(page.getByText(/Saved/).first()).toBeVisible();
    const shot = await db.videoShot.findFirstOrThrow({
      where: { script: { projectId: world.projects.review2 }, sortOrder: 0 },
    });
    expect(shot.onScreenText).toBe('Fresh bread daily');
    await report(w);
  });

  test('shots tab: selecting a shot shows regenerate and text controls', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.review}`);
    await page.getByRole('tab', { name: 'Shots' }).click();
    await page
      .getByRole('button', { name: /Shot 1/ })
      .first()
      .click();
    await expect(page.getByRole('button', { name: 'Save text' })).toBeVisible();
    await w.shot('shots-tab');
    await report(w);
  });

  test('a project that is still working shows progress and cancel; a draft shows generate', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.rendering}`);
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(
      page.getByText('Variants appear here as each format finishes rendering.'),
    ).toBeVisible();
    await w.visit(`/projects/${world.projects.draft}`);
    await expect(page.getByRole('button', { name: 'Generate' })).toBeVisible();
    await w.visit(`/projects/${world.projects.failed}`);
    await expect(page.getByRole('alert').filter({ hasText: /unavailable/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate again' })).toBeVisible();
    await w.shot('project-failed');
    await report(w);
  });

  test('a viewer sees no Generate button, and the API still refuses the call', async () => {
    const page = pages.viewer;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.draft}`);
    await expect(page.getByRole('heading', { name: 'QA Draft video' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate', exact: true })).toHaveCount(0);
    w.expect4xx(/\/generate$/, 403);
    const res = await page.request.post(`/api/studio/projects/${world.projects.draft}/generate`, {
      headers: { origin: baseURL },
      data: {},
    });
    expect(res.status()).toBe(403);
    await report(w);
  });

  test('a missing project shows a friendly not-found state', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    w.expect4xx(/\/projects\/[^/]+$/, 404);
    await page.goto('/projects/does-not-exist');
    await expect(page.getByRole('link', { name: 'Projects' }).first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/Application error|NotFoundError/);
    await expect(page.getByText('Project not found')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Back to projects' }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await report(w);
  });

  test('another organisation cannot open this project', async () => {
    const page = pages.empty;
    const res = await page.request.get(`/api/studio/projects/${world.projects.review}`);
    expect(res.status()).toBe(404);
  });
});

// -------------------------------------------------------------------- Approve / reject / roles

test.describe('approve and reject', () => {
  test('reject needs a note, then moves the project to Rejected', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.review2}`);
    await page.getByRole('button', { name: 'Reject' }).click();
    await expect(page.getByRole('button', { name: 'Confirm rejection' })).toBeDisabled();
    await page.getByLabel(/What needs to change/).fill('Hook is too slow');
    await page.getByRole('button', { name: 'Confirm rejection' }).click();
    await expect(page.getByText('Rejected.').first()).toBeVisible();
    await expect
      .poll(
        async () =>
          (await db.videoProject.findUniqueOrThrow({ where: { id: world.projects.review2 } }))
            .state,
      )
      .toBe('REJECTED');
    await w.shot('project-rejected');
    await report(w);
  });

  test('approve with a note moves the project to Approved and opens publishing', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.review}`);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByLabel('Note (optional)').fill('Looks good');
    await page.getByRole('button', { name: 'Confirm approval' }).click();
    await expect(page.getByText('Approved — ready to publish.').first()).toBeVisible();
    await expect
      .poll(
        async () =>
          (await db.videoProject.findUniqueOrThrow({ where: { id: world.projects.review } })).state,
      )
      .toBe('APPROVED');
    const task = await db.approvalTask.findFirst({ where: { projectId: world.projects.review } });
    expect(task?.state).toBe('APPROVED');
    expect(task?.note).toBe('Looks good');
    await report(w);
  });

  test('quality-failed project: the failed check is explained and it can be rejected', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.qfailed}`);
    await expect(page.getByText('Quality failed').first()).toBeVisible();
    await expect(page.getByText('Black frames').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();
    await w.shot('project-quality-failed');
    await report(w);
  });

  test('force-approving a failed check needs a reason and is audited', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.qfailed}`);
    const reason = page.getByLabel(/Override the failed check/);
    await reason.fill('Black frame is an intentional fade');
    await page.getByRole('button', { name: 'Force-approve' }).first().click();
    await expect(page.getByText('Quality check overridden.').first()).toBeVisible();
    const render = await db.videoRender.findFirstOrThrow({
      where: { projectId: world.projects.qfailed },
    });
    expect(render.qualityCheckState).toBe('FORCE_APPROVED');
    await report(w);
  });

  test('roles: viewer and creator see no Approve/Reject (and the API refuses), publisher can', async () => {
    const project = world.projects.review3;
    for (const role of ['viewer', 'creator'] as const) {
      const page = pages[role];
      const w = new Watcher(page, shotsDir);
      await w.visit(`/projects/${project}`);
      // No buttons to press: the page says who can approve; the API refuses all the same.
      await expect(page.getByText(/Only a publisher, admin or owner can approve/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
      w.expect4xx(/\/approve$/, 403);
      const res = await page.request.post(`/api/studio/projects/${project}/approve`, {
        headers: { origin: baseURL },
        data: {},
      });
      expect(res.status(), role).toBe(403);
      expect((await db.videoProject.findUniqueOrThrow({ where: { id: project } })).state).toBe(
        'READY_FOR_REVIEW',
      );
      await report(w);
    }
    const page = pages.publisher;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${project}`);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm approval' }).click();
    await expect(page.getByText('Approved — ready to publish.').first()).toBeVisible();
    await report(w);
  });
});

// ------------------------------------------------------------------------------------ Approvals

test.describe('approval workflows', () => {
  test('create a multi-step workflow, edit it, and delete it', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit('/approvals');
    await page.getByRole('button', { name: 'New workflow' }).first().click();
    await page.getByLabel('Name').fill('Two-step sign-off');
    await page.getByRole('button', { name: 'Add step' }).click();
    await expect(page.getByLabel('Role')).toHaveCount(2);
    await page.getByLabel('Role').nth(0).fill('publisher');
    await page.getByLabel('Role').nth(1).fill('admin');
    await page.getByRole('button', { name: 'Create workflow' }).click();
    await expect(page.getByText('Workflow created.').first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'Two-step sign-off steps' })).toBeVisible();
    await w.shot('approvals-list');

    await page.getByRole('button', { name: 'Edit' }).first().click();
    await page.getByLabel('Name').fill('Two-step sign-off v2');
    await page.getByRole('button', { name: 'Save workflow' }).click();
    await expect(page.getByText(/Workflow saved/).first()).toBeVisible();

    await page.getByRole('button', { name: 'Delete Two-step sign-off v2' }).click();
    await page.getByRole('button', { name: 'Confirm delete' }).click();
    await expect(page.getByText(/Deleted “Two-step sign-off v2”/).first()).toBeVisible();
    await report(w);
  });

  test('form validation: name and step role are required', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit('/approvals');
    await page.getByRole('button', { name: 'New workflow' }).first().click();
    await page.getByRole('button', { name: 'Create workflow' }).click();
    await expect(page.getByText('Give the workflow a name.')).toBeVisible();
    await page.getByLabel('Name').fill('Bad role');
    await page.getByLabel('Role').first().fill('');
    await page.getByRole('button', { name: 'Create workflow' }).click();
    await expect(page.getByText(/Step 1: use a membership role name/)).toBeVisible();
    await report(w);
  });

  test('multi-step approval: step 1 keeps the project in review, step 2 approves it', async () => {
    const wf = await db.approvalWorkflow.create({
      data: {
        organisationId: world.orgId,
        name: 'QA publisher then admin',
        steps: [
          { role: 'publisher', minApprovers: 1 },
          { role: 'admin', minApprovers: 1 },
        ],
        appliesTo: { platforms: [], businessIds: [world.businessId], tags: [] },
      },
    });
    const project = world.projects.review4;
    const publisher = pages.publisher;
    const w = new Watcher(publisher, shotsDir);
    await w.visit(`/projects/${project}`);
    await expect(publisher.getByRole('region', { name: 'Approval steps' })).toContainText(
      /Step 1 of 2/,
    );
    await publisher.getByRole('button', { name: 'Approve', exact: true }).click();
    await publisher.getByRole('button', { name: 'Confirm approval' }).click();
    await expect(publisher.getByRole('region', { name: 'Approval steps' })).toContainText(
      /Step 2 of 2/,
    );
    expect((await db.videoProject.findUniqueOrThrow({ where: { id: project } })).state).toBe(
      'READY_FOR_REVIEW',
    );
    await w.shot('approval-step-2');

    // The same publisher cannot satisfy the admin step.
    w.expect4xx(/\/approve$/, 403);
    await publisher.getByRole('button', { name: 'Approve', exact: true }).click();
    await publisher.getByRole('button', { name: 'Confirm approval' }).click();
    await expect(publisher.locator('[data-sonner-toast]').first()).toBeVisible();
    expect((await db.videoProject.findUniqueOrThrow({ where: { id: project } })).state).toBe(
      'READY_FOR_REVIEW',
    );

    const admin = pages.admin;
    const wa = new Watcher(admin, shotsDir);
    await wa.visit(`/projects/${project}`);
    await admin.getByRole('button', { name: 'Approve', exact: true }).click();
    await admin.getByRole('button', { name: 'Confirm approval' }).click();
    await expect(admin.getByText('Approved — ready to publish.').first()).toBeVisible();
    await expect
      .poll(async () => (await db.videoProject.findUniqueOrThrow({ where: { id: project } })).state)
      .toBe('APPROVED');
    await db.approvalWorkflow.delete({ where: { id: wf.id } });
    await report(w);
    await report(wa);
  });

  test('roles: only owner and admin may change workflows; everyone may read them', async () => {
    for (const role of ['publisher', 'creator', 'viewer'] as const) {
      const res = await pages[role].request.post('/api/studio/approval-workflows', {
        headers: { origin: baseURL },
        data: { name: `by ${role}`, steps: [{ role: 'admin', minApprovers: 1 }] },
      });
      expect(res.status(), role).toBe(403);
      const list = await pages[role].request.get('/api/studio/approval-workflows');
      expect(list.status(), role).toBe(200);
    }
    // A viewer opening the screen sees the list without a crash; creating is refused kindly.
    const page = pages.viewer;
    const w = new Watcher(page, shotsDir);
    w.expect4xx(/approval-workflows$/, 403);
    await w.visit('/approvals');
    await page.getByRole('button', { name: 'New workflow' }).first().click();
    await page.getByLabel('Name').fill('Viewer attempt');
    await page.getByRole('button', { name: 'Create workflow' }).click();
    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    await expect(toast).not.toContainText(/studio:|capability/);
    await report(w);
  });

  test('a step role no member can hold is refused up front (standalone roles)', async () => {
    const res = await pages.owner.request.post('/api/studio/approval-workflows', {
      headers: { origin: baseURL },
      data: { name: 'Unreachable step', steps: [{ role: 'client_reviewer', minApprovers: 1 }] },
    });
    expect(res.status()).toBe(400);
  });
});

// --------------------------------------------------------------------------------- Publications

test.describe('publish from a project', () => {
  test('publish tab of an unapproved project asks for approval first', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.draft}`);
    await page.getByRole('tab', { name: 'Publish' }).click();
    await expect(page.getByText('Approve the video before publishing it.')).toBeVisible();
    await report(w);
  });

  test('schedule: past and too-far times are refused inline; a valid time schedules each platform', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.approved2}`);
    await page.getByRole('tab', { name: 'Publish' }).click();
    const when = page.getByLabel('Schedule (optional)');
    await when.fill('2020-01-01T10:00');
    await expect(page.getByRole('alert').filter({ hasText: 'at least a minute' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Schedule/ })).toBeDisabled();
    await when.fill('2099-01-01T10:00');
    await expect(page.getByRole('alert').filter({ hasText: /days ahead/ })).toBeVisible();
    const future = new Date(Date.now() + 5 * 86_400_000);
    const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    await fillHashtags(page.getByRole('listitem').filter({ hasText: 'TikTok' }).first());
    await when.fill(local);
    await page.getByRole('button', { name: /^Schedule/ }).click();
    const queued = await expectQueued(page, w, /Scheduled 1 post/, /\/api\/studio\/publications$/);
    if (!queued) {
      expect(
        await db.videoPublication.count({ where: { projectId: world.projects.approved2 } }),
      ).toBe(0);
      return report(w);
    }
    const pubs = await db.videoPublication.findMany({
      where: { projectId: world.projects.approved2 },
    });
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.state).toBe('SCHEDULED');
    expect(pubs[0]?.scheduledFor).not.toBeNull();
    await w.shot('publish-scheduled');
    // Duplicate request: the same render and account are refused with a readable message.
    const res = await page.request.post('/api/studio/publications', {
      headers: { origin: baseURL },
      data: {
        renderId: world.renders.approved2![0],
        platform: 'tiktok',
        connectionId: world.connections.tiktok,
        caption: 'Fresh today',
        // The business hashtag is added server-side (20.13), so four of ours make the five it needs.
        hashtags: ['qa1', 'qa2', 'qa3', 'qa4'],
        scheduledFor: future.toISOString(),
      },
    });
    expect(res.status()).toBe(409);
    await report(w);
  });

  test('publish now creates a queued publication per platform with the chosen account', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.approved}`);
    await page.getByRole('tab', { name: 'Publish' }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(2);
    const tiktok = page.getByRole('listitem').filter({ hasText: 'TikTok' });
    await tiktok.getByLabel('Caption').fill('Fresh today');
    await tiktok.first().getByPlaceholder('Type a hashtag, then press Enter').fill('bread');
    await tiktok.first().getByPlaceholder('Type a hashtag, then press Enter').press('Enter');
    await fillHashtags(tiktok.first());
    await fillHashtags(page.getByRole('listitem').filter({ hasText: 'YouTube Shorts' }).first());
    await page.getByRole('button', { name: /Publish now \(2\)/ }).click();
    const queued = await expectQueued(
      page,
      w,
      /Publishing 2 posts/,
      /\/api\/studio\/publications$/,
    );
    if (!queued) {
      expect(
        await db.videoPublication.count({ where: { projectId: world.projects.approved } }),
      ).toBe(0);
      return report(w);
    }
    const pubs = await db.videoPublication.findMany({
      where: { projectId: world.projects.approved, state: { in: ['SCHEDULED', 'PUBLISHING'] } },
    });
    expect(pubs.map((p) => p.platform).sort()).toEqual(['tiktok', 'youtube_short']);
    // Stored in the platform's casing (20.13 title-cases a word: Bread).
    expect(
      pubs.find((p) => p.platform === 'tiktok')?.hashtags.map((h) => h.toLowerCase()),
    ).toContain('bread');
    await report(w);
  });

  test('a platform with no active connection offers to connect instead of failing', async () => {
    const page = pages.owner;
    // The project's only variant is TikTok: with that account needing a reconnect there is none to post with.
    await db.platformConnection.update({
      where: { id: world.connections.tiktok },
      data: { state: 'needs_reconnect' },
    });
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.published}`);
    await page.getByRole('tab', { name: 'Publish' }).click();
    await expect(page.getByText('No connected account.').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Connect/ }).first()).toBeVisible();
    await db.platformConnection.update({
      where: { id: world.connections.tiktok },
      data: { state: 'active' },
    });
    await report(w);
  });

  test('roles: creator and viewer cannot publish (friendly refusal)', async () => {
    for (const role of ['creator', 'viewer'] as const) {
      const res = await pages[role].request.post('/api/studio/publications', {
        headers: { origin: baseURL },
        data: {
          renderId: world.renders.approved![0],
          platform: 'tiktok',
          connectionId: world.connections.tiktok,
        },
      });
      expect(res.status(), role).toBe(403);
    }
  });
});

test.describe('publications page', () => {
  test('lists every state with its filter, platform filter and friendly failure text', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit('/publications');
    await expect(page.getByRole('heading', { name: 'Publications' }).first()).toBeVisible();
    await w.shot('publications-all');
    const tabs: Record<string, { text: string; absent?: string }> = {
      Scheduled: { text: 'Scheduled', absent: 'Taken down' },
      Live: { text: 'Published' },
      Failed: { text: 'Failed' },
      'Cancelled & taken down': { text: 'Cancelled|Taken down' },
    };
    for (const [tab, { text }] of Object.entries(tabs)) {
      await page.getByRole('radio', { name: tab }).click();
      await expect(page.getByRole('radio', { name: tab })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('row').nth(1)).toContainText(new RegExp(text, 'i'));
    }
    // A stored platform failure reads as a sentence (the class), not a bare code.
    await page.getByRole('radio', { name: 'Failed' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'QA Partly published' })).toContainText(
      /needs to be reconnected/,
    );
    await expect(page.getByRole('row').filter({ hasText: 'QA Published video' })).toContainText(
      /service is unavailable/,
    );
    // A customer never sees the platform's own text (hostnames, tokens, ECONNREFUSED...).
    await expect(page.locator('body')).not.toContainText(/ECONNREFUSED|access token expired/);
    await w.shot('publications-failed');
    // Platform filter.
    await page.getByRole('radio', { name: 'All' }).click();
    await page.getByLabel('Platform').selectOption('x');
    await expect(page.getByRole('row')).toHaveCount(2);
    await page.getByLabel('Platform').selectOption('linkedin_video');
    await expect(page.getByText('No publications match these filters.')).toBeVisible();
    await report(w);
  });

  test('cancel a scheduled post: the dialog can be dismissed, then confirmed', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit('/publications');
    await page.getByRole('radio', { name: 'Scheduled' }).click();
    const cancel = page.getByRole('button', { name: 'Cancel' }).first();
    await cancel.click();
    await expect(page.getByRole('dialog')).toContainText('Cancel this scheduled post?');
    await page.getByRole('button', { name: 'Keep it' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(
      (
        await db.videoPublication.findUniqueOrThrow({
          where: { id: world.publications.scheduled2 },
        })
      ).state,
    ).toBe('SCHEDULED');
    await page
      .getByRole('row')
      .filter({ hasText: 'QA Published video' })
      .getByRole('button', { name: 'Cancel' })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel post' }).click();
    await expect(page.getByText('Scheduled post cancelled').first()).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await db.videoPublication.findUniqueOrThrow({
              where: { id: world.publications.scheduled2 },
            })
          ).state,
      )
      .toBe('CANCELLED');
    await report(w);
  });

  test('retry a failed post requeues it; connection errors read as friendly text', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit('/publications');
    await page.getByRole('radio', { name: 'Failed' }).click();
    const row = page.getByRole('row').filter({ hasText: 'QA Partly published' });
    await expect(row).toContainText(/reconnect/i);
    await row.getByRole('button', { name: 'Retry' }).click();
    const queued = await expectQueued(page, w, /Retry queued/, /\/publications\/[^/]+\/retry$/);
    if (!queued) {
      const kept = await db.videoPublication.findUniqueOrThrow({
        where: { id: world.publications.failed },
      });
      expect(kept.state).toBe('FAILED');
      expect(kept.errorReason).toContain('needs_reconnect');
      return report(w);
    }
    await expect
      .poll(
        async () =>
          (
            await db.videoPublication.findUniqueOrThrow({
              where: { id: world.publications.failed },
            })
          ).state,
      )
      .toBe('SCHEDULED');
    await report(w);
  });

  test('take down asks for confirmation and can be dismissed without any platform call', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit('/publications');
    await page.getByRole('radio', { name: 'Live' }).click();
    await page.getByRole('button', { name: 'Take down' }).first().click();
    await expect(page.getByRole('dialog')).toContainText('cannot be undone');
    await page.getByRole('button', { name: 'Keep it' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await report(w);
  });

  test('the project detail Publish tab lists its posts with cancel and retry', async () => {
    const page = pages.owner;
    const w = new Watcher(page, shotsDir);
    await w.visit(`/projects/${world.projects.partial}`);
    await page.getByRole('tab', { name: 'Publish' }).click();
    await expect(page.getByRole('button', { name: /Cancel TikTok post/ })).toBeVisible();
    await w.shot('project-posts');
    await report(w);
  });

  test('empty organisation: friendly empty state; mobile layout has no overflow', async ({
    browser,
  }) => {
    const empty = pages.empty;
    const w = new Watcher(empty, shotsDir);
    await w.visit('/publications');
    await expect(empty.getByText('Nothing published yet')).toBeVisible();
    await report(w);
    const mobile = await signedInPage(browser, baseURL, emailFor('owner'), {
      viewport: { width: 375, height: 800 },
    });
    const wm = new Watcher(mobile, shotsDir);
    await wm.visit('/publications');
    expect(
      await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    await wm.shot('publications-mobile');
    await report(wm);
    await mobile.context().close();
  });
});
