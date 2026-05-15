/**
 * Strukturalna ekstrakcja z reference doc (raport SAR, tech spec) przez
 * Gemini 2.5 Pro Vision. Wynik zapisany do gen4_reference_docs.extracted_structured
 * (jsonb) — uzywany pozniej w system prompcie generacji jako konkretne
 * wartosci (zamiast placeholdera "DO UZUPELNIENIA").
 *
 * Body: { kind?: "sar" } — na razie tylko SAR. W przyszlosci kind=tech_spec
 * z inna schema (specifications: { battery_mah, ip_rating, frequencies, ... }).
 *
 * Faza 2 z deep research planu. Wymaga GEMINI_API_KEY + migracji 0021.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { callGeminiWithRetry, GEMINI_FLASH } from "@/lib/v4Gemini";
import {
  SarReportSchema,
  TechSpecSchema,
  DeclarationCeSchema,
  ManufacturerManualSchema,
  GenericDocSchema,
} from "@/lib/v4Schemas";
import { logAiCall } from "@/lib/v4AiLog";
import type { ZodSchema } from "zod";

export const runtime = "nodejs";
// Vercel Hobby + fluid compute = do 300s max. Ekstrakcja bogatej schemy z
// 9MB+ PDF Gemini Flash trwa 60-180s — 60s default Hobby to za malo.
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ docId: string }>;
}

const BUCKET = "gen4-reference-docs";

const SAR_SYSTEM = `Jestes ekspertem w analizie raportow SAR (Specific Absorption Rate) dla urzadzen radiowych — smartwatchy, trackerow GPS, opasek seniora. Czytasz pelen raport SAR (zwykle 50-500 stron PDF, czesto po angielsku lub chinsku) i wyciagasz konkretne wartosci pomiarowe + meta.

Twoja praca:
1. Identyfikuj model urzadzenia i numer certyfikatu.
2. Wyciagnij wartosci SAR (W/kg) per scenariusz pomiarowy:
   - head: pomiar przy glowie (zwykle worst-case z roznych pozycji)
   - body: pomiar przy ciele (zwykle z 0-5mm separation distance)
   - limb: pomiar konczyny (jezeli zmierzone)
3. Dla kazdego pomiaru: averaging mass (1g dla FCC, 10g dla ICNIRP/EU), band, frequency, separation distance jezeli podane.
4. Wymien wszystkie testowane pasma + zakresy frekwencji.
5. Wymien zastosowane normy (np. EN 62209-1, IEC 62209, FCC OET 65).
6. Wartosci LICZBOWE — nie wymyslaj. Jezeli raport nie zawiera danej kategorii, pomin (zostaw null/undefined).

Zwracaj WYLACZNIE strukturalny JSON wg schemy submit_sar_report. Bez prozy, bez fence.`;

const TECH_SPEC_SYSTEM = `Jestes ekspertem analizujacym specyfikacje techniczne urzadzen elektronicznych — smartwatchy, trackerow, opasek. Czytasz dokument (PDF/XLSX/CSV) i wyciagasz parametry urzadzenia + opisy funkcjonalnosci.

Twoja praca:
1. Identyfikuj model + producenta.
2. Wartosci bezpieczne: bateria (mAh), IP rating, waga (g), wymiary (mm), temperatura pracy (C).
3. Wszystkie obslugiwane pasma RF + zakresy MHz.
4. Lista konektywnosci (4G/3G/2G/BT/Wi-Fi/GPS).
5. Lista czujnikow.
6. **BARDZO WAZNE**: feature_descriptions — wyciagnij KAZDA funkcje urzadzenia ktora dokument opisuje (np. SOS, monitor pulsu, geofencing, powiadomienia, kroki, sen, alarmy). Dla kazdej 2-5 zdan opisu jak dziala.
7. key_use_cases — glowne scenariusze uzycia eksponowane przez producenta.
8. NIE wymyslaj wartosci. Brakujace pola pomin.

Zwracaj WYLACZNIE strukturalny JSON wg schemy submit_tech_spec.`;

const DECLARATION_SYSTEM = `Jestes ekspertem analizujacym deklaracje zgodnosci CE / RED / RoHS. Czytasz dokument deklaracji i wyciagasz: model, producent, dyrektywy, normy, sygnatariusza, jednostke notyfikowana, date.

Wartosci LICZBOWE / TEKSTOWE doslownie — to dokument prawny. Brakujace pola pomin.

Zwracaj WYLACZNIE strukturalny JSON wg schemy submit_declaration.`;

const MANUAL_SYSTEM = `Jestes ekspertem analizujacym instrukcje obslugi (instrukcje producenta — czesto chinskie/angielskie). Czytasz pelen manual i wyciagasz BOGATA strukture — to bedzie GLOWNE zrodlo wiedzy do generacji polskiej QSG.

Twoja praca (kazda sekcja jest WAZNA — nie pomijaj):
1. **device_model, manufacturer, language** — podstawowe meta.
2. **sections_found** — lista WSZYSTKICH rozdzialow/tematow ktore manual pokrywa (nawet jezeli brzmia podobnie).
3. **key_specs** — wszystkie specyfikacje techniczne ktore manual wymienia (battery, IP, frequencies, weight, dimensions...).
4. **feature_descriptions** — PEŁNE opisy funkcji urzadzenia. To krytyczny field. Dla KAZDEJ funkcji wymienionej w manualu (SOS, monitor pulsu, GPS, geofencing, powiadomienia, kroki, sen, alarmy, kamera, etc) zwroc 2-5 zdan opisujacych jak dziala. Nie ograniczaj sie do 3-4 najwazniejszych — wymien WSZYSTKO.
5. **setup_steps** — krok-po-kroku pierwszego uruchomienia (laduj, wloz SIM, pobierz app, sparuj, wprowadz QR code itd.).
6. **app_pairing** — pelen procedure parowania z aplikacja + nazwa aplikacji.
7. **key_procedures** — procedury operacyjne (SOS, reset, factory reset, aktualizacja firmware) — pelne opisy.
8. **troubleshooting** — FAQ / problem-rozwiazanie z manuala.
9. **warnings** — wszystkie ostrzezenia i przeciwwskazania.

NIE wymyslaj wartosci nieobecnych w dokumencie. Cytuj producenta tam gdzie wartosciowe (parafrazuj na polski). Dla manualow chinskich/angielskich — tlumacz opisy na polski w trakcie ekstrakcji.

Zwracaj WYLACZNIE strukturalny JSON wg schemy submit_manual_summary.`;

const GENERIC_SYSTEM = `Jestes ekspertem analizujacym rozne dokumenty zwiazane z urzadzeniami elektronicznymi — raporty EMC, RoHS, REACH, RF tests, oceny ryzyka, certyfikaty bezpieczenstwa, zdjecia produktu, broszury, instrukcje, itp.

Twoja praca:
1. WYKRYJ typ dokumentu w polu detected_doc_type.
2. Wyciagnij identyfikator (model, numer certyfikatu, laboratorium, data).
3. Wymien zastosowane normy / dyrektywy.
4. **key_values** — wszystkie istotne wartosci pomiarowe / specyfikacje (np. 'Maks moc TX' = '23 dBm', 'Pojemnosc baterii' = '500 mAh', 'EUT temperature' = '23 C'). Im wiecej tym lepiej — to zrodlo do generacji.
5. **feature_descriptions** — jezeli dokument zawiera opisy funkcji urzadzenia (manuale, broszury, opisy produktowe), wyciagnij je. Dla KAZDEJ funkcji 2-5 zdan opisu. To krytyczne zrodlo do generacji opisow w QSG.
6. **procedures** — jezeli dokument zawiera procedury (jak naladowac, jak sparowac, jak zresetowac) — wyciagnij pelne opisy krok-po-kroku.
7. **quoted_passages** — 5-10 wartosciowych cytatow z dokumentu (do 200 znakow kazdy) ktore mozna parafrazowac w QSG.
8. **warnings** — ostrzezenia i przeciwwskazania.
9. Streszczenie 2-4 zdan — co tam jest i co przydatne dla generacji.

NIE wymyslaj. Im bogatszy zwrot tym lepiej dla generacji QSG. Dla dokumentow obcojezycznych — tlumacz na polski w trakcie ekstrakcji.

Zwracaj WYLACZNIE strukturalny JSON wg schemy submit_generic_doc.`;

interface SchemaConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: ZodSchema<any>;
  system: string;
  name: string;
  description: string;
}

function pickSchemaForKind(kind: string | null): SchemaConfig {
  switch (kind) {
    case "sar_report":
      return {
        schema: SarReportSchema,
        system: SAR_SYSTEM,
        name: "submit_sar_report",
        description: "Strukturalna ekstrakcja wartosci SAR + meta z raportu",
      };
    case "tech_spec":
      return {
        schema: TechSpecSchema,
        system: TECH_SPEC_SYSTEM,
        name: "submit_tech_spec",
        description: "Strukturalna ekstrakcja specyfikacji technicznej urzadzenia",
      };
    case "declaration_ce":
      return {
        schema: DeclarationCeSchema,
        system: DECLARATION_SYSTEM,
        name: "submit_declaration",
        description: "Strukturalna ekstrakcja deklaracji zgodnosci CE / RED / RoHS",
      };
    case "manufacturer_manual":
      return {
        schema: ManufacturerManualSchema,
        system: MANUAL_SYSTEM,
        name: "submit_manual_summary",
        description: "Strukturalne streszczenie instrukcji obslugi producenta",
      };
    default:
      // 'other' albo null/undefined — auto-detect typ + wyciagnij key_values.
      return {
        schema: GenericDocSchema,
        system: GENERIC_SYSTEM,
        name: "submit_generic_doc",
        description: "Adaptive ekstrakcja dla dokumentow nietypowych — auto-detect typ + key values",
      };
  }
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY not configured" },
      { status: 503 },
    );
  }

  const { docId } = await ctx.params;
  const sb = getSupabaseAdmin();

  // Auth check + pobierz metadata pliku
  const { data: doc, error: selErr } = await sb
    .from("gen4_reference_docs")
    .select("id, project_id, kind, name, file_path, mime_type, anthropic_file_id")
    .eq("id", docId)
    .single();
  if (!doc) {
    return NextResponse.json(
      { error: `doc not found (id=${docId}): ${selErr?.message ?? "no row"}` },
      { status: 404 },
    );
  }

  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", doc.project_id)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Sciagamy PDF/text bytes z Supabase Storage. Mamy juz file w Storage od
  // czasu uploadu (rowniez gdy Anthropic Files sync zostal zrobiony — Storage
  // jest source of truth).
  const { data: download, error: dlErr } = await sb.storage.from(BUCKET).download(doc.file_path);
  if (dlErr || !download) {
    return NextResponse.json({ error: `download failed: ${dlErr?.message ?? "unknown"}` }, { status: 500 });
  }

  const buf = Buffer.from(await download.arrayBuffer());
  const base64 = buf.toString("base64");
  const mimeType = doc.mime_type || "application/pdf";

  // Gemini inline file limit ~20MB. Wieksze pliki wymagaja Files API —
  // dorobimy gdy bedzie potrzeba (typowy raport SAR ~5-15MB miesci sie).
  if (buf.length > 20 * 1024 * 1024) {
    return NextResponse.json(
      { error: `file too large for inline (${(buf.length / 1024 / 1024).toFixed(1)}MB > 20MB). Files API integration TODO.` },
      { status: 413 },
    );
  }

  const cfg = pickSchemaForKind(doc.kind);

  const userPrompt = `Plik referencyjny: ${doc.name}
Typ (wybrany przez uzytkownika): ${doc.kind ?? "(brak / inne)"}
Mime: ${mimeType}

Wyciagnij strukturalne wartosci z zalaczonego dokumentu wg schemy ${cfg.name}.
Jezeli wybrany typ nie pasuje do realnej zawartosci pliku (np. user oznaczyl jako sar_report ale to manual) — wypelnij co potrafisz, a w polu 'notes' opisz krotko realny typ dokumentu.`;

  const startedAt = Date.now();

  // SSE streaming — Gemini call moze trwac 60-180s dla bogatej schemy + 9MB PDF.
  // Hub Edge middleware proxy zamyka polaczenie po ~25-30s bezruchu, wiec wysylamy
  // heartbeat co 10s. Frontend zbiera chunki, finalny event 'done' niesie wynik.
  const encoder = new TextEncoder();
  const sse = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("started", { doc_name: doc.name, kind: doc.kind, file_size_bytes: buf.length });

      const heartbeat = setInterval(() => {
        try { send("ping", { elapsed_ms: Date.now() - startedAt }); } catch { /* stream closed */ }
      }, 10000);

      try {
        const ai = await callGeminiWithRetry({
          system: cfg.system,
          user: userPrompt,
          model: GEMINI_FLASH,
          maxTokens: 16000,
          outputSchema: {
            name: cfg.name,
            description: cfg.description,
            schema: cfg.schema,
          },
          inlineFiles: [{ mimeType, data: base64 }],
        }, {
          onProgress: (info) => {
            // Emituj do SSE zeby user widzial w UI ze trwa retry / fallback.
            try { send(info.type, info); } catch { /* stream closed */ }
          },
        });

        clearInterval(heartbeat);

        const structured = ai.parsed;
        if (!structured) {
          send("error", {
            error: "Gemini did not return parsed structured output (prawdopodobnie truncacja max_tokens lub niepoprawny JSON)",
            raw: ai.text.slice(0, 2000),
            output_tokens: ai.outputTokens,
            text_length: ai.text.length,
          });
          void logAiCall({
            project_id: doc.project_id,
            endpoint: "reference-docs/extract-structured",
            context_type: "project",
            user_instruction: `extract structured from ${doc.name}`,
            system_prompt: cfg.system,
            user_prompt: userPrompt,
            model: ai.model,
            max_tokens: 16000,
            response_text: ai.text,
            tokens_in: ai.inputTokens,
            tokens_out: ai.outputTokens,
            duration_ms: Date.now() - startedAt,
            error: "no parsed output",
            user_email: auth.email,
          });
          controller.close();
          return;
        }

        const { error: updateErr } = await sb
          .from("gen4_reference_docs")
          .update({
            extracted_structured: structured,
            extracted_structured_at: new Date().toISOString(),
            extracted_structured_model: ai.model,
          })
          .eq("id", docId);

        if (updateErr) {
          send("error", { error: `DB update failed: ${updateErr.message}` });
          controller.close();
          return;
        }

        void logAiCall({
          project_id: doc.project_id,
          endpoint: "reference-docs/extract-structured",
          context_type: "project",
          user_instruction: `extract structured from ${doc.name}`,
          system_prompt: cfg.system,
          user_prompt: userPrompt,
          model: ai.model,
          max_tokens: 16000,
          response_text: ai.text,
          tokens_in: ai.inputTokens,
          tokens_out: ai.outputTokens,
          duration_ms: Date.now() - startedAt,
          user_email: auth.email,
        });

        send("done", {
          ok: true,
          extracted: structured,
          model: ai.model,
          tokens_in: ai.inputTokens,
          tokens_out: ai.outputTokens,
          duration_ms: Date.now() - startedAt,
        });
        controller.close();
      } catch (err) {
        clearInterval(heartbeat);
        const msg = err instanceof Error ? err.message : "Gemini call failed";
        void logAiCall({
          project_id: doc.project_id,
          endpoint: "reference-docs/extract-structured",
          context_type: "project",
          user_instruction: `extract structured from ${doc.name}`,
          system_prompt: cfg.system,
          user_prompt: userPrompt,
          model: GEMINI_FLASH,
          max_tokens: 16000,
          error: msg,
          duration_ms: Date.now() - startedAt,
          user_email: auth.email,
        });
        send("error", { error: `Gemini extraction failed: ${msg}` });
        controller.close();
      }
    },
  });

  return new Response(sse, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
