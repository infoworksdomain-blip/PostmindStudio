import { expect, test, type Page } from '@playwright/test';
import {
  addMember,
  cleanWorld,
  createUser,
  emailFor,
  newDb,
  seedWorld,
  signedInPage,
  type Db,
  type World,
} from './fixtures';
import { baseURL } from './pass2.support';
import { Watcher } from './watcher';

// 20.31 (QA pass 2) — Approvals and "Plan my month" through the real UI against a Prisma-seeded
// organisation: the business picker (no raw ids), a workflow that points at a removed business,
// rejecting at the second step, and the month-plan list and editor. No provider is called.

const hasDb = Boolean(process.env.DATABASE_URL);
test.skip(!hasDb, 'DATABASE_URL is not set: the QA specs need the app’s database');
test.describe.configure({ mode: 'serial' });

let db: Db;
let world: World;
const pages = {} as Record<'owner' | 'admin' | 'publisher', Page>;
const ROLES = ['owner', 'admin', 'publisher'] as const;

async function expectClean(w: Watcher): Promise<void> {
  expect(w.issues).toEqual([]);
}

test.beforeAll(async ({ browser, playwright }) => {
  test.setTimeout(240_000);
  db = newDb();
  const request = await playwright.request.newContext({ baseURL });
  const ids = {} as Record<(typeof ROLES)[number], string>;
  for (const role of ROLES) {
    ids[role] = await createUser(request, db, baseURL, emailFor(`p2-${role}`), `QA ${role}`);
  }
  world = await seedWorld(db, ids.owner);
  for (const role of ROLES) await addMember(db, world.orgId, ids[role], role);
  for (const role of ROLES)
    pages[role] = await signedInPage(browser, baseURL, emailFor(`p2-${role}`));
  await request.dispose();
});

test.afterAll(async () => {
  for (const page of Object.values(pages)) await page?.context().close();
  await db?.contentPlan
    .deleteMany({ where: { organisationId: world?.orgId } })
    .catch(() => undefined);
  await cleanWorld(db, world);
  const emails = ROLES.map((r) => emailFor(`p2-${r}`));
  const users = await db.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  await db.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await db.account.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  if (world)
    await db.organization.deleteMany({ where: { id: { in: [world.orgId, world.emptyOrgId] } } });
  await db?.$disconnect();
});

