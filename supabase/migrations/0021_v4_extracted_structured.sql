-- Generator Instrukcji v4 — strukturalna ekstrakcja z plikow referencyjnych.
--
-- gen4_reference_docs juz ma `extracted_summary` (text, 1-3 zdania od Haiku
-- po uploadzie). Teraz dodajemy `extracted_structured` (jsonb) — pelna
-- strukturalna ekstrakcja przez Gemini 2.5 Pro Vision z responseSchema.
--
-- Use case: raport SAR (zwykle 100-500 stron PDF) → AI wyciaga konkretne
-- wartosci (SAR head/body w W/kg, frequencies, IP rating, certificates,
-- compliance norms). Wynik zapisany jako jsonb i wstrzykiwany do system
-- promptu przy generacji sekcji "Informacja SAR" — AI dostaje konkretne
-- liczby zamiast wymyslac placeholdery.
--
-- Faza 2 z planu deep research (WSKAZOWKI/02-plan-implementacji.md).
-- Roznica vs extracted_summary: summary to text dla LLM context (krotki opis),
-- structured to znormalizowane wartosci dla code uzycia (template variables).

alter table public.gen4_reference_docs
  add column if not exists extracted_structured jsonb,
  add column if not exists extracted_structured_at timestamptz,
  add column if not exists extracted_structured_model text;

-- Index dla quick lookup "ktore pliki SAR maja strukturalne wartosci".
create index if not exists gen4_reference_docs_structured_idx
  on public.gen4_reference_docs (project_id)
  where extracted_structured is not null;
