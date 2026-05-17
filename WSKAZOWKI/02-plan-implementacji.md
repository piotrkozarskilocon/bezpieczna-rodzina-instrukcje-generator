# Plan implementacji — synteza Deep Research + brakujące fundamenty

> **Status:** wstępny plan po analizie odpowiedzi research modela (Gemini Deep Research).
> **Filozofia:** bierzemy co dobre z research, odrzucamy nadmiarowe abstrakcje (LangGraph, Edge Runtime jako "lekarstwo"), dokładamy brakujące fundamenty (testy, telemetria, error recovery).
> **Założenie:** 1 developer (PKZ + Claude Code w terminalu). Cele iteracyjne, mergeowalne osobno.

---

## Co przyjmujemy, co odrzucamy, co dodajemy

### ✅ Przyjmujemy z research (bez modyfikacji)
- **RFC 6902 JSON Patch** dla edycji wizualnej (canvas) — redukcja kosztu 5-10×
- **Structured Outputs / tool use** zamiast `parseJsonFromAi` z 5 fallbackami
- **Native Vision Gemini 2.5 Pro** dla raportów SAR i specyfikacji
- **Bounding Boxes Gemini** dla auto-callouts zdjęć produktów
- **Multi-Provider Gateway** z routingiem per task
- **Translation memory** na MD5 hash (już mamy, ale routing przez Gemini Flash dla bulk)

### ⚠️ Przyjmujemy z modyfikacją
- **Multi-agent architecture** — TAK, ale jako **zwykłe TypeScript moduły** (Orchestrator/Extractor/Layout/Compliance), bez LangGraph
- **Edge Runtime** — TYLKO dla lekkich orkiestratorów AI. Ciężkie operacje (pdf-lib, mammoth, xlsx) zostają w Node.js. Long-running operations → **Supabase Edge Functions (Deno)** lub upgrade do Vercel Pro (300s cap)
- **"Update-on-Change" wzorzec** — zwykły streaming reduce, bez branding

### ❌ Odrzucamy lub odkładamy
- **LangGraph** — overkill dla tego use case. Wracamy do tego jeśli proste TS nie wystarczy
- **Pełna migracja Vercel Hobby → Edge dla wszystkiego** — nierealne bez refactoringu pdf-lib i Office parsers
- **Quasi-naukowy język ("ReAct", "Activity-on-Vertex Graph")** — używamy zwykłych nazw

### ➕ Dokładamy (czego research nie zauważył, a my pisaliśmy w briefie)
- **Testy regresyjne** (Vitest + Playwright) jako Faza 0
- **Telemetria produkcyjna** (Sentry + custom events do gen4_ai_calls)
- **Workflow zatwierdzeń** (multi-step approval z notyfikacjami email)
- **Role i permissioning** per projekt
- **Anthropic prompt caching** — zachowany (90% rabat na powtarzane prompty)

---

## Fazy implementacji (chronologicznie)

### Faza 0 — Fundamenty (must-have, ~5 dni)

**Cel:** żadne ulepszenie AI nie ma sensu bez bezpiecznika regresji.

#### 0.1 Testy podstawowe
- Vitest + @testing-library/react
- Unit testy dla: `parseJsonFromAi` (regression), `repairTruncatedJson`, `v4LegalTemplates`, `v4Validate`, `v4FileExtract` (DOCX/XLSX conversion)
- Integration test: pełen flow „create project → skeleton → populate → export" przeciw mock Anthropic
- Playwright E2E dla 3 krytycznych ścieżek: tworzenie projektu, edycja strony, eksport PDF
- **CI:** GitHub Actions z testami na każdy push

**Wysiłek:** M (3 dni)
**ROI:** XL — każdy następny refactor jest 5× bezpieczniejszy

#### 0.2 Structured Outputs (Anthropic tool use)
- Refactor `callClaude` żeby przyjmować `output_schema?: ZodSchema`
- Gdy schema podany → wymuszamy przez `tool_choice: { type: "tool", name: "..." }` z input_schema z Zod
- Refactor 4 endpointów krytycznych (ai-edit, ai-fix-element, apply-style, apply-design) na schema-based
- `parseJsonFromAi` zostaje jako fallback dla legacy

