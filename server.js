#!/usr/bin/env node
/**
 * Peso Tracker — painel privado de acompanhamento corporal
 * Zero dependências. Apenas Node.js >= 22.
 *
 * Uso:
 *   node server.js --init-admin        # cria admin (ou usa env ADMIN_USER/ADMIN_PASSWORD)
 *   node server.js                     # inicia em http://127.0.0.1:3000
 *   PORT=3000 BIND=127.0.0.1 node server.js
 *   node server.js --daemon [porta]    # modo serviço (estilo pm2): roda em background,
 *                                      # escolhe porta livre se omitida, gera senha admin
 *                                      # se não houver nenhum usuário. Sobrevive ao fim
 *                                      # desta sessão (detached). Gerencia com:
 *   node server.js --status            # mostra pid/porta/stats do serviço
 *   node server.js --stop              # para o serviço
 *
 * Atrás do Cloudflare Tunnel, rode ouvindo em 127.0.0.1 e aponte o tunnel para lá.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_PATH = path.join(DATA_DIR, "tracker.db");
const PUBLIC_DIR = path.join(__dirname, "public");
const PID_FILE = path.join(DATA_DIR, "service.pid");
const PORT_FILE = path.join(DATA_DIR, "service.port");
const LOG_FILE = path.join(DATA_DIR, "service.log");

const PORT = parseInt(process.env.PORT || "3000", 10);
const BIND = process.env.BIND || "127.0.0.1";
const TRUST_PROXY = (process.env.TRUST_PROXY || "1") === "1"; // cloudflared envia X-Forwarded-For/Proto
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const KCAL_PER_KG = 7700;
const SEDENTARY_FACTOR = 1.2; // gasto sedentário ≈ TMB * 1.2

// Flags de "dia atípico": a balança oscila ±1–2 kg por água/glicogênio/conteúdo
// intestinal sem que isso seja gordura. Dias marcados entram no cálculo com
// peso menor (não são descartados) e alimentam a margem de erro.
const FLAGS = {
  agua:    { bit: 1,  label: "Muita água antes de dormir",      w: 0.3 },
  inchaco: { bit: 2,  label: "Acordou inchado/a (retenção)",    w: 0.3 },
  jantar:  { bit: 4,  label: "Jantar pesado / tarde",           w: 0.5 },
  alcool:  { bit: 8,  label: "Álcool no dia anterior",          w: 0.4 },
  horario: { bit: 16, label: "Pesagem em horário diferente",    w: 0.5 },
  treino:  { bit: 32, label: "Fez exercício neste dia",         w: 0.3 },
  outro:   { bit: 64, label: "Outro motivo atípico",            w: 0.5 },
};
function parseFlags(v) {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 127) return v;
  if (!Array.isArray(v)) return 0;
  let f = 0;
  for (const k of v) if (FLAGS[k]) f |= FLAGS[k].bit;
  return f;
}
function flagKeys(f) { return Object.keys(FLAGS).filter((k) => (f & FLAGS[k].bit)); }
function dayWeight(f) {
  let w = 1;
  for (const k of Object.keys(FLAGS)) if (f & FLAGS[k].bit) w = Math.min(w, FLAGS[k].w);
  return w;
}

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// ---------------- DB ----------------
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash BLOB NOT NULL,
  pass_salt BLOB NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  weight_kg REAL NOT NULL,
  calories INTEGER NOT NULL,
  flags INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_entries_user_day ON entries(user_id, day);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  stored TEXT NOT NULL UNIQUE,
  orig_name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_entry ON media(entry_id);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
`);

// migração: coluna flags em bancos criados antes dessa versão
try { db.exec("ALTER TABLE entries ADD COLUMN flags INTEGER NOT NULL DEFAULT 0"); } catch {}

// ---------------- crypto / senhas ----------------
function hashPassword(password, salt = crypto.randomBytes(32)) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { hash, salt };
}
function verifyPassword(password, salt, expected) {
  try {
    const h = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    if (h.length !== expected.length) return false;
    return crypto.timingSafeEqual(h, expected);
  } catch { return false; }
}
function validUsername(u) { return typeof u === "string" && /^[a-zA-Z0-9._-]{3,32}$/.test(u); }
function validPassword(p) {
  return typeof p === "string" && p.length >= 12 && p.length <= 128;
}
function audit(ip, actor, event, detail = "") {
  try { db.prepare("INSERT INTO audit(at,ip,actor,event,detail) VALUES(?,?,?,?,?)").run(Date.now(), ip, actor, event, String(detail).slice(0, 500)); } catch {}
}

// ---------------- rate limit / lockout ----------------
// Anti-bruteforce em 3 camadas:
// 1) bucket por IP (token bucket) p/ /api/login
// 2) lockout progressivo por conta (5 erros -> 15min, dobra a cada 5)
// 3) atraso artificial + resposta genérica (não revela se usuário existe)
const ipBuckets = new Map(); // ip -> {tokens, reset}
function ipAllowed(ip) {
  const now = Date.now();
  let b = ipBuckets.get(ip);
  if (!b || now > b.reset) { b = { tokens: 10, reset: now + 60_000 }; ipBuckets.set(ip, b); }
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  return true;
}
const generalBuckets = new Map();
function generalAllowed(ip, limit = 120) {
  const now = Date.now();
  let b = generalBuckets.get(ip);
  if (!b || now > b.reset) { b = { tokens: limit, reset: now + 60_000 }; generalBuckets.set(ip, b); }
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of ipBuckets) if (n > v.reset) ipBuckets.delete(k); for (const [k, v] of generalBuckets) if (n > v.reset) generalBuckets.delete(k); }, 60_000).unref();

function lockoutRemaining(user) {
  return Math.max(0, (user.locked_until || 0) - Date.now());
}
function registerFailure(username, ip) {
  const u = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!u) return;
  const fails = (u.failed_attempts || 0) + 1;
  let locked = u.locked_until || 0;
  if (fails % 5 === 0) {
    const level = Math.floor(fails / 5); // 1,2,3...
    const mins = 15 * Math.pow(2, level - 1); // 15,30,60...
    locked = Date.now() + Math.min(mins, 24 * 60) * 60_000;
  }
  db.prepare("UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?").run(fails, locked, u.id);
  audit(ip, username, "login_fail", `tentativa ${fails}`);
}
function registerSuccess(user, ip) {
  db.prepare("UPDATE users SET failed_attempts=0, locked_until=0 WHERE id=?").run(user.id);
  audit(ip, user.username, "login_ok", "");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- sessões / cookies ----------------
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (/^[A-Za-z0-9_-]{1,64}$/.test(k)) out[k] = decodeURIComponent(v).slice(0, 512);
  }
  return out;
}
function isLoopback(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
function clientIp(req) {
  // Só confia em X-Forwarded-For/CF-Connecting-IP quando a conexão vem do
  // próprio host (cloudflared). Acesso direto via LAN não pode forjar IP
  // para furar o rate-limit.
  if (TRUST_PROXY && isLoopback(req)) {
    const f = req.headers["x-forwarded-for"];
    if (typeof f === "string" && f.length) return f.split(",")[0].trim().slice(0, 64);
    const r = req.headers["cf-connecting-ip"];
    if (typeof r === "string" && r.length) return r.slice(0, 64);
  }
  return (req.socket.remoteAddress || "").slice(0, 64);
}
function isHttps(req) {
  if (TRUST_PROXY && isLoopback(req)) {
    const p = req.headers["x-forwarded-proto"];
    if (typeof p === "string" && p.split(",")[0].trim() === "https") return true;
    const cf = req.headers["cf-visitor"];
    if (typeof cf === "string" && cf.includes("https")) return true;
  }
  return false;
}
function setSessionCookie(res, sid, https) {
  const parts = [`sid=${sid}`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=43200"];
  if (https) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}
function clearCookie(res) {
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}
function getSession(req) {
  const { sid } = parseCookies(req);
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
  const s = db.prepare("SELECT sessions.*, users.username, users.role FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ?").get(sid);
  if (!s) return null;
  if (s.expires_at < Date.now()) { try { db.prepare("DELETE FROM sessions WHERE id=?").run(sid); } catch {} return null; }
  return s;
}
function createSession(userId, ip) {
  const sid = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare("INSERT INTO sessions(id,user_id,csrf,created_at,expires_at,ip) VALUES(?,?,?,?,?,?)").run(sid, userId, csrf, now, now + SESSION_TTL_MS, ip);
  // limita sessões simultâneas
  db.prepare("DELETE FROM sessions WHERE user_id=? AND id NOT IN (SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 10)").run(userId, userId);
  // sliding: renova em cada request autenticado (feito no handler)
  return { sid, csrf };
}
function needCsrf(req, session) {
  const t = req.headers["x-csrf-token"];
  if (typeof t !== "string" || !session) return false;
  const a = Buffer.from(t, "utf8"), b = Buffer.from(session.csrf, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------- helpers HTTP ----------------
function secHeaders(res, isHtml) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (isHtml) res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  else res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
}
function json(res, code, obj, req) {
  secHeaders(res, false);
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function readJson(req, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > maxBytes) { reject(new Error("payload grande")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("JSON inválido")); } });
    req.on("error", reject);
  });
}
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function serveStatic(req, res, urlPath) {
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

// Upload: parser multipart mínimo, sem dependências
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm"]);
const MAX_FILE_BYTES = 15 * 1024 * 1024;
function parseMultipart(req, maxTotal = 16 * 1024 * 1024) {
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
function validMagic(buf, mime) {
  const h = (n) => buf.subarray(0, n);
  if (mime === "image/png") return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mime === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === "image/gif") { const s = h(6).toString("latin1"); return s === "GIF87a" || s === "GIF89a"; }
  if (mime === "image/webp") return h(4).toString("latin1") === "RIFF" && h(12).toString("latin1").slice(8) === "WEBP";
  if (mime === "video/mp4") { const s = buf.subarray(4, 12).toString("latin1"); return s.includes("ftyp"); }
  if (mime === "video/webm") return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  return false;
}
const EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm" };

// ---------------- validação ----------------
function validDay(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date(); today.setHours(23, 59, 59, 999);
  return d <= today && d.getFullYear() >= 2000;
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------------- estimativa TMB ----------------
// Modelo: regressão LINEAR PONDERADA do peso × tempo.
// - dias normais têm peso 1; dias atípicos (água/inchaço/jantar/alcool…)
//   entram com peso menor (0.3–0.5) em vez de serem descartados;
// - gasto = média(calorias) − tendência(kg/dia) × 7700;
// - TMB ≈ gasto ÷ 1.2 (sedentário, sem exercício — dia com flag "treino"
//   também recebe peso menor porque o gasto real foge da hipótese);
// - margem de erro: IC95% da tendência. O ruído é estimado só com os dias
//   NORMAIS (não marcados): marcar um dia como atípico reduz a influência
//   dele no ajuste E estreita a margem; deixar o outlier sem marcar alarga
//   a margem. Resíduo típico diário é reportado à parte.
function statsFor(userId) {
  const rows = db.prepare("SELECT day, weight_kg, calories, flags FROM entries WHERE user_id=? ORDER BY day ASC").all(userId);
  if (rows.length < 2) {
    return { n: rows.length, ready: false, message: "Adicione pelo menos 2 dias para estimar a TMB." };
  }
  const t0 = new Date(rows[0].day + "T12:00:00Z").getTime();
  const xs = [], ws = [], cals = [], ps = [];
  for (const r of rows) {
    xs.push((new Date(r.day + "T12:00:00Z").getTime() - t0) / 86400000);
    ws.push(r.weight_kg); cals.push(r.calories); ps.push(dayWeight(r.flags || 0));
  }
  const n = xs.length;
  const wsum = ps.reduce((s, v) => s + v, 0);
  const wmean = (a) => a.reduce((s, v, i) => s + v * ps[i], 0) / wsum;
  const mx = wmean(xs), mw = wmean(ws);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += ps[i] * (xs[i] - mx) * (ws[i] - mw); den += ps[i] * (xs[i] - mx) ** 2; }
  const slope = den > 1e-9 ? num / den : 0; // kg/dia (ponderado)
  const avgCal = cals.reduce((s, v) => s + v, 0) / n;
  const gasto = avgCal - slope * KCAL_PER_KG;
  const tmb = gasto / SEDENTARY_FACTOR;
  // resíduos ponderados → R² ponderado; o RUÍDO é estimado só com dias
  // normais (dias atípicos não contaminam a margem — marcar um dia como
  // "água/inchaço" reduz a influência dele E estreita a margem).
  let ssTot = 0, ssRes = 0;
  const resid = [], cleanResid = [];
  for (let i = 0; i < n; i++) {
    const pred = mw + slope * (xs[i] - mx);
    const r = ws[i] - pred;
    resid.push(r);
    if ((rows[i].flags || 0) === 0) cleanResid.push(r);
    ssTot += ps[i] * (ws[i] - mw) ** 2;
    ssRes += ps[i] * r * r;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const noise = cleanResid.length >= 3 ? cleanResid : resid;
  const dof = Math.max(1, noise.length - 2);
  const s2 = noise.reduce((s, v) => s + v * v, 0) / dof; // variância do ruído (dias normais)
  const seSlope = den > 1e-9 ? Math.sqrt(s2 / den) : 0; // erro-padrão do slope
  const t95 = n >= 30 ? 2.04 : n >= 10 ? 2.23 : n >= 5 ? 2.78 : 4.3; // t de Student aprox.
  // Margem = IC95% da tendência com ruído dos dias normais. Marcar dias
  // atípicos estreita a margem; não marcar alarga.
  const margemTmb = den > 1e-9 ? Math.max(50, Math.round((t95 * seSlope * KCAL_PER_KG) / SEDENTARY_FACTOR)) : 999;
  const residTipico = Math.sqrt(noise.reduce((s, v) => s + v * v, 0) / noise.length); // kg
  const spanDays = Math.max(1, Math.round(xs[n - 1] - xs[0]) + 1);
  const flagged = rows.filter((r) => (r.flags || 0) !== 0).length;
  const effN = Math.round(wsum * 10) / 10;
  const first = ws[0], last = ws[n - 1];
  const conf = (n >= 14 && spanDays >= 14 && margemTmb < 250) ? (r2 > 0.3 ? "alta" : "média") : n >= 7 ? "média" : "baixa";
  return {
    n, ready: true, spanDays, firstWeight: first, lastWeight: last,
    deltaKg: +(last - first).toFixed(2), avgCalories: Math.round(avgCal),
    slopeKgDay: +slope.toFixed(4), gastoDiario: Math.round(gasto),
    tmbEstimada: Math.round(tmb),
    margemTmb: margemTmb, tmbMin: Math.round(tmb - margemTmb), tmbMax: Math.round(tmb + margemTmb),
    gastoMin: Math.round(gasto - margemTmb * SEDENTARY_FACTOR), gastoMax: Math.round(gasto + margemTmb * SEDENTARY_FACTOR),
    residuoTipicoKg: +residTipico.toFixed(2), diasAtipicos: flagged, diasEfetivos: effN,
    r2: +r2.toFixed(3), confianca: conf,
    plausivel: gasto > 800 && gasto < 8000,
    metodo: `Regressão ponderada em ${n} dias (${flagged} atípico(s), n efetivo ${effN}): gasto = média de calorias − (tendência × ${KCAL_PER_KG}); TMB ≈ gasto ÷ ${SEDENTARY_FACTOR}. Margem = IC95% da tendência + ruído típico de ${residTipico.toFixed(2)} kg/dia. Dias com água/inchaço/jantar pesado pesam menos no ajuste e alargam a margem.`
  };
}

// ---------------- router ----------------
async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const ip = clientIp(req);
  const method = req.method;

  if (!generalAllowed(ip)) { json(res, 429, { error: "muitas requisições, tente em 1 minuto" }, req); return; }

  // estáticos públicos (sem auth): /, /style.css, /app.js
  if (method === "GET" && (p === "/" || p === "/index.html" || p === "/style.css" || p === "/app.js")) {
    return serveStatic(req, res, p === "/" ? "/index.html" : p);
  }

  // ---- login ----
  if (p === "/api/login" && method === "POST") {
    if (!ipAllowed(ip)) { audit(ip, "", "login_ratelimit", ""); await sleep(800); return json(res, 429, { error: "muitas tentativas, aguarde 1 minuto" }, req); }
    let body; try { body = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }, req); }
    const username = String(body.username || "").slice(0, 64);
    const password = String(body.password || "");
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    await sleep(400); // custo constante: dificulta timing/oracle
    if (!user) { audit(ip, username.slice(0, 40), "login_fail_nouser", ""); return json(res, 401, { error: "usuário ou senha inválidos" }, req); }
    if (lockoutRemaining(user) > 0) {
      const min = Math.ceil(lockoutRemaining(user) / 60000);
      audit(ip, user.username, "login_locked", `${min}min`);
      return json(res, 423, { error: `conta bloqueada por segurança, tente em ~${min} min` }, req);
    }
    if (!verifyPassword(password, user.pass_salt, user.pass_hash)) {
      registerFailure(user.username, ip);
      const u2 = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
      if (lockoutRemaining(u2) > 0) return json(res, 423, { error: "muitas tentativas erradas — conta bloqueada temporariamente" }, req);
      return json(res, 401, { error: "usuário ou senha inválidos" }, req);
    }
    registerSuccess(user, ip);
    const { sid, csrf } = createSession(user.id, ip);
    setSessionCookie(res, sid, isHttps(req));
    return json(res, 200, { ok: true, username: user.username, role: user.role, csrf }, req);
  }

  // sessão necessária daqui em diante
  const sess = getSession(req);
  if (p === "/api/logout" && method === "POST") {
    if (sess) { try { db.prepare("DELETE FROM sessions WHERE id=?").run(parseCookies(req).sid); } catch {} }
    clearCookie(res);
    return json(res, 200, { ok: true }, req);
  }
  if (!sess) return json(res, 401, { error: "não autenticado" }, req);
  // sliding expiration
  try { db.prepare("UPDATE sessions SET expires_at=? WHERE id=?").run(Date.now() + SESSION_TTL_MS, parseCookies(req).sid); } catch {}

  if (p === "/api/me" && method === "GET") {
    return json(res, 200, { username: sess.username, role: sess.role, csrf: sess.csrf }, req);
  }

  // mutações exigem CSRF (exceto GET/HEAD)
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !needCsrf(req, sess)) {
    audit(ip, sess.username, "csrf_fail", p);
    return json(res, 403, { error: "token CSRF inválido" }, req);
  }

  // ---- admin: gerenciar usuários (só admin cria perfis) ----
  if (p === "/api/users" && method === "GET") {
    if (sess.role !== "admin") return json(res, 403, { error: "só administrador" }, req);
    const users = db.prepare("SELECT id, username, role, created_at, failed_attempts, locked_until FROM users ORDER BY id").all();
    return json(res, 200, { users }, req);
  }
  if (p === "/api/users" && method === "POST") {
    if (sess.role !== "admin") return json(res, 403, { error: "só administrador pode criar perfis" }, req);
    let body; try { body = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }, req); }
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const role = body.role === "admin" ? "admin" : "user";
    if (!validUsername(username)) return json(res, 400, { error: "usuário: 3–32 letras/números/._-" }, req);
    if (!validPassword(password)) return json(res, 400, { error: "senha: mínimo 12 caracteres (máx 128)" }, req);
    const { hash, salt } = hashPassword(password);
    try {
      db.prepare("INSERT INTO users(username,pass_hash,pass_salt,role,created_at) VALUES(?,?,?,?,?)").run(username, hash, salt, role, Date.now());
    } catch { return json(res, 409, { error: "nome de usuário já existe" }, req); }
    audit(ip, sess.username, "user_create", `${username}:${role}`);
    return json(res, 201, { ok: true }, req);
  }
  let m;
  if ((m = p.match(/^\/api\/users\/(\d+)\/reset-password$/)) && method === "POST") {
    if (sess.role !== "admin") return json(res, 403, { error: "só administrador" }, req);
    let body; try { body = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }, req); }
    const password = String(body.password || "");
    if (!validPassword(password)) return json(res, 400, { error: "senha: mínimo 12 caracteres" }, req);
    const { hash, salt } = hashPassword(password);
    db.prepare("UPDATE users SET pass_hash=?, pass_salt=?, failed_attempts=0, locked_until=0 WHERE id=?").run(hash, salt, Number(m[1]));
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(Number(m[1])); // derruba sessões antigas
    audit(ip, sess.username, "user_reset_pw", `id=${m[1]}`);
    return json(res, 200, { ok: true }, req);
  }
  if ((m = p.match(/^\/api\/users\/(\d+)\/unlock$/)) && method === "POST") {
    if (sess.role !== "admin") return json(res, 403, { error: "só administrador" }, req);
    db.prepare("UPDATE users SET failed_attempts=0, locked_until=0 WHERE id=?").run(Number(m[1]));
    audit(ip, sess.username, "user_unlock", `id=${m[1]}`);
    return json(res, 200, { ok: true }, req);
  }
  if ((m = p.match(/^\/api\/users\/(\d+)$/)) && method === "DELETE") {
    if (sess.role !== "admin") return json(res, 403, { error: "só administrador" }, req);
    const target = db.prepare("SELECT * FROM users WHERE id=?").get(Number(m[1]));
    if (!target) return json(res, 404, { error: "não encontrado" }, req);
    if (target.id === sess.user_id) return json(res, 400, { error: "não pode excluir a si mesmo" }, req);
    // remove mídias do disco
    const meds = db.prepare("SELECT stored FROM media WHERE user_id=?").all(target.id);
    db.prepare("DELETE FROM users WHERE id=?").run(target.id); // cascade limpa entries/media/sessions
    for (const x of meds) { try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(x.stored))); } catch {} }
    audit(ip, sess.username, "user_delete", target.username);
    return json(res, 200, { ok: true }, req);
  }

  // ---- entradas ----
  if (p === "/api/entries" && method === "GET") {
    const rows = db.prepare("SELECT id, day, weight_kg, calories, flags, note FROM entries WHERE user_id=? ORDER BY day DESC LIMIT 500").all(sess.user_id);
    const ids = rows.map((r) => r.id);
    let mediaByEntry = {};
    if (ids.length) {
      const ph = ids.map(() => "?").join(",");
      const meds = db.prepare(`SELECT id, entry_id, stored, mime, size, created_at FROM media WHERE entry_id IN (${ph}) ORDER BY created_at`).all(...ids);
      for (const x of meds) { (mediaByEntry[x.entry_id] ||= []).push(x); }
    }
    return json(res, 200, { entries: rows.map((r) => ({ ...r, media: mediaByEntry[r.id] || [] })) }, req);
  }
  if (p === "/api/entries" && method === "POST") {
    let body; try { body = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }, req); }
    const day = String(body.day || "");
    const weight = Number(body.weight_kg);
    const calories = Number(body.calories);
    const flags = parseFlags(body.flags ?? body.flagsKeys);
    const note = String(body.note || "").slice(0, 500);
    if (!validDay(day)) return json(res, 400, { error: "data inválida (use datas até hoje)" }, req);
    if (!(weight >= 20 && weight <= 500)) return json(res, 400, { error: "peso inválido (20–500 kg)" }, req);
    if (!(Number.isInteger(calories) && calories >= 0 && calories <= 30000)) return json(res, 400, { error: "calorias inválidas (0–30000)" }, req);
    const now = Date.now();
    try {
      const r = db.prepare("INSERT INTO entries(user_id,day,weight_kg,calories,flags,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(sess.user_id, day, weight, calories, flags, note, now, now);
      return json(res, 201, { ok: true, id: Number(r.lastInsertRowid) }, req);
    } catch { return json(res, 409, { error: "já existe registro neste dia — edite o existente" }, req); }
  }
  if ((m = p.match(/^\/api\/entries\/(\d+)$/)) && method === "PUT") {
    let body; try { body = await readJson(req); } catch (e) { return json(res, 400, { error: e.message }, req); }
    const weight = Number(body.weight_kg), calories = Number(body.calories);
    const flags = parseFlags(body.flags ?? body.flagsKeys);
    const note = String(body.note || "").slice(0, 500);
    if (!(weight >= 20 && weight <= 500)) return json(res, 400, { error: "peso inválido" }, req);
    if (!(Number.isInteger(calories) && calories >= 0 && calories <= 30000)) return json(res, 400, { error: "calorias inválidas" }, req);
    const r = db.prepare("UPDATE entries SET weight_kg=?, calories=?, flags=?, note=?, updated_at=? WHERE id=? AND user_id=?").run(weight, calories, flags, note, Date.now(), Number(m[1]), sess.user_id);
    if (r.changes === 0) return json(res, 404, { error: "não encontrado" }, req);
    return json(res, 200, { ok: true }, req);
  }
  if ((m = p.match(/^\/api\/entries\/(\d+)$/)) && method === "DELETE") {
    const meds = db.prepare("SELECT stored FROM media WHERE entry_id=? AND user_id=?").all(Number(m[1]), sess.user_id);
    const r = db.prepare("DELETE FROM entries WHERE id=? AND user_id=?").run(Number(m[1]), sess.user_id);
    if (r.changes === 0) return json(res, 404, { error: "não encontrado" }, req);
    for (const x of meds) { try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(x.stored))); } catch {} }
    return json(res, 200, { ok: true }, req);
  }

  // ---- mídia por dia ----
  if ((m = p.match(/^\/api\/entries\/(\d+)\/media$/)) && method === "POST") {
    const entry = db.prepare("SELECT * FROM entries WHERE id=? AND user_id=?").get(Number(m[1]), sess.user_id);
    if (!entry) return json(res, 404, { error: "registro não encontrado" }, req);
    const count = db.prepare("SELECT COUNT(*) c FROM media WHERE entry_id=?").get(entry.id).c;
    if (count >= 6) return json(res, 400, { error: "máximo 6 arquivos por dia" }, req);
    let files;
    try { files = await parseMultipart(req); }
    catch (e) { return json(res, 400, { error: e.message }, req); }
    if (!files.length) return json(res, 400, { error: "nenhum arquivo" }, req);
    const out = [];
    for (const f of files) {
      const stored = crypto.randomBytes(24).toString("hex") + EXT[f.mime];
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), f.data, { mode: 0o600 });
      const r = db.prepare("INSERT INTO media(user_id,entry_id,stored,orig_name,mime,size,created_at) VALUES(?,?,?,?,?,?,?)").run(sess.user_id, entry.id, stored, f.origName, f.mime, f.data.length, Date.now());
      out.push({ id: Number(r.lastInsertRowid), mime: f.mime, size: f.data.length });
    }
    audit(ip, sess.username, "media_upload", `entry=${entry.id} n=${out.length}`);
    return json(res, 201, { ok: true, files: out }, req);
  }
  if ((m = p.match(/^\/api\/media\/(\d+)$/)) && method === "DELETE") {
    const x = db.prepare("SELECT * FROM media WHERE id=? AND user_id=?").get(Number(m[1]), sess.user_id);
    if (!x) return json(res, 404, { error: "não encontrado" }, req);
    db.prepare("DELETE FROM media WHERE id=?").run(x.id);
    try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(x.stored))); } catch {}
    return json(res, 200, { ok: true }, req);
  }
  // servir mídia (dono vê a sua; admin vê qualquer uma via ?user= — não: só dono; admin usa painel? simplifica: dono + admin)
  if ((m = p.match(/^\/media\/([a-f0-9]{48}\.(?:jpg|png|webp|gif|mp4|webm))$/)) && method === "GET") {
    const stored = m[1];
    const x = db.prepare("SELECT * FROM media WHERE stored=?").get(stored);
    if (!x) { secHeaders(res, false); res.writeHead(404); res.end(); return; }
    if (x.user_id !== sess.user_id && sess.role !== "admin") return json(res, 403, { error: "sem acesso" }, req);
    const fp = path.join(UPLOAD_DIR, path.basename(stored));
    if (!fp.startsWith(UPLOAD_DIR)) return json(res, 400, { error: "bad path" }, req);
    fs.readFile(fp, (err, data) => {
      if (err) { secHeaders(res, false); res.writeHead(404); res.end(); return; }
      secHeaders(res, false);
      res.writeHead(200, { "Content-Type": x.mime, "Content-Length": data.length, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" });
      res.end(data);
    });
    return;
  }

  // ---- flags disponíveis (para montar os checkboxes) ----
  if (p === "/api/flags" && method === "GET") {
    return json(res, 200, { flags: Object.fromEntries(Object.entries(FLAGS).map(([k, v]) => [k, v.label])) }, req);
  }

  // ---- estatística TMB ----
  if (p === "/api/stats" && method === "GET") {
    return json(res, 200, statsFor(sess.user_id), req);
  }

  return json(res, 404, { error: "não encontrado" }, req);
}

const server = http.createServer((req, res) => handler(req, res).catch((e) => {
  try { json(res, 500, { error: "erro interno" }, req); } catch {}
}));

// ---------------- init admin ----------------
function ensureAdmin() {
  const n = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  const envUser = process.env.ADMIN_USER, envPass = process.env.ADMIN_PASSWORD;
  if (process.argv.includes("--init-admin") || (n === 0 && (envUser || process.argv.includes("--init-admin")))) {
    const username = (envUser || "admin").trim();
    let password = envPass;
    if (!password) { password = "Admin-" + crypto.randomBytes(9).toString("base64url"); console.log("\n=============================================="); console.log(`  Usuário admin: ${username}`); console.log(`  Senha admin:  ${password}`); console.log("  Troque após o 1º login. Guarde em local seguro."); console.log("==============================================\n"); }
    if (!validUsername(username) || !validPassword(password)) { console.error("ADMIN_USER inválido ou ADMIN_PASSWORD < 12 chars"); process.exit(1); }
    const { hash, salt } = hashPassword(password);
    try { db.prepare("INSERT INTO users(username,pass_hash,pass_salt,role,created_at) VALUES(?,?,?,?,?)").run(username, hash, salt, "admin", Date.now()); console.log(`Admin '${username}' criado.`); }
    catch { const { hash: h2, salt: s2 } = hashPassword(password); db.prepare("UPDATE users SET pass_hash=?, pass_salt=?, role='admin', failed_attempts=0, locked_until=0 WHERE username=?").run(h2, s2, username); console.log(`Admin '${username}' atualizado.`); }
    if (process.argv.includes("--init-admin")) process.exit(0);
  } else if (n === 0) {
    console.log("\nNenhum usuário existe. Rode:  node server.js --init-admin");
    console.log("Ou defina ADMIN_USER/ADMIN_PASSWORD e reinicie.\n");
  }
}
ensureAdmin();

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}
async function pickFreePort(preferred) {
  // tenta a porta pedida/default primeiro; senão varre a partir dela
  const start = preferred || 3000;
  for (let p = start; p < start + 500; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p)) return p;
  }
  throw new Error("nenhuma porta livre encontrada");
}
function serviceInfo() {
  let pid = null, port = null;
  try { pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10) || null; } catch {}
  try { port = parseInt(fs.readFileSync(PORT_FILE, "utf8").trim(), 10) || null; } catch {}
  let alive = false;
  if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
  return { pid, port, alive };
}
function genAdminPassword() {
  // 16 chars, letras+números (sem ambíguos), cumpre política de 12+
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let s = "";
  const rnd = crypto.randomBytes(24);
  for (let i = 0; i < 16; i++) s += abc[rnd[i] % abc.length];
  return s;
}
async function cmdDaemon(argPort) {
  const cur = serviceInfo();
  if (cur.alive) {
    console.log(`Serviço já rodando: pid=${cur.pid} porta=${cur.port} (http://127.0.0.1:${cur.port})`);
    process.exit(0);
  }
  const envBind = process.env.BIND || "127.0.0.1";
  const port = await pickFreePort(argPort ? parseInt(argPort, 10) : (process.env.PORT ? parseInt(process.env.PORT, 10) : 0) || 0);
  // garante senha admin quando o banco está vazio (sem ela o usuário não entra)
  let freshCreds = null;
  const nUsers = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  if (nUsers === 0) {
    const password = process.env.ADMIN_PASSWORD || genAdminPassword();
    const username = (process.env.ADMIN_USER || "admin").trim();
    const { hash, salt } = hashPassword(password);
    db.prepare("INSERT INTO users(username,pass_hash,pass_salt,role,created_at) VALUES(?,?,?,?,?)").run(username, hash, salt, "admin", Date.now());
    freshCreds = { username, password };
  }
  db.close();
  const log = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    detached: true, stdio: ["ignore", log, log],
    env: { ...process.env, PORT: String(port), BIND: envBind },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  fs.writeFileSync(PORT_FILE, String(port));
  fs.writeFileSync(path.join(DATA_DIR, "service.bind"), envBind);
  // espera subir (health check)
  const t0 = Date.now();
  let up = false;
  const probeHost = envBind === "0.0.0.0" ? "127.0.0.1" : envBind;
  while (Date.now() - t0 < 15000) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      await new Promise((resolve, reject) => {
        const rq = http.get({ host: probeHost, port, path: "/", timeout: 1500 }, (rs) => { rs.resume(); rs.on("end", resolve); });
        rq.on("error", reject); rq.on("timeout", () => { rq.destroy(); reject(new Error("t")); });
      });
      up = true; break;
    } catch {}
  }
  console.log("\n==============================================");
  console.log(`  Peso Tracker rodando como serviço (pid ${child.pid})`);
  console.log(`  URL local:  http://${envBind}:${port}`);
  console.log(`  Cloudflare Tunnel →  http://${envBind === "0.0.0.0" ? "127.0.0.1" : envBind}:${port}  (use http, NÃO https)`);
  if (freshCreds) {
    console.log(`  Usuário admin: ${freshCreds.username}`);
    console.log(`  Senha admin:   ${freshCreds.password}`);
    console.log("  Guarde e troque após o 1º login.");
  } else {
    console.log("  Admin: use a senha já existente (banco já tinha usuários).");
  }
  console.log(`  Log: ${LOG_FILE} · status: node server.js --status`);
  console.log("==============================================\n");
  if (!up) { console.error("AVISO: serviço iniciado mas não respondeu em 15s — veja o log."); process.exit(1); }
  process.exit(0);
}
function cmdStatus() {
  const { pid, port, alive } = serviceInfo();
  let bind = "127.0.0.1";
  try { bind = fs.readFileSync(path.join(DATA_DIR, "service.bind"), "utf8").trim() || bind; } catch {}
  if (!port && !pid) { console.log("Serviço nunca iniciado (sem service.pid/service.port em data/)."); return; }
  console.log(alive ? `Rodando: pid=${pid} em http://${bind}:${port}` : `Parado (último pid=${pid} em ${bind}:${port}). Suba com: node server.js --daemon`);
}
function cmdStop() {
  const { pid, alive } = serviceInfo();
  if (!alive || !pid) { console.log("Serviço não está rodando."); try { fs.unlinkSync(PID_FILE); } catch {} return; }
  try { process.kill(pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(pid, 0); try { process.kill(pid, "SIGKILL"); } catch {} } catch {} }, 2500).unref?.();
  try { fs.unlinkSync(PID_FILE); } catch {}
  console.log(`Sinal de parada enviado ao pid ${pid}.`);
}
const _args = process.argv.slice(2);
if (_args.includes("--status")) { cmdStatus(); process.exit(0); }
if (_args.includes("--stop")) { cmdStop(); process.exit(0); }
if (_args.includes("--daemon") || _args.includes("--service")) {
  const i = Math.max(_args.indexOf("--daemon"), _args.indexOf("--service"));
  const portArg = _args[i + 1] && /^\d+$/.test(_args[i + 1]) ? _args[i + 1] : null;
  await cmdDaemon(portArg);
}

server.listen(PORT, BIND, () => {
  try { fs.writeFileSync(PORT_FILE, String(PORT)); } catch {}
  console.log(`Peso Tracker em http://${BIND}:${PORT}  (exponha via Cloudflare Tunnel, veja tunnel.md)`);
});
