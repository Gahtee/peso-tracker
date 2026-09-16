import { SESSION_TTL_MS } from "./config.js";
import { db, audit } from "./db.js";
import { generalAllowed } from "./security.js";
import { clientIp, getSession, needCsrf, parseCookies } from "./session.js";
import { json, secHeaders, serveStatic } from "./http.js";
import { handleLogin, handleLogout, handleMe } from "./routes/auth.js";
import { handleCreateUser, handleDeleteUser, handleListUsers, handleResetPassword, handleUnlockUser } from "./routes/users.js";
import { handleCreateEntry, handleDeleteEntry, handleDeleteMedia, handleListEntries, handleServeMedia, handleUpdateEntry, handleUploadMedia } from "./routes/entries.js";
import { handleCyclePhase, handleCreateCycleEvent, handleDeleteCycleEvent, handleExportCsv, handleFlags, handleGetProfile, handleListCycleEvents, handlePutProfile, handleStats } from "./routes/profile.js";

export async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const ip = clientIp(req);
  const method = req.method;

  if (!generalAllowed(ip)) { json(res, 429, { error: "muitas requisições, tente em 1 minuto" }); return; }

  // estáticos públicos (sem auth): /, /style.css, /app.js
  if (method === "GET" && (p === "/" || p === "/index.html" || p === "/style.css" || p === "/app.js")) {
    return serveStatic(req, res, p === "/" ? "/index.html" : p);
  }

  // health check público (p/ monitor/tunnel) — sem dados sensíveis
  if (p === "/api/health" && method === "GET") {
    secHeaders(res, false);
    const body = JSON.stringify({ ok: true });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": body.length });
    res.end(body);
    return;
  }

  // ---- login ----
  if (p === "/api/login" && method === "POST") {
    return handleLogin(req, res, ip);
  }

  // sessão necessária daqui em diante
  const sess = getSession(req);
  if (p === "/api/logout" && method === "POST") {
    return handleLogout(req, res);
  }
  if (!sess) return json(res, 401, { error: "não autenticado" });
  // sliding expiration
  try { db.prepare("UPDATE sessions SET expires_at=? WHERE id=?").run(Date.now() + SESSION_TTL_MS, parseCookies(req).sid); } catch {}

  if (p === "/api/me" && method === "GET") {
    return handleMe(res, sess);
  }

  // mutações exigem CSRF (exceto GET/HEAD)
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !needCsrf(req, sess)) {
    audit(ip, sess.username, "csrf_fail", p);
    return json(res, 403, { error: "token CSRF inválido" });
  }

  // ---- admin: gerenciar usuários (só admin cria perfis) ----
  if (p === "/api/users" && method === "GET") return handleListUsers(req, res, sess);
  if (p === "/api/users" && method === "POST") return handleCreateUser(req, res, ip, sess);

  let m;
  if ((m = p.match(/^\/api\/users\/(\d+)\/reset-password$/)) && method === "POST") {
    return handleResetPassword(req, res, ip, sess, Number(m[1]));
  }
  if ((m = p.match(/^\/api\/users\/(\d+)\/unlock$/)) && method === "POST") {
    return handleUnlockUser(res, ip, sess, Number(m[1]));
  }
  if ((m = p.match(/^\/api\/users\/(\d+)$/)) && method === "DELETE") {
    return handleDeleteUser(res, ip, sess, Number(m[1]));
  }

  // ---- entradas ----
  if (p === "/api/entries" && method === "GET") return handleListEntries(res, sess);
  if (p === "/api/entries" && method === "POST") return handleCreateEntry(req, res, sess);
  if ((m = p.match(/^\/api\/entries\/(\d+)$/)) && method === "PUT") {
    return handleUpdateEntry(req, res, sess, Number(m[1]));
  }
  if ((m = p.match(/^\/api\/entries\/(\d+)$/)) && method === "DELETE") {
    return handleDeleteEntry(res, sess, Number(m[1]));
  }

  // ---- mídia por dia ----
  if ((m = p.match(/^\/api\/entries\/(\d+)\/media$/)) && method === "POST") {
    return handleUploadMedia(req, res, ip, sess, Number(m[1]));
  }
  if ((m = p.match(/^\/api\/media\/(\d+)$/)) && method === "DELETE") {
    return handleDeleteMedia(res, sess, Number(m[1]));
  }
  if ((m = p.match(/^\/media\/([a-f0-9]{48}\.(?:jpg|png|webp|gif|mp4|webm))$/)) && method === "GET") {
    return handleServeMedia(req, res, sess, m[1]);
  }

  // ---- flags disponíveis (para montar os checkboxes) ----
  if (p === "/api/flags" && method === "GET") return handleFlags(res);

  // ---- perfil: meta de peso + fator de atividade + ciclo ----
  if (p === "/api/profile" && method === "GET") return handleGetProfile(res, sess);
  if (p === "/api/profile" && (method === "PUT" || method === "POST")) {
    return handlePutProfile(req, res, sess);
  }

  // ---- eventos de início do ciclo (histórico) ----
  if (p === "/api/cycle/events" && method === "GET") return handleListCycleEvents(res, sess);
  if (p === "/api/cycle/events" && method === "POST") return handleCreateCycleEvent(req, res, sess);
  if ((m = p.match(/^\/api\/cycle\/events\/(\d+)$/)) && method === "DELETE") {
    return handleDeleteCycleEvent(res, sess, Number(m[1]));
  }

  // ---- fase do ciclo em um dia ----
  if (p === "/api/cycle" && method === "GET") return handleCyclePhase(url, res, sess);

  // ---- estatística TMB (aceita ?window=14|28|0) ----
  if (p === "/api/stats" && method === "GET") return handleStats(url, res, sess);

  // ---- export CSV ----
  if (p === "/api/export.csv" && method === "GET") return handleExportCsv(res, sess);

  return json(res, 404, { error: "não encontrado" });
}
