-- Generator Instrukcji v4 — synchronizacja gen4_images z Anthropic Files API.
--
-- Galeria obrazkow projektu nie byla wczesniej widoczna dla AI — Claude widzial
-- tylko reference docs (PDF/CSV/TXT) ale nie obrazki z biblioteki. Po tej
-- migracji obrazki sa uploadowane do Anthropic Files i wpinane jako attachments
-- (image blocks) w wywolaniach AI.
--
-- anthropic_file_id moze byc null gdy:
--   1. Klucz API niedostepny przy uploadzie (sync robiony lazy przy AI call)
--   2. Sync nie powiodl sie (lazy retry przy nastepnym AI call)
--   3. Obrazek wgrany przed wdrozeniem tej feature (backfill on-demand)

alter table public.gen4_images
  add column if not exists anthropic_file_id text;

-- Index dla szybkiego sprawdzenia ktore obrazki czekaja na sync.
create index if not exists gen4_images_anthropic_sync_idx
  on public.gen4_images (project_id)
  where anthropic_file_id is null;
