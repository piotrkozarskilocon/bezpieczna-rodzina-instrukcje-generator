-- Generator Instrukcji v4 — explicit page titles + Table of Contents template.
--
-- Każda strona poza okładką (cover) MUSI mieć krótki tytuł — wyświetlamy go w
-- bocznym pasku edytora, używamy w spisie treści (template=toc), a AI zapełnia
-- to pole przy generacji / Apply DS. Dla cover tytuł jest opcjonalny (NULL).
--
-- Dodajemy też nowy template 'toc' (Table of Contents). Generator wstawia
-- stronę z tym template tuż po okładce, a edytor i Apply DS znają jej rolę.
--
-- Backfill: dotychczasowe strony bez tytułu zostają z NULL — użytkownik może
-- je nazwać ręcznie lub uruchomić ponownie generację / Apply DS.

alter table public.gen4_pages
  add column if not exists title text;

-- Spis treści jako pełnoprawny template — pozwala filtrować i trzymać
-- wymóg "po cover MUSI być toc" w warstwie aplikacji bez magicznych stringów.
-- (Kolumna template nie ma constraintu CHECK, więc wystarczy dodać go w
--  zbiorze VALID_TEMPLATES po stronie kodu.)

create index if not exists idx_gen4_pages_title
  on public.gen4_pages (project_id, page_number)
  where title is not null;
