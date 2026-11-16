import { readFileSync } from "node:fs";
import { join } from "node:path";

// `curl -fsSL https://phoneuse.dev/install | bash`
// The script is public/install.sh (also served at /install.sh). This route
// serves the same file as plain text, so it also reads in a browser. It is
// rendered once, at build time.
export const dynamic = "force-static";

export function GET() {
  const script = readFileSync(join(process.cwd(), "public", "install.sh"), "utf8");
  return new Response(script, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
