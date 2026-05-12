-- Generator Instrukcji v4 — log post-AI edits (do auto-suggest notes).
--
-- Po każdej generacji AI (auto-populate, ai-edit, apply-design) user
-- zwykle robi 1-3 ręczne poprawki. Te poprawki to sygnał: AI generuje
-- coś co nie pasuje, trzeba dodać regułkę do AI Notebook.
--
-- Logujemy: czas, project_id, page_id, opcjonalnie element_id, opis
-- co się zmieniło (before/after w jsonb), czy zmiana była ręczna (Ctrl+klik
-- w properties) czy via Assistant AI.

create table if not exists public.gen4_post_edit_log (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.gen4_projects(id) on delete cascade,
  page_id         uuid references public.gen4_pages(id) on delete cascade,
  element_id      uuid,  -- nie FK bo elements znikają przy replace
  owner_email     text not null,
  -- 'manual' = user edytował properties w panelu / przeciągnął element
  -- 'ai_edit' = wynik /pages/[id]/ai-edit (też zmiana ale AI)
  -- 'undo' = przywrócenie poprzedniego stanu
  source          text not null check (source in ('manual', 'ai_edit', 'undo')),
  -- Krótki opis ("element text 'Krok 1' przeniesiony z (5,5) do (10,7)")
  description     text,
  -- before/after — opcjonalne snapshoty diff'a do późniejszej analizy AI
  before_state    jsonb,
  after_state     jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists idx_gen4_post_edit_log_owner
  on public.gen4_post_edit_log (owner_email, created_at desc);

create index if not exists idx_gen4_post_edit_log_project
  on public.gen4_post_edit_log (project_id, created_at desc);
