/**
 * Shared database fixtures for integration tests. Rows go in with SQL, so a test doesn't depend on the code under
 * test (the document vault) to set up its data.
 */
import type postgres from "postgres";

export type DocumentFixture = {
  applicationId: string;
  applicantId: string;
  kind: string;
  /** Free text on purpose: tests put an injection string here to prove it never reaches a model. */
  displayName: string;
  /** Makes the content hash unique per application. */
  n: number;
};

/** One `document` row with the minimum valid columns (no bytes: tests here never read content). */
export async function insertDocument(sql: postgres.Sql, doc: DocumentFixture): Promise<void> {
  await sql`insert into document (application_id, applicant_id, kind, display_name, content_type, size_bytes, sha256)
    values (${doc.applicationId}, ${doc.applicantId}, ${doc.kind}, ${doc.displayName}, 'application/pdf', 10, ${String(doc.n).padStart(64, "0")})`;
}
