import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { db, audit } from "../db.js";
import { UPLOAD_DIR } from "../config.js";
import { json, secHeaders } from "../http.js";
import { readBody } from "./helpers.js";
import { parseFlags, validCalories, validDay, validExercise, validExerciseSrc, validWeight } from "../validation.js";
import { EXT, parseMultipart } from "../media.js";

export function handleListEntries(res, sess) {
  const rows = db.prepare("SELECT id, day, weight_kg, calories, exercise_kcal, exercise_src, flags, note FROM entries WHERE user_id=? ORDER BY day DESC LIMIT 500").all(sess.user_id);
  const ids = rows.map((r) => r.id);
  let mediaByEntry = {};
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const meds = db.prepare(`SELECT id, entry_id, stored, mime, size, created_at FROM media WHERE entry_id IN (${ph}) ORDER BY created_at`).all(...ids);
    for (const x of meds) { (mediaByEntry[x.entry_id] ||= []).push(x); }
  }
  return json(res, 200, { entries: rows.map((r) => ({ ...r, media: mediaByEntry[r.id] || [] })) });
}

export async function handleCreateEntry(req, res, sess) {
  const body = await readBody(req, res);
  if (!body) return;
  const day = String(body.day || "");
  const weight = Number(body.weight_kg);
  const calories = Number(body.calories);
  const exercise = validExercise(body.exercise_kcal);
  const exSrc = validExerciseSrc(body.exercise_src);
  const flags = parseFlags(body.flags ?? body.flagsKeys);
  const note = String(body.note || "").slice(0, 500);
  if (!validDay(day)) return json(res, 400, { error: "data inválida (use datas até hoje)" });
  if (!validWeight(weight)) return json(res, 400, { error: "peso inválido (20–500 kg)" });
  if (!validCalories(calories)) return json(res, 400, { error: "calorias inválidas (0–30000)" });
  if (exercise === null) return json(res, 400, { error: "exercício inválido (0–10000 kcal)" });
  const now = Date.now();
  try {
    const r = db.prepare("INSERT INTO entries(user_id,day,weight_kg,calories,exercise_kcal,exercise_src,flags,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(sess.user_id, day, weight, calories, exercise, exSrc, flags, note, now, now);
    return json(res, 201, { ok: true, id: Number(r.lastInsertRowid) });
  } catch { return json(res, 409, { error: "já existe registro neste dia — edite o existente" }); }
}

export async function handleUpdateEntry(req, res, sess, id) {
  const body = await readBody(req, res);
  if (!body) return;
  const weight = Number(body.weight_kg), calories = Number(body.calories);
  const exercise = validExercise(body.exercise_kcal);
  const exSrc = validExerciseSrc(body.exercise_src);
  const flags = parseFlags(body.flags ?? body.flagsKeys);
  const note = String(body.note || "").slice(0, 500);
  if (!validWeight(weight)) return json(res, 400, { error: "peso inválido" });
  if (!validCalories(calories)) return json(res, 400, { error: "calorias inválidas" });
  if (exercise === null) return json(res, 400, { error: "exercício inválido (0–10000 kcal)" });
  const r = db.prepare("UPDATE entries SET weight_kg=?, calories=?, exercise_kcal=?, exercise_src=?, flags=?, note=?, updated_at=? WHERE id=? AND user_id=?").run(weight, calories, exercise, exSrc, flags, note, Date.now(), id, sess.user_id);
  if (r.changes === 0) return json(res, 404, { error: "não encontrado" });
  return json(res, 200, { ok: true });
}

export function handleDeleteEntry(res, sess, id) {
  const meds = db.prepare("SELECT stored FROM media WHERE entry_id=? AND user_id=?").all(id, sess.user_id);
  const r = db.prepare("DELETE FROM entries WHERE id=? AND user_id=?").run(id, sess.user_id);
  if (r.changes === 0) return json(res, 404, { error: "não encontrado" });
  for (const x of meds) { try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(x.stored))); } catch {} }
  return json(res, 200, { ok: true });
}

export async function handleUploadMedia(req, res, ip, sess, entryId) {
  const entry = db.prepare("SELECT * FROM entries WHERE id=? AND user_id=?").get(entryId, sess.user_id);
  if (!entry) return json(res, 404, { error: "registro não encontrado" });
  let files;
  try { files = await parseMultipart(req); }
  catch (e) { return json(res, 400, { error: e.message }); }
  if (!files.length) return json(res, 400, { error: "nenhum arquivo" });
  // limite aplicado ANTES de gravar (conta atual + lote), sem condição de corrida
  const count = db.prepare("SELECT COUNT(*) c FROM media WHERE entry_id=?").get(entry.id).c;
  if (count + files.length > 6) return json(res, 400, { error: `máximo 6 arquivos por dia (já há ${count})` });
  const out = [];
  for (const f of files) {
    const stored = crypto.randomBytes(24).toString("hex") + EXT[f.mime];
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), f.data, { mode: 0o600 });
    const r = db.prepare("INSERT INTO media(user_id,entry_id,stored,orig_name,mime,size,created_at) VALUES(?,?,?,?,?,?,?)").run(sess.user_id, entry.id, stored, f.origName, f.mime, f.data.length, Date.now());
    out.push({ id: Number(r.lastInsertRowid), mime: f.mime, size: f.data.length });
  }
  audit(ip, sess.username, "media_upload", `entry=${entry.id} n=${out.length}`);
  return json(res, 201, { ok: true, files: out });
}

export function handleDeleteMedia(res, sess, id) {
  const x = db.prepare("SELECT * FROM media WHERE id=? AND user_id=?").get(id, sess.user_id);
  if (!x) return json(res, 404, { error: "não encontrado" });
  db.prepare("DELETE FROM media WHERE id=?").run(x.id);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(x.stored))); } catch {}
  return json(res, 200, { ok: true });
}

// servir mídia (dono + admin) com streaming e Range (seek em vídeo, sem
// carregar o arquivo inteiro na RAM)
export function handleServeMedia(req, res, sess, stored) {
  const x = db.prepare("SELECT * FROM media WHERE stored=?").get(stored);
  if (!x) { secHeaders(res, false); res.writeHead(404); res.end(); return; }
  if (x.user_id !== sess.user_id && sess.role !== "admin") return json(res, 403, { error: "sem acesso" });
  const fp = path.join(UPLOAD_DIR, path.basename(stored));
  if (!fp.startsWith(UPLOAD_DIR)) return json(res, 400, { error: "bad path" });
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { secHeaders(res, false); res.writeHead(404); res.end(); return; }
    secHeaders(res, false);
    const total = st.size;
    const base = { "Content-Type": x.mime, "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Cache-Control": "private, max-age=3600", "Accept-Ranges": "bytes" };
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [s, e] = range.replace("bytes=", "").split("-");
      const start = s === "" ? Math.max(0, total - parseInt(e || "0", 10)) : parseInt(s, 10);
      const end = e === "" ? total - 1 : parseInt(e, 10);
      if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end >= total || start > end) {
        res.writeHead(416, { ...base, "Content-Range": `bytes */${total}` });
        res.end(); return;
      }
      res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": end - start + 1 });
      fs.createReadStream(fp, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...base, "Content-Length": total });
      fs.createReadStream(fp).pipe(res);
    }
  });
}
