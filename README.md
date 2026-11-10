# Loan Application Portal

A borrower portal and an underwriting desk for the Breakthru Ventures portfolio. Applicants file a
personal-loan application, underwriters review submitted files, and admins see counts plus an audit log.
This is a demo. Don't enter real financial information or upload real documents.

## What this app does

Applicants create and edit their own drafts, attach documents, and submit. Underwriters work a queue of
submitted applications: claim, request information, and approve or decline with reason codes. Admins
grant the underwriter role, read counts and storage, and verify the audit chain. They never see
application contents. Underwriters also get deterministic risk rules and an advisory AI summary (see "Risk rules and AI risk summary"). A full write-up of the state machine, the vault,
and fair-lending rules is too.

## Architecture

```
Browser (desktop and phone)
   │ HTTPS + session cookie
   ▼
Next.js container ── pages, server actions, route handlers (/api/*)
   │                  auth + RBAC, zod validation, AI gateway, JSON logs, /api/health
   ├──► Postgres (Drizzle; pgvector available for RAG)
   └──► Model API (Gemini free tier, Claude optional, or recorded demo answers)
```

| Concern | Where |
| --- | --- |
| Config, validated at startup | `src/lib/env.ts` |
| Schema and migrations | `src/lib/db/schema.ts`, `drizzle/` |
| Sign-in, sessions, roles | `src/lib/auth/` (Better Auth + admin plugin) |
| Access rules | `src/lib/access.ts` for applications (admin content is a 404). `src/lib/auth/rbac.ts` maps a session to one role |
| AI gateway | `src/lib/ai/` — input cap, JSON schema validation, demo fallback |
| Health check | `GET /api/health` (503 if the database is down) |

## Auth and roles

