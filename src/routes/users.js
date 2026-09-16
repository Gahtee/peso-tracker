import fs from "node:fs";
import path from "node:path";
import { db, audit } from "../db.js";
import { UPLOAD_DIR } from "../config.js";
import { hashPassword } from "../security.js";
import { json } from "../http.js";
import { readBody, requireAdmin } from "./helpers.js";
import { validPassword, validUsername } from "../validation.js";

export async function handleListUsers(req, res, sess) {
  if (!requireAdmin(sess, res)) return;
  const users = db.prepare("SELECT id, username, role, created_at, failed_attempts, locked_until FROM users ORDER BY id").all();
  return json(res, 200, { users });
}

export async function handleCreateUser(req, res, ip, sess) {
  if (!requireAdmin(sess, res)) return;
  const body = await readBody(req, res);
  if (!body) return;
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const role = body.role === "admin" ? "admin" : "user";
  if (!validUsername(username)) return json(res, 400, { error: "usuário: 3–32 letras/números/._-" });
  if (!validPassword(password)) return json(res, 400, { error: "senha: mínimo 12 caracteres (máx 128)" });
  const { hash, salt } = hashPassword(password);
  try {
    db.prepare("INSERT INTO users(username,pass_hash,pass_salt,role,created_at) VALUES(?,?,?,?,?)").run(username, hash, salt, role, Date.now());
  } catch { return json(res, 409, { error: "nome de usuário já existe" }); }
  audit(ip, sess.username, "user_create", `${username}:${role}`);
  return json(res, 201, { ok: true });
}

export async function handleResetPassword(req, res, ip, sess, id) {
  if (!requireAdmin(sess, res)) return;
  const body = await readBody(req, res);
  if (!body) return;
  const password = String(body.password || "");
  if (!validPassword(password)) return json(res, 400, { error: "senha: mínimo 12 caracteres" });
  const { hash, salt } = hashPassword(password);
  db.prepare("UPDATE users SET pass_hash=?, pass_salt=?, failed_attempts=0, locked_until=0 WHERE id=?").run(hash, salt, id);
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(id); // derruba sessões antigas
  audit(ip, sess.username, "user_reset_pw", `id=${id}`);
  return json(res, 200, { ok: true });
}

export function handleUnlockUser(res, ip, sess, id) {
  if (!requireAdmin(sess, res)) return;
  db.prepare("UPDATE users SET failed_attempts=0, locked_until=0 WHERE id=?").run(id);
  audit(ip, sess.username, "user_unlock", `id=${id}`);
  return json(res, 200, { ok: true });
}

export function handleDeleteUser(res, ip, sess, id) {
  if (!requireAdmin(sess, res)) return;
  const target = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  if (!target) return json(res, 404, { error: "não encontrado" });
  if (target.id === sess.user_id) return json(res, 400, { error: "não pode excluir a si mesmo" });
  // remove mídias do disco
  const meds = db.prepare("SELECT stored FROM media WHERE user_id=?").all(target.id);
  db.prepare("DELETE FROM users WHERE id=?").run(target.id); // cascade limpa entries/media/sessions
  for (const x of meds) { try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(x.stored))); } catch {} }
  audit(ip, sess.username, "user_delete", target.username);
  return json(res, 200, { ok: true });
}
