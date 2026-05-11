-- Generator Instrukcji v3 (Edytor strukturalny) — fully isolated from v1/v2.
-- All tables prefixed `gen3_*`. Storage bucket: `gen3-images` (PDFs as
-- reference only, stored alongside).
--
-- Architecture: structured authoring (build pages from templates and
-- elements). PDF source is reference-only; final output is a vector PDF
-- generated from elements. Translations stored per element per language
-- so language switch is just a re-render with different text.
--
-- RLS off (same model as v1/v2) — auth via verified JWT email in API routes.

create extension if not exists "pgcrypto";

-- Projects -----------------------------------------------------------------
create table if not exists public.gen3_projects (
  id                      uuid primary key default gen_random_uuid(),
  owner_email             text not null,
  name                    text not null,
  default_lang            text not null default 'pl',
  reference_pdf_path      text,                                -- optional reference PDF in `gen3-images` bucket
  reference_pdf_size_bytes bigint,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists idx_gen3_projects_owner
  on public.gen3_projects (owner_email, created_at desc);

-- Pages --------------------------------------------------------------------
create table if not exists public.gen3_pages (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.gen3_projects(id) on delete cascade,
  page_number  int  not null,
  width_mm     numeric not null default 76,
  height_mm    numeric not null default 76,
  template     text,                                            -- 'cover' | 'step' | 'warranty_terms' | 'warranty_stamp' | 'contact' | 'blank'
  notes        text,
  created_at   timestamptz not null default now(),
  unique (project_id, page_number)
);

create index if not exists idx_gen3_pages_project
  on public.gen3_pages (project_id, page_number);

-- Elements (atomic units of authoring) -------------------------------------
create table if not exists public.gen3_elements (
  id          uuid primary key default gen_random_uuid(),
  page_id     uuid not null references public.gen3_pages(id) on delete cascade,
  type        text not null,                                    -- 'text' | 'image' | 'line' | 'rect' | 'qr' | 'page_number' | 'callout'
  x_mm        numeric not null,
  y_mm        numeric not null,
  w_mm        numeric not null,
  h_mm        numeric not null,
  z_index     int     not null default 0,
  rotation_deg numeric not null default 0,
  properties  jsonb   not null default '{}'::jsonb,             -- type-specific fields (font, color, src, url, etc.)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_gen3_elements_page
  on public.gen3_elements (page_id, z_index);

-- Images library (per project) ---------------------------------------------
create table if not exists public.gen3_images (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.gen3_projects(id) on delete cascade,
  name        text not null,
  path        text not null,                                    -- key in `gen3-images` bucket
  size_bytes  bigint,
  width_px    int,
  height_px   int,
  created_at  timestamptz not null default now()
);

create index if not exists idx_gen3_images_project
  on public.gen3_images (project_id, created_at desc);

-- Translations (per element per language) ----------------------------------
-- Only text-bearing elements (text, callout) get rows here. The default-lang
-- text lives in gen3_elements.properties; this table is for non-default
-- language overrides + AI/imported translations.
create table if not exists public.gen3_translations (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.gen3_projects(id) on delete cascade,
  element_id      uuid not null references public.gen3_elements(id) on delete cascade,
  language        text not null,                                -- 'bg' | 'en' | 'hr' | 'ro' | 'mk' | 'sq' | ...
  text            text not null,
  is_pinned       boolean not null default false,               -- true = manually edited, won't be overwritten by re-translate
  source          text not null default 'import',              -- 'import' | 'manual' | 'api'
  last_synced_at  timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (element_id, language)
);

create index if not exists idx_gen3_translations_project_lang
  on public.gen3_translations (project_id, language);
create index if not exists idx_gen3_translations_element
  on public.gen3_translations (element_id);

-- Glossary (global, app-level — not per-project) ---------------------------
-- Lists terms that the translation prompt protects (do_not_translate)
-- or has fixed renderings for in specific languages.
create table if not exists public.gen3_glossary (
  id                   uuid primary key default gen_random_uuid(),
  source_term          text not null unique,
  do_not_translate     boolean not null default false,
  locked_translations  jsonb not null default '{}'::jsonb,      -- { bg: "...", en: "...", ... }
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Seed glossary with what we already know from BR/Locon work --------------
insert into public.gen3_glossary (source_term, do_not_translate, notes) values
  ('Locon Watch GOAT', true, 'Brand product name'),
  ('Bezpieczna Rodzina', true, 'Brand'),
  ('Locon', true, 'Company / brand'),
  ('GJD.15', true, 'Model code'),
  ('GJD.16', true, 'Model code'),
  ('GJD.08', true, 'Model code'),
  ('Smartwatch', true, 'Common term, kept in original'),
  ('LOCON WATCH GOAT', true, 'Capitalised brand'),
  ('Locon Sp. z o.o.', true, 'Legal entity name'),
  ('VAT EU PL8521013334', true, 'Tax ID'),
  ('locon.pl', true, 'Domain'),
  ('bezpiecznarodzina.pl', true, 'Domain'),
  ('docs.locon.pl', true, 'Domain'),
  ('loconsafefamily.com', true, 'Domain (foreign)')
on conflict (source_term) do nothing;

-- Auto-bump updated_at -----------------------------------------------------
create or replace function public.gen3_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_gen3_projects_updated on public.gen3_projects;
create trigger trg_gen3_projects_updated
  before update on public.gen3_projects
  for each row execute function public.gen3_set_updated_at();

drop trigger if exists trg_gen3_elements_updated on public.gen3_elements;
create trigger trg_gen3_elements_updated
  before update on public.gen3_elements
  for each row execute function public.gen3_set_updated_at();

drop trigger if exists trg_gen3_translations_updated on public.gen3_translations;
create trigger trg_gen3_translations_updated
  before update on public.gen3_translations
  for each row execute function public.gen3_set_updated_at();

drop trigger if exists trg_gen3_glossary_updated on public.gen3_glossary;
create trigger trg_gen3_glossary_updated
  before update on public.gen3_glossary
  for each row execute function public.gen3_set_updated_at();
