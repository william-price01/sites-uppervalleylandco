// Dev server: static files from public/ (the deploy directory) + the same
// /api/geocode the site uses in production on Cloudflare Pages. Run: bun run serve
import { onRequestGet as geocode } from "./functions/api/geocode.js";

const root = import.meta.dir + "/public";

Bun.serve({
  port: 4173,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/geocode") return geocode({ request: req });

    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    let file = Bun.file(root + path);
    if (await file.exists()) return new Response(file);
    file = Bun.file(root + path + ".html");
    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404 });
  },
});

console.log("Serving on http://localhost:4173 (with /api/geocode proxy)");