Three roles, `user` (applicant), `underwriter`, and `admin`, via Better Auth's admin plugin. An underwriter
has no admin-plugin permissions. Admin is not a superset of underwriter. **Admins manage accounts but never act as users:**
`src/lib/auth/permissions.ts` gives `admin` create, list, get, update, set-role, ban and delete on users plus
session revoke/delete. It withholds `impersonate`, `impersonate-admins`, `set-password` and `set-email`
(Better Auth's default admin role includes them) and session `list`, which would expose other users' raw
session tokens, IP addresses and user agents. `/admin/impersonate-user`, `/admin/stop-impersonating`,
`/admin/set-user-password` and `/admin/list-user-sessions` are also in `disabledPaths`, so they return 404 even
if a role is widened later. `update` lets an admin change another user's name and image (intended).
Tests: `test/admin-permissions.integration.test.ts`. Don't add these permissions back; apps promise that admins
see counts only.

## Run locally

```bash
cp .env.example .env.local          # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db
pnpm install
pnpm db:migrate
pnpm dev                             # http://localhost:3000
```

To make yourself an admin: sign up, then `SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... pnpm db:seed`
while the app is running.

## Design system

Every app shares the Breakthru look (guide and concept: `ai-dev-os/design/`). Tokens live in `src/app/globals.css`
(light and dark; use `bg-surface`, `text-muted`, `border-border`, `bg-accent` and the status tokens, never raw colors).
Fonts are self-hosted with `next/font/local` in `src/app/layout.tsx` (files and licenses in `src/app/fonts/`, so builds need no network): Newsreader (`font-display`), Public Sans (`font-sans`),
IBM Plex Mono (`font-mono`). Set the app's name once in `src/lib/app-config.ts` (`APP_TITLE`, or the `APP_NAME` variable).

| Component | Location | Use |
| --- | --- | --- |
| `AppShell` | `src/components/app-shell.tsx` | Header (logo, app name, nav, sign in or user and sign out) and footer; wraps every page in the root layout |
| `PageIntro` | `src/components/ui/` | Eyebrow, Newsreader headline, one-line description, actions |
| `StatTile`, `StatGrid` | `src/components/ui/` | A number and a label; tiles stack at 375px |
| `FilterBar` | `src/components/ui/` | Search, select filters, sort and table/cards toggle as a GET form (state in the URL) |
| `StatusBadge` | `src/components/ui/` | Live, building, blocked, not started (neutral), healthy, degraded, down |
| `DataList` | `src/components/ui/` | Table from 640px, cards below |
| `Panel` | `src/components/ui/` | Titled panel; `collapsible` adds a "Show all" toggle (small client component) |
| `DemoBadge` | `src/components/ui/` | "Demo data" label for seeded or demo content |

The header links come from `NAV_LINKS` in `src/lib/app-config.ts`; each app must edit that list (the template's
`/dashboard` and `/admin` links break if the app deletes those pages).

Shared button and field classes are in `src/components/ui/styles.ts` (44px minimum height). Don't add `loading.tsx` or
`<Suspense>` above a page that calls `requireRoleOrRedirect()` or `notFound()`.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests
TEST_DATABASE_URL=postgres://... pnpm test # plus data-layer tests against real Postgres
pnpm build && pnpm smoke                   # end-to-end smoke test against a running app
```

CI runs all of these plus both container builds on every pull request.

## Deploy

Every push to `main` publishes a multi-arch image (x86 and ARM) to GitHub Container Registry as
`ghcr.io/breakthrudevelopment/<repo>:sha-<commit>`. [30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra)
deploys those tags to AWS, Azure, Google Cloud and Oracle Cloud with Terraform; this repo holds no cloud credentials.

With `MIGRATE_ON_START=true` the server applies pending migrations before taking traffic, holding a Postgres
advisory lock so instances starting together can't race. `pnpm db:migrate` does the same by hand.

## Using the AI feature

| `AI_PROVIDER` | Behavior |
| --- | --- |
| `demo` (default) | Recorded answers from `src/lib/ai/demo.ts`; no key, no network |
| `gemini` | Google Gemini API (`GEMINI_API_KEY`, free tier) |
| `anthropic` | Claude (`ANTHROPIC_API_KEY`) |

With `AI_FALLBACK_TO_DEMO=true`, a quota error or outage serves the recorded answer and the UI says so.

## Risk rules and AI risk summary

**Rules first, model second.** `src/lib/risk-rules.ts` computes the metrics and flags with plain arithmetic: no
model, no database, so Oracle (no Gemini key) shows correct reasons. Metrics: monthly income, the estimated new
payment (amortization at a fixed demo APR per credit band: 9.9 / 14.9 / 21.9 / 29.9 percent, 24.9 for unknown),
DTI including that payment, loan-to-annual-income, months employed and documents by kind. Flags, each with a
reason built from the numbers and the rule as written: `DTI_HIGH` (over 43%), `DTI_ELEVATED` (36 to 43%),
`LTI_HIGH` (over 35%), `SHORT_EMPLOYMENT` (under 12 months, employed or self-employed), `NO_EMPLOYMENT_INCOME`,
`MISSING_INCOME_DOC`, `CREDIT_BAND_POOR`, `INCOME_UNVERIFIED` (always: documents aren't read). Ratios are rounded
to one decimal and the thresholds use the rounded value.

**The AI summary only explains the flags.** It never decides, and the decide action never reads it. It is shown to
underwriters only (applicants and admins get 404). The model (`generate()`, task `loan-risk-summary`) receives
only `<metrics>` and `<flags>` JSON (numbers, enums, flag codes; at most 3,000 characters). Names, employer,
notes, filenames and document contents are never inputs, so applicant free text can't reach the prompt.
`src/lib/risk-guardrails.ts` then drops concerns for flags the rules didn't raise, replaces any number that isn't
a computed one with the rule's reason, filters decision language and protected characteristics (a hit in the
summary replaces the whole answer: `mode: "fallback"`, rule reasons only), and drops strengths that contradict a
flag. With `AI_PROVIDER=demo` the recorded fixture goes through the same guardrails.

**Caching and caps.** One summary per version of the application's inputs (`risk_summary`, keyed by a hash of
the metrics and flags); any change to fields or documents makes the stored one stale and it is not returned.
Up to 3 regenerations per version, 20 generations per underwriter per hour, `RISK_DAILY_CAP` (default 200) per
day app-wide. Cached reads use no allowance. Each generation writes a `risk_summary.generated` audit row with
ids and codes only. Logs carry task, mode, flag codes, guardrail codes and latency, never application data.

### Route contract (`/api/applications/[id]/risk`)

Underwriter session required. Anonymous is 401. Applicants, admins, drafts and unknown ids are 404.
Mutating calls require a same-origin request.

| Call | Body | Response |
| --- | --- | --- |
| `GET` | none | `200 { risk }` from the rules; `risk.summary` is the cached summary or `null`. No model call |
| `POST` | optional `{ "regenerate": true }` | `200 { risk }` with the cached summary, or a newly generated one |

`risk`: `{ applicationId, applicationVersion, metrics, flags, summary, outdated, unavailable?, disclaimer }`.

- `metrics`: `{ monthlyIncomeCents, newPaymentCents, assumedAprPct, dtiPct | null, ltiPct | null, monthsEmployed, creditBand, documents: { id, pay_stub, bank_statement, tax_return, other } }` (counts).
- `flags[]`: `{ code, severity: "high" | "medium" | "info", reason, rule, evidence: metric names[] }`. Always shown, with or without a summary.
- `summary`: `null` or `{ mode: "live" | "demo" | "fallback", provider, generatedAt, regenerationsLeft, data }`, where `data` is `{ summary, strengths[{ text, evidence }], concerns[{ flag, text, evidence }], questionsForApplicant[] }`. Every `concerns[].flag` is one of `flags[].code`; render the rule `reason` and `rule` beside it.
- `outdated`: a summary exists for an older version of the application; offer "Generate".
- `unavailable`: the model failed; `summary` holds the rule reasons only and wasn't stored.
- `disclaimer`: show it on the panel: "AI summary to assist review. The underwriter makes the decision."

Errors: 409 (regeneration allowance used, or the application changed while generating), 429 (hourly or daily
limit), 400 (bad body).

**Evals.** `test/ai-evals.test.ts` runs in CI with the model stubbed at the network edge (the real `generate()`
and guardrails run) and the demo fixture for demo mode. `GEMINI_API_KEY=... pnpm eval:risk` runs the
answer-quality evals against the live model; it isn't possible on Oracle (no key).

### Images: `generate({ images })`

`generate()` takes an optional `images: { mimeType, data }[]` (base64 of the raw bytes, no `data:` prefix). Limits
(`input_rejected`, checked before any network call, in every mode): at most 4 images, 5 MB each decoded
(`MAX_IMAGE_BYTES`), 10 MB in total, MIME `image/jpeg`, `image/png`, `image/webp`, `image/heic` or `image/heif`, valid
base64. Gemini gets one `inlineData` part per image before the text part; Anthropic gets `image` blocks and rejects
HEIC/HEIF. `demo` answers from the task's fixture and ignores the images. Logs carry the image count and total bytes,
never the data. Treat text inside an image as data in your system prompt, exactly like user text.

### Embeddings: `embed()`

`embed({ task, texts, kind: "document" | "query" })` from `src/lib/ai` returns
`{ vectors, provider, model, dims, demo, latencyMs }`: 768-dim, L2-normalized vectors (fits pgvector's 2,000-dim
HNSW limit). Limits: 32 texts per call, 8,000 characters each, 64,000 in total (`input_rejected`).

- `gemini` calls `batchEmbedContents` with `AI_EMBED_MODEL` (default `gemini-embedding-2`, which takes the task in
  the text: `task: search result | query: …` / `title: none | text: …`; set `gemini-embedding-001` to use `taskType`).
  Changing the model changes the vector space: stored vectors must be re-embedded.
- `demo` (and a missing key, or a provider failure while `AI_FALLBACK_TO_DEMO=true`) uses deterministic hashed
  bag-of-words vectors, model `demo-hash-768`: lexical but meaningful, offline.
- `AI_PROVIDER=anthropic` has no embeddings API, so it embeds with Gemini if `GEMINI_API_KEY` is set, else demo.
- Always store `model` with each vector and only compare vectors with the same model; a demo fallback reports
  `demo: true` and the demo model name so vector spaces are never mixed.
- `AI_TIMEOUT_MS` (default 20000, max 22000) bounds every provider call, `generate()` and `embed()` alike.
- Logs carry task, provider, model, count and latency, never the text.
