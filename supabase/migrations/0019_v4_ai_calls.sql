-- Generator Instrukcji v4 — pelna historia wywolan AI (debug panel).
--
-- Pozwala uzytkownikowi sledzic co dokladnie generator wysyla do Claude:
-- - context: czy to byla edycja calej strony, jednego elementu, applikacja
--   stylu z innej strony, generacja szkieletu, tlumaczenie itd.
-- - user_instruction: co user napisal w UI (np. "popraw kontrast")
-- - system_prompt i user_prompt: dokladnie co generator zbudowal jako prompt
-- - response_text: surowa odpowiedz Claude (przed parsowaniem JSON)
-- - model, tokens, duration: dla weryfikacji kosztow i porownywania modeli
--
-- Indeks po (project_id, created_at desc) zeby panel debug ladowal sie szybko.

create table if not exists public.gen4_ai_calls (
  id                       uuid primary key default gen_random_uuid(),
  project_id               uuid not null references public.gen4_projects(id) on delete cascade,
  -- Opcjonalne — gdy call dotyczy konkretnej strony/elementu.
  page_id                  uuid,
  element_id               uuid,
  -- Endpoint ktory zostal wywolany, np. "ai-edit", "ai-edit-stream",
  -- "ai-fix-element", "apply-style", "apply-design", "auto-populate",
  -- "ai-notes/suggest", "translate", "compliance-check".
  endpoint                 text not null,
  -- "page" | "element" | "project" | "global" — co bylo kontekstem operacji.
  context_type             text not null,
  -- Treso polecenia od usera (textarea w UI). Moze byc null gdy generator
  -- sam wymyslal prompt (np. apply-style bez instrukcji).
  user_instruction         text,
  -- Pelne prompty PRZED i PO ewentualnej edycji uzytkownika.
  system_prompt            text,
  user_prompt              text,
  -- Czy user edytowal prompt przed wyslaniem (override generator-built).
  prompt_edited_by_user    boolean not null default false,
  -- Konfiguracja wywolania.
  model                    text,
  max_tokens               integer,
  temperature              numeric,
  -- Wynik.
  response_text            text,
  -- Wypelnione gdy wywolanie sie nie powiodlo (parse error, API error itd.).
  error                    text,
  -- Telemetria.
  tokens_in                integer,
  tokens_out               integer,
  cache_creation_tokens    integer,
  cache_read_tokens        integer,
  duration_ms              integer,
  user_email               text,
  created_at               timestamptz not null default now()
);

create index if not exists idx_gen4_ai_calls_project
  on public.gen4_ai_calls (project_id, created_at desc);

create index if not exists idx_gen4_ai_calls_page
  on public.gen4_ai_calls (page_id, created_at desc)
  where page_id is not null;

create index if not exists idx_gen4_ai_calls_element
  on public.gen4_ai_calls (element_id, created_at desc)
  where element_id is not null;
