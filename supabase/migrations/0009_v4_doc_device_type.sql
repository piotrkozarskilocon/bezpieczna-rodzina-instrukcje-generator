-- Generator Instrukcji v4 — typ dokumentu + typ urządzenia.
--
-- Każdy projekt ma teraz parę (document_type, device_type) która determinuje
-- listę wymaganych sekcji prawnych. Słownik dopuszczalnych wartości pilnowany
-- po stronie aplikacji w lib/v4LegalTemplates.ts — bez CHECK constraintu w
-- bazie, bo lista będzie ewoluować razem z kodem (legal_template_version
-- rośnie wtedy z 'v1' wzwyż).
--
-- Backfill: dotychczasowe projekty zostają z NULL — wizard prosi o uzupełnienie
-- tych pól zanim AI wygeneruje strony.

alter table public.gen4_projects
  add column if not exists document_type           text,
  add column if not exists device_type             text,
  add column if not exists legal_template_version  text default 'v1';

create index if not exists idx_gen4_projects_doc_type
  on public.gen4_projects (document_type, device_type);
