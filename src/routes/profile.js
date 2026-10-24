import { db } from "../db.js";
import { ACTIVITY_LEVELS, FLAGS } from "../config.js";
import { json, secHeaders } from "../http.js";
import { readBody } from "./helpers.js";
import { validCm, validDateString, validDay, validWeight } from "../validation.js";
import { FASE_LABEL, cyclePhase, getProfile } from "../cycle.js";
import { statsFor } from "../stats.js";

// Medidas fixas (cm) — chaves da API -> colunas do profile
export const FIX_KEYS = {
  ombros: "fix_ombros",
  braco_len: "fix_braco_len",
  perna_len: "fix_perna_len",
  altura: "fix_altura",
  gancho: "fix_gancho",
  busto_gap: "fix_busto_gap",
};

function readFix(body) {
  const src = body.medidas_fix ?? body.fix ?? {};
  const out = {};
  for (const [k, col] of Object.entries(FIX_KEYS)) {
    const raw = src[k] !== undefined ? src[k] : body["fix_" + k];
    const v = validCm(raw);
    if (v === undefined) return { error: `medida fixa "${k}" inválida (5–300 cm)` };
    out[col] = v;
  }
  return { out };
}

function fixToApi(pr) {
  const out = {};
  for (const [k, col] of Object.entries(FIX_KEYS)) out[k] = pr[col] ?? null;
  return out;
}

export function handleFlags(res) {
  return json(res, 200, { flags: Object.fromEntries(Object.entries(FLAGS).map(([k, v]) => [k, v.label])) });
}

export function handleGetProfile(res, sess) {
  const pr = getProfile(sess.user_id);
  return json(res, 200, {
    goal_kg: pr.goal_kg, goal_day: pr.goal_day, activity: pr.activity, levels: ACTIVITY_LEVELS,
    cycle_enabled: !!pr.cycle_enabled, cycle_last: pr.cycle_last, cycle_len: pr.cycle_len || 28,
    fix: fixToApi(pr),
  });
}

export async function handlePutProfile(req, res, sess) {
  const body = await readBody(req, res);
  if (!body) return;
  const hasGoal = body.goal_kg !== undefined && body.goal_kg !== null && String(body.goal_kg) !== "";
  const goalKg = hasGoal ? Number(body.goal_kg) : null;
  const goalDay = body.goal_day ? String(body.goal_day) : null;
  const act = body.activity !== undefined ? Number(body.activity) : 1.2;
  const cycOn = body.cycle_enabled === true || body.cycle_enabled === 1;
  const cycLast = body.cycle_last ? String(body.cycle_last) : null;
  const cycLen = body.cycle_len !== undefined ? parseInt(body.cycle_len, 10) : 28;
  if (hasGoal && !validWeight(goalKg)) return json(res, 400, { error: "meta inválida (20–500 kg)" });
  if (goalDay && !validDateString(goalDay)) return json(res, 400, { error: "data da meta inválida" });
  if (!ACTIVITY_LEVELS.includes(act)) return json(res, 400, { error: "nível de atividade inválido" });
  if (cycLast && !validDateString(cycLast)) return json(res, 400, { error: "data do ciclo inválida" });
  if (cycLast && cycLast > new Date().toISOString().slice(0, 10)) return json(res, 400, { error: "data do ciclo não pode ser futura" });
  if (!(cycLen >= 20 && cycLen <= 45)) return json(res, 400, { error: "duração do ciclo inválida (20–45 dias)" });
  const r = readFix(body);
  if (r.error) return json(res, 400, { error: r.error });
  getProfile(sess.user_id);
  db.prepare("UPDATE profile SET goal_kg=?, goal_day=?, activity=?, cycle_enabled=?, cycle_last=?, cycle_len=?, updated_at=?, fix_ombros=?, fix_braco_len=?, fix_perna_len=?, fix_altura=?, fix_gancho=?, fix_busto_gap=? WHERE user_id=?")
    .run(goalKg, goalDay, act, cycOn ? 1 : 0, cycLast, cycLen, Date.now(), r.out.fix_ombros, r.out.fix_braco_len, r.out.fix_perna_len, r.out.fix_altura, r.out.fix_gancho, r.out.fix_busto_gap, sess.user_id);
  return json(res, 200, { ok: true });
}

