-- Generator Instrukcji v2 (Edytor tabelaryczny) — schema kept independent of v1
-- so the two editors can evolve without ever stepping on each other.
-- All tables prefixed `gen2_*` (v1 = `generator_*`). Storage bucket: `gen2-pdfs`.
--
-- RLS off (same model as v1) — auth lives in API routes via verified JWT email.

create extension if not exists "pgcrypto";

create table if not exists public.gen2_projects (
  id                      uuid primary key default gen_random_uuid(),
  owner_email             text not null,
  name                    text not null,
  source_pdf_path         text,
  source_pdf_size_bytes   bigint,
  source_pdf_pages_count  int,
  current_page            int default 1,            -- v2-specific: last page user was on
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists idx_gen2_projects_owner
  on public.gen2_projects (owner_email, created_at desc);

create table if not exists public.gen2_pages (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.gen2_projects(id) on delete cascade,
  page_number  int  not null,
  width_mm     numeric,
  height_mm    numeric,
  bitmap_path  text,
  created_at   timestamptz not null default now(),
  unique (project_id, page_number)
);

create index if not exists idx_gen2_pages_project
  on public.gen2_pages (project_id, page_number);

create table if not exists public.gen2_blocks (
  id           uuid primary key default gen_random_uuid(),
  page_id      uuid not null references public.gen2_pages(id) on delete cascade,
  type         text not null,
  x_mm         numeric not null,
  y_mm         numeric not null,
  w_mm         numeric not null,
  h_mm         numeric not null,
  z_index      int     not null default 0,
  content      jsonb   not null default '{}'::jsonb,
  lang_default text    not null default 'pl',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_gen2_blocks_page
  on public.gen2_blocks (page_id, z_index);

create table if not exists public.gen2_translations (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.gen2_projects(id) on delete cascade,
  row_index   int  not null,
  row_key     text,
  content     jsonb not null default '{}'::jsonb,   -- { pl, bg, hr, ro, mk, sq, en }
  page_hint   int,                                  -- v2-specific: parsed local page number from XLSX
  created_at  timestamptz not null default now(),
  unique (project_id, row_index)
);

create index if not exists idx_gen2_translations_project
  on public.gen2_translations (project_id, row_index);

create or replace function public.gen2_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_gen2_projects_updated on public.gen2_projects;
create trigger trg_gen2_projects_updated
  before update on public.gen2_projects
  for each row execute function public.gen2_set_updated_at();

drop trigger if exists trg_gen2_blocks_updated on public.gen2_blocks;
create trigger trg_gen2_blocks_updated
  before update on public.gen2_blocks
  for each row execute function public.gen2_set_updated_at();
