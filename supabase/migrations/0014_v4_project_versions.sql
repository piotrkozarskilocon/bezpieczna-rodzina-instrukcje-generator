-- Generator Instrukcji v4 — version history (snapshoty projektu).
--
-- Każda destruktywna operacja (import po regeneracji szkieletu, apply DS na
-- cały projekt, batch auto-populate) zapisuje snapshot stanu PRZED zmianą.
-- Snapshot to JSON: { pages: [...], elements: [...], note?: 'apply DS Stop Hejt' }
-- Umożliwia cofnięcie projektu do wybranej wersji bez utraty całej historii.
--
-- version_number rośnie liniowo per projekt (1, 2, 3, ...). Snapshot przed
-- pierwszą zmianą = v1.

create table if not exists public.gen4_project_versions (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.gen4_projects(id) on delete cascade,
  version_number  int not null,
  -- Krótki opis co spowodowało utworzenie wersji (do listy w UI).
  description     text,
  -- Full snapshot stanu projektu: pages, elements, design_systems, notes.
  -- Nie kopiujemy reference_docs (Anthropic file_id reuse) ani translations
  -- (te przywracamy z translation memory).
  snapshot        jsonb not null,
  created_by      text,
  created_at      timestamptz not null default now(),
  unique (project_id, version_number)
);

create index if not exists idx_gen4_versions_project
  on public.gen4_project_versions (project_id, version_number desc);
