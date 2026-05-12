import { NextResponse } from "next/server";
import { AVAILABLE_MODELS, EDIT_MODEL } from "@/lib/anthropic";

export const runtime = "nodejs";

/** Lista modeli dostepnych do wyboru w UI per-call (Asistant AI, Apply DS,
 *  Apply Style, per-element fix). Zwraca tez ktory model jest defaultem. */
export async function GET() {
  return NextResponse.json({
    models: AVAILABLE_MODELS,
    default: EDIT_MODEL,
  });
}
