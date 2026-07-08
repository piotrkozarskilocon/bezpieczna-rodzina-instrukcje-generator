import { z } from "zod";
import { callClaude, PREMIUM_MODEL, parseJsonFromAi } from "../anthropic";
import {
  DeviceKBSchema,
  type DeviceKB,
  type KbConflict,
  type SourceKind,
} from "./types";

/** Priorytet źródeł przy konfliktach skalarów: im wcześniej, tym bardziej wiarygodne
 *  dla danych technicznych. Spec od producenta > deklaracja > raporty > manual. */
const KIND_PRIORITY: SourceKind[] = [
  "tech_spec",
  "declaration_ce",
  "sar_report",
  "rf_test_report",
  "safety_test_report",
  "emc_test_report",
  "nb_certificate",
  "rohs_reach",
  "manufacturer_manual",
  "feature_guide",
  "risk_assessment",
  "product_photos",
  "app_screens",
  "app_video",
  "protocol_spec",
  "other",
];

type Fact = { value: unknown; sources: Array<Record<string, unknown>> } | undefined;

function isFact(v: unknown): v is NonNullable<Fact> {
  return !!v && typeof v === "object" && "value" in (v as object) && "sources" in (v as object);
}

function canon(v: unknown): string {
  return JSON.stringify(v).toLowerCase().replace(/\s+/g, " ");
}

/** Deterministyczne scalenie fragmentów KB: tablice konkatenowane (dedupe po treści),
 *  skalary wg priorytetu rodzaju źródła; rozbieżne wartości → konflikt. */
export function mergeFragments(
  fragments: Array<{ kind: SourceKind; fragment: DeviceKB; sourceName?: string }>
): { kb: DeviceKB; conflicts: KbConflict[] } {
  const conflicts: KbConflict[] = [];
  // Tie-breaker w obrębie rodzaju: dokument PODPISANY (oficjalna wersja rynkowa,
  // np. deklaracja *_signed_*.pdf) wygrywa z roboczym docx od producenta.
  const rank = (f: { kind: SourceKind; sourceName?: string }) =>
    KIND_PRIORITY.indexOf(f.kind) - (/signed|podpisan/i.test(f.sourceName ?? "") ? 0.5 : 0);
  const ordered = [...fragments].sort((a, b) => rank(a) - rank(b));

  const mergeValue = (path: string, values: Array<{ kind: SourceKind; v: unknown }>): unknown => {
    const facts = values.filter((x) => isFact(x.v));
    if (facts.length === 0) return values[0]?.v;

    // Tożsamość prawna (producent/importer) pochodzi z deklaracji zgodności,
    // nie ze specyfikacji technicznej; podpisana wersja rynkowa wygrywa.
    if (/^identity\.(manufacturer|importer)/.test(path)) {
      facts.sort((a, b) => {
        const score = (f: { kind: SourceKind; v: unknown }) =>
          (f.kind === "declaration_ce" ? -10 : 0) -
          (/signed|podpisan/i.test(
            String((f.v as NonNullable<Fact>).sources[0]?.source_doc ?? "")
          )
            ? 1
            : 0);
        return score(a) - score(b);
      });
    }

    // Fakty o wartości OBIEKTOWEJ (np. battery) scalamy per pole — inne źródła
    // często pokrywają inne pola (spec: capacity, raport Safety: type/removable).
    const objectFacts = facts.filter(
      (f) =>
        (f.v as NonNullable<Fact>).value &&
        typeof (f.v as NonNullable<Fact>).value === "object" &&
        !Array.isArray((f.v as NonNullable<Fact>).value)
    );
    // Wyjątek: obiekty TOŻSAMOŚCIOWE (różne `name` = różne byty, np. producent
    // Locon vs Lagenio) — scalanie pól mieszałoby dane różnych podmiotów.
    const names = new Set(
      facts
        .map((f) => (f.v as NonNullable<Fact>).value as Record<string, unknown>)
        .filter((v) => v && typeof v === "object" && "name" in v)
        .map((v) => canon((v as { name: unknown }).name))
    );
    const identityConflict = names.size > 1;
    if (objectFacts.length === facts.length && facts.length > 1 && !identityConflict) {
      const mergedValue: Record<string, unknown> = {};
      const mergedSources: Array<Record<string, unknown>> = [];
      const seenSrc = new Set<string>();
      for (const f of facts) {
        const fact = f.v as NonNullable<Fact>;
        for (const [k, fieldVal] of Object.entries(fact.value as Record<string, unknown>)) {
          if (fieldVal === undefined || fieldVal === null) continue;
          if (!(k in mergedValue)) {
            mergedValue[k] = fieldVal;
          } else if (canon(mergedValue[k]) !== canon(fieldVal)) {
            conflicts.push({
              path: `${path}.${k}`,
              values: [
                { value: JSON.stringify(mergedValue[k]), source_doc: String(mergedSources[0]?.source_doc ?? "") },
                { value: JSON.stringify(fieldVal), source_doc: String(fact.sources[0]?.source_doc ?? f.kind) },
              ],
              resolution: `wybrano wartość ze źródła o najwyższym priorytecie`,
            });
          }
        }
        for (const s of fact.sources) {
          const key = canon(s);
          if (!seenSrc.has(key)) {
            seenSrc.add(key);
            mergedSources.push(s);
          }
        }
      }
      return { value: mergedValue, sources: mergedSources };
    }

    const distinct = new Map<string, { kind: SourceKind; v: Fact }>();
    for (const f of facts) {
      const key = canon((f.v as NonNullable<Fact>).value);
      if (!distinct.has(key)) distinct.set(key, f as { kind: SourceKind; v: Fact });
    }
    const winner = facts[0].v as NonNullable<Fact>;
    if (distinct.size > 1) {
      conflicts.push({
        path,
        values: [...distinct.values()].map((d) => ({
          value: JSON.stringify((d.v as NonNullable<Fact>).value),
          source_doc: String((d.v as NonNullable<Fact>).sources[0]?.source_doc ?? d.kind),
        })),
        resolution: `wybrano wartość ze źródła o najwyższym priorytecie (${facts[0].kind})`,
      });
      // zwycięzca zachowuje swoje sources; warianty są w conflicts do wglądu.
    }
    return winner;
  };

  const mergeNode = (path: string, values: Array<{ kind: SourceKind; v: unknown }>): unknown => {
    const present = values.filter((x) => x.v !== undefined && x.v !== null);
    if (present.length === 0) return undefined;
    const sample = present[0].v;
    if (Array.isArray(sample)) {
      const out: unknown[] = [];
      const seen = new Set<string>();
      for (const { v } of present) {
        for (const item of v as unknown[]) {
          const key = canon(
            isFact(item) ? (item as NonNullable<Fact>).value : stripSources(item)
          );
          if (!seen.has(key)) {
            seen.add(key);
            out.push(item);
          }
        }
      }
      return out;
    }
    if (isFact(sample)) return mergeValue(path, present);
    if (typeof sample === "object") {
      const keys = new Set<string>();
      for (const { v } of present)
        for (const k of Object.keys(v as object)) keys.add(k);
      const obj: Record<string, unknown> = {};
      for (const k of keys) {
        const merged = mergeNode(
          `${path ? path + "." : ""}${k}`,
          present.map((x) => ({ kind: x.kind, v: (x.v as Record<string, unknown>)[k] }))
        );
        if (merged !== undefined) obj[k] = merged;
      }
      return obj;
    }
    return sample;
  };

  const kb = mergeNode(
    "",
    ordered.map((f) => ({ kind: f.kind, v: f.fragment }))
  ) as DeviceKB;
  return { kb: DeviceKBSchema.parse(kb), conflicts };
}

