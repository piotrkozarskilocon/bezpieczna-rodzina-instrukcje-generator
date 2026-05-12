-- Generator Instrukcji v4 — zatwierdzenie projektu.
--
-- approved_by + approved_at — gdy ustawione, PDF eksport może dodać
-- stopkę 'Zatwierdzono: [imię] [data]' jako oznaczenie że dokument jest
-- gotowy do druku.

alter table public.gen4_projects
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz;
