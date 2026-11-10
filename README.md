# Loan Application Portal

> A borrower portal plus an underwriting desk for community banks, credit unions, and online lenders.

Live: [https://app8.breakthruventures.ai](https://app8.breakthruventures.ai) · Runs on: Oracle Cloud (OCI Always Free A1 VM) · Part of [30 apps in 30 days](https://github.com/BreakthruDevelopment/ai-dev-os)

> **Demo Only Notice:** This application is a technology demonstration. Do not enter real personal financial information (such as real income or real account numbers) or upload real personal identity documents. The system deliberately does not collect Social Security Numbers or dates of birth.

---

## What this app does

Community banks, credit unions, and online lending platforms require strict operational boundaries: applicants need a seamless digital experience on their phones, while underwriters need a secure queue to evaluate files, verify supporting documents, request missing information, and render credit decisions.

* **Applicants (`user` role):** Complete mobile-friendly personal loan applications (amount, term, loan purpose, employment, income, housing, and existing debt payments). Upload and manage required identity and income verification documents into a secure document vault. Track application progress on a timeline, respond to underwriter information requests, or withdraw applications before a final decision.
* **Underwriters (`underwriter` role):** Review the submitted queue, claim files, inspect financial metrics and rule flags, examine uploaded documents, consult an AI risk summary, communicate with applicants via structured messages, and record approval or decline decisions with mandatory reason codes.
* **Admins (`admin` role):** Manage user accounts and assign underwriter credentials, monitor aggregate system metrics (application counts by status, document storage usage against quota caps), and inspect and cryptographically verify the append-only audit trail. Admins have zero access to applicant financial data or document contents.

---

## The Three Roles and Separation of Duties

Financial institutions and regulatory examiners mandate strict separation of duties: credit decisions must be decoupled from user account and system administration.

| Role | Permissions & Scope | Restricted Powers |
| --- | --- | --- |
| **Applicant (`user`)** | Create, edit, and submit own loan applications; upload/delete own documents while editable; respond to underwriter information requests; withdraw own application; view own status timeline. | Cannot view any other applicant's file; cannot view internal underwriter notes; cannot access underwriter queue or admin controls. |
| **Underwriter (`underwriter`)** | Access the queue of submitted loans; claim or release applications; review applicant details and documents; view computed financial metrics and AI risk summaries; write internal notes; request information; approve or decline applications. | Zero administrative powers in Better Auth (cannot set roles, ban users, delete accounts, or inspect system sessions); cannot view draft applications. |
| **Admin (`admin`)** | User account management (create, list, update, ban, delete, assign roles); monitor aggregate counts and document storage volume vs. caps; inspect audit log metadata; execute audit chain cryptographic verification; seed demo workspace. | Strictly barred from viewing application contents, applicant financials, underwriter notes, or downloading loan documents (all content queries return 404). |

### Why Underwriter is a Distinct Role

Mapping underwriters onto `admin` would give underwriters user-management capabilities (banning users, changing roles), violating core banking audit separation-of-duties principles, and would breach the portfolio guarantee that admins see only counts and never customer content. Conversely, implementing underwriting as a simple flag on `user` would place authorization outside the role system.

Instead, `underwriter` is a first-class app-level role in Better Auth permissions (`src/lib/auth/permissions.ts` and `src/lib/auth/rbac.ts`). Underwriters hold zero Better Auth administrative capabilities, and role changes (`role.changed`) are logged to the tamper-evident audit trail.

---

## Application State Machine

Applications transition through an immutable state machine enforced in a single database transaction with version-based optimistic locking (`version`). Stale updates fail with `409 Conflict`.

```
                ┌───────────────┐
                │     Draft     │
                └───────┬───────┘
                        │ applicant submits (requires valid fields +
                        │ ≥1 ID doc and ≥1 income doc)
                        ▼
                ┌───────────────┐
         ┌─────►│   Submitted   │◄────────────────┐
         │      └───────┬───────┘                 │
         │              │ underwriter claims      │
underwriter releases    ▼                         │ applicant replies
         │      ┌───────────────┐                 │ or uploads doc
         └──────┤   In Review   │                 │
                └───┬─────────┬─┘                 │
 underwriter requests│         │                  │
 information        │         │                  │
                    ▼         │ underwriter      │
       ┌──────────────────┐   │ approves/declines│
       │  Info Requested  ├───┘                  │
       └────────┬─────────┘                      │
                └────────────────────────────────┘
                        │
                        ▼ (from In Review)
             ┌─────────────────────┐
             │ Approved / Declined │ (Final, immutable)
             └─────────────────────┘

 * Any non-final state can be transitioned to "Withdrawn" by the applicant.
```

### Transition Rules

* **`draft` → `submitted`:** Triggered by the applicant. Requires all mandatory fields (amount, term, purpose, employment status, income, housing, debts) and document completeness: at least one ID document (`id`) and at least one income verification document (`pay_stub`, `bank_statement`, or `tax_return`).
* **`submitted` → `in_review`:** Claimed by an underwriter (`assigned_underwriter_id = actor.id`).
* **`in_review` → `submitted`:** Released back to the unclaimed pool by the assigned underwriter.
* **`in_review` → `info_requested`:** Underwriter requests additional information with an applicant-visible message (up to 1,000 characters).
* **`info_requested` → `submitted`:** Applicant submits a response note or uploads a requested document.
* **`in_review` → `approved`:** Assigned underwriter approves with an optional decision note.
* **`in_review` → `declined`:** Assigned underwriter declines, requiring 1 to 4 adverse action reason codes from a fixed list:
  * `DTI_TOO_HIGH`
  * `INSUFFICIENT_INCOME`
  * `INCOMPLETE_DOCUMENTATION`
  * `SHORT_EMPLOYMENT`
  * `UNVERIFIABLE_INFORMATION`
  * `OTHER` (mandatory accompanying note)
* **Any non-final state → `withdrawn`:** Initiated by the applicant.
* **Finality:** `approved`, `declined`, and `withdrawn` are permanent and immutable. Submitted applications cannot be deleted; drafts may be deleted by their owner.

---

## Document Vault & Upload Hygiene

Documents are stored directly inside PostgreSQL using two split tables: `document` (metadata) and `document_blob` (`bytea` payload). Standard metadata and list queries never select or transfer document bytes, preventing memory bloat.

### Hygiene & Safeguards

* **Strict Quota Caps:** Uploads are capped at 5 MB per file, up to 8 files and 20 MB per application, with an app-wide storage ceiling of 2,048 MB (`DOC_STORAGE_CAP_MB`). Total storage is evaluated under a Postgres advisory lock before write; when the ceiling is reached, uploads fail closed with a clear message.
* **Pre-read Size Enforcement:** Route handlers inspect the HTTP `Content-Length` header prior to reading request streams (`411 Length Required` if missing, `413 Payload Too Large` if > 5.5 MB).
* **Magic-Byte Sniffing:** MIME types are verified by inspectable magic bytes (`%PDF-` for PDF, PNG signature, JPEG `FF D8 FF`), rather than client file extensions or HTTP headers. Extension and sniffed type must match (`415 Unsupported Media Type` otherwise).
* **PDF Active-Content Refusal:** PDFs containing scripts, executable actions, embedded attachments, or encryption (`/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/RichMedia`, `/XFA`, `/Encrypt`) are rejected.
* **Sanitized Filenames:** User filenames are stripped of path separators and control characters, capped at 120 characters, and used strictly for display. Download headers generate deterministic names (`document-<id>.<ext>`).
* **Deduplication:** SHA-256 hashes are calculated for every file; uploading the duplicate file to the same application returns `409 Conflict`.
* **Download Hardening:** Served with defensive security headers:
  * `Content-Disposition: attachment; filename="document-<id>.<ext>"` (`?inline=1` allowed only for PNG/JPEG preview; PDFs always download).
  * `X-Content-Type-Options: nosniff`
  * `Content-Security-Policy: default-src 'none'; sandbox`
  * `Cross-Origin-Resource-Policy: same-origin`
  * `Cache-Control: private, no-store`

### Why There is No Antivirus (AV) Scanning

ClamAV requires a dedicated sidecar container consuming 1.0–1.5 GB of RAM with frequent virus signature database updates. On the Oracle Always Free ARM VM, where the execution agent runs without root privileges in a constrained memory budget, running an AV sidecar is infeasible.

**Defense-in-Depth Mitigations:**
1. Upload type strict allow-list with byte-level magic number sniffing.
2. Heuristic refusal of active PDF scripts, embedded objects, and encrypted containers.
3. Download isolation via sandboxed CSP headers preventing browser script execution.
4. Review screens explicitly warn underwriters: *"Files aren't scanned for malware."*

---

## Append-Only Audit Log

Every security-sensitive action writes an audit event inside the exact same database transaction as the business operation (`appendAudit`), ensuring that actions and their audit entries commit or roll back together.

### Tamper Evidence & Cryptographic Hash Chain

To provide mathematical proof against record alteration:
1. Every write acquires a transactional advisory lock (`pg_advisory_xact_lock`).
2. The current tail hash is read (`prev_hash`).
3. The new event hash is computed:
   $$\text{hash} = \text{SHA-256}(\text{prev\_hash} \mathbin{\Vert} \text{CanonicalJSON}(\text{id}, \text{at}, \text{actor\_id}, \text{actor\_role}, \text{action}, \text{application\_id}, \text{document\_id}, \text{detail}))$$
4. Database triggers (`BEFORE UPDATE`, `BEFORE DELETE`, `BEFORE TRUNCATE`) abort any modification attempt on `audit_event`.
5. Administrators can verify the cryptographic integrity of the entire log at `/admin/audit` via **Verify chain** (`POST /api/admin/audit/verify`), which walks the hash chain from the genesis block and reports broken links.

### The Superuser Limit on Oracle

Database triggers prevent accidental changes and standard application-level tampering. However, in the current Oracle Always Free deployment, all applications share a single PostgreSQL instance connecting as the database `superuser`. A superuser has the privileges to disable or drop table triggers.

While triggers stop accidental modifications, the **cryptographic SHA-256 hash chain** ensures that any unauthorized modification, deletion, or insertion by a privileged account breaks subsequent hashes, making any log tampering immediately evident upon audit verification.

### Privacy by Design in Audit Details

Audit `detail` payloads (JSON up to 2 KB) record action metadata, statuses, reason codes, and entity IDs, but **never personal financial values, borrower names, notes, or raw filenames**. This enables administrators to audit compliance without compromising applicant privacy.

---

## Rules-First AI & Fair-Lending Guardrails

Credit risk assessment is governed by strict fair lending laws (Equal Credit Opportunity Act / Regulation B). Machine learning models must not make credit decisions, introduce unlawful bias, or hallucinate financial figures.

```
┌─────────────────────────────────┐
│     Applicant Form & Docs       │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│   Deterministic Rules Engine    │
│      (src/lib/risk-rules.ts)    │
│  - Monthly Income & Debt ratios │
│  - Amortized payment (demo APR) │
│  - DTI (>43% high, 36-43% elev) │
│  - LTI (>35% high)              │
│  - Employment & Document checks │
└────────────────┬────────────────┘
                 │ metrics & rule flags JSON
                 ▼
┌─────────────────────────────────┐
│       AI Explanation Model      │
│     (generate() / Gemini)       │
│  - Explains computed flags      │
│  - Highlights strengths         │
│  - Suggests missing questions   │
└────────────────┬────────────────┘
                 │ raw text output
                 ▼
┌─────────────────────────────────┐
│    Fair-Lending Guardrails      │
│   (src/lib/risk-guardrails.ts)  │
│  - Drop unrecognized flags      │
│  - Verify all cited numbers     │
│  - Decision language filter     │
│  - Protected characteristic filter│
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│   Underwriter Decision Panel    │
│  "AI summary to assist review.  │
│  The underwriter decides."      │
└─────────────────────────────────┘
```

1. **Rules First, Model Second:** A deterministic engine (`src/lib/risk-rules.ts`) calculates standardized ratios:
   * Debt-to-Income (DTI) including the amortized payment of the requested loan.
   * Loan-to-Income (LTI).
   * Months employed.
   * Document presence across verification categories.
   * Rule flags: `DTI_HIGH` (>43%), `DTI_ELEVATED` (36–43%), `LTI_HIGH` (>35%), `SHORT_EMPLOYMENT` (<12 months), `NO_EMPLOYMENT_INCOME`, `MISSING_INCOME_DOC`, `CREDIT_BAND_POOR`, `INCOME_UNVERIFIED`.
2. **PII and Free-Text Exclusion:** The AI model receives only structured metrics and rule flags. Borrower names, employer names, applicant notes, filenames, and document contents are strictly excluded from the prompt.
3. **Guardrails & Filters (`src/lib/risk-guardrails.ts`):**
   * **Hallucination Control:** Any flag cited by the model that is not in the computed rule flags is stripped. Any number mentioned in the text must match a computed metric (within $\pm0.5\%$ tolerance for percentages), or the text is replaced by the deterministic rule text.
   * **Decision Language Filter:** The AI must never decide or recommend funding. Words such as *approve*, *deny*, *decline*, *reject*, *fund*, or *recommend* are stripped or force a fallback to deterministic rule text.
   * **Protected Characteristics Filter:** Any reference to age, race, religion, sex, gender, marital status, nationality, disability, or location/zip codes triggers an immediate fallback.
   * **Advisory Only:** Underwriter interfaces clearly state that the AI summary is an assistive explanation; the human underwriter retains sole decision-making authority.

---

## Oracle Constraints & What Changes If Fixed

The application is deployed on Oracle Cloud Infrastructure (OCI) Always Free tier. The current host environment has specific architectural constraints:

| Current Constraint | Operational Impact | What Changes If Host Is Fixed |
| --- | --- | --- |
| **Non-root Agent (Run Command)** | Agent cannot self-update or install host-level packages. | Self-updating deployment agent; streamlined system maintenance. |
| **Shared Superuser Access** | All OCI apps connect as the shared `postgres` superuser. | Dedicated, least-privilege PostgreSQL roles per application. |
| **No Per-App Secrets / External KMS** | App cannot safely store keys for envelope encryption; files rely on boot volume encryption. | Envelope encryption of `document_blob` with `DOC_ENC_KEY` (AES-256-GCM with authenticated additional data). |
| **No External Model Key on OCI** | Oracle deployment runs AI features in deterministic `demo` mode using cached fixtures. | Live Gemini API risk explanations (`AI_PROVIDER=gemini`). |
| **Caddy Configuration Reloading** | Provisioning a new app requires an OCI VM reboot to reload Caddy site definitions. | Dynamic zero-downtime Caddy configuration reloads. |
| **Memory Budget Limits** | RAM constraints prevent running an in-line ClamAV sidecar container. | Optional ClamAV sidecar scanning uploaded files prior to vault acceptance. |

---

## Architecture

```
Browser (mobile & desktop)
   │ HTTPS + Session Cookie
   ▼
Caddy Reverse Proxy (OCI Always Free A1 VM)
   │
   ▼
Next.js Container (App Router, Node.js 22 runtime)
   ├── Auth & RBAC (Better Auth + Underwriter & Admin permissions)
   ├── Document Vault API (Magic byte sniffing, PDF sanitization, streaming limits)
   ├── Deterministic Risk Engine & Guardrails
   ├── Audit Logger (Transactional hash-chaining)
   │
   ├──► PostgreSQL (Drizzle ORM)
   │     ├── application, application_note
   │     ├── document, document_blob (bytea)
   │     ├── risk_summary
   │     └── audit_event (append-only with triggers)
   │
   └──► AI Gateway (`generate()`, Gemini free tier or deterministic demo fallback)
```

| Concern | Implementation | Location |
| --- | --- | --- |
| **Configuration** | Environment validation at boot | `src/lib/env.ts` |
| **Database Schema** | Drizzle ORM schema & migrations | `src/lib/db/schema.ts`, `drizzle/` |
| **Authentication & RBAC** | Better Auth with Admin plugin & custom Underwriter role | `src/lib/auth/`, `src/lib/auth/rbac.ts` |
| **Authorization Rules** | Server-side predicates enforced in every data function | `src/lib/access.ts` |
| **State Machine** | Transition validation & optimistic concurrency locking | `src/lib/applications.ts` |
| **Document Vault** | Streaming upload, magic sniffing, security headers | `src/lib/documents.ts`, `/api/applications/[id]/documents` |
| **Audit Log** | Transactional hash-chained append with triggers | `src/lib/audit.ts`, `/api/admin/audit` |
| **AI Risk Rules & Guardrails** | Deterministic metrics + fair lending filters | `src/lib/risk-rules.ts`, `src/lib/risk-guardrails.ts` |
| **Health Probes** | Zero-dependency health check | `GET /api/health` |

---

## Environment Variables

| Variable | Description | Default / Mode |
| --- | --- | --- |
| `APP_NAME` | Display name of the application | `Loan Portal` |
| `APP_URL` | Fully-qualified public URL | `https://app8.breakthruventures.ai` |
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `BETTER_AUTH_SECRET` | 32+ character key for session encryption | Required (`openssl rand -base64 32`) |
| `AI_PROVIDER` | AI provider (`demo`, `gemini`, or `anthropic`) | `demo` (on Oracle) |
| `GEMINI_API_KEY` | Google Gemini API key | Optional (required for live Gemini) |
| `AI_FALLBACK_TO_DEMO` | Fallback to deterministic demo answer on error | `true` |
| `AI_TIMEOUT_MS` | Gateway execution timeout | `20000` |
| `DOC_STORAGE_CAP_MB` | App-wide maximum document storage volume | `2048` |
| `MIGRATE_ON_START` | Run database migrations automatically on start | `true` |
| `LOG_LEVEL` | Minimum log output level (`debug`, `info`, `warn`, `error`) | `info` |

---

## Run Locally

```bash
# 1. Clone and configure environment
cp .env.example .env.local
# Set BETTER_AUTH_SECRET in .env.local (e.g. openssl rand -base64 32)

# 2. Start PostgreSQL
docker compose up -d db

# 3. Install dependencies and run migrations
pnpm install
pnpm db:migrate

# 4. Start local development server
pnpm dev
# App will be accessible at http://localhost:3000
```

### Seed Demo Workspace

To seed test accounts (applicants, an underwriter, and an admin) along with sample loan applications across different lifecycle states:

```bash
pnpm db:seed
```

---

## 2-Minute Demo Script

Follow this step-by-step walkthrough to verify the complete loan portal lifecycle across all three roles in two minutes.

### 1. Applicant: Start Application and Upload Pay Stub (0:00 – 0:30)
1. Navigate to `http://localhost:3000` (or `https://app8.breakthruventures.ai`).
2. Notice the persistent demo warning banner across the application.
3. Sign in as an applicant (or register a new user).
4. Click **Start an application**.
5. Step through the loan wizard:
   * **Loan:** Request $15,000 for Debt Consolidation (36-month term).
   * **Work & Income:** Select Employed, enter $60,000 annual income, 24 months employed.
   * **Payments:** Enter $1,400 monthly rent and $400 existing monthly debt payments.
   * **Documents:** Upload an identity document (sample PNG or PDF) and an income verification document (`pay_stub.pdf`). Note that the file type is verified by magic bytes and client size is validated.
6. Click **Review and submit**. Confirm status updates to `Submitted`.

### 2. Underwriter: Claim File and Review AI Risk Panel (0:30 – 1:00)
1. Sign out and sign in with underwriter credentials.
2. Navigate to `/queue`. Open the **New** tab to view unclaimed applications.
3. Locate the submitted application and click **Claim**. The application status transitions to `In Review` and moves to the underwriter's personal queue.
4. Open the application review page:
   * Inspect computed metrics: Monthly Income ($5,000), Amortized New Payment, and combined Debt-to-Income (DTI).
   * Observe the rule flags (e.g., `DTI_ELEVATED` or `INCOME_UNVERIFIED`).
   * Review the **AI Risk Summary** panel: notice how it explains the DTI ratio in plain language without making a credit decision or referencing protected demographics.
   * Download the applicant's pay stub; observe that defensive security headers (`nosniff`, CSP sandbox, attachment) are served.

### 3. Underwriter: Request Information (1:00 – 1:20)
1. On the review page, click **Request Information**.
2. Enter message: *"Please provide your most recent W-2 or an updated pay stub confirming overtime income."*
3. Submit the request. Status transitions to `Info Requested`.

### 4. Applicant: Reply with Documentation (1:20 – 1:40)
1. Switch back to the applicant session and open `/applications`.
2. Open the application; see the underwriter's message in the timeline.
3. Post a reply: *"Uploaded my second pay stub as requested."*
4. Upload an additional document (`pay_stub_2.pdf`).
5. Submit response. Status returns to `Submitted` / `In Review`.

### 5. Underwriter: Decline with Reason Codes (1:40 – 1:50)
1. Return to the underwriter review interface.
2. Under actions, click **Decline Application**.
3. Select adverse action reason codes:
   * `DTI_TOO_HIGH`
   * `UNVERIFIABLE_INFORMATION`
4. Add an internal underwriter note and confirm. Status transitions to `Declined`. Notice that the application is now final and locked against further edits.

### 6. Admin: Verify Cryptographic Audit Chain (1:50 – 2:00)
1. Sign in with admin credentials and navigate to `/admin`.
2. Notice the system stats: application counts by status and document storage volume vs. the 2 GB cap. Confirm that admins have no UI to view application contents or customer documents.
3. Navigate to `/admin/audit`.
4. Review the chronological audit log entries (`application.created`, `document.uploaded`, `application.claimed`, `application.info_requested`, `application.decided`).
5. Click **Verify chain**.
6. Observe the green confirmation: *"Chain verified: all hashes intact and valid from genesis."* This mathematically confirms that no database records were tampered with or deleted.
