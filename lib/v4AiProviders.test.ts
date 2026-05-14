import { describe, it, expect } from "vitest";
import { inferProvider, resolveAnyModel, ALL_MODELS } from "./v4AiProviders";

describe("inferProvider", () => {
  it("rozpoznaje Anthropic Claude po prefixie claude-", () => {
    expect(inferProvider("claude-haiku-4-5-20251001")).toBe("anthropic");
    expect(inferProvider("claude-sonnet-4-6")).toBe("anthropic");
    expect(inferProvider("claude-opus-4-7")).toBe("anthropic");
  });

  it("rozpoznaje Gemini po prefixie gemini-", () => {
    expect(inferProvider("gemini-2.5-flash")).toBe("gemini");
    expect(inferProvider("gemini-2.5-pro")).toBe("gemini");
  });

  it("defaultuje do anthropic dla nieznanych prefixów (bezpieczna domyślna ścieżka)", () => {
    expect(inferProvider("unknown-model-id")).toBe("anthropic");
    expect(inferProvider("")).toBe("anthropic");
  });
});

describe("resolveAnyModel", () => {
  it("zwraca requested gdy jest na liscie", () => {
    expect(resolveAnyModel("claude-haiku-4-5-20251001", "fallback")).toBe("claude-haiku-4-5-20251001");
    expect(resolveAnyModel("gemini-2.5-flash", "fallback")).toBe("gemini-2.5-flash");
  });

  it("zwraca fallback gdy requested nie jest na liscie", () => {
    expect(resolveAnyModel("claude-imaginary-99", "claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
    expect(resolveAnyModel(null, "gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(resolveAnyModel(undefined, "gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });
});

describe("ALL_MODELS list", () => {
  it("zawiera Anthropic + Gemini (lacznie >= 5)", () => {
    expect(ALL_MODELS.length).toBeGreaterThanOrEqual(5);
  });

  it("kazdy model ma id, label, description, provider", () => {
    for (const m of ALL_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.label).toBeTruthy();
      expect(m.description).toBeTruthy();
      expect(["anthropic", "gemini"]).toContain(m.provider);
    }
  });

  it("zawiera Haiku 4.5 (Anthropic) + Gemini 2.5 Flash", () => {
    expect(ALL_MODELS.some((m) => m.id === "claude-haiku-4-5-20251001")).toBe(true);
    expect(ALL_MODELS.some((m) => m.id === "gemini-2.5-flash")).toBe(true);
  });
});
