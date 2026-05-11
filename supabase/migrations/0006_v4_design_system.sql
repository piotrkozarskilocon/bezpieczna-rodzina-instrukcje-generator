-- Generator Instrukcji v4 — design_system column.
-- Stores an optional per-project design system (colors, typography, spacing,
-- page templates, brand voice) that the AI prompt builders weave into every
-- generation/edit/translate prompt. Lives in JSONB so the schema can evolve
-- without migrations.

alter table public.gen4_projects
  add column if not exists design_system jsonb;

comment on column public.gen4_projects.design_system is
  'Optional per-project design system: { colors, typography, spacing, page, templates, brand_voice }. Fed to AI prompts as visual context.';
