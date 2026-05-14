-- Generator Instrukcji v4 — gen4_ai_calls.project_id nullable.
--
-- Dotychczas project_id NOT NULL — uniemozliwialo to logowanie cross-project
-- endpointow takich jak /api/v4/ai-notes/suggest (analizator wzorcow w
-- edycjach uzytkownika, dziala na ALL projektach tego usera, nie ma jednego
-- konkretnego project_id).
--
-- Po tej migracji ai-notes/suggest moze logowac normalnie do gen4_ai_calls
-- (project_id = null), reszta endpointow (per-page/element/project) dziala
-- bez zmian.

alter table public.gen4_ai_calls
  alter column project_id drop not null;
