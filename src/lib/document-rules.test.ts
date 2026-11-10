import { describe, expect, it } from "vitest";
import { DEMO_PDF, DEMO_PNG } from "@/lib/demo-files";
import { extensionAgrees, sanitizeDisplayName, sniffContentType } from "@/lib/document-rules";
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
