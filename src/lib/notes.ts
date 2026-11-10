import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { canReadApplication, canReadNote, canWriteNote, contentWhere } from "@/lib/access";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { noteBody, parseUuid } from "@/lib/loan";

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
  return notes.filter((note) => canReadNote(actor, row, note.visibility));
}

export async function addNote(actor: Actor, applicationId: string, input: unknown) {
  const id = parseUuid(applicationId);
  const body = noteBody.parse(input);
  const visibility = actor.role === "user" ? "applicant" : (body.visibility ?? "internal");
  if (actor.role === "user" && body.visibility === "internal") throw new ForbiddenError();
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.application)
      .where(and(eq(schema.application.id, id), contentWhere(actor)));
    if (!row || !canReadApplication(actor, row)) throw new NotFoundError();
    if (!canWriteNote(actor, row, visibility)) throw new ForbiddenError();
    const [note] = await tx
      .insert(schema.applicationNote)
      .values({ applicationId: id, authorId: actor.id, visibility, body: body.body })
      .returning();
    return note;
  });
}