**Wysiłek:** M (2 dni)
**ROI:** XL — eliminuje 90% bugów typu „JSON parse failed"

#### 0.3 Telemetria
- Sentry SDK (Next.js) z source maps
- Custom events: `ai_call_started`, `ai_call_completed`, `ai_call_failed`, `editor_action` (drag/resize/delete), `export_started/completed`
- Dashboard w `/admin/telemetry` — top errors, top slow endpoints, p50/p95 latency
- Retention policy dla `gen4_ai_calls` — partition po miesiącu, drop po 90 dniach

**Wysiłek:** S (1 dzień)
**ROI:** L — bez tego optymalizujemy ślepo

---

### Faza 1 — Multi-Provider Gateway (~3 dni)

**Cel:** móc wybrać provider per task bez przepisywania endpointów.

#### 1.1 Wrapper `lib/v4AiProviders.ts`
```ts
type AiProvider = "anthropic-haiku" | "anthropic-sonnet" | "anthropic-opus"
                | "gemini-flash" | "gemini-pro";

interface AiCallOpts {
  provider: AiProvider;
  system: string;
  user: string;
  attachments?: FileRef[];
  outputSchema?: ZodSchema;
  maxTokens?: number;
  temperature?: number;
  cacheSystemPrompt?: boolean;
}

callAi(opts: AiCallOpts): Promise<AiResponse>
```

- Implementacja Anthropic — refactor istniejącego `callClaude`
- Implementacja Gemini — nowa, używa `@google/generative-ai` SDK
- Wspólny output type (`AiResponse`)
- Wspólne logowanie do `gen4_ai_calls` (dodać kolumnę `provider`)
- Migracja 0020: `alter table gen4_ai_calls add column provider text`

#### 1.2 Routing per endpoint
- `ai-fix-element` → default Haiku (Anthropic) — szybkie geometry
- `ai-edit` → Haiku/Sonnet z UI picker (zostaje)
- `apply-style` → Sonnet z UI picker (zostaje)
- `apply-design` → Sonnet z UI picker (zostaje)
- `auto-populate` → Haiku (fast)
- `translate` (nowy bulk) → **Gemini Flash** (3-5× taniej dla simple translation)
- `reference-docs/extract-summary` → **Gemini 2.5 Pro** (1M context window dla raportów SAR)
- `image-mapping/preview` → **Gemini 2.5 Pro Vision** (Bounding Boxes)

#### 1.3 UI: rozszerzony picker
- Dropdown w model picker rozbudowany o Gemini Flash/Pro
- Per-endpoint label: „Gemini Flash (najszybszy, najtańszy) / Sonnet 4.6 / Opus 4.7"
- Cost preview gdy user wybiera (szacunek tokens × rate)

**Wysiłek:** M (3 dni)
**ROI:** L — odkrywa nowe możliwości + redukcja kosztu tłumaczeń ~70%

---

### Faza 2 — Native Vision Gemini dla plików referencyjnych (~4 dni)

**Cel:** wydobywanie wartości technicznych (SAR, IP, frequencies) z 500-stronicowych raportów bez halucynacji.

#### 2.1 Gemini Files API integration
- Nowy `lib/v4GeminiFiles.ts` — upload + cache file_id w `gen4_reference_docs.gemini_file_id` (kolumna dodawana migracją 0021)
- Sync trigger: gdy user uploaduje plik z `kind=sar_report` lub `tech_spec` → upload do Gemini File API
- Cache 48h (Gemini limit), automatyczne re-upload gdy expired

#### 2.2 Structured extraction z Zod schema
```ts
const SarReportSchema = z.object({
  device_model: z.string(),
  test_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sar_head_max: z.object({
    value_w_per_kg: z.number(),
    standard: z.enum(["1g", "10g"]),
    frequency_mhz: z.number(),
  }),
  sar_body_max: z.object({ /* ... */ }),
  frequencies_tested: z.array(z.object({
    band: z.string(),
    range_mhz: z.tuple([z.number(), z.number()]),
  })),
  separation_distance_mm: z.number().optional(),
  certifications: z.array(z.string()),
});
```

