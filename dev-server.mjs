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
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".mp3": "audio/mpeg",
  ".json": "application/json", ".spz": "application/octet-stream",
};

http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;

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
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(3000, () => console.log("One's Own Room dev server → http://localhost:3000"));
