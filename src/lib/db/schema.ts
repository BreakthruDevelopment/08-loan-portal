import { type AnyColumn, sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  APPLICATION_STATUSES,
  CONTENT_TYPES,
  CREDIT_BANDS,
  DECISION_CODES,
  DOCUMENT_KINDS,
  EMPLOYMENT_STATUSES,
  NOTE_VISIBILITIES,
  PURPOSES,
} from "@/lib/loan";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Usage limits (src/lib/usage.ts). Kinds are this app's: uploads and risk
// summaries are per-user windows; risk and demo loads also have a daily cap.
// Changing a list needs a migration, because the CHECK constraints are schema.
// ---------------------------------------------------------------------------

export const RATE_KINDS = ["upload", "risk"] as const;
export const DAILY_USAGE_KINDS = ["risk", "demo_load"] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/** App-wide daily counters (one row per UTC day and kind) for free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: DAILY_USAGE_KINDS }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in (${list(DAILY_USAGE_KINDS)})`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RATE_KINDS }).notNull(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in (${list(RATE_KINDS)})`),
  ],
);

const inList = (column: AnyColumn, name: string, values: readonly string[]) =>
  check(name, sql`${column} in (${list(values)})`);

const nullableInList = (column: AnyColumn, name: string, values: readonly string[]) =>
  check(name, sql`${column} is null or ${column} in (${list(values)})`);

/**
 * A personal-loan application. `applicant_id` is restricted so a user with a
 * non-draft file can't be deleted (ban them instead). The unique (id, applicant_id)
 * pair is what document rows reference, so a document can't point at someone else's file.
 * At most 3 open applications per applicant is enforced in the data function.
 */
export const application = pgTable(
  "application",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicantId: text("applicant_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    status: text("status", { enum: APPLICATION_STATUSES }).notNull().default("draft"),
    amountCents: integer("amount_cents"),
    termMonths: integer("term_months"),
    purpose: text("purpose", { enum: PURPOSES }),
    employmentStatus: text("employment_status", { enum: EMPLOYMENT_STATUSES }),
    employerName: text("employer_name"),
    monthsEmployed: integer("months_employed"),
    annualIncomeCents: integer("annual_income_cents"),
    monthlyHousingCents: integer("monthly_housing_cents"),
    monthlyDebtCents: integer("monthly_debt_cents"),
    creditBand: text("credit_band", { enum: CREDIT_BANDS }),
    assignedUnderwriterId: text("assigned_underwriter_id").references(() => user.id, { onDelete: "set null" }),
    decisionCodes: text("decision_codes").array().notNull().default(sql`'{}'::text[]`),
    decisionNote: text("decision_note"),
    submittedAt: timestamp("submitted_at", { withTimezone: true, precision: 3 }),
    decidedAt: timestamp("decided_at", { withTimezone: true, precision: 3 }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    unique("application_id_applicant_id_key").on(t.id, t.applicantId),
    index("application_status_submitted_at_idx").on(t.status, t.submittedAt),
    index("application_applicant_id_idx").on(t.applicantId),
    inList(t.status, "application_status_chk", APPLICATION_STATUSES),
    check("application_amount_chk", sql`${t.amountCents} is null or (${t.amountCents} between 100000 and 5000000)`),
    check("application_term_chk", sql`${t.termMonths} is null or ${t.termMonths} in (12, 24, 36, 48, 60)`),
    nullableInList(t.purpose, "application_purpose_chk", PURPOSES),
    nullableInList(t.employmentStatus, "application_employment_chk", EMPLOYMENT_STATUSES),
    check("application_employer_chk", sql`${t.employerName} is null or char_length(${t.employerName}) <= 120`),
    check("application_months_chk", sql`${t.monthsEmployed} is null or (${t.monthsEmployed} between 0 and 600)`),
    check("application_income_chk", sql`${t.annualIncomeCents} is null or (${t.annualIncomeCents} between 0 and 2000000000)`),
    check("application_housing_chk", sql`${t.monthlyHousingCents} is null or (${t.monthlyHousingCents} between 0 and 1000000000)`),
    check("application_debt_chk", sql`${t.monthlyDebtCents} is null or (${t.monthlyDebtCents} between 0 and 1000000000)`),
    nullableInList(t.creditBand, "application_credit_chk", CREDIT_BANDS),
    check(
      "application_decision_codes_chk",
      sql`${t.decisionCodes} <@ array[${list(DECISION_CODES)}]::text[] and coalesce(array_length(${t.decisionCodes}, 1), 0) <= 4`,
    ),
    check("application_decision_note_chk", sql`${t.decisionNote} is null or char_length(${t.decisionNote}) <= 1000`),
    check("application_version_chk", sql`${t.version} >= 1`),
  ],
);

/** Document metadata. List queries never join `document_blob`. */
export const document = pgTable(
  "document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id").notNull(),
    applicantId: text("applicant_id").notNull(),
    kind: text("kind", { enum: DOCUMENT_KINDS }).notNull(),
    displayName: text("display_name").notNull(),
    contentType: text("content_type", { enum: CONTENT_TYPES }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    index("document_application_id_idx").on(t.applicationId),
    uniqueIndex("document_application_sha_uidx").on(t.applicationId, t.sha256).where(sql`${t.deletedAt} is null`),
    foreignKey({
      columns: [t.applicationId, t.applicantId],
      foreignColumns: [application.id, application.applicantId],
      name: "document_application_applicant_fk",
    }).onDelete("cascade"),
    inList(t.kind, "document_kind_chk", DOCUMENT_KINDS),
    inList(t.contentType, "document_content_type_chk", CONTENT_TYPES),
    check("document_name_chk", sql`char_length(${t.displayName}) between 1 and 120`),
    check("document_size_chk", sql`${t.sizeBytes} > 0 and ${t.sizeBytes} <= 5242880`),
    check("document_sha_chk", sql`char_length(${t.sha256}) = 64`),
  ],
);

