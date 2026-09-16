import fs from "node:fs";
import path from "node:path";
import { MIME, PUBLIC_DIR } from "./config.js";

export function secHeaders(res, isHtml) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (isHtml) res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  else res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
}

export function json(res, code, obj) {
  secHeaders(res, false);
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export function readJson(req, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return;
      n += c.length;
      if (n > maxBytes) { tooBig = true; reject(Object.assign(new Error("payload grande"), { code: 413 })); }
      else chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(Object.assign(new Error("JSON inválido"), { code: 400 })); }
    });
    req.on("error", reject);
  });
}

export function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === "/") p = "/index.html";
  if (p.includes("\0") || p.includes("..")) { json(res, 400, { error: "bad path" }); return; }
  const file = path.join(PUBLIC_DIR, p.slice(1));
  if (!file.startsWith(PUBLIC_DIR)) { json(res, 400, { error: "bad path" }); return; }
  fs.readFile(file, (err, data) => {
    if (err) { secHeaders(res, false); res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); return; }
    const ext = path.extname(file).toLowerCase();
    secHeaders(res, ext === ".html");
    // HTML/CSS/JS sempre revalidados: sem cache travado após deploys de UI.
    // (Query ?v=N no HTML garante troca imediata mesmo atrás do Cloudflare.)
    let body = data;
    if (ext === ".html") {
      try {
        const v = (f) => String(Math.floor(fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs));
        body = Buffer.from(
          body.toString("utf8")
            .replace('/style.css"', `/style.css?v=${v("style.css")}"`)
            .replace("/app.js\"", `/app.js?v=${v("app.js")}"`)
        );
      } catch {}
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache", "Content-Length": body.length });
    res.end(body);
  });
}
