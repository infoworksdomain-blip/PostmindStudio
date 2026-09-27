# PostMind Studio — Claude Code Starter Kit

You are looking at the starter kit for building **PostMind Studio**, an AI video generation and multi-platform publishing microservice for PostMind AI. This kit is designed to be built by **you + Claude Code** working together.

## What's in this kit

```
postmind-studio/
├── CLAUDE.md              ← Read by Claude Code every session (architecture + rules)
├── BACKLOG.md             ← Sequenced work items (Phase 0 → Phase 12)
├── PROGRESS.md            ← Build log (updated as you go)
├── README.md              ← This file
├── .env.example           ← Every env var documented (60+)
├── .gitignore
├── prompts/
│   └── FIRST_PROMPTS.md   ← Literal prompts to paste into Claude Code
├── docs/
│   ├── PostMind_Studio_Specification.docx           ← v1.0 spec (47pp)
│   ├── PostMind_Studio_Specification_Addendum_v1.1.docx  ← v1.1 additions (34pp)
│   ├── PostMind_Studio_PreProduction_Planning_Playbook.docx  ← planning context (29pp)
│   └── PostMind_Engagement_Developer_Handover.docx  ← sibling service pattern (39pp)
├── prisma/                ← Prisma will populate this
├── src/                   ← Claude Code will populate this
│   ├── app/
│   ├── lib/
│   └── components/
├── scripts/               ← Dev scripts (Claude Code will add these)
├── .github/workflows/     ← CI (Claude Code will set up)
└── docker-compose.yml     ← Local Postgres + Redis (Claude Code will create)
```

## Local development (quick reference)

Requires Node.js 20 LTS or newer, npm 10+, and Docker.

```bash
npm install                      # also runs `prisma generate`
cp .env.example .env.local       # then fill in real values (never commit .env.local)
npm run db:up                    # Postgres 15 + pgvector on :5432, Redis 7 on :6379
npm run db:migrate               # applies prisma/migrations to the `studio` schema
npm run dev                      # http://localhost:3010
```

| Script | What it does |
|--------|--------------|
| `npm run typecheck` | `tsc --noEmit` in strict mode |
| `npm run lint` | ESLint (Next.js + TypeScript rules), zero warnings allowed |
| `npm run format` / `format:check` | Prettier write / verify |
| `npm test` / `test:watch` / `test:coverage` | Vitest (coverage threshold 80% on `src/lib`) |
| `npm run build` | Production Next.js build |
| `npm run db:validate` | Validate `prisma/schema.prisma` |
| `npm run db:reset` | Drop and re-apply all migrations on the local DB (destructive) |
| `npm run db:studio` | Prisma Studio GUI |
| `npm run db:down` | Stop the local containers (data volumes kept) |
| `npm run gate2:anthropic` / `:runway` / `:elevenlabs` / `:shotstack` / `:router` | GATE 2 live smoke tests against staging keys (write `provider_jobs` rows; Runway costs real credits) |

Prisma CLI commands read `.env.local` via `dotenv-cli`; Next.js loads `.env.local` automatically.
CI (`.github/workflows/ci.yml`) runs validate, typecheck, lint, format check and tests on every push.

> npm 11+ blocks dependency install scripts unless approved. The `allowScripts` field in
> `package.json` approves exactly the ones Studio needs (Prisma engines, esbuild, unrs-resolver).
> After upgrading one of those packages, run `npm install-scripts approve <pkg>`.

## Setup — do this once before starting Claude Code

### 1. Install Claude Code

Follow the official install instructions at https://claude.com/docs/claude-code.

Verify: `claude --version`

### 2. Clone this starter into a new empty directory

```bash
# Unzip the starter kit to a location of your choice, e.g.:
unzip postmind-studio-starter.zip -d postmind-studio
cd postmind-studio
```

### 3. Initialize as a git repository

```bash
git init
git add .
git commit -m "chore: initial starter kit"
```

### 4. Copy `.env.example` to `.env.local`

```bash
cp .env.example .env.local
```

Then populate `.env.local` with your real credentials. Everything in `.env.example` is documented with where to get it. `.env.local` is git-ignored — never commit it.

### 5. Verify you have the required tools locally

Required:
- **Node.js 20 LTS** — `node --version` should be `v20.x`
- **npm 10+** — `npm --version`
- **Docker** — `docker --version` (for local Postgres + Redis)
- **PostgreSQL client** (`psql`) — for spot checks

If any missing, install before proceeding.

## Starting the build

### Step 1 — Open in VS Code

```bash
code .
```

### Step 2 — Start Claude Code

In the VS Code integrated terminal, from the repo root:

```bash
claude
```

Claude Code will start and automatically read `CLAUDE.md`. It should acknowledge the project.

### Step 3 — Paste Prompt 1 from `prompts/FIRST_PROMPTS.md`

