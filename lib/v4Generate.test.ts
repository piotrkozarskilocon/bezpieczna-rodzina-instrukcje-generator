import { describe, it, expect } from "vitest";
import { parseJsonFromAi } from "./v4Generate";

describe("parseJsonFromAi — 5-tap fallback parser", () => {
  // Strategy 1: strict JSON parse
  describe("strategy 1: strict parse", () => {
    it("parsuje czysty JSON object", () => {
      expect(parseJsonFromAi<{ a: number }>(`{"a":1}`)).toEqual({ a: 1 });
    });

    it("parsuje czysty JSON array", () => {
      expect(parseJsonFromAi<number[]>(`[1,2,3]`)).toEqual([1, 2, 3]);
    });

    it("parsuje zagniezdzone struktury z whitespace", () => {
      const text = `\n  { "elements": [ { "type": "text" } ] }  \n`;
      expect(parseJsonFromAi(text)).toEqual({ elements: [{ type: "text" }] });
    });
  });

  // Strategy 2: fence stripping
  describe("strategy 2: fence strip", () => {
    it("rozbiera markdown fence ```json", () => {
      const text = "```json\n{\"a\":1}\n```";
      expect(parseJsonFromAi(text)).toEqual({ a: 1 });
    });

    it("rozbiera fence z wielkimi literami (JSON)", () => {
      const text = "```JSON\n[1,2]\n```";
      expect(parseJsonFromAi(text)).toEqual([1, 2]);
    });

    it("rozbiera fence bez specyfikatora języka", () => {
      const text = "```\n{\"x\":\"y\"}\n```";
      expect(parseJsonFromAi(text)).toEqual({ x: "y" });
    });
  });

  // Strategy 3: control chars escape
  describe("strategy 3: control chars escape w stringach", () => {
    it("naprawia surowy newline wewnatrz stringa", () => {
      // AI czasem zostawia literalny \n zamiast \\n w content stringów —
      // to standardowy bug Anthropic gdy generuje multiline tekst.
      const text = `{"content":"linia 1\nlinia 2"}`;
      const result = parseJsonFromAi<{ content: string }>(text);
      expect(result.content).toContain("linia 1");
      expect(result.content).toContain("linia 2");
    });
  });

  // Strategy 4: bracket extraction
  describe("strategy 4: bracket extract (extra text around JSON)", () => {
    it("wyciaga JSON z otoczki promptowej", () => {
      const text = `Sure! Here's the JSON:\n\n{"elements":[]}\n\nLet me know if you need anything else.`;
      expect(parseJsonFromAi(text)).toEqual({ elements: [] });
    });

    it("wyciaga JSON gdy fence jest niesymetryczny (tylko otwierajacy)", () => {
      const text = "```json\n{\"a\":1}";
      expect(parseJsonFromAi(text)).toEqual({ a: 1 });
    });

    it("wyciaga array gdy nie ma object", () => {
      const text = `Output: [1, 2, 3] — gotowe.`;
      expect(parseJsonFromAi(text)).toEqual([1, 2, 3]);
    });
  });

  // Strategy 5: truncation repair
  describe("strategy 5: truncation repair", () => {
    it("naprawia obciety object (brak zamykajacego })", () => {
      const text = `{"elements":[{"type":"text","content":"hello"}]`;
      const result = parseJsonFromAi<{ elements: unknown[] }>(text);
      expect(result.elements).toHaveLength(1);
    });

    it("naprawia obciety array w srodku elementu", () => {
      // Symuluje sytuację gdy Haiku skończył tokeny w środku listy elementów —
      // ostatni element jest niekompletny, ale poprzednie powinny zostać.
      const text = `{"elements":[{"type":"text","content":"a"},{"type":"text","content":"b"},{"type":"text"`;
      const result = parseJsonFromAi<{ elements: Array<{ content?: string }> }>(text);
      expect(result.elements.length).toBeGreaterThanOrEqual(2);
      expect(result.elements[0].content).toBe("a");
      expect(result.elements[1].content).toBe("b");
    });
  });

  describe("error path", () => {
    it("rzuca explicit error gdy zaden strategia nie zadziala", () => {
      expect(() => parseJsonFromAi("to nie jest JSON, w ogole nic z JSON")).toThrow(
        /failed to parse JSON after 5 attempts/,
      );
    });

    it("rzuca error dla pustego stringa", () => {
      expect(() => parseJsonFromAi("")).toThrow();
    });
  });
});
