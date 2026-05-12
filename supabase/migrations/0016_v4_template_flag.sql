-- Generator Instrukcji v4 — flagi template/preset.
--
-- is_template: projekt oznaczony jako template służy jako baza dla nowych
-- projektów (alternatywa do generacji AI od zera). Klon templatu zachowuje
-- wszystkie strony, elementy, design systems, notatki project-scoped i
-- reference docs (reuse anthropic_file_id).

alter table public.gen4_projects
  add column if not exists is_template boolean not null default false;

create index if not exists idx_gen4_projects_templates
  on public.gen4_projects (owner_email, is_template)
  where is_template = true;