Open `prompts/FIRST_PROMPTS.md`. Copy Prompt 1. Paste it into the Claude Code terminal.

Wait for Claude Code to respond. Follow the prompts in sequence.

### Step 4 — Work through the backlog

After the first 10 prompts, you'll be building in phases. Use prompts like:

- `"Start Phase 3. Show me the plan first."`
- `"Continue with the next backlog item."`
- `"GATE 3 review: run the end-to-end test."`

## How to work with Claude Code effectively

### Do

- ✅ Review every diff before accepting. Claude Code makes mistakes.
- ✅ Test after every phase completes. Run the tests yourself.
- ✅ Update `PROGRESS.md` yourself if Claude Code forgets.
- ✅ Cite the spec section number when correcting Claude Code.
- ✅ Start fresh sessions when things go sideways — sometimes context grows too dense.
- ✅ Use git aggressively. Commit after every accepted change.
- ✅ Read what Claude Code writes. If you don't understand a file, ask Claude Code to explain it.

### Don't

- ❌ Accept diffs blindly, especially in security-sensitive code (auth, tokens, kill switch).
- ❌ Skip gates. Every `[GATE]` in `BACKLOG.md` is a decision point.
- ❌ Let Claude Code make load-bearing architecture changes without your review.
- ❌ Ship anything to production without running against real staging APIs first.
- ❌ Assume Claude Code will remember conversations from days ago — restate context if needed.
- ❌ Rush. Solo development with an AI is fast, but "fast" is not the same as "in one afternoon."

## Realistic timeline

Based on the specs and assuming you're driving Claude Code for 4-6 hours a day:

| Phase | Description | Wall time |
|-------|-------------|-----------|
| 0-2 | Foundations, integration points, first providers | 1-2 weeks |
| 3-4 | Pipeline + project APIs | 2 weeks |
| 5 | Publishing to all 6 platforms | 2-3 weeks |
| 6-8 | v1.1 features (Website scan, Slideshow, Overlays) | 3-4 weeks |
| 9 | Video library (Feature A) — ingestion + search + TEMPLATE | 3-4 weeks |
| 10 | Frontend (parallel with 6-9) | 4-6 weeks |
| 11 | Analytics + observability | 1-2 weeks |
| 12 | Hardening + launch prep | 2 weeks |

**Total realistic solo timeline: 3-4 months to v1.0 GA.**

This assumes:
- You are the QA and product owner
- You have all external accounts (Meta, TikTok, YouTube approvals) already active
- You have the corpus delivered to S3 before Phase 9
- You take Claude Code's output seriously — reviewing, testing, correcting

## When you get stuck

1. **Claude Code produces wrong code**: Reject the diff. Cite the spec section. Ask again.
2. **Claude Code loops**: Start a fresh session with `claude` in a new terminal. Restart from where the last session left off using `PROGRESS.md`.
3. **A provider API doesn't work**: The specs may have outdated details. Trust the provider's current docs. Have Claude Code fetch and read them.
4. **A test fails and you don't know why**: Ask Claude Code to explain the failure and propose a fix. Do not just accept the "fix" — understand it first.
5. **You're overwhelmed**: Stop. Come back tomorrow. Solo building an application this size is a marathon.

## Support resources

- **Specs**: `/docs/` — always the first place to check.
- **Engagement service pattern**: `/docs/PostMind_Engagement_Developer_Handover.docx` — the sibling service is the reference implementation. When in doubt, copy its pattern.
- **Claude Code docs**: https://claude.com/docs/claude-code
- **Provider docs** (bookmark these):
  - Runway: https://docs.runwayml.com
  - Luma: https://docs.lumalabs.ai
  - HeyGen: https://docs.heygen.com
  - ElevenLabs: https://elevenlabs.io/docs
  - Shotstack: https://shotstack.io/docs
  - AssemblyAI: https://www.assemblyai.com/docs
  - OpenAI: https://platform.openai.com/docs
  - Anthropic: https://docs.claude.com
  - Meta Graph API: https://developers.facebook.com/docs/graph-api
  - TikTok Content Posting API: https://developers.tiktok.com/doc/content-posting-api-get-started
  - YouTube Data API: https://developers.google.com/youtube/v3
  - X API: https://docs.x.com/x-api
  - LinkedIn API: https://learn.microsoft.com/en-us/linkedin/

## One final thing

The specs describe a system that would take a team of 5-7 engineers 5-8 months. You are attempting this solo with an AI assistant. That's a real acceleration but not magic. Expect frustrations, expect rework, expect to learn things about video encoding and rate limits you didn't want to know.

Move quickly on the boring parts (scaffolding, boilerplate, CRUD endpoints). Slow down on the critical parts (auth, publishing, kill switch, cost tracking). Ship something you'd let your own customers use.

Good luck.