- Endpoint `POST /api/v4/reference-docs/[id]/extract-structured`
- Wzorzec "Update-on-Change" (streaming reduce dla bardzo długich raportów):
  - Stream odpowiedzi modelu z `responseSchema`
  - Aktualizuj structured object inkrementalnie
  - Po zakończeniu zapisz do `gen4_reference_docs.extracted_structured` (jsonb)

#### 2.3 Wykorzystanie w generacji
- Gdy AI generuje stronę „Informacja SAR" → backend dolącza `extracted_structured` z reference doc jako context
- AI dostaje konkretne liczby zamiast wymyślać → znika placeholder DO UZUPEŁNIENIA

**Wysiłek:** L (4 dni)
**ROI:** XL — kluczowa wartość biznesowa (compliance), eliminuje placeholdery

---

### Faza 3 — Auto-callouts z Bounding Boxes (~5 dni)

**Cel:** „Wgraj zdjęcie zegarka → AI sam wstawia callouts wskazujące przyciski/porty/czujniki".

#### 3.1 Endpoint i serwis
- `POST /api/v4/projects/[id]/auto-callouts` — body: `{ image_id, target_page_id, language }`
- `lib/v4SpatialMapping.ts` — Gemini 2.5 Pro z prompt:
  > „Identify hardware interface points (buttons, ports, sensors, indicators) on this product photo. For each return: `{ label_pl: string, label_<lang>: string, bbox: [ymin, xmin, ymax, xmax] }` normalized 0-1000."
- Schema Zod z walidacją koordynatów
- Konwersja [0-1000] → mm na canvasie z uwzględnieniem fit_mode obrazka

#### 3.2 UI w Gen4ImagePanel + edytorze
- Dropdown przy obrazku: „✨ Wygeneruj callouts AI"
- Modal: wybierz target_page_id, język
- Preview callouts (markery + label) — user może edytować label/usunąć przed apply
- Apply → wstawia do `gen4_elements` nowe text + line elements (line z `x1_pct/y1_pct/x2_pct/y2_pct` wskazuje na bbox center)

#### 3.3 Fallback z Claude Vision
- Gdy Gemini fail/disabled → fallback do Claude vision z mniejszą precyzją
- Loguje w `gen4_ai_calls` który provider był użyty

**Wysiłek:** L (5 dni)
**ROI:** XL — nowa funkcjonalność produktowa, ogromne zmniejszenie czasu pracy z QSG

---

### Faza 4 — RFC 6902 JSON Patch (~6 dni)

**Cel:** redukcja kosztów AI 5-10× i szybkość edycji.

#### 4.1 Refactor endpointów na patch output
- Pierwsze: `ai-fix-element` — najmniejszy zakres, łatwy test
  - Schema: `{ patches: Array<{ op: "replace"|"add"|"remove", path: string, value?: any }> }`
  - Server: pobiera obecny element → AI generuje patches → walidacja → apply z `fast-json-patch` → save
- Drugi: `ai-edit` (per page)
  - Schema: patches z paths typu `/elements/0/properties/color`, `/elements/3` (whole replace) itd.
- Trzeci: `apply-style` per target page

#### 4.2 Client-side optimistic updates
- `fast-json-patch` na froncie też
- Po wysłaniu request → otrzymujemy patches → applyPatches do lokalnego state PRZED odświeżeniem z DB
- Eliminuje flicker

#### 4.3 Wsparcie undo
- Każdy patch ma odwrotność (inverse) — można cofnąć bez DB roundtrip
- Historia patches w state (replace istniejący `history` w Gen4Editor)
- Ctrl+Z cofa **patche per call**, nie tylko per element

**Wysiłek:** L (6 dni)
**ROI:** XL — token output spada ~85%, UX znacznie płynniejszy, undo dla AI calls działa

---

