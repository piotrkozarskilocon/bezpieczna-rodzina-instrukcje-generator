-- Generator Instrukcji — initial schema (Phase 1.0)
--
-- RLS is OFF intentionally: this app uses hub-issued JWT cookie (NOT Supabase Auth).
-- Access control happens in Next.js API routes that check the JWT before any DB call,
-- and queries always filter by `owner_email` derived from the verified JWT.
-- Service role key is the only credential ever used (server-side only).

create extension if not exists "pgcrypto";

-- Projects: one row per uploaded source PDF / manual being edited.
create table if not exists public.generator_projects (
  id              uuid primary key default gen_random_uuid(),
  owner_email     text not null,
  name            text not null,
  source_pdf_path text,                              -- key in `generator-pdfs` bucket
  source_pdf_size_bytes bigint,
  source_pdf_pages_count int,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_generator_projects_owner
  on public.generator_projects (owner_email, created_at desc);

-- Pages: one row per page in a source PDF.
create table if not exists public.generator_pages (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.generator_projects(id) on delete cascade,
  page_number  int  not null,
  width_mm     numeric,
  height_mm    numeric,
  bitmap_path  text,                                 -- key in `generator-pdfs` bucket
  created_at   timestamptz not null default now(),
  unique (project_id, page_number)
);

create index if not exists idx_generator_pages_project
  on public.generator_pages (project_id, page_number);

-- Blocks: text/image/shape regions on a page, with per-language content.
create table if not exists public.generator_blocks (
  id          uuid primary key default gen_random_uuid(),
  page_id     uuid not null references public.generator_pages(id) on delete cascade,
  type        text not null,                         -- 'text' | 'image' | 'shape' | 'qr'
  x_mm        numeric not null,
  y_mm        numeric not null,
  w_mm        numeric not null,
  h_mm        numeric not null,
  z_index     int     not null default 0,
  content     jsonb   not null default '{}'::jsonb,  -- { pl: "...", bg: "...", ... } or { src: "<bucket key>" }
  lang_default text   not null default 'pl',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_generator_blocks_page
  on public.generator_blocks (page_id, z_index);

-- Auto-bump updated_at on UPDATE.
create or replace function public.generator_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_generator_projects_updated on public.generator_projects;
create trigger trg_generator_projects_updated
  before update on public.generator_projects
  for each row execute function public.generator_set_updated_at();

drop trigger if exists trg_generator_blocks_updated on public.generator_blocks;
create trigger trg_generator_blocks_updated
  before update on public.generator_blocks
  for each row execute function public.generator_set_updated_at();
