-- Generator Instrukcji v4 — multi-DS support.
-- Replaces the single gen4_projects.design_system column with a per-project
-- list of design systems. One can be marked is_default=true (used as the
-- implicit DS when nothing else is specified).
--
-- The legacy column gen4_projects.design_system stays in place for backward
-- compat (older code that hasn't migrated yet falls back to it). Future
-- migration: copy any non-null legacy value into a row here, then drop column.

create table if not exists public.gen4_design_systems (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.gen4_projects(id) on delete cascade,
  name        text not null,
  content     jsonb not null default '{}'::jsonb,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_gen4_design_systems_project
  on public.gen4_design_systems (project_id, created_at desc);

-- At most one default DS per project. Partial unique index — only enforced
-- when is_default=true so multiple non-default rows are fine.
create unique index if not exists idx_gen4_design_systems_one_default
  on public.gen4_design_systems (project_id)
  where is_default = true;

drop trigger if exists trg_gen4_design_systems_updated on public.gen4_design_systems;
create trigger trg_gen4_design_systems_updated
  before update on public.gen4_design_systems
  for each row execute function public.gen4_set_updated_at();