export const documentBlob = pgTable("document_blob", {
  documentId: uuid("document_id")
    .primaryKey()
    .references(() => document.id, { onDelete: "cascade" }),
  bytes: bytea("bytes").notNull(),
});

export const applicationNote = pgTable(
  "application_note",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    visibility: text("visibility", { enum: NOTE_VISIBILITIES }).notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("application_note_application_id_idx").on(t.applicationId, t.createdAt),
    inList(t.visibility, "application_note_visibility_chk", NOTE_VISIBILITIES),
    check("application_note_body_chk", sql`char_length(${t.body}) between 1 and 2000`),
  ],
);

/** Written by the risk-summary feature. Underwriters only; no route in the core issue. */
export const riskSummary = pgTable(
  "risk_summary",
  {
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),
    inputHash: text("input_hash").notNull(),
    appVersion: integer("app_version").notNull(),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull(),
    ruleFlags: jsonb("rule_flags").$type<unknown[]>().notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    mode: text("mode").notNull(),
    regenerations: integer("regenerations").notNull().default(0),
    generatedBy: text("generated_by").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.applicationId, t.inputHash] }),
    check("risk_summary_regenerations_chk", sql`${t.regenerations} >= 0`),
  ],
);

/**
 * Append-only hash chain. No foreign keys: deleting a user or an application must not
 * touch history. Triggers in the migration reject update, delete, and truncate.
 */
export const auditEvent = pgTable(
  "audit_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull(),
    actorId: text("actor_id").notNull(),
    actorRole: text("actor_role").notNull(),
    action: text("action").notNull(),
    applicationId: uuid("application_id"),
    documentId: uuid("document_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
    prevHash: char("prev_hash", { length: 64 }),
    hash: char("hash", { length: 64 }).notNull(),
  },
  (t) => [
    index("audit_event_application_id_idx").on(t.applicationId, t.id),
    check("audit_event_hash_chk", sql`char_length(${t.hash}) = 64 and (${t.prevHash} is null or char_length(${t.prevHash}) = 64)`),
  ],
);

export type User = typeof user.$inferSelect;
export type Application = typeof application.$inferSelect;
