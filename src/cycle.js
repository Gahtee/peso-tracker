// ---------------- ciclo menstrual ----------------
// Efeitos documentados (valores típicos de literatura/revisões):
// - fase lútea (pós-ovulação até menstruação): TMB sobe ~5–10% (usa-se +7%,
//   progesterona eleva gasto de repouso); apetite/cravings aumentam;
// - menstruação + dias anteriores: retenção hídrica de +0.5 a +2 kg na balança
//   SEM ser gordura — dias nessa janela entram no cálculo com peso menor e
//   NÃO disparam alerta de outlier nem contam como "fora do ritmo" da meta.
// Fases estimadas a partir do 1º dia da última menstruação + duração do ciclo:
//   menstrual: dias 1–5 · folicular: 6–(ov-2) · ovulatória: (ov-2)–(ov+1) ·
//   lútea: (ov+2)–fim, com ovulação ≈ len−14.
import { db } from "./db.js";
import { ACTIVITY_LEVELS, SEDENTARY_FACTOR } from "./config.js";

export const FASE_LABEL = { menstrual: "Menstrual", folicular: "Folicular", ovulatoria: "Ovulatória", lutea: "Lútea" };

export function cyclePhase(cycProf, dayStr) {
  if (!cycProf || !cycProf.cycle_enabled || !cycProf.cycle_last) return null;
  const len = Math.min(45, Math.max(20, cycProf.cycle_len || 28));
  const t0 = new Date(cycProf.cycle_last + "T12:00:00Z").getTime();
  const t = new Date(dayStr + "T12:00:00Z").getTime();
  if (Number.isNaN(t0) || Number.isNaN(t)) return null;
  const diff = Math.floor((t - t0) / 86400000);
  if (diff < 0) return null;
  const d = (diff % len) + 1; // dia do ciclo 1..len
  const ov = len - 14;
  let fase, retencao = false, tmbFator = 1;
  if (d <= 5) { fase = "menstrual"; retencao = true; }
  else if (d <= Math.max(6, ov - 2)) { fase = "folicular"; }
  else if (d <= ov + 1) { fase = "ovulatoria"; }
  else { fase = "lutea"; tmbFator = 1.07; }
  // TPM: 3 dias antes da próxima menstruação também retêm líquido
  if (d > len - 3) retencao = true;
  return { dia: d, duracao: len, fase, retencao, tmbFator };
}

export function getProfile(userId) {
  let p = db.prepare("SELECT * FROM profile WHERE user_id=?").get(userId);
  if (!p) {
    db.prepare("INSERT INTO profile(user_id,activity,updated_at) VALUES(?,1.2,?)").run(userId, Date.now());
    p = db.prepare("SELECT * FROM profile WHERE user_id=?").get(userId);
  }
  return p;
}

// Início do ciclo efetivo: último evento registrado tem prioridade;
// cai para o campo manual do perfil (compatibilidade).
export function effectiveCycleStart(userId, profile) {
  try {
    const ev = db.prepare("SELECT day FROM cycle_events WHERE user_id=? ORDER BY day DESC LIMIT 1").get(userId);
    if (ev && ev.day) return ev.day;
  } catch {}
  return profile.cycle_last || null;
}

export function resolveActivity(profile) {
  return ACTIVITY_LEVELS.includes(profile.activity) ? profile.activity : SEDENTARY_FACTOR;
}
