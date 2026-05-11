-- Generator Instrukcji v4 (AI-first) — fully isolated from v1/v2/v3.
-- Schema mirrors v3 (gen3_*) but adds AI-specific metadata and history.
-- Glossary is shared with v3 (gen3_glossary, global app-level).
--
-- Bucket: `gen4-images`. Routes: /generator-instrukcji/ai/...

create extension if not exists "pgcrypto";

-- Projects ----------------------------------------------------------------
create table if not exists public.gen4_projects (
  id                       uuid primary key default gen_random_uuid(),
  owner_email              text not null,
  name                     text not null,
  default_lang             text not null default 'pl',
  status                   text not null default 'draft', -- 'draft' | 'generating' | 'ready' | 'error'
  -- Originally-supplied generation inputs so we can re-run / re-generate.
  -- Shape: { model_code, model_name, features: [{key,label,enabled}], step_count, warranty_mode, ... }
  ai_input                 jsonb not null default '{}'::jsonb,
  -- Lightweight log of generation attempts (model used, tokens, error if any).
  ai_log                   jsonb not null default '[]'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_gen4_projects_owner
  on public.gen4_projects (owner_email, created_at desc);

-- Pages -------------------------------------------------------------------
create table if not exists public.gen4_pages (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.gen4_projects(id) on delete cascade,
  page_number  int  not null,
  width_mm     numeric not null default 76,
  height_mm    numeric not null default 76,
  template     text,
  notes        text,
  created_at   timestamptz not null default now(),
  unique (project_id, page_number)
);

create index if not exists idx_gen4_pages_project
  on public.gen4_pages (project_id, page_number);

-- Elements ----------------------------------------------------------------
create table if not exists public.gen4_elements (
  id           uuid primary key default gen_random_uuid(),
  page_id      uuid not null references public.gen4_pages(id) on delete cascade,
  type         text not null,
  x_mm         numeric not null,
  y_mm         numeric not null,
  w_mm         numeric not null,
  h_mm         numeric not null,
  z_index      int     not null default 0,
  rotation_deg numeric not null default 0,
  properties   jsonb   not null default '{}'::jsonb,
  -- Marker for elements emitted by the AI (vs. user-added) — useful for
  -- regenerate/diff flows ("regenerate just AI elements, keep manual ones").
  origin       text not null default 'manual', -- 'ai' | 'manual'
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_gen4_elements_page
  on public.gen4_elements (page_id, z_index);

-- Images library ----------------------------------------------------------
create table if not exists public.gen4_images (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.gen4_projects(id) on delete cascade,
  name        text not null,
  path        text not null,
  size_bytes  bigint,
  width_px    int,
  height_px   int,
  created_at  timestamptz not null default now()
);

create index if not exists idx_gen4_images_project
  on public.gen4_images (project_id, created_at desc);

-- Translations ------------------------------------------------------------
create table if not exists public.gen4_translations (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.gen4_projects(id) on delete cascade,
  element_id      uuid not null references public.gen4_elements(id) on delete cascade,
  language        text not null,
  text            text not null,
  is_pinned       boolean not null default false,
  source          text not null default 'ai', -- 'ai' | 'manual' | 'import'
  last_synced_at  timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (element_id, language)
);

create index if not exists idx_gen4_translations_project_lang
  on public.gen4_translations (project_id, language);

-- AI conversation history (side-panel chat per project) -------------------
create table if not exists public.gen4_ai_history (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.gen4_projects(id) on delete cascade,
  role         text not null, -- 'user' | 'assistant' | 'system'
  content      text not null,
  -- For assistant turns: structured response (e.g. element diff applied).
  structured   jsonb,
  -- Telemetry: which model, how many tokens, latency.
  model        text,
  input_tokens  int,
  output_tokens int,
  latency_ms   int,
  created_at   timestamptz not null default now()
);

create index if not exists idx_gen4_ai_history_project
  on public.gen4_ai_history (project_id, created_at);

-- Triggers ---------------------------------------------------------------
create or replace function public.gen4_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_gen4_projects_updated on public.gen4_projects;
create trigger trg_gen4_projects_updated
  before update on public.gen4_projects
  for each row execute function public.gen4_set_updated_at();

drop trigger if exists trg_gen4_elements_updated on public.gen4_elements;
create trigger trg_gen4_elements_updated
  before update on public.gen4_elements
  for each row execute function public.gen4_set_updated_at();

drop trigger if exists trg_gen4_translations_updated on public.gen4_translations;
create trigger trg_gen4_translations_updated
  before update on public.gen4_translations
  for each row execute function public.gen4_set_updated_at();