test.describe('approval workflows', () => {
  test('the business is picked by name, saved by id, shown by name, and can be changed', async () => {
    const page = pages.owner;
    const w = new Watcher(page);
    await w.visit('/approvals');
    await page.getByRole('button', { name: 'New workflow' }).first().click();
    const form = page.getByRole('form', { name: 'New approval workflow' });
    // No free-text id box any more.
    await expect(form.getByLabel(/Business ids/)).toHaveCount(0);
    await form.getByLabel('Name').fill('Bakery sign-off');
    const picker = form.getByRole('group', { name: 'Businesses' });
    await picker.getByRole('button', { name: 'QA Bakery' }).click();
    await expect(picker.getByRole('button', { name: 'QA Bakery' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await form.getByRole('button', { name: 'TikTok' }).click();
    await form.getByRole('button', { name: 'Create workflow' }).click();
    await expect(page.getByText('Workflow created.').first()).toBeVisible();
    await expect(page.getByText('Applies to business QA Bakery · TikTok')).toBeVisible();
    await expect(page.getByText(world.businessId)).toHaveCount(0);
    const stored = await db.approvalWorkflow.findFirstOrThrow({
      where: { organisationId: world.orgId, name: 'Bakery sign-off' },
    });
    expect(stored.appliesTo).toMatchObject({
      businessIds: [world.businessId],
      platforms: ['tiktok'],
    });

    // Edit: unselect the business, so the workflow applies to every business again.
    await page.getByRole('button', { name: 'Edit' }).first().click();
    const edit = page.getByRole('form', { name: 'Edit Bakery sign-off' });
    const editPicker = edit.getByRole('group', { name: 'Businesses' });
    await expect(editPicker.getByRole('button', { name: 'QA Bakery' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await editPicker.getByRole('button', { name: 'QA Bakery' }).click();
    await edit.getByRole('button', { name: 'Save workflow' }).click();
    await expect(page.getByText(/Workflow saved/).first()).toBeVisible();
    await expect(page.getByText('Applies to TikTok', { exact: true })).toBeVisible();
    expect(
      (await db.approvalWorkflow.findUniqueOrThrow({ where: { id: stored.id } })).appliesTo,
    ).toMatchObject({ businessIds: [] });

    await page.getByRole('button', { name: 'Delete Bakery sign-off' }).click();
    await page.getByRole('button', { name: 'Confirm delete' }).click();
    await expect(page.getByText(/Deleted “Bakery sign-off”/).first()).toBeVisible();
    await expectClean(w);
  });

  test('a workflow for a business that no longer exists says so and never shows the id', async () => {
    const page = pages.owner;
    const gone = `biz-removed-${world.businessId.slice(-6)}`;
    const wf = await db.approvalWorkflow.create({
      data: {
        organisationId: world.orgId,
        name: 'Wholesale sign-off',
        steps: [{ role: 'admin', minApprovers: 1 }],
        appliesTo: { businessIds: [gone], platforms: [], tags: [] },
      },
    });
    const w = new Watcher(page);
    await w.visit('/approvals');
    await expect(page.getByText('Applies to business a removed business')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'no longer applies' })).toBeVisible();
    await expect(page.getByText(gone)).toHaveCount(0);
    // Editing shows it as a removed business too, and unselecting it clears it.
    await page.getByRole('button', { name: 'Edit' }).first().click();
    const edit = page.getByRole('form', { name: 'Edit Wholesale sign-off' });
    const stale = edit.getByRole('group', { name: 'Businesses' }).getByRole('button', {
      name: 'a removed business',
    });
    await expect(stale).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(gone)).toHaveCount(0);
    await stale.click();
    await edit.getByRole('button', { name: 'Save workflow' }).click();
    await expect(page.getByText(/Workflow saved/).first()).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'no longer applies' })).toHaveCount(0);
    await db.approvalWorkflow.delete({ where: { id: wf.id } });
    await expectClean(w);
  });

  test('step 1 approved by a publisher, then an admin rejects at step 2 with a note', async () => {
    const wf = await db.approvalWorkflow.create({
      data: {
        organisationId: world.orgId,
        name: 'QA publisher then admin (reject)',
        steps: [
          { role: 'publisher', minApprovers: 1 },
          { role: 'admin', minApprovers: 1 },
        ],
        appliesTo: { platforms: [], businessIds: [world.businessId], tags: [] },
      },
    });
    const project = world.projects.review3;
    const publisher = pages.publisher;
    const wp = new Watcher(publisher);
    await wp.visit(`/projects/${project}`);
    await expect(publisher.getByRole('region', { name: 'Approval steps' })).toContainText(
      /Step 1 of 2/,
    );
    await publisher.getByRole('button', { name: 'Approve', exact: true }).click();
    await publisher.getByRole('button', { name: 'Confirm approval' }).click();
    await expect(publisher.getByRole('region', { name: 'Approval steps' })).toContainText(
      /Step 2 of 2/,
    );

    const admin = pages.admin;
    const wa = new Watcher(admin);
    await wa.visit(`/projects/${project}`);
    await admin.getByRole('button', { name: 'Reject' }).click();
    await expect(admin.getByRole('button', { name: 'Confirm rejection' })).toBeDisabled();
    await admin.getByLabel(/What needs to change/).fill('The offer price is out of date');
    await admin.getByRole('button', { name: 'Confirm rejection' }).click();
    await expect(admin.getByText('Rejected.').first()).toBeVisible();
    await expect
      .poll(async () => (await db.videoProject.findUniqueOrThrow({ where: { id: project } })).state)
      .toBe('REJECTED');
    const tasks = await db.approvalTask.findMany({
      where: { projectId: project },
      orderBy: { stepIndex: 'asc' },
    });
    expect(tasks.map((t) => [t.stepIndex, t.state])).toEqual([
      [0, 'APPROVED'],
      [1, 'REJECTED'],
    ]);
    expect(tasks[1]?.note).toContain('out of date');
    await admin.reload();
    await expect(admin.getByRole('region', { name: 'Approval steps' })).toContainText(
      /rejected at step 2 of 2/,
    );
    await db.approvalWorkflow.delete({ where: { id: wf.id } });
    await expectClean(wp);
    await expectClean(wa);
  });
});

