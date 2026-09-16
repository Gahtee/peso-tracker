import crypto from "node:crypto";
import { db, audit } from "./db.js";

export function hashPassword(password, salt = crypto.randomBytes(32)) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { hash, salt };
}

export function verifyPassword(password, salt, expected) {
  try {
    const h = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    if (h.length !== expected.length) return false;
    return crypto.timingSafeEqual(h, expected);
  } catch { return false; }
}

export function genAdminPassword() {
  // 16 chars, letras+números (sem ambíguos), cumpre política de 12+
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let s = "";
  const rnd = crypto.randomBytes(24);
  for (let i = 0; i < 16; i++) s += abc[rnd[i] % abc.length];
  return s;
}

// ---------------- rate limit / lockout ----------------
// Anti-bruteforce em 3 camadas:
// 1) bucket por IP (token bucket) p/ /api/login
// 2) lockout progressivo por conta (5 erros -> 15min, dobra a cada 5)
// 3) atraso artificial + resposta genérica (não revela se usuário existe)
const ipBuckets = new Map(); // ip -> {tokens, reset}
export function ipAllowed(ip) {
  const now = Date.now();
  let b = ipBuckets.get(ip);
  if (!b || now > b.reset) { b = { tokens: 10, reset: now + 60_000 }; ipBuckets.set(ip, b); }
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  return true;
}

const generalBuckets = new Map();
export function generalAllowed(ip, limit = 120) {
  const now = Date.now();
  let b = generalBuckets.get(ip);
  if (!b || now > b.reset) { b = { tokens: limit, reset: now + 60_000 }; generalBuckets.set(ip, b); }
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  return true;
}

setInterval(() => {
  const n = Date.now();
  for (const [k, v] of ipBuckets) if (n > v.reset) ipBuckets.delete(k);
  for (const [k, v] of generalBuckets) if (n > v.reset) generalBuckets.delete(k);
}, 60_000).unref();

export function lockoutRemaining(user) {
  return Math.max(0, (user.locked_until || 0) - Date.now());
}

export function registerFailure(username, ip) {
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

export function registerSuccess(user, ip) {
  db.prepare("UPDATE users SET failed_attempts=0, locked_until=0 WHERE id=?").run(user.id);
  audit(ip, user.username, "login_ok", "");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
