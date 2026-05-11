-- Generator Instrukcji v4 — opisy semantyczne dla obrazków projektu.
--
-- AI używa opisu ("front zegarka", "ekran logowania w aplikacji",
-- "proces ładowania step 2") by zdecydować na której stronie wstawić dany
-- obrazek. preferred_page_id pozwala wskazać preferowaną stronę gdy upload
-- jest robiony z poziomu Assistant AI konkretnej strony — AI go uszanuje.
--
-- mime_type i thumbnail_path ułatwią renderowanie miniatury w bibliotece UI
-- bez pobierania pełnego pliku.

alter table public.gen4_images
  add column if not exists description       text,
  add column if not exists preferred_page_id uuid references public.gen4_pages(id) on delete set null,
  add column if not exists mime_type         text,
  add column if not exists uploaded_by       text;

create index if not exists idx_gen4_images_preferred_page
  on public.gen4_images (preferred_page_id)
  where preferred_page_id is not null;