export function handleListCycleEvents(res, sess) {
  const evs = db.prepare("SELECT id, day FROM cycle_events WHERE user_id=? ORDER BY day DESC LIMIT 24").all(sess.user_id);
  return json(res, 200, { events: evs });
}

export async function handleCreateCycleEvent(req, res, sess) {
  const body = await readBody(req, res);
  if (!body) return;
  const day = String(body.day || new Date().toISOString().slice(0, 10));
  if (!validDay(day)) return json(res, 400, { error: "data inválida (use datas até hoje)" });
  try {
    db.prepare("INSERT INTO cycle_events(user_id,day,created_at) VALUES(?,?,?)").run(sess.user_id, day, Date.now());
  } catch { return json(res, 409, { error: "data já registrada" }); }
  db.prepare("UPDATE profile SET cycle_last=?, updated_at=? WHERE user_id=?").run(day, Date.now(), sess.user_id);
  return json(res, 201, { ok: true });
}

export function handleDeleteCycleEvent(res, sess, id) {
  db.prepare("DELETE FROM cycle_events WHERE id=? AND user_id=?").run(id, sess.user_id);
  const last = db.prepare("SELECT day FROM cycle_events WHERE user_id=? ORDER BY day DESC LIMIT 1").get(sess.user_id);
  db.prepare("UPDATE profile SET cycle_last=?, updated_at=? WHERE user_id=?").run(last ? last.day : null, Date.now(), sess.user_id);
  return json(res, 200, { ok: true });
}

export function handleCyclePhase(url, res, sess) {
  const pr = getProfile(sess.user_id);
  const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
  const ph = cyclePhase(pr, day);
  return json(res, 200, {
    ativo: !!pr.cycle_enabled,
    fase: ph ? ph.fase : null,
    faseLabel: ph ? (FASE_LABEL[ph.fase] || ph.fase) : null,
    dia: ph ? ph.dia : null, duracao: ph ? ph.duracao : (pr.cycle_len || 28),
    retencao: ph ? ph.retencao : false, tmbFator: ph ? ph.tmbFator : 1,
  });
}

export function handleStats(url, res, sess) {
  const w = [14, 28].includes(parseInt(url.searchParams.get("window") || "0", 10))
    ? parseInt(url.searchParams.get("window"), 10) : 0;
  return json(res, 200, statsFor(sess.user_id, w));
}

export function handleExportCsv(res, sess) {
  const rows = db.prepare("SELECT day, weight_kg, calories, exercise_kcal, exercise_src, flags, note, m_pulso, m_cintura, m_abdomen, m_quadril, m_busto, m_torax, m_coxas, m_bracos FROM entries WHERE user_id=? ORDER BY day ASC").all(sess.user_id);
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = ["data,peso_kg,calorias,exercicio_kcal,exercicio_fonte,atipico,nota,pulso_cm,cintura_cm,abdomen_cm,quadril_cm,busto_cm,torax_cm,coxas_cm,bracos_cm"];
  for (const r of rows) {
    const fl = Object.keys(FLAGS).filter((k) => ((r.flags | 0) & FLAGS[k].bit)).join(";");
    lines.push([r.day, r.weight_kg, r.calories, r.exercise_kcal || 0, r.exercise_src || "est", fl, q(r.note), r.m_pulso ?? "", r.m_cintura ?? "", r.m_abdomen ?? "", r.m_quadril ?? "", r.m_busto ?? "", r.m_torax ?? "", r.m_coxas ?? "", r.m_bracos ?? ""].join(","));
  }
  const body = "\uFEFF" + lines.join("\n");
  secHeaders(res, false);
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=peso-tracker.csv", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
