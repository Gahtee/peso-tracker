// Upload: parser multipart mínimo, sem dependências
import path from "node:path";

export const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm"]);
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm" };

export function parseMultipart(req, maxTotal = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const ct = req.headers["content-type"] || "";
    const m = ct.match(/boundary=(.+)$/);
    if (!m) return reject(new Error("multipart inválido"));
    const boundary = "--" + m[1].trim().replace(/^"|"$/g, "");
    const chunks = []; let total = 0;
    req.on("data", (c) => { total += c.length; if (total > maxTotal) { reject(new Error("arquivo grande")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      try {
        const buf = Buffer.concat(chunks);
        const b = Buffer.from(boundary, "latin1");
        // divide por boundary
        const parts = [];
        let start = 0;
        while (true) {
          const i = buf.indexOf(b, start);
          if (i < 0) break;
          parts.push(buf.subarray(start, i));
          start = i + b.length;
        }
        const files = [];
        for (const part of parts) {
          if (part.length < 10) continue;
          const hEnd = part.indexOf(Buffer.from("\r\n\r\n", "latin1"));
          if (hEnd < 0) continue;
          const head = part.subarray(0, hEnd).toString("latin1");
          let body = part.subarray(hEnd + 4);
          if (body.subarray(-2).toString("latin1") === "\r\n") body = body.subarray(0, -2);
          const fn = (head.match(/filename="([^"]{0,200})"/) || [])[1] || "";
          const name = ((head.match(/name="([^"]{0,100})"/) || [])[1]) || "";
          const mime = ((head.match(/[Cc]ontent-[Tt]ype:\s*([^\r\n;]+)/) || [])[1] || "").trim().toLowerCase();
          if (!fn) continue;
          if (!ALLOWED_MIME.has(mime)) return reject(new Error("tipo de arquivo não permitido"));
          if (body.length > MAX_FILE_BYTES) return reject(new Error("arquivo grande (máx 15MB)"));
          if (body.length < 16) return reject(new Error("arquivo vazio"));
          // valida magic bytes
          if (!validMagic(body, mime)) return reject(new Error("conteúdo não confere com o tipo"));
          if (name !== "file") return reject(new Error("campo inválido"));
          files.push({ origName: path.basename(fn).slice(0, 120), mime, data: body });
        }
        resolve(files);
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

export function validMagic(buf, mime) {
  const h = (n) => buf.subarray(0, n);
  if (mime === "image/png") return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mime === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === "image/gif") { const s = h(6).toString("latin1"); return s === "GIF87a" || s === "GIF89a"; }
  if (mime === "image/webp") return h(4).toString("latin1") === "RIFF" && h(12).toString("latin1").slice(8) === "WEBP";
  if (mime === "video/mp4") { const s = buf.subarray(4, 12).toString("latin1"); return s.includes("ftyp"); }
  if (mime === "video/webm") return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  return false;
}
