/**
 * Endpoint diagnostyczny — listuje wszystkie attachments ktore poszlyby do AI
 * dla danego projektu, razem z mime_type/filename z Anthropic Files i jaki
 * blockType zostalby wybrany przez lib/anthropic.ts. Bez wywolywania AI.
 *
 * Uzyj: GET /api/v4/debug/attachments?projectId=<uuid>
 * Wynik to JSON; pokazuje dokladnie ktory plik nie pasuje do heurystyki
 * image/document zanim trafi do Anthropic messages.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authenticate } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAnthropicClient } from "@/lib/anthropic";
import { loadReferenceDocs, getAttachmentFileIds } from "@/lib/v4ReferenceDocs";
import { loadProjectImagesForAi, getImageAttachmentFileIds } from "@/lib/v4Images";

export const runtime = "nodejs";
export const maxDuration = 60;

interface AttachmentReport {
  source: "reference_doc" | "gallery_image";
  source_id: string;
  source_name: string;
  anthropic_file_id: string | null;
  anthropic_mime_type: string | null;
  anthropic_filename: string | null;
  computed_block_type: "document" | "image" | null;
  retrieve_error: string | null;
}

function classify(mime: string, filename: string): "document" | "image" {
  const isImageByExt = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filename);
  const isDocByExt = /\.(pdf|csv|txt|md|json|docx?|xlsx?)$/i.test(filename);
  const isImageByMime = mime.startsWith("image/");
  if (isImageByExt) return "image";
  if (isDocByExt) return "document";
  if (isImageByMime) return "image";
  return "document";
}

export async function GET(request: NextRequest) {
  const auth = await authenticate(request);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const projectId = request.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "missing ?projectId=<uuid>" }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  const { data: project } = await sb
    .from("gen4_projects")
    .select("owner_email")
    .eq("id", projectId)
    .single();
  if (!project || project.owner_email !== auth.email) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const refDocs = await loadReferenceDocs(projectId);
  const galleryImages = await loadProjectImagesForAi(projectId);
  const refFileIds = getAttachmentFileIds(refDocs);
  const imgFileIds = getImageAttachmentFileIds(galleryImages);
  const allFileIds = [...refFileIds, ...imgFileIds];

  const refByFileId = new Map(refDocs.map((d) => [d.anthropic_file_id, d]));
  const imgByFileId = new Map(galleryImages.map((i) => [i.anthropic_file_id, i]));

  const client = getAnthropicClient();
  const reports: AttachmentReport[] = await Promise.all(
    allFileIds.map(async (fileId): Promise<AttachmentReport> => {
      const refDoc = refByFileId.get(fileId);
      const img = imgByFileId.get(fileId);
      const base: AttachmentReport = {
        source: refDoc ? "reference_doc" : "gallery_image",
        source_id: refDoc?.id ?? img?.id ?? "",
        source_name: refDoc?.name ?? img?.name ?? "",
        anthropic_file_id: fileId,
        anthropic_mime_type: null,
        anthropic_filename: null,
        computed_block_type: null,
        retrieve_error: null,
      };
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const meta: any = await (client as any).beta.files.retrieveMetadata(fileId);
        base.anthropic_mime_type = (meta?.mime_type ?? null) as string | null;
        base.anthropic_filename = (meta?.filename ?? null) as string | null;
        base.computed_block_type = classify(meta?.mime_type ?? "", meta?.filename ?? "");
      } catch (err: unknown) {
        base.retrieve_error = err instanceof Error ? err.message : String(err);
      }
      return base;
    }),
  );

  // Sortowane po source_name dla czytelnosci
  reports.sort((a, b) => a.source_name.localeCompare(b.source_name));

  const summary = {
    project_id: projectId,
    total_attachments: reports.length,
    reference_docs_count: refDocs.length,
    gallery_images_count: galleryImages.length,
    block_types: reports.reduce<Record<string, number>>((acc, r) => {
      const key = r.computed_block_type ?? "error";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    suspicious: reports.filter(
      (r) =>
        r.retrieve_error !== null ||
        // PDF/CSV oznaczone jako image lub odwrotnie = bug w klasyfikacji
        (r.computed_block_type === "image" && /\.(pdf|csv|txt|docx?|xlsx?)$/i.test(r.anthropic_filename ?? "")) ||
        (r.computed_block_type === "document" && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(r.anthropic_filename ?? "")),
    ),
  };

  return NextResponse.json({ summary, reports });
}