### Faza 5 — Long-running jobs (~5 dni)

**Cel:** ominąć 60s Vercel cap dla operacji typu „apply DS do całego projektu" (14 stron × 5s = 70s).

#### 5.1 Architektura
**Opcja A** (preferowana): **Supabase Edge Functions** (Deno, 150s timeout, free)
- Job worker w Deno: odbiera `job_id` → odpala N AI calls → updates `gen4_jobs` table z postępem
- Frontend polluje `/api/v4/jobs/[id]` co 2s lub używa Supabase Realtime subscription

**Opcja B** (alternative): **Vercel Pro upgrade** ($20/mc, 300s function timeout)
- Bez refactoringu architektury
- Wystarczy zmienić `export const maxDuration = 300`

**Opcja C** (najbardziej elastyczna): Background queue z **Supabase pg_cron + worker funkcja**
- Worker działa nawet 10 minut
- Najwięcej fleksybilności

**Decyzja do podjęcia:** czekamy na cost analysis — Vercel Pro vs effort migration.

#### 5.2 Migracja `gen4_jobs`
```sql
create table gen4_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references gen4_projects(id),
  job_type text not null, -- "apply_ds_all", "translate_all", "apply_style_all"
  status text not null check (status in ('queued','running','completed','failed','cancelled')),
  progress jsonb default '{"done":0,"total":0}'::jsonb,
  result jsonb,
  error text,
  created_at timestamptz default now(),
  started_at timestamptz,
  completed_at timestamptz
);
```

#### 5.3 SSE streaming postępu
- `GET /api/v4/jobs/[id]/stream` — Server-Sent Events
- Frontend: `EventSource` zamiast pollingu

**Wysiłek:** L (5 dni)
**ROI:** L — eliminuje fragility client-side loop, lepsze UX dla długich operacji

---

### Faza 6 — Compliance Agent z RAG (~7 dni)

**Cel:** automatyczna weryfikacja zgodności prawnej dokumentu (nie tylko obecność sekcji, ale ich poprawność).

#### 6.1 Vector store
- Supabase pgvector
- Tabela `legal_clauses` z embeddings fragmentów norm:
  - RED 2014/53/EU (artykuły dot. instrukcji + deklaracji)
  - RoHS 2011/65/EU
  - RODO art. 13/14 (informacje o przetwarzaniu)
  - MDR 2017/745 (dla opasek z funkcjami medycznymi)
  - Ustawa o ochronie konsumentów (gwarancja)
- Embeddings generowane przez OpenAI ada-002 lub Gemini embeddings (tańsze)

#### 6.2 Compliance check workflow
1. Pobierz finalne treści projektu (text z gen4_elements, połączone per strona)
2. Per wymagana sekcja (z `v4LegalTemplates`):
   - Retrieve top-5 relevant clauses z vector store
   - AI sprawdza czy treść sekcji pokrywa wymogi z clauses
   - Output: `{ section_id, status: "ok"|"warning"|"missing", reason: string, suggested_addition?: string }`
3. Raport zwrócony do UI z markdownem + linkami do edycji

#### 6.3 UI
- Panel **Compliance Check** rozszerzony — pokaż per sekcja status + sugestie
- Przycisk „Zastosuj sugestię AI" przy każdej missing/warning

**Wysiłek:** XL (7 dni)
**ROI:** L — duża wartość biznesowa, ale skomplikowane prawnie (kto bierze odpowiedzialność za rekomendacje AI?)

---

### Faza 7 — Workflow zatwierdzeń + role (~5 dni)

**Cel:** przejście z 1-3 userów do procesu zespołowego.

#### 7.1 Role
- `owner` — może wszystko
- `designer` — edycja layout, AI assistant, brak approval
- `translator` — tylko edycja tłumaczeń (panel Translations only)
- `legal_reviewer` — read-only + comments + approve/reject
- Tabela `gen4_project_members (project_id, email, role)`

#### 7.2 Approval workflow
- States: `draft → designer_ready → translator_ready → legal_review → approved`
- Tranzycje: tylko określone role mogą zmienić state w określoną stronę
- Email notifications (nodemailer + Gmail SMTP — już mamy) przy każdej tranzycji
- Audit log z user_email i czas

