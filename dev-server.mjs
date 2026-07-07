// Local dev server: static files from public/ + the api/ serverless functions,
// with env loaded from .env.local — the full pipeline without `vercel dev`.
//
//   node dev-server.mjs      → http://localhost:3000
//
// (`npx serve public` still works for frontend-only work; this exists so the
// real Claude/ElevenLabs pipeline is testable in the browser before deploying.)
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";

// --- .env.local ---
for (const line of readFileSync(new URL("./.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Za-z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const API = {
  "/api/generate-script": (await import("./api/generate-script.js")).default,
  "/api/tts": (await import("./api/tts.js")).default,
  "/api/stt": (await import("./api/stt.js")).default,
};

const PUBLIC = new URL("./public", import.meta.url).pathname;
const TOOLS = new URL("./tools", import.meta.url).pathname;

// --- Researcher console relay (design.md: wizard-of-oz console) ---
// Zero-dependency SSE + POST message bus between the headset page and the
// console page. In-memory, local-only by design: Vercel serverless can't
// hold SSE connections, so the console is a lab instrument that exists only
// where this dev server runs. On the deployed site /ctl 404s and the
// headset-side client silently disables itself.
const ctlClients = { headset: new Set(), console: new Set() };
function ctlBroadcast(to, msg) {
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of ctlClients[to] ?? []) res.write(payload);
}
// Periodic comment-line ping keeps proxies/browsers from reaping idle streams.
setInterval(() => {
  for (const set of Object.values(ctlClients))
    for (const res of set) res.write(":ping\n\n");
}, 15000).unref();
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".mp3": "audio/mpeg",
  ".json": "application/json", ".spz": "application/octet-stream",
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;

  // Console relay: subscribe (SSE) ...
  if (path === "/ctl/events") {
    const role = url.searchParams.get("role");
    if (!ctlClients[role]) { res.writeHead(400); return res.end(); }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    ctlClients[role].add(res);
    req.on("close", () => ctlClients[role].delete(res));
    return;
  }
  // ... and publish (POST {to, type, ...} relayed verbatim to that role).
  if (path === "/ctl/send" && req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      ctlBroadcast(msg.to, msg);
      res.writeHead(204);
    } catch {
      res.writeHead(400);
    }
    return res.end();
  }
  // The console page lives in tools/ (NOT public/), so it can never ship in
  // a deploy — it only exists where this dev server runs.
  if (path === "/console") {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
    return res.end(readFileSync(join(TOOLS, "console.html")));
  }

  // API routes — shim the Vercel res helpers the handlers use.
  if (API[path]) {
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (o) => (res.setHeader("Content-Type", "application/json"), res.end(JSON.stringify(o)), res);
    res.send = (b) => (res.end(b), res);
    try {
      await API[path](req, res);
    } catch (e) {
      console.error(path, e);
      if (!res.writableEnded) res.status(500).json({ error: "internal" });
    }
    console.log(`${res.statusCode} ${req.method} ${path}`);
    return;
  }

  // Static files from public/, traversal-safe.
  const rel = normalize(path).replace(/^(\.\.[/\\])+/, "");
  let file = join(PUBLIC, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    // Quest Browser heuristically caches ES modules without this and then
    // runs stale code across deploys/tunnel sessions — always revalidate.
    "Cache-Control": "no-cache",
  });
  res.end(readFileSync(file));
}).listen(3000, () => console.log("One's Own Room dev server → http://localhost:3000"));
