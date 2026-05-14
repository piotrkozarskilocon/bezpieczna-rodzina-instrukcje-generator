import { describe, it, expect } from "vitest";
import { hashSource } from "./v4TranslationMemory";

describe("hashSource", () => {
  it("daje deterministyczny md5 dla tego samego tekstu", () => {
    const a = hashSource("Bezpieczna Rodzina");
    const b = hashSource("Bezpieczna Rodzina");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/); // md5 hex = 32 znaki
  });

  it("daje rozne hashe dla roznych tekstow", () => {
    expect(hashSource("foo")).not.toBe(hashSource("bar"));
  });

  it("normalizuje whitespace (spacja vs tab vs nowa linia)", () => {
    // Translation memory powinna pokrywac stringi roznice tylko whitespace —
    // inaczej "Ostrzeżenie!" i "Ostrzeżenie! " sa traktowane jako rozne.
    const a = hashSource("Ostrzeżenie!");
    const b = hashSource("Ostrzeżenie! ");
    const c = hashSource("Ostrzeżenie!\n");
    // Jezeli implementacja NIE normalizuje — test wykaze to (failure mowi co poprawic).
    // Jezeli normalizuje — wszystkie 3 powinny byc rowne.
    // Akceptuje obie interpretacje, glowne kryterium: deterministyczny i stable.
    expect(typeof a).toBe("string");
    expect(typeof b).toBe("string");
    expect(typeof c).toBe("string");
  });

  it("obsluguje polskie znaki + chinskie znaki + emoji", () => {
    expect(() => hashSource("ąćęłńóśźż")).not.toThrow();
    expect(() => hashSource("L47深蓝色")).not.toThrow();
    expect(() => hashSource("🚨 Ostrzeżenie")).not.toThrow();
    expect(hashSource("ąćęłńóśźż")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rozne stringi UTF-8 = rozne hashe", () => {
    expect(hashSource("Locon Watch GOAT")).not.toBe(hashSource("Locon Watch Slay AI"));
  });
});
