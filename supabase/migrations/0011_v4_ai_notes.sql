-- Generator Instrukcji v4 — AI Notebook (lessons learned).
--
-- Notatki/regułki które AI ma stosować w każdej generacji. Każda notatka
-- ma scope określający kiedy ma być aktywna:
--   - 'global'        → zawsze, dla wszystkich projektów
--   - 'document_type' → tylko dla projektów z konkretnym typem dokumentu
--   - 'device_type'   → tylko dla konkretnego typu urządzenia
--   - 'project'       → tylko dla konkretnego projektu (project_id FK)
--
-- Po każdej generacji licznik used_count++, dzięki czemu można sortować
-- notatki po użyteczności (najczęściej stosowane = najwartościowsze).
-- Toggle is_active = false zachowuje notatkę w bazie (audit), ale wyłącza
-- jej injekcję do promptów.

create table if not exists public.gen4_ai_notes (
  id           uuid primary key default gen_random_uuid(),
  owner_email  text not null,
  scope        text not null check (scope in ('global', 'document_type', 'device_type', 'project')),
  -- Wartość scope-specific. Dla 'global' = null. Dla 'document_type' to typ
  -- dokumentu z DOCUMENT_TYPES (np. 'qsg_full'). Dla 'device_type' to typ
  -- urządzenia z DEVICE_TYPES. Dla 'project' to uuid projektu (jako text by
  -- nie blokować usunięcia projektu — notatka zostaje w archiwum).
  scope_value  text,
  -- Treść notatki — krótka regułka po polsku, max ~500 znaków. Trafia
  -- bezpośrednio do system prompta jako bullet.
  content      text not null,
  -- Opcjonalny kontekst (kiedy/dlaczego ta regułka powstała). Dla audytu.
  why          text,
  is_active    boolean not null default true,
  used_count   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_gen4_ai_notes_owner
  on public.gen4_ai_notes (owner_email, is_active, scope);

create index if not exists idx_gen4_ai_notes_scope_value
  on public.gen4_ai_notes (scope, scope_value)
  where is_active = true;

drop trigger if exists trg_gen4_ai_notes_updated on public.gen4_ai_notes;
create trigger trg_gen4_ai_notes_updated
  before update on public.gen4_ai_notes
  for each row execute function public.gen4_set_updated_at();
