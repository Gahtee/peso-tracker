import { db, audit } from "../db.js";
import { ipAllowed, lockoutRemaining, registerFailure, registerSuccess, sleep, verifyPassword } from "../security.js";
import { createSession, getSession, isHttps, parseCookies, setSessionCookie, clearCookie } from "../session.js";
import { json, readJson } from "../http.js";

export async function handleLogin(req, res, ip) {
  if (!ipAllowed(ip)) {
    audit(ip, "", "login_ratelimit", "");
    await sleep(800);
    return json(res, 429, { error: "muitas tentativas, aguarde 1 minuto" });
  }
  let body;
  try { body = await readJson(req); }
  catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: e.message }); }
  const username = String(body.username || "").slice(0, 64);
  const password = String(body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  await sleep(400); // custo constante: dificulta timing/oracle
  if (!user) {
    audit(ip, username.slice(0, 40), "login_fail_nouser", "");
    return json(res, 401, { error: "usuário ou senha inválidos" });
  }
  if (lockoutRemaining(user) > 0) {
    const min = Math.ceil(lockoutRemaining(user) / 60000);
    audit(ip, user.username, "login_locked", `${min}min`);
    return json(res, 423, { error: `conta bloqueada por segurança, tente em ~${min} min` });
  }
  if (!verifyPassword(password, user.pass_salt, user.pass_hash)) {
    registerFailure(user.username, ip);
    const u2 = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
    if (lockoutRemaining(u2) > 0) return json(res, 423, { error: "muitas tentativas erradas — conta bloqueada temporariamente" });
    return json(res, 401, { error: "usuário ou senha inválidos" });
  }
  registerSuccess(user, ip);
  const { sid, csrf } = createSession(user.id, ip);
  setSessionCookie(res, sid, isHttps(req));
  return json(res, 200, { ok: true, username: user.username, role: user.role, csrf });
}

export function handleLogout(req, res) {
  const sess = getSession(req);
  if (sess) { try { db.prepare("DELETE FROM sessions WHERE id=?").run(parseCookies(req).sid); } catch {} }
  clearCookie(res);
  return json(res, 200, { ok: true });
}

export function handleMe(res, sess) {
  return json(res, 200, { username: sess.username, role: sess.role, csrf: sess.csrf });
}