test.describe('Plan my month', () => {
  let planId: string;

  test('the plans list shows a drafted plan and the editor opens it', async () => {
    const page = pages.owner;
    const start = new Date(Date.now() + 2 * 86_400_000);
    const at = (n: number, hh: number) =>
      new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + n, hh, 30),
      );
    const plan = await db.contentPlan.create({
      data: {
        organisationId: world.orgId,
        businessId: world.businessId,
        createdByUserId: 'qa-p2',
        status: 'DRAFT',
        startDate: start.toISOString().slice(0, 10),
        days: 2,
        timezone: 'UTC',
        windowStart: at(0, 0),
        windowEnd: at(2, 0),
        postsPerDay: 2,
        videoShare: 50,
        platforms: ['tiktok'],
        targets: [{ platform: 'tiktok', connectionId: world.connections.tiktok }],
        planTier: 'STANDARD',
        requestedCount: 3,
        items: {
          create: [
            { n: 0, h: 9, kind: 'VIDEO', title: 'Sourdough basics' },
            { n: 0, h: 17, kind: 'SLIDESHOW', title: 'Three bakery myths' },
            { n: 1, h: 9, kind: 'VIDEO', title: 'Meet the baker' },
          ].map((i, position) => ({
            organisationId: world.orgId,
            position,
            slotAt: at(i.n, i.h),
            kind: i.kind as 'VIDEO' | 'SLIDESHOW',
            angle: 'custom',
            title: i.title,
            brief: `Brief for ${i.title}`,
            slides:
              i.kind === 'SLIDESHOW'
                ? { hook: i.title, points: ['One', 'Two'], cta: 'Visit us' }
                : undefined,
          })),
        },
      },
    });
    planId = plan.id;
    const w = new Watcher(page);
    await w.visit('/plans');
    await expect(page.getByRole('heading', { name: 'Month plans' }).first()).toBeVisible();
    const row = page.getByRole('link').filter({ hasText: '3 posts' }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('Draft');
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/plans/${planId}$`));
    await expect(page.getByText('3 posts: 2 videos and 1 slideshow')).toBeVisible();
    for (const title of ['Sourdough basics', 'Three bakery myths', 'Meet the baker']) {
      await expect(page.getByText(title).first()).toBeVisible();
    }
    await expectClean(w);
  });

  test('discarding a draft needs a confirmation and removes it from the list', async () => {
    const page = pages.owner;
    const w = new Watcher(page);
    await w.visit(`/plans/${planId}`);
    await page.getByRole('button', { name: 'Discard plan' }).click();
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(dialog.getByText('Discard this plan?')).toBeVisible();
    // Not yet: the draft stays.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await db.contentPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'DRAFT',
    );
    await page.getByRole('button', { name: 'Discard plan' }).click();
    await dialog.getByRole('button', { name: 'Discard plan' }).click();
    await expect(page.getByText('Plan discarded').first()).toBeVisible();
    await expect
      .poll(async () => (await db.contentPlan.findUnique({ where: { id: planId } }))?.status)
      .not.toBe('DRAFT');
    await expectClean(w);
  });
});
