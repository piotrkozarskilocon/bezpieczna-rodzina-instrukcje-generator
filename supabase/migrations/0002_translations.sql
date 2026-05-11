-- Generator Instrukcji — translations table (Phase 2.6)
--
-- One row = one entry in the multilang Excel sheet (e.g. "Wersja 003" with
-- its 7 language values). Blocks reference these via
-- `generator_blocks.content._translation_row` (the integer row_index here),
-- not via FK, so a re-import doesn't need to update every block row.
--
-- RLS stays off (same model as generator_blocks/pages — auth handled in API
-- routes via owner_email derived from the verified JWT).

create table if not exists public.generator_translations (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.generator_projects(id) on delete cascade,
  row_index   int  not null,
  row_key     text,                                 -- optional human-friendly key from XLSX
  content     jsonb not null default '{}'::jsonb,   -- { pl, bg, hr, ro, mk, sq, en }
  created_at  timestamptz not null default now(),
  unique (project_id, row_index)
);

create index if not exists idx_generator_translations_project
  on public.generator_translations (project_id, row_index);
