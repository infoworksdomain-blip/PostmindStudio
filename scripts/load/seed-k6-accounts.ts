import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { createArgon2Hasher } from '../../src/lib/auth/password';
import { assertFakeProvidersAllowed } from '../../src/lib/studio/load-test/guard';

// BACKLOG 20.29 — accounts for the 200-user k6 run (load-test/k6/studio-users.js), on a DISPOSABLE
// stack only (the same STUDIO_FAKE_PROVIDERS guard as the pipeline harness: never production).
// Users, organisations, memberships, plans, businesses and a few existing projects per
// organisation are written with Prisma; each user then signs in through the real Better Auth
// endpoint for a genuine session cookie (the pattern of e2e/qa/support.ts).
//
//   STUDIO_FAKE_PROVIDERS=1 npx tsx scripts/load/seed-k6-accounts.ts --base-url http://web:3010 \
//     --orgs 40 --users-per-org 5 --out ops/results/load-test/accounts.json

const PASSWORD = `Load-${randomUUID()}`;

/** A different private source address per call: the auth rate limit is keyed on x-real-ip. */
const randomIp = () =>
  `10.${1 + Math.floor(Math.random() * 254)}.${1 + Math.floor(Math.random() * 254)}.${1 + Math.floor(Math.random() * 254)}`;

/** "name=value" pairs from Set-Cookie headers, joined for a Cookie header. */
export function cookieHeader(setCookies: readonly string[]): string {
  return setCookies
    .map((c) => c.split(';')[0]?.trim() ?? '')
    .filter((pair) => pair.includes('='))
    .join('; ');
}

async function post(baseUrl: string, origin: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-real-ip': randomIp() },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res;
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      'base-url': { type: 'string', default: 'http://127.0.0.1:3010' },
      orgs: { type: 'string', default: '40' },
      'users-per-org': { type: 'string', default: '5' },
      tier: { type: 'string', default: 'STANDARD' },
      out: { type: 'string', default: 'ops/results/load-test/accounts.json' },
    },
  });
  assertFakeProvidersAllowed(process.env);
  const baseUrl = (args['base-url'] ?? '').replace(/\/$/, '');
  const origin = (process.env.APP_URL ?? baseUrl).replace(/\/$/, '');
  const db = new PrismaClient();
  const run = randomUUID().slice(0, 6);
  const passwordHash = await createArgon2Hasher().hash(PASSWORD);
  const accounts: Array<{
    email: string;
    cookie: string;
    organisationId: string;
    businessId: string;
    projectIds: string[];
  }> = [];
  for (let o = 0; o < Number(args.orgs); o += 1) {
    const organisationId = `lt-k6-${run}-${o}`;
    await db.organization.create({
      data: { id: organisationId, name: `k6 load ${run} ${o}`, slug: organisationId },
    });
    await db.orgEntitlement.create({
      data: {
        organisationId,
        tier: args.tier ?? 'STANDARD',
        access: 'full',
        source: 'admin',
        reason: 'load test 20.29',
      },
    });
    const business = await db.business.create({
      data: { organisationId, name: `k6 bakery ${o}`, createdByUserId: 'load-test' },
    });
    // A realistic dashboard: a few finished projects per organisation.
    const projectIds: string[] = [];
    for (let p = 0; p < 6; p += 1) {
      const project = await db.videoProject.create({
        data: {
          organisationId,
          businessId: business.id,
          createdByUserId: 'load-test',
          name: `Existing video ${p}`,
          description: 'Seeded for the load test',
          state: p % 2 ? 'READY_FOR_REVIEW' : 'DRAFT',
          sourceType: 'BRIEF',
          targetFormats: [{ platform: 'tiktok', aspectRatio: '9:16', duration: 30 }],
          metadata: { runId: randomUUID() },
        },
      });
      projectIds.push(project.id);
    }
    for (let u = 0; u < Number(args['users-per-org']); u += 1) {
      const email = `k6-${run}-${o}-${u}@example.test`;
      // Users and their password credential are written directly (the app's argon2id hasher, src/lib/auth/password.ts):
      // a production-like stack keeps sign-up closed until the legal texts are filled in
      // (src/lib/legal/readiness.ts). Signing IN is the real endpoint, so the session is genuine.
      const user = await db.user.create({
        data: { id: randomUUID(), name: `k6 ${o}.${u}`, email, emailVerified: true },
      });
      await db.account.create({
        data: {
          id: randomUUID(),
          accountId: user.id,
          providerId: 'credential',
          userId: user.id,
          password: passwordHash,
        },
      });
      await db.member.create({
        data: {
          id: randomUUID(),
          organizationId: organisationId,
          userId: user.id,
          role: u === 0 ? 'owner' : 'admin',
        },
      });
      const signIn = await post(baseUrl, origin, '/api/auth/sign-in/email', {
        email,
        password: PASSWORD,
      });
      const cookie = cookieHeader(signIn.headers.getSetCookie());
      if (!cookie) throw new Error(`no session cookie for ${email}`);
      accounts.push({ email, cookie, organisationId, businessId: business.id, projectIds });
    }
    process.stdout.write(`organisation ${o + 1}/${args.orgs} ready\n`);
  }
  await mkdir(dirname(args.out ?? '.'), { recursive: true });
  await writeFile(args.out ?? 'accounts.json', JSON.stringify(accounts));
  process.stdout.write(`${accounts.length} accounts → ${args.out}\n`);
  await db.$disconnect();
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/load/seed-k6-accounts.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
