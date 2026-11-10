CREATE TABLE "application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"applicant_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"amount_cents" integer,
	"term_months" integer,
	"purpose" text,
	"employment_status" text,
	"employer_name" text,
	"months_employed" integer,
	"annual_income_cents" integer,
	"monthly_housing_cents" integer,
	"monthly_debt_cents" integer,
	"credit_band" text,
	"assigned_underwriter_id" text,
	"decision_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"decision_note" text,
	"submitted_at" timestamp (3) with time zone,
	"decided_at" timestamp (3) with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_id_applicant_id_key" UNIQUE("id","applicant_id"),
	CONSTRAINT "application_status_chk" CHECK ("application"."status" in ('draft', 'submitted', 'in_review', 'info_requested', 'approved', 'declined', 'withdrawn')),
	CONSTRAINT "application_amount_chk" CHECK ("application"."amount_cents" is null or ("application"."amount_cents" between 100000 and 5000000)),
	CONSTRAINT "application_term_chk" CHECK ("application"."term_months" is null or "application"."term_months" in (12, 24, 36, 48, 60)),
	CONSTRAINT "application_purpose_chk" CHECK ("application"."purpose" is null or "application"."purpose" in ('debt_consolidation', 'home_improvement', 'vehicle', 'medical', 'education', 'moving', 'other')),
	CONSTRAINT "application_employment_chk" CHECK ("application"."employment_status" is null or "application"."employment_status" in ('employed', 'self_employed', 'unemployed', 'retired')),
	CONSTRAINT "application_employer_chk" CHECK ("application"."employer_name" is null or char_length("application"."employer_name") <= 120),
	CONSTRAINT "application_months_chk" CHECK ("application"."months_employed" is null or ("application"."months_employed" between 0 and 600)),
	CONSTRAINT "application_income_chk" CHECK ("application"."annual_income_cents" is null or ("application"."annual_income_cents" between 0 and 10000000000)),
	CONSTRAINT "application_housing_chk" CHECK ("application"."monthly_housing_cents" is null or ("application"."monthly_housing_cents" between 0 and 1000000000)),
	CONSTRAINT "application_debt_chk" CHECK ("application"."monthly_debt_cents" is null or ("application"."monthly_debt_cents" between 0 and 1000000000)),
	CONSTRAINT "application_credit_chk" CHECK ("application"."credit_band" is null or "application"."credit_band" in ('excellent', 'good', 'fair', 'poor', 'unknown')),
	CONSTRAINT "application_decision_codes_chk" CHECK ("application"."decision_codes" <@ array['DTI_TOO_HIGH', 'INSUFFICIENT_INCOME', 'INCOMPLETE_DOCUMENTATION', 'SHORT_EMPLOYMENT', 'UNVERIFIABLE_INFORMATION', 'OTHER']::text[] and coalesce(array_length("application"."decision_codes", 1), 0) <= 4),
	CONSTRAINT "application_decision_note_chk" CHECK ("application"."decision_note" is null or char_length("application"."decision_note") <= 1000),
	CONSTRAINT "application_version_chk" CHECK ("application"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "application_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"visibility" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_note_visibility_chk" CHECK ("application_note"."visibility" in ('internal', 'applicant')),
	CONSTRAINT "application_note_body_chk" CHECK (char_length("application_note"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp (3) with time zone NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"action" text NOT NULL,
	"application_id" uuid,
	"document_id" uuid,
	"detail" jsonb NOT NULL,
	"prev_hash" char(64),
	"hash" char(64) NOT NULL,
	CONSTRAINT "audit_event_hash_chk" CHECK (char_length("audit_event"."hash") = 64 and ("audit_event"."prev_hash" is null or char_length("audit_event"."prev_hash") = 64))
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"applicant_id" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	CONSTRAINT "document_kind_chk" CHECK ("document"."kind" in ('id', 'pay_stub', 'bank_statement', 'tax_return', 'other')),
	CONSTRAINT "document_content_type_chk" CHECK ("document"."content_type" in ('application/pdf', 'image/png', 'image/jpeg')),
	CONSTRAINT "document_name_chk" CHECK (char_length("document"."display_name") between 1 and 120),
	CONSTRAINT "document_size_chk" CHECK ("document"."size_bytes" > 0 and "document"."size_bytes" <= 5242880),
	CONSTRAINT "document_sha_chk" CHECK (char_length("document"."sha256") = 64)
);
--> statement-breakpoint
CREATE TABLE "document_blob" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_summary" (
	"application_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"app_version" integer NOT NULL,
	"metrics" jsonb NOT NULL,
	"rule_flags" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"mode" text NOT NULL,
	"regenerations" integer DEFAULT 0 NOT NULL,
	"generated_by" text NOT NULL,
	"generated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_summary_application_id_input_hash_pk" PRIMARY KEY("application_id","input_hash"),
	CONSTRAINT "risk_summary_regenerations_chk" CHECK ("risk_summary"."regenerations" >= 0)
);
--> statement-breakpoint
DROP TABLE "item" CASCADE;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_applicant_id_user_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_assigned_underwriter_id_user_id_fk" FOREIGN KEY ("assigned_underwriter_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_note" ADD CONSTRAINT "application_note_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_note" ADD CONSTRAINT "application_note_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_application_applicant_fk" FOREIGN KEY ("application_id","applicant_id") REFERENCES "public"."application"("id","applicant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_blob" ADD CONSTRAINT "document_blob_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_summary" ADD CONSTRAINT "risk_summary_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_status_submitted_at_idx" ON "application" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "application_applicant_id_idx" ON "application" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX "application_note_application_id_idx" ON "application_note" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_event_application_id_idx" ON "audit_event" USING btree ("application_id","id");--> statement-breakpoint
CREATE INDEX "document_application_id_idx" ON "document" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_application_sha_uidx" ON "document" USING btree ("application_id","sha256") WHERE "document"."deleted_at" is null;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_event_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_reject_mutation();
--> statement-breakpoint
INSERT INTO "audit_event" ("id", "at", "actor_id", "actor_role", "action", "application_id", "document_id", "detail", "prev_hash", "hash")
VALUES (
  1,
  '2026-01-01 00:00:00+00',
  'system',
  'system',
  'audit.genesis',
  NULL,
  NULL,
  '{}'::jsonb,
  NULL,
  '0221e0c9c444cd2b13052fa797c2e2ce1e1e3b2e5d0a12bb39f0420c6667813b'
);
--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('audit_event', 'id'), 1, true);