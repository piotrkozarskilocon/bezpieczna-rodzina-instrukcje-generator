-- Generator Instrukcji v4 — translation memory (globalna).
--
-- AI pamięta jak wcześniej przetłumaczył dany fragment i używa tego samego
-- tłumaczenia w kolejnych projektach. Dzięki temu terminologia jest spójna
-- między dokumentami (np. 'Locon Watch' zawsze tłumaczy się tak samo, nazwy
-- przycisków SOS są identyczne).
--
-- source_lang zawsze 'pl' w obecnej fazie (jedyny źródłowy w generatorze).
-- target_lang z SUPPORTED_LANGS w v4Translate.ts.
-- source_text — pełny tekst PL elementu. Hash używamy do szybkiego lookup
-- bo PostgREST nie ma natywnego full-text na text (.eq() działa, ale tylko
-- exact match — przy długich tekstach zaleca się index B-tree co i tak robimy).
--
-- owner_email pozwala filtrować "moje memory" gdy będą inni użytkownicy
-- (dziś tylko Piotr, ale safe).

create table if not exists public.gen4_translation_memory (
  id            uuid primary key default gen_random_uuid(),
  owner_email   text not null,
  source_lang   text not null default 'pl',
  target_lang   text not null,
  source_text   text not null,
  target_text   text not null,
  used_count    int not null default 1,
  -- Skrótowy fingerprint dla szybkiego lookup. Generujemy md5 po stronie
  -- aplikacji (JS), żeby było deterministycznie i nie wymagało extension.
  source_hash   text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_gen4_tm_lookup
  on public.gen4_translation_memory (owner_email, target_lang, source_hash);

-- Per pair owner_email + target_lang + source_hash trzymamy jeden wiersz
-- (ostatnio użyte tłumaczenie). Konflikt = update used_count.
create unique index if not exists idx_gen4_tm_unique
  on public.gen4_translation_memory (owner_email, target_lang, source_hash);

drop trigger if exists trg_gen4_tm_updated on public.gen4_translation_memory;
create trigger trg_gen4_tm_updated
  before update on public.gen4_translation_memory
  for each row execute function public.gen4_set_updated_at();
