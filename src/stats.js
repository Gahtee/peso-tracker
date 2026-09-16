// ---------------- estimativa TMB ----------------
// CONVENÇÃO DE REGISTRO (fisiologia da pesagem):
// - `day` = dia da PESAGEM, de manhã ao acordar após a 1ª urina (peso + foto/vídeo);
// - `calories`/`exercise_kcal` do MESMO registro = total ingerido/gasto na VÉSPERA
//   (dia anterior completo). Não dá para prever o que ainda vai comer hoje, então
//   o fluxo é: de manhã pesa + fotografa, e fecha as calorias de ontem.
// - Modelo: regressão LINEAR PONDERADA do peso × tempo sobre calorias LÍQUIDAS
//   da véspera (ingeridas − exercício), com os MESMOS pesos nos dois lados.
//   O deslocamento de 1 dia entre pesagem e ingestão não viesam a média: a série
//   de N manhãs cobre N vésperas, e a tendência kg/dia absorve o ruído hídrico.
// - dias normais têm peso 1; dias atípicos entram com peso menor (0.3–0.5);
// - gasto = média_ponderada(cal − exercício) − tendência(kg/dia) × 7700;
// - TMB ≈ gasto ÷ fator de atividade do perfil (padrão 1.2 sedentário);
// - margem: IC95% da tendência; ruído estimado só com dias NORMAIS, então
//   marcar um dia como atípico reduz a influência dele E estreita a margem;
// - window: usa só os últimos N dias (14/28/tudo);
// - outliers (|resíduo| > 2.5σ) são reportados p/ considerar marcar;
// - projeção de meta: quando o peso-alvo chega no ritmo atual, e quantas
//   kcal/dia permitem chegar lá até o dia-alvo.
import { db } from "./db.js";
import { KCAL_PER_KG } from "./config.js";
import { dayWeight } from "./validation.js";
import { cyclePhase, effectiveCycleStart, getProfile, resolveActivity, FASE_LABEL } from "./cycle.js";

