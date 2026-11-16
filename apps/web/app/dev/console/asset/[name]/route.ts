// Dev only: serves the real phone captures in docs/design/console-revamp to
// the fixtures page, so the console renders every state without a backend and
// without shipping the images in public/.

import { readFile } from "node:fs/promises";
import path from "node:path";

const DIR = path.join(process.cwd(), "../../docs/design/console-revamp/prototypes/assets");

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  if (process.env.NODE_ENV === "production") return new Response("Not found", { status: 404 });
  const { name } = await params;
  if (!/^[a-z0-9-]+\.jpg$/.test(name)) return new Response("Not found", { status: 404 });
  try {
    const body = await readFile(path.join(DIR, name));
    return new Response(new Uint8Array(body), { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
