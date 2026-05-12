-- Generator Instrukcji v4 — rozszerzenie typów plików referencyjnych.
--
-- Bucket `gen4-reference-docs` byl pierwotnie utworzony z restrykcja MIME na
-- application/pdf, przez co direct PUT do storage dla DOCX/XLSX/TXT/MD/CSV/JSON
-- zwracal HTTP 400. Rozszerzamy liste o wszystkie formaty ktore obsluguje
-- lib/v4FileExtract.ts.
--
-- Limit rozmiaru 25 MB (Anthropic Files API cap) ustawiamy tez tutaj zeby
-- bucket sam odrzucal za duze pliki przy direct upload (bez zuzywania tokenu
-- API ani slotow w storage).

update storage.buckets
set
  allowed_mime_types = array[
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    -- starsze formaty Office (rzadkie ale moga sie pojawic z drag&drop)
    'application/msword',
    'application/vnd.ms-excel',
    -- fallback gdy przegladarka wysyla 'application/octet-stream' (zdarza sie
    -- z drag&drop niektorych OS / przegladarek dla DOCX/XLSX bez rejestracji)
    'application/octet-stream'
  ],
  file_size_limit = 26214400 -- 25 MB
where id = 'gen4-reference-docs';
