import crypto from "node:crypto";
import { db } from "./db.js";
import { SESSION_TTL_MS, TRUST_PROXY } from "./config.js";

// ---------------- sessões / cookies ----------------
export function parseCookies(req) {
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

export function isLoopback(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

export function clientIp(req) {
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

export function isHttps(req) {
  if (TRUST_PROXY && isLoopback(req)) {
    const p = req.headers["x-forwarded-proto"];
    if (typeof p === "string" && p.split(",")[0].trim() === "https") return true;
    const cf = req.headers["cf-visitor"];
    if (typeof cf === "string" && cf.includes("https")) return true;
  }
  return false;
}

export function setSessionCookie(res, sid, https) {
  const parts = [`sid=${sid}`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=43200"];
  if (https) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearCookie(res) {
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

export function getSession(req) {
  const { sid } = parseCookies(req);
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
  const s = db.prepare("SELECT sessions.*, users.username, users.role FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ?").get(sid);
  if (!s) return null;
  if (s.expires_at < Date.now()) { try { db.prepare("DELETE FROM sessions WHERE id=?").run(sid); } catch {} return null; }
  return s;
}

export function createSession(userId, ip) {
  const sid = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare("INSERT INTO sessions(id,user_id,csrf,created_at,expires_at,ip) VALUES(?,?,?,?,?,?)").run(sid, userId, csrf, now, now + SESSION_TTL_MS, ip);
  // limita sessões simultâneas
  db.prepare("DELETE FROM sessions WHERE user_id=? AND id NOT IN (SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 10)").run(userId, userId);
  // sliding: renova em cada request autenticado (feito no handler)
  return { sid, csrf };
}

export function needCsrf(req, session) {
  const t = req.headers["x-csrf-token"];
  if (typeof t !== "string" || !session) return false;
  const a = Buffer.from(t, "utf8"), b = Buffer.from(session.csrf, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
