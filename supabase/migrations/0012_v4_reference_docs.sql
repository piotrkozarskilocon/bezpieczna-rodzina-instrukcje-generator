-- Generator Instrukcji v4 — pliki referencyjne (faza 2 z PRD).
--
-- Użytkownik może wgrać do projektu pliki (PDF/DOCX) — raport SAR, specyfikację
-- techniczną od producenta, instrukcję producenta (często w języku obcym).
-- AI dostaje je jako attachments via Anthropic Files API i wyciąga konkretne
-- wartości (SAR head/body, normy, częstotliwości, IP rating itd.) wpisując
-- je w docelowych miejscach instrukcji zamiast placeholderów DO UZUPEŁNIENIA.
--
-- anthropic_file_id — Anthropic Files API zwraca uuid po uploadzie. Trzymamy
-- go po stronie bazy żeby reuse w wielu wywołaniach (skeleton, auto-populate,
-- ai-edit) bez ponownego uploadu. Po deleted Anthropic auto-czyści po 90 dniach.

create table if not exists public.gen4_reference_docs (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.gen4_projects(id) on delete cascade,
  kind                text not null check (kind in (
    'sar_report',         -- raport SAR
    'tech_spec',          -- specyfikacja techniczna producenta
    'manufacturer_manual', -- instrukcja od producenta (może być po chińsku)
    'declaration_ce',     -- deklaracja zgodności CE
    'other'
  )),
  -- Język źródłowy pliku (do tłumaczenia gdy potrzebne).
  source_lang         text default 'pl',
  -- Nazwa wyświetlana w UI (filename uploadu).
  name                text not null,
  -- Ścieżka w bucket gen4-reference-docs.
  file_path           text not null,
  size_bytes          bigint,
  mime_type           text,
  -- Anthropic Files API: po sync z Anthropic tutaj trafia file_id zwrócony
  -- przez files.create(). Null gdy upload nie był jeszcze syncowany do
  -- Anthropic (np. user jest w trybie manual).
  anthropic_file_id   text,
  -- Krótkie streszczenie zawartości wygenerowane przez AI przy uploadzie
  -- (1-2 zdania, np. "Raport SAR dla modelu GJD.16. Head: 0.42 W/kg, Body: 0.78 W/kg.
  --  Norma EN 50360. Data badania: 2026-03").
  extracted_summary   text,
  uploaded_by         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_gen4_reference_docs_project
  on public.gen4_reference_docs (project_id, kind);

drop trigger if exists trg_gen4_reference_docs_updated on public.gen4_reference_docs;
create trigger trg_gen4_reference_docs_updated
  before update on public.gen4_reference_docs
  for each row execute function public.gen4_set_updated_at();
