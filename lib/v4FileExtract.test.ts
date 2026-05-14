import { describe, it, expect } from "vitest";
import { guessMimeFromFilename, normalizeMime, ACCEPTED_MIME_TYPES } from "./v4FileExtract";

describe("guessMimeFromFilename", () => {
  it("rozpoznaje PDF po rozszerzeniu", () => {
    expect(guessMimeFromFilename("raport.pdf")).toBe("application/pdf");
    expect(guessMimeFromFilename("Raport-SAR.PDF")).toBe("application/pdf");
  });

  it("rozpoznaje pliki tekstowe", () => {
    expect(guessMimeFromFilename("notes.txt")).toBe("text/plain");
    expect(guessMimeFromFilename("readme.md")).toBe("text/markdown");
    expect(guessMimeFromFilename("data.csv")).toBe("text/csv");
    expect(guessMimeFromFilename("payload.json")).toBe("application/json");
  });

  it("rozpoznaje formaty Office", () => {
    expect(guessMimeFromFilename("spec.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(guessMimeFromFilename("budget.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("zwraca null dla nieznanych typów", () => {
    expect(guessMimeFromFilename("photo.png")).toBeNull();
    expect(guessMimeFromFilename("archive.zip")).toBeNull();
    expect(guessMimeFromFilename("no_extension")).toBeNull();
  });

  it("obsluguje wielkie litery + nazwy z kropkami", () => {
    expect(guessMimeFromFilename("My.Document.v2.DOCX")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });
});

describe("normalizeMime", () => {
  it("zachowuje akceptowane MIME bez zmian", () => {
    expect(normalizeMime("application/pdf", "anything.bin")).toBe("application/pdf");
    expect(normalizeMime("text/csv", "anything.bin")).toBe("text/csv");
  });

  it("zgaduje po nazwie pliku gdy mime jest pusty", () => {
    expect(normalizeMime("", "raport.pdf")).toBe("application/pdf");
    expect(normalizeMime(null, "data.csv")).toBe("text/csv");
    expect(normalizeMime(undefined, "spec.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("zgaduje po nazwie gdy mime jest application/octet-stream (browser drag&drop)", () => {
    expect(normalizeMime("application/octet-stream", "raport.pdf")).toBe("application/pdf");
    expect(normalizeMime("application/octet-stream", "data.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("zwraca null gdy ani mime ani extension nie sa rozpoznawalne", () => {
    expect(normalizeMime("application/x-shockwave-flash", "movie.swf")).toBeNull();
    expect(normalizeMime("", "no_extension")).toBeNull();
  });
});

describe("ACCEPTED_MIME_TYPES", () => {
  it("zawiera kluczowe formaty (PDF, text, Office)", () => {
    expect(ACCEPTED_MIME_TYPES.has("application/pdf")).toBe(true);
    expect(ACCEPTED_MIME_TYPES.has("text/plain")).toBe(true);
    expect(ACCEPTED_MIME_TYPES.has("text/csv")).toBe(true);
    expect(
      ACCEPTED_MIME_TYPES.has("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toBe(true);
    expect(
      ACCEPTED_MIME_TYPES.has("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).toBe(true);
  });
});
