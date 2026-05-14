/**
 * Galeria obrazkow projektu — synchronizacja z Anthropic Files API.
 *
 * Obrazki uploadowane przez user'a do biblioteki projektu (gen4_images) musza
 * byc widoczne dla Claude w wywolaniach AI (apply-design, ai-edit, watermark
 * z gallery). Inaczej user pisze "uzyj zdjecia L47.png z galerii" a AI go
 * nie ma — nigdy nie zobaczy obrazka.
 *
 * Strategia: lazy sync — przy KAZDYM AI call sprawdzamy ktore obrazki projektu
 * nie maja jeszcze anthropic_file_id, sciagamy bytes z Supabase Storage i
 * uploadujemy do Anthropic Files. Wynik zapisujemy do bazy zeby kolejny call
 * od razu uzyl cached file_id. Pierwszy AI call po wgraniu obrazka jest
 * troche wolniejszy (~1-3s per nowy obrazek), kolejne sa instant.
 *
 * Alternatywa "sync przy POST" tez jest, ale lazy pokrywa starsze obrazki
 * wgrane przed wdrozeniem feature + retry gdy upload do Anthropic failuje
 * (np. klucz API tymczasowo niedostepny).
 */

import { toFile } from "@anthropic-ai/sdk/core/uploads";
import { getAnthropicClient } from "@/lib/anthropic";
import { getSupabaseAdmin } from "@/lib/supabase";

const BUCKET = "gen4-images";

export interface ProjectImage {
  id: string;
  name: string;
  path: string;
  mime_type: string | null;
  description: string | null;
  preferred_page_id: string | null;
  anthropic_file_id: string | null;
}

/** Pobiera obrazki projektu z bazy (bez sync). */
async function loadProjectImagesRaw(projectId: string): Promise<ProjectImage[]> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("gen4_images")
    .select("id, name, path, mime_type, description, preferred_page_id, anthropic_file_id")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  return (data ?? []) as ProjectImage[];
}

/** Lazy upload pojedynczego obrazka do Anthropic Files API. Aktualizuje wiersz
 *  w gen4_images z otrzymanym file_id. Zwraca nowy file_id lub null gdy upload
 *  failuje (nie blokuje AI call — Claude po prostu nie zobaczy tego obrazka). */
async function syncImageToAnthropic(img: ProjectImage): Promise<string | null> {
  if (img.anthropic_file_id) return img.anthropic_file_id;
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const sb = getSupabaseAdmin();
  const { data: download, error: dlErr } = await sb.storage.from(BUCKET).download(img.path);
  if (dlErr || !download) {
    console.warn(`[v4Images] download ${img.path} failed:`, dlErr);
    return null;
  }

  try {
    const buf = Buffer.from(await download.arrayBuffer());
    const mime = img.mime_type || "image/png";
    const client = getAnthropicClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const upload: any = await (client as any).beta.files.upload({
      file: await toFile(new Blob([new Uint8Array(buf)], { type: mime }), img.name),
    });
    const fileId = upload?.id as string | undefined;
    if (!fileId) return null;

    await sb.from("gen4_images").update({ anthropic_file_id: fileId }).eq("id", img.id);
    return fileId;
  } catch (err) {
    console.warn(`[v4Images] anthropic upload ${img.name} failed:`, err);
    return null;
  }
}

/** Lista obrazkow projektu z anthropic_file_id (po lazy sync). Obrazki ktore
 *  nie udalo sie zsynchronizowac sa pomijane — AI po prostu ich nie zobaczy
 *  ale to nie blokuje calego call'a. */
export async function loadProjectImagesForAi(projectId: string): Promise<Array<ProjectImage & { anthropic_file_id: string }>> {
  const images = await loadProjectImagesRaw(projectId);
  if (images.length === 0) return [];

  const synced = await Promise.all(
    images.map(async (img) => {
      if (img.anthropic_file_id) return img;
      const fileId = await syncImageToAnthropic(img);
      return fileId ? { ...img, anthropic_file_id: fileId } : null;
    }),
  );
  return synced.filter((img): img is ProjectImage & { anthropic_file_id: string } => img !== null && !!img.anthropic_file_id);
}

/** Zwraca anthropic_file_id obrazkow do dorzucenia jako attachments do callClaude. */
export function getImageAttachmentFileIds(images: Array<ProjectImage & { anthropic_file_id: string }>): string[] {
  return images.map((img) => img.anthropic_file_id);
}

/** Renderuje sekcje system prompt o obrazkach z biblioteki — Claude musi
 *  wiedziec ze ma do nich dostep + jak je zaadresowac (image_id z gen4_images
 *  uzywany w properties elementu image: { image_id: "..." }). */
export function renderImagesGalleryForPrompt(images: Array<ProjectImage & { anthropic_file_id: string }>): string {
  if (images.length === 0) return "";
  const lines: string[] = [
    "🖼️ BIBLIOTEKA OBRAZKOW PROJEKTU:",
    "Ponizsze obrazki sa zalaczone jako image blocks — MOZESZ je zobaczyc.",
    "Uzywaj ich gdy user mowi 'zdjecie X', 'logo', 'watermark z tego zdjecia'.",
    "W generowanym layoucie wstawiaj jako element 'image' z properties.image_id =",
    "konkretne ID ponizej. Dla watermarka ustaw opacity 0.10-0.20.",
    "",
    "Lista obrazkow (image_id → nazwa pliku → opis):",
  ];
  for (const img of images) {
    const desc = img.description ? ` — ${img.description}` : "";
    lines.push(`- ${img.id}  →  ${img.name}${desc}`);
  }
  return lines.join("\n");
}
