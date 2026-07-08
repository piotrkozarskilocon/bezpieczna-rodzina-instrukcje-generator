import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import type { ZodType } from "zod";
import { parseJsonFromAi } from "../anthropic";

export const V5_GEMINI_PRO = "gemini-2.5-pro";
export const V5_GEMINI_FLASH = "gemini-2.5-flash";

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY nie ustawiony");
  return key;
}

export interface UploadedFile {
  uri: string;
  mimeType: string;
  name: string;
}

/** Upload pliku do Gemini Files API i czekanie aż będzie ACTIVE.
 *  Obsługuje PDF/obrazy/wideo do 2 GB — jednolita ścieżka dla wszystkich plików. */
export async function uploadToGemini(
  filePath: string,
  mimeType: string,
  displayName: string
): Promise<UploadedFile> {
  const manager = new GoogleAIFileManager(apiKey());
  const uploaded = await manager.uploadFile(filePath, { mimeType, displayName });
  let file = uploaded.file;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (file.state === FileState.PROCESSING) {
    if (Date.now() > deadline) throw new Error(`Gemini file processing timeout: ${displayName}`);
    await new Promise((r) => setTimeout(r, 3000));
    file = await manager.getFile(file.name);
  }
  if (file.state !== FileState.ACTIVE) {
    throw new Error(`Gemini file state=${file.state} dla ${displayName}`);
  }
  return { uri: file.uri, mimeType: file.mimeType, name: file.name };
}

export interface GeminiFileCallOpts<T> {
  model?: string;
  system: string;
  user: string;
  files?: UploadedFile[];
  schema?: ZodType<T>;
  maxOutputTokens?: number;
}

export interface GeminiFileCallResult<T> {
  parsed?: T;
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** Wywołanie Gemini z plikami (fileData). JSON wymuszany promptem i walidowany
 *  Zod-em; przy niezgodności jedna poprawka z komunikatem błędu. Deep-nested
 *  schematy są zbyt złożone dla responseSchema (podzbiór OpenAPI), stąd parse+retry. */
export async function callGeminiWithFiles<T = unknown>(
  opts: GeminiFileCallOpts<T>
): Promise<GeminiFileCallResult<T>> {
  const genAi = new GoogleGenerativeAI(apiKey());
  const model = genAi.getGenerativeModel({
    model: opts.model ?? V5_GEMINI_PRO,
    systemInstruction: opts.system,
    generationConfig: {
      temperature: 0,
      maxOutputTokens: opts.maxOutputTokens ?? 32768,
      responseMimeType: opts.schema ? "application/json" : undefined,
    },
  });

  const fileParts = (opts.files ?? []).map((f) => ({
    fileData: { fileUri: f.uri, mimeType: f.mimeType },
  }));

  const attempt = async (userText: string) => {
    const res = await model.generateContent([...fileParts, { text: userText }]);
    const text = res.response.text();
    const usage = res.response.usageMetadata;
    return {
      text,
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  };

  let last = await attempt(opts.user);
  if (!opts.schema) return { ...last, parsed: undefined };

  for (let i = 0; i < 2; i++) {
    try {
      const raw = parseJsonFromAi<unknown>(last.text);
      const parsed = opts.schema.parse(raw);
      return { ...last, parsed };
    } catch (err) {
      if (i === 1) throw new Error(`Gemini: niepoprawny JSON po retry: ${String(err).slice(0, 500)}`);
      const fix =
        `${opts.user}\n\nTwoja poprzednia odpowiedź nie przeszła walidacji schematu:\n` +
        `${String(err).slice(0, 1500)}\n\nPopraw i zwróć WYŁĄCZNIE poprawny JSON.`;
      last = await attempt(fix);
    }
  }
  throw new Error("unreachable");
}
