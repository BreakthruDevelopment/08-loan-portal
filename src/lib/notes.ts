import "server-only";
import { and, asc, count, eq } from "drizzle-orm";
import { canReadApplication, canReadNote, canWriteNote, contentWhere } from "@/lib/access";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { NOTES_PER_APPLICATION_CAP, noteBody, parseUuid } from "@/lib/loan";
import { advisoryLock } from "@/lib/usage";

type NoteRow = typeof schema.applicationNote.$inferSelect;
/** What an applicant sees of a note: no account ids, only whether they wrote it or the reviewer did. */
export type ApplicantNote = { id: string; body: string; createdAt: Date; author: "you" | "underwriter" };

function present(actor: Actor, note: NoteRow): NoteRow | ApplicantNote {
  if (actor.role !== "user") return note;
  return { id: note.id, body: note.body, createdAt: note.createdAt, author: note.authorId === actor.id ? "you" : "underwriter" };
}

export async function listNotes(actor: Actor, applicationId: string) {
  const id = parseUuid(applicationId);
  const [row] = await db()
    .select()
    .from(schema.application)
    .where(and(eq(schema.application.id, id), contentWhere(actor)));
  if (!row || !canReadApplication(actor, row)) throw new NotFoundError();
  const notes = await db()
    .select()
    .from(schema.applicationNote)
    .where(eq(schema.applicationNote.applicationId, id))
    .orderBy(asc(schema.applicationNote.createdAt));
  return notes.filter((note) => canReadNote(actor, row, note.visibility)).map((note) => present(actor, note));
}

export async function addNote(actor: Actor, applicationId: string, input: unknown) {
  const id = parseUuid(applicationId);
  const body = noteBody.parse(input);
  const visibility = actor.role === "user" ? "applicant" : (body.visibility ?? "internal");
  if (actor.role === "user" && body.visibility === "internal") throw new ForbiddenError();
  return db().transaction(async (tx) => {
    await advisoryLock(tx, `application:${id}`);
    const [row] = await tx
      .select()
      .from(schema.application)
      .where(and(eq(schema.application.id, id), contentWhere(actor)));
    if (!row || !canReadApplication(actor, row)) throw new NotFoundError();
    if (!canWriteNote(actor, row, visibility)) {
      // Visible but not writable: say why for a final file, otherwise it's a plain 403.
      if (["approved", "declined", "withdrawn"].includes(row.status)) throw new ConflictError("Notes are closed on a final application.");
      throw new ForbiddenError();
    }
    const [{ n }] = await tx.select({ n: count() }).from(schema.applicationNote).where(eq(schema.applicationNote.applicationId, id));
    if (n >= NOTES_PER_APPLICATION_CAP) throw new ConflictError("This application already has 50 notes.");
    const [note] = await tx
      .insert(schema.applicationNote)
      .values({ applicationId: id, authorId: actor.id, visibility, body: body.body })
      .returning();
    return present(actor, note);
  });
}
