-- Generator Instrukcji v4 — long-running jobs (Faza 5 z deep research).
--
-- Workaround dla Vercel Hobby 60s function cap. Job worker dziala w Supabase
-- Edge Function (Deno, 150s timeout, free do 500K invocations/mc) i odpala
-- N wywolan AI sekwencyjnie. Frontend zamiast petli client-side robi:
--   1. POST /api/v4/jobs {type, project_id, params} → zwraca jobId
--   2. Polling GET /api/v4/jobs/[id]/ co 2s — czyta status + progress
--   3. Gdy status='completed' → reload danych
--
-- Job types (na razie 1, dodawac w przyszlosci):
--   - apply_ds_all: zastosuj design system do wszystkich stron projektu
--     params: { ds_id: uuid, model?: string, instruction?: string }
--
-- W przyszlosci:
--   - translate_all: tlumaczenie projektu na wszystkie jezyki
--   - apply_style_all: zastosuj styl strony X do pozostalych
--   - validate_all: lint calego projektu
--   - export_pdf: generacja PDF (dla wielkich projektow)

create table if not exists public.gen4_jobs (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.gen4_projects(id) on delete cascade,
  type            text not null check (type in (
    'apply_ds_all',
    'translate_all',
    'apply_style_all',
    'validate_all',
    'export_pdf'
  )),
  status          text not null default 'queued' check (status in (
    'queued', 'running', 'completed', 'failed', 'cancelled'
  )),
  -- Progress jsonb dla per-page tracking. Format:
  --   { done: 3, total: 14, current_step: "Strona 4 — Bezpieczeństwo", errors: [...] }
  progress        jsonb not null default '{"done":0,"total":0}'::jsonb,
  params          jsonb not null default '{}'::jsonb,
  result          jsonb,
  error           text,
  user_email      text,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz
);

create index if not exists gen4_jobs_project_idx
  on public.gen4_jobs (project_id, created_at desc);

create index if not exists gen4_jobs_status_idx
  on public.gen4_jobs (status, created_at)
  where status in ('queued', 'running');
