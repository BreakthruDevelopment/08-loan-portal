import { describe, expect, it } from "vitest";
import { DEMO_PDF, DEMO_PNG } from "@/lib/demo-files";
import { assertPdfHygiene, downloadFilename, extensionAgrees, sanitizeDisplayName, sniffContentType } from "@/lib/document-rules";
import { BadRequestError } from "@/lib/errors";

describe("document rules", () => {
  it("sniffs the demo PDF and PNG and refuses HTML", () => {
    expect(sniffContentType(DEMO_PDF)).toBe("application/pdf");
    expect(sniffContentType(DEMO_PNG)).toBe("image/png");
    expect(sniffContentType(Buffer.from("<html></html>"))).toBeNull();
    expect(DEMO_PDF.toString("utf8")).not.toMatch(/\/JavaScript|\/JS|\/Launch|\/EmbeddedFile|\/RichMedia|\/XFA|\/Encrypt/);
  });

  it("requires the extension to agree when one is present", () => {
    expect(extensionAgrees("id.pdf", "application/pdf")).toBe(true);
    expect(extensionAgrees("id.png", "application/pdf")).toBe(false);
    expect(extensionAgrees("statement", "application/pdf")).toBe(false);
    expect(extensionAgrees("statement.", "application/pdf")).toBe(false);
    expect(extensionAgrees(".pdf", "application/pdf")).toBe(false);
  });

  it("strips path characters from a display name", () => {
    expect(sanitizeDisplayName("../pay stub.pdf")).toBe("pay stub.pdf");
    expect(() => sanitizeDisplayName("...")).toThrow(BadRequestError);
  });
});

describe("PDF hygiene", () => {
  const pdf = (body: string) => Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`, "latin1");

  it("accepts a plain PDF, including names that only start like a forbidden one", () => {
    expect(() => assertPdfHygiene(DEMO_PDF)).not.toThrow();
    expect(() => assertPdfHygiene(pdf("1 0 obj<</Type/Metadata/JSON 1/JSAlike 2/Encrypted 3>>endobj"))).not.toThrow();
  });

  it.each([
    ["/JavaScript", "1 0 obj<</S/JavaScript/JS(app.alert(1))>>endobj"],
    ["/JS", "1 0 obj<</JS (app.alert(1))>>endobj"],
    ["/Launch", "1 0 obj<</S/Launch/F(cmd.exe)>>endobj"],
    ["/EmbeddedFile", "1 0 obj<</Type/EmbeddedFile>>endobj"],
    ["/EmbeddedFiles", "1 0 obj<</Names<</EmbeddedFiles 2 0 R>>>>endobj"],
    ["/RichMedia", "1 0 obj<</Subtype/RichMedia>>endobj"],
    ["/XFA", "1 0 obj<</XFA[(a)(b)]>>endobj"],
    ["/Encrypt", "trailer<</Encrypt 5 0 R/Root 1 0 R>>"],
    ["an escaped name", "1 0 obj<</S/Java#53cript>>endobj"],
    ["an escaped name at the very start", "1 0 obj<</#4aS(x)>>endobj"],
  ])("refuses %s", (_label, body) => {
    expect(() => assertPdfHygiene(pdf(body))).toThrowError(expect.objectContaining({ status: 422 }));
  });
});

describe("download names and display names", () => {
  it("builds the download name from the id and the sniffed type only", () => {
    expect(downloadFilename("abc", "application/pdf")).toBe("document-abc.pdf");
    expect(downloadFilename("abc", "image/png")).toBe("document-abc.png");
    expect(downloadFilename("abc", "image/jpeg")).toBe("document-abc.jpg");
  });

  it("strips bidi overrides, zero-width characters, and lone surrogates", () => {
    expect(sanitizeDisplayName("pay‮fdp.exe")).toBe("payfdp.exe");
    expect(sanitizeDisplayName("a​b.pdf")).toBe("ab.pdf");
    expect(sanitizeDisplayName("a\ud800b.pdf")).not.toMatch(/[\ud800-\udfff]/);
    const long = sanitizeDisplayName("x".repeat(300) + ".pdf");
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith(".pdf")).toBe(true);
  });
});