#### 7.3 UI
- Panel **Workflow** z aktualnym stanem + przyciskami akcji widocznymi tylko dla uprawnionych ról
- Read-only mode dla designerów gdy `state ≥ legal_review`
- Komentarze inline na elementach (jak Google Docs) dla legal_reviewer

**Wysiłek:** L (5 dni)
**ROI:** M — krytyczne gdy zespół rośnie, ale dziś z 1-3 userów mniej pilne

---

## Priorytetyzacja (ROI vs wysiłek)

| Faza | Wysiłek | Wpływ na jakość | Wpływ na czas usera | Pilność |
|------|---------|-----------------|---------------------|---------|
| 0. Fundamenty (testy + Structured Outputs + telemetria) | M (5d) | XL | M | **must-have** |
| 4. RFC 6902 JSON Patch | L (6d) | L | XL | **wysoka** |
| 2. Native Vision Gemini (SAR/spec) | L (4d) | XL (compliance) | L | **wysoka** |
| 3. Auto-callouts Bounding Boxes | L (5d) | M | XL (QSG) | **średnia** |
| 1. Multi-Provider Gateway | M (3d) | M | M | **średnia** (enabler dla 2 i 3) |
| 5. Long-running jobs | L (5d) | M | M | **niska** (ma workaround) |
| 7. Approval workflow + role | L (5d) | L | M | **niska** (zespół jeszcze mały) |
| 6. Compliance RAG | XL (7d) | L | L | **niska** (ryzyko prawne) |

**Suma TOP 4 (0+4+2+1): ~18 dni roboczych ≈ 3.5 tygodnia** — to realistyczny scope na 1 sprint Q2/2026.

---

## TOP 5 ulepszeń (rekomendacja)

1. **Structured Outputs (Faza 0.2)** — najtaniej + największy wpływ na stabilność. Eliminuje 90% „JSON parse failed". 2 dni.
2. **RFC 6902 JSON Patch dla ai-edit (Faza 4.1+4.2)** — 80% redukcja output tokens, lepsze UX. 4 dni dla MVP.
3. **Gemini Vision dla SAR extraction (Faza 2)** — kluczowe dla compliance. Eliminuje placeholdery „DO UZUPEŁNIENIA". 4 dni.
4. **Auto-callouts Bounding Boxes (Faza 3)** — nowa funkcjonalność produktowa, gigantyczny time-saver dla QSG. 5 dni.
5. **Testy regresyjne + telemetria (Faza 0.1+0.3)** — bez tego każdy z powyższych jest ryzykiem. 4 dni.

---

## Czego NIE robimy w pierwszym podejściu

- LangGraph (jeśli okaże się że proste TS nie skaluje — wracamy)
- Migracja na Edge Runtime jako norma (tylko punktowo dla orkiestratorów AI)
- Vertex AI vs Google AI Studio decyzja — startujemy z Google AI Studio (prostsze billing)
- Compliance RAG (Faza 6) — odkładamy do Q3 ze względu na ryzyka prawne

---

## Pytania do PKZ przed startem

1. **Budget AI:** mamy ~$10 na Anthropic, ile na Gemini? Czy okay płacić ~$5-15/projekt zamiast obecnych ~$2-5?
2. **Vercel Pro?** $20/mc daje 300s timeout — czy upgrade akceptowalny zamiast refactoringu na Edge?
3. **Google Cloud konto** — czy już mamy projekt w Google AI Studio? Trzeba klucza GEMINI_API_KEY.
4. **Priorytet biznesowy:** czy najpilniejsze jest QSG (auto-callouts) czy full manual (compliance + Vision SAR)?
5. **Czy okay 3-4 tygodnie zamrożenia features dla Fazy 0 (testy + structured)?** Bez tego nie warto budować dalszych warstw.

---

**Koniec planu. Czekam na decyzję od PKZ co do priorytetów + odpowiedzi na pytania.**
