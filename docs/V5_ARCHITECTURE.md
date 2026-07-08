# Generator Instrukcji v5 — architektura

**Data:** 2026-07-08 · **Autor:** Claude (Fable 5) na zlecenie PKZ · **Status:** obowiązujący design doc budowy

## Cel

Wgrywasz WSZYSTKIE materiały nowego trackera/smartwatcha — instrukcje producenta (często
po chińsku), specyfikacje, raporty badań (SAR/EMC/RF/Safety), deklaracje zgodności UE,
RoHS/REACH, zdjęcia produktu, screeny i nagrania z aplikacji z flow dodawania urządzenia —
a generator produkuje **gotowy, kompletny dokument potrzebny do wprowadzenia do obrotu**
(QSG, IO/instrukcja obsługi, …) w wybranych językach, jako PDF do druku.

## Pryncypium nr 1: treść ≠ layout

Porażka v4 wynikała z jednego wyboru: AI układało elementy na kanwie w mm
(x/y/w/h), a system potem *ratował* geometrię (clamp, overlap-resolver,
font-shrinker). W v5:

- **AI pracuje wyłącznie na treści** — ekstrahuje fakty, pisze sekcje, tłumaczy.
- **Skład jest deterministyczny** — szablony HTML + CSS paged media
  (`@page { size: 76mm 76mm }`), render Chromium → PDF. Tekst się zawija,
  strony się łamią, font nigdy nie spada poniżej minimum, bo tak mówi CSS.
- Overflow to nie „bug do naprawy przez AI", tylko sygnał mierzalny w DOM
  (scrollHeight > clientHeight) → sekcja dzielona na kolejną stronę przez silnik.

## Pipeline (7 etapów)

```
[1 INGEST]  upload plików → bucket + rekord gen5_source_docs
[2 CLASSIFY]  Gemini Flash: kind + język + czego dotyczy (tanio, per plik)
[3 EXTRACT]  per-doc ekstrakcja strukturalna wg schematu dla kind:
              manual → funkcje, kroki obsługi, ostrzeżenia, parametry
              sar_report → wartości SAR per pasmo/pozycja, norma, laboratorium
              rf/emc → pasma, moce max (wymóg RED art. 10(8a))
              declaration_ce → producent, importer, normy, moduły
              tech_spec (xlsx) → hardware, bateria, wymiary, wodoodporność
              photos → kategoryzacja + opis (Gemini Vision)
              screeny/wideo → kroki flow parowania (klatki → sekwencja)
              (chiński/angielski → ekstrakcja OD RAZU z tłumaczeniem na PL)
[4 MERGE]  scalenie do Device Knowledge Base — kanoniczny schemat faktów
            z atrybucją źródeł (doc_id + cytat), confidence, WYKRYWANIE KONFLIKTÓW
            (np. inna pojemność baterii w spec vs manual → do rozstrzygnięcia)
[5 COMPOSE]  Claude Sonnet pisze treść sekcji dokumentu (QSG/IO) WYŁĄCZNIE z KB;
              szablon dokumentu = lista sekcji wymaganych (regulacyjnych i
              produktowych); brak danych → jawna luka w raporcie, nigdy zmyślenie
[6 RENDER]  HTML (szablon per typ dokumentu) + CSS print → Chromium → PDF;
             warianty językowe z tej samej struktury
[7 QA GATE]  brama kompletności: wymagane sekcje × wymagane fakty (checklista
              regulacyjna — wgrywalna z deep researchu), zero placeholderów,
              zero nieprzetłumaczonego CJK, limity stron, weryfikacja overflow
```

Każdy etap zapisuje wynik do DB — pipeline jest wznawialny i inspekcjonowalny.

## Model danych (tabele `gen5_`)

- **`gen5_projects`** — id, owner_email, name, device (model_code, marketing_name,
  device_type), status, kb jsonb (zmaterializowany Device KB), kb_report jsonb
  (pokrycie/konflikty/luki), created/updated.
- **`gen5_source_docs`** — id, project_id, kind, source_lang, name, file_path
  (bucket `gen4-reference-docs` — reuse), size, mime, pages, sha256,
  classify jsonb, extracted jsonb (wynik etapu 3 wg schematu kind),
  extract_model, extract_status, error.
- **`gen5_assets`** — obrazy do użycia w dokumentach (zdjęcia produktu, ikony,
  wykadrowane screeny): project_id, source_doc_id?, path, category, description,
  width/height.
- **`gen5_documents`** — wygenerowane dokumenty: project_id, doc_type
  (qsg|io|…), title, languages[], content jsonb (drzewo sekcji z treścią per
  język), template_key, status, qa jsonb (wynik bramy), pdf_paths jsonb
  (per język/wariant).