function stripSources(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const { sources: _s, ...rest } = item as Record<string, unknown>;
  return rest;
}

const KB_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(DeviceKBSchema));

/** Rafinacja KB przez Claude: dedupe semantyczny (te same funkcje/ostrzeżenia/pasma
 *  opisane różnie w różnych źródłach), normalizacja polszczyzny, scalenie sources
 *  łączonych wpisów. Fakty i liczby NIE mogą się zmienić. */
export async function refineKb(kb: DeviceKB): Promise<DeviceKB> {
  const res = await callClaude<DeviceKB>({
    model: PREMIUM_MODEL,
    maxTokens: 32000,
    system:
      "Porządkujesz bazę wiedzy o urządzeniu (smartwatch/tracker GPS) scaloną z wielu źródeł.\n" +
      "WOLNO CI: łączyć duplikaty opisujące to samo (funkcje, ostrzeżenia, pasma, kroki) — przy " +
      "łączeniu SUMUJESZ ich tablice sources; poprawiać gramatykę/naturalność polszczyzny; ujednolicać " +
      "jednostki zapisu (np. '33dBm' → '33 dBm').\n" +
      "NIE WOLNO CI: zmieniać wartości liczbowych, dodawać faktów, usuwać unikalnych wpisów, usuwać " +
      "ani modyfikować pól quote/locator/source_doc wewnątrz sources.\n" +
      "Zwróć kompletny, uporządkowany obiekt KB (JSON).",
    user: `Schemat: ${KB_JSON_SCHEMA}\n\nKB do uporządkowania:\n${JSON.stringify(kb)}`,
    outputSchema: {
      name: "refined_kb",
      description: "Uporządkowana baza wiedzy o urządzeniu",
      schema: DeviceKBSchema,
    },
  });
  if (res.parsed) return res.parsed;
  return DeviceKBSchema.parse(parseJsonFromAi(res.text));
}