export function statsFor(userId, windowDays = 0) {
  let rows = db.prepare("SELECT day, weight_kg, calories, exercise_kcal, exercise_src, flags FROM entries WHERE user_id=? ORDER BY day ASC").all(userId);
  const totalN = rows.length;
  if (windowDays > 0 && rows.length > windowDays) rows = rows.slice(rows.length - windowDays);
  if (rows.length < 2) {
    return { n: rows.length, totalN, ready: false, message: "Adicione pelo menos 2 dias para estimar a TMB." };
  }
  const profile = getProfile(userId);
  const ACT = resolveActivity(profile);
  const cycStart = effectiveCycleStart(userId, profile);
  const cycProf = { ...profile, cycle_last: cycStart };
  const t0 = new Date(rows[0].day + "T12:00:00Z").getTime();
  const xs = [], ws = [], nets = [], exs = [], ps = [], fases = [];
  for (const r of rows) {
    xs.push((new Date(r.day + "T12:00:00Z").getTime() - t0) / 86400000);
    ws.push(r.weight_kg);
    nets.push(r.calories - (r.exercise_kcal || 0));
    exs.push(r.exercise_kcal || 0);
    const fl = r.flags || 0;
    const ph = cyclePhase(cycProf, r.day);
    fases.push(ph ? ph.fase : null);
    // retenção hídrica do ciclo: se o dia cai na janela de retenção e não foi
    // marcado manualmente, pondera metade automaticamente (não é gordura)
    const auto = (ph && ph.retencao && fl === 0) ? 0.5 : 1;
    ps.push(Math.min(dayWeight(fl), auto));
  }
  const n = xs.length;
  const wsum = ps.reduce((s, v) => s + v, 0);
  const wmean = (a) => a.reduce((s, v, i) => s + v * ps[i], 0) / wsum;
  const mx = wmean(xs), mw = wmean(ws);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += ps[i] * (xs[i] - mx) * (ws[i] - mw); den += ps[i] * (xs[i] - mx) ** 2; }
  const slope = den > 1e-9 ? num / den : 0; // kg/dia (ponderado)
  const avgNet = wmean(nets); // média PONDERADA das líquidas (mesmos pesos)
  const avgEx = wmean(exs);
  const gasto = avgNet - slope * KCAL_PER_KG;
  const tmb = gasto / ACT;
  let ssTot = 0, ssRes = 0;
  const resid = [], cleanResid = [];
  for (let i = 0; i < n; i++) {
    const pred = mw + slope * (xs[i] - mx);
    const r = ws[i] - pred;
    resid.push(r);
    if ((rows[i].flags || 0) === 0 && fases[i] !== "menstrual" && !(cyclePhase(cycProf, rows[i].day) || {}).retencao) cleanResid.push(r);
    ssTot += ps[i] * (ws[i] - mw) ** 2;
    ssRes += ps[i] * r * r;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const noise = cleanResid.length >= 3 ? cleanResid : resid;
  const dof = Math.max(1, noise.length - 2);
  const s2 = noise.reduce((s, v) => s + v * v, 0) / dof;
  const seSlope = den > 1e-9 ? Math.sqrt(s2 / den) : 0;
  const t95 = noise.length >= 30 ? 2.04 : noise.length >= 10 ? 2.23 : noise.length >= 5 ? 2.78 : 4.3;
  const margemTmb = den > 1e-9 ? Math.max(50, Math.round((t95 * seSlope * KCAL_PER_KG) / ACT)) : 999;
  // Incerteza do exercício: relógio/app e estimativas erram ~25%. Dias medidos
  // por aparelho (dev) ou sem treino não inflam a margem; o resto sim.
  const nExUnc = rows.filter((r) => (r.exercise_kcal || 0) > 0 && (r.exercise_src || "est") !== "dev").length;
  const exIncert = n > 0 ? 0.25 * avgEx * (nExUnc / n) : 0; // kcal/dia
  const margemEx = Math.round(exIncert / ACT);
  const margemTmbFinal = margemTmb + margemEx;
  const residTipico = Math.sqrt(noise.reduce((s, v) => s + v * v, 0) / noise.length); // kg
  const spanDays = Math.max(1, Math.round(xs[n - 1] - xs[0]) + 1);
  const flagged = rows.filter((r) => (r.flags || 0) !== 0).length;
  const effN = Math.round(wsum * 10) / 10;
  // delta pela RETA AJUSTADA (robusto a outlier no 1º/último dia)
  const fitFirst = mw + slope * (xs[0] - mx), fitLast = mw + slope * (xs[n - 1] - mx);
  // outliers: dias normais fora da janela de retenção, |resíduo| > 2.5σ
  const sigma = residTipico > 0 ? residTipico : 0.3;
  const outliers = [];
  for (let i = 0; i < n; i++) {
    const ph = cyclePhase(cycProf, rows[i].day);
    if ((rows[i].flags || 0) === 0 && !(ph && ph.retencao) && Math.abs(resid[i]) > 2.5 * sigma) {
      outliers.push({ day: rows[i].day, weight_kg: rows[i].weight_kg, residuo: +resid[i].toFixed(2) });
    }
  }
  const conf = (effN >= 12 && spanDays >= 14 && margemTmb < 250) ? (r2 > 0.3 ? "alta" : "média") : effN >= 6 ? "média" : "baixa";
  // ---- projeção de meta (+ ajuste de ciclo na TMB) ----
  // Na fase lútea a TMB real sobe ~7%: o "gasto ajustado" reflete isso para
  // não subestimar o quanto pode comer; dias de retenção não contam como
  // "fora do ritmo" (a balança sobe por água, não por gordura).
  const todayPhase = cyclePhase(cycProf, new Date().toISOString().slice(0, 10));
  const ciclo = profile.cycle_enabled ? {
    ativo: true,
    faseAtual: todayPhase ? todayPhase.fase : null,
    faseAtualLabel: todayPhase ? (FASE_LABEL[todayPhase.fase] || todayPhase.fase) : null,
    diaCiclo: todayPhase ? todayPhase.dia : null,
    duracao: todayPhase ? todayPhase.duracao : (profile.cycle_len || 28),
    retencaoAgora: todayPhase ? todayPhase.retencao : false,
    tmbFatorFase: todayPhase ? todayPhase.tmbFator : 1,
  } : { ativo: false };
  let goal = null;
  if (profile.goal_kg && profile.goal_kg >= 20 && profile.goal_kg <= 500) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const curW = fitLast;
    const diff = profile.goal_kg - curW;
    const gastoAjust = gasto * (todayPhase ? todayPhase.tmbFator : 1);
    const g = { alvo: profile.goal_kg, atual: +curW.toFixed(1), diff: +diff.toFixed(1) };
    if (Math.abs(diff) < 0.3) { g.status = "atingida"; }
    else if (slope !== 0 && Math.sign(-diff) === Math.sign(slope)) {
      const daysTo = Math.ceil(Math.abs(diff / slope));
      const d = new Date(); d.setDate(d.getDate() + daysTo);
      g.status = "no-ritmo";
      g.diasRestantes = daysTo;
      g.previsao = d.toISOString().slice(0, 10);
      g.ritmoKgSem = +((slope * 7).toFixed(2));
    } else {
      // retenção hídrica do ciclo mascara a tendência: não decreta fracasso
      g.status = (todayPhase && todayPhase.retencao) ? "retencao" : "fora-do-ritmo";
      g.ritmoKgSem = +((slope * 7).toFixed(2));
    }
    if (profile.goal_day && /^\d{4}-\d{2}-\d{2}$/.test(profile.goal_day) && profile.goal_day > todayStr && Math.abs(diff) >= 0.3) {
      const daysLeft = Math.round((new Date(profile.goal_day + "T12:00:00Z") - new Date(todayStr + "T12:00:00Z")) / 86400000);
      if (daysLeft > 0) {
        const kcalDia = gastoAjust + (diff * KCAL_PER_KG) / daysLeft;
        g.diaAlvo = profile.goal_day;
        g.diasParaAlvo = daysLeft;
        g.kcalPorDia = Math.round(kcalDia);
        g.kcalPorDiaBase = Math.round(gasto + (diff * KCAL_PER_KG) / daysLeft);
        g.ajusteCiclo = (todayPhase && todayPhase.tmbFator > 1) ? `+${Math.round(gastoAjust - gasto)} pela fase lútea` : null;
        g.plausivel = kcalDia >= 1200 && kcalDia <= 6000;
      }
    }
    goal = g;
  }
  // ---- trajetória: peso ESPERADO dia a dia ----
  // Para cada dia com registro: esperado = reta ajustada (sem ruído).
  // Projeção futura: 30 dias à frente no ritmo atual + faixa ±margem.
  const traj = rows.map((r, i) => ({
    day: r.day,
    real: r.weight_kg,
    esperado: +(mw + slope * (xs[i] - mx)).toFixed(2),
    fase: fases[i],
    flags: r.flags || 0,
  }));
  const lastDate = new Date(rows[n - 1].day + "T12:00:00Z").getTime();
  const proj = [];
  for (let d = 1; d <= 30; d++) {
    const dt = new Date(lastDate + d * 86400000).toISOString().slice(0, 10);
    const w = fitLast + slope * d;
    const band = (margemTmb * ACT * d) / (KCAL_PER_KG * Math.sqrt(Math.max(1, n)));
    proj.push({ day: dt, esperado: +w.toFixed(2), min: +(w - band).toFixed(2), max: +(w + band).toFixed(2) });
  }
  return {
    n, totalN, window: windowDays || 0, ready: true, spanDays,
    firstWeight: ws[0], lastWeight: ws[n - 1],
    deltaKg: +((fitLast - fitFirst).toFixed(2)),
    avgCalories: Math.round(avgNet + avgEx), avgLiquidas: Math.round(avgNet), avgExercicio: Math.round(avgEx),
    slopeKgDay: +slope.toFixed(4), gastoDiario: Math.round(gasto),
    gastoAjustadoCiclo: Math.round(gasto * (todayPhase ? todayPhase.tmbFator : 1)),
    atividade: ACT,
    tmbEstimada: Math.round(tmb),
    margemTmb: margemTmbFinal, tmbMin: Math.round(tmb - margemTmbFinal), tmbMax: Math.round(tmb + margemTmbFinal),
    gastoMin: Math.round(gasto - margemTmbFinal * ACT), gastoMax: Math.round(gasto + margemTmbFinal * ACT),
    margemBalanca: margemTmb, margemExercicio: margemEx, exercicioIncertoKcal: Math.round(exIncert),
    residuoTipicoKg: +residTipico.toFixed(2), diasAtipicos: flagged, diasEfetivos: effN,
    outliers,
    r2: +r2.toFixed(3), confianca: conf,
    plausivel: gasto > 800 && gasto < 8000,
    goal, ciclo,
    trajetoria: traj, projecao: proj,
    metodo: `Cada dia = pesagem de manhã (após a 1ª urina) + calorias/exercício da VÉSPERA. Regressão ponderada em ${n} dias${windowDays ? ` (janela ${windowDays})` : ""} (${flagged} atípico(s), n efetivo ${effN}): gasto = média ponderada das calorias líquidas (ingeridas − exercício) − (tendência × ${KCAL_PER_KG}); TMB ≈ gasto ÷ ${ACT} (fator de atividade do perfil). Margem = IC95% da balança (±${margemTmb})${margemEx > 0 ? ` + incerteza do exercício (±${margemEx}, ~25% do treino estimado)` : ""}. Marcar dias atípicos estreita a margem.${profile.cycle_enabled ? " Ciclo ativo: dias de retenção ponderam metade automaticamente." : ""}`
  };
}