- **`gen5_jobs`** — długie operacje (wzór gen4_jobs): typ, stan, postęp,
  wynik; API poll. Konieczne przez limit 60 s na Vercel Hobby.

## Device Knowledge Base — kanoniczny schemat (skrót)

```ts
DeviceKB {
  identity: { model_code, trade_name, manufacturer{name,address}, importer{...} }
  hardware: { dimensions, weight, display, battery{type,capacity_mah,charging},
              ip_rating, sensors[], sim, memory }
  radio:    { bands: [{tech, band, freq, max_power_dbm}], gps, wifi, bt }   // RED 10(8a)
  sar:      { limit_w_kg, results: [{position, band, value_w_kg}], standard, lab }
  regulatory: { ce, red_nb{number,cert}, rohs, reach, weee, doc{url,date,signatory} }
  features: [{ key, name_pl, description_pl, requires_app, source }]
  app_flow: { app_name, stores[], pairing_steps: [{n, action_pl, screen_asset?}] }
  safety:   [{ severity: danger|warning|caution|notice, text_pl, source }]
  package_contents: [...]
  support:  { phone, email, www }
}
```

Każdy liść ma provenance: `{ source_doc_id, quote|page, confidence }`.
Merge wykrywa konflikty między źródłami i raportuje je zamiast po cichu wybierać.

## Szablony dokumentów

Definicja dokumentu = uporządkowana lista sekcji, każda z:
`key, required (prawnie|produktowo|opcjonalna), needs (ścieżki w KB), audience,
max_length_hint`. Startowo: **QSG** (76×76 mm booklet, zszywka) i **IO** (A5/A4,
pełna instrukcja). Sekcje regulacyjne (uproszczona deklaracja zgodności z URL,
pasma+moce, SAR, WEEE/bateria, producent/importer) wbudowane; checklista z deep
researchu PKZ zostanie wgrana jako `lib/v5/regulatoryChecklist.ts` i podpięta
do bramy QA (etap 7) oraz do `required` sekcji.

## Render

- Szablony: TSX → statyczny HTML string (bez hydratacji) + dedykowany
  `print.css` per typ dokumentu; fonty lokalne (Inter TTF już w repo).
- Silnik: lokalnie **Playwright** (dev/testy), na Vercelu
  **puppeteer-core + @sparticuz/chromium** (ta sama ścieżka kodu, wspólny
  interfejs `renderHtmlToPdf(html, css, pageSize)`).
- Weryfikacja renderu: przed PDF-em strona mierzy w DOM overflow każdej
  sekcji; wynik wraca do QA. Render do PNG per strona → inspekcja wizualna
  (testy + podgląd w UI).

## Reużycie z v4 (adaptacja, nie import 1:1)

- `lib/anthropic.ts`, `lib/v4Gemini.ts`, `lib/v4AiProviders.ts` → warstwa AI
  (structured output Zod, retry, routing modeli, log do gen4_ai_calls).
- `lib/v4FileExtract.ts` → przygotowanie DOCX/XLSX/PDF.
- `lib/v4LegalTemplates.ts` → punkt wyjścia dla definicji sekcji.
- `lib/auth.ts`, `proxy.ts`, `lib/supabase.ts` → bez zmian.
- Dane: istniejące pliki źródłowe w buckecie `gen4-reference-docs`
  (projekt testowy GJD.16 = `ddb872d7-…`, 28 dokumentów) — v5 umie
  zaimportować projekt v4 jako źródła.

**Nie przenosimy:** v4Export (pdf-lib), v4FinalizeLayout/BoundsClamp/
OverlapResolver/FontShrinker, Gen4Editor, PageElementSchema (x/y/w/h).

## Testowalność (CLI-first)

Rdzeń pipeline'u to czyste moduły `lib/v5/*` uruchamialne bez UI:
`scripts/v5.ts <projekt> <etap>` — dzięki temu cały E2E (realne pliki
GJD.16 → QSG PDF) odpalany lokalnie z kluczami z `.env.vercel-prod`.
Testy: vitest dla logiki (merge, gate, szablony sekcji), snapshot HTML,
render-smoke z pomiarem overflow, wizualna inspekcja PNG.

## Modele AI (routing)

- classify / kategoryzacja obrazów: **Gemini 2.5 Flash** (tanio, wysoki wolumen)
- ekstrakcja dokumentów (w tym CN, duże PDF-y): **Gemini 2.5 Pro** (długi
  kontekst, natywny PDF vision); pliki >20 MB przez Gemini Files API
- merge KB (rozstrzyganie, normalizacja): **Claude Sonnet**
- compose sekcji + tłumaczenia: **Claude Sonnet** (jakość języka)
- tanie poprawki/regeneracje pojedynczych sekcji: **Claude Haiku**
