"use strict";
const $ = (id) => document.getElementById(id);
let CSRF = "", ME = null, FLAG_LABELS = {}, CACHE = [], EXPANDED = new Set(), WIN = 0, STATS = null, PROFILE = null;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const FLAGS_ORDER = ["agua","inchaco","jantar","alcool","horario","treino","outro","ciclo"];
const ACT_LABELS = { 1.2: "Sedentário ×1.2", 1.375: "Leve ×1.375", 1.55: "Moderado ×1.55", 1.725: "Intenso ×1.725" };

/* confirm() e prompt() inline no estilo do app (sem diálogos nativos) */
function askConfirm(title, text, okLabel = "Excluir") {
  $("c-title").textContent = title;
  $("c-text").textContent = text || "";
  $("c-ok").textContent = okLabel;
  $("dlg-confirm").showModal();
  return new Promise((resolve) => {
    const ok = $("c-ok");
    const h = () => { ok.removeEventListener("click", h); resolve(true); };
    ok.addEventListener("click", h);
    $("dlg-confirm").addEventListener("close", function c() {
      $("dlg-confirm").removeEventListener("close", c);
      ok.removeEventListener("click", h); resolve(false);
    });
  });
}
function askValue(kicker, title, label, initial = "", type = "text") {
  $("p-kicker").textContent = kicker;
  $("p-title").textContent = title;
  $("p-label").textContent = label;
  const inp = $("p-input");
  inp.type = type === "password" ? "password" : "text";
  inp.value = initial || "";
  $("p-err").textContent = "";
  $("dlg-prompt").showModal();
  setTimeout(() => inp.focus(), 50);
  return new Promise((resolve) => {
    const ok = $("p-ok");
    const h = () => { ok.removeEventListener("click", h); resolve(inp.value); };
    ok.addEventListener("click", h);
    $("dlg-prompt").addEventListener("close", function c() {
      $("dlg-prompt").removeEventListener("close", c);
      ok.removeEventListener("click", h); resolve(null);
    });
  });
}

function flagNames(f) {
  if (!f) return [];
  return FLAGS_ORDER.filter((_, i) => (f & (1 << i))).map((k) => FLAG_LABELS[k] || k);
}
function checkedFlags(containerSel) {
  return [...document.querySelectorAll(`${containerSel} input[type=checkbox]:checked`)].map((c) => c.value);
}
function flagsHTML(selected) {
  return FLAGS_ORDER.map((k) => {
    const on = (selected & (1 << FLAGS_ORDER.indexOf(k))) ? " checked" : "";
    return `<label class="flag"><input type="checkbox" value="${k}"${on}><span>${esc(FLAG_LABELS[k] || k)}</span></label>`;
  }).join("");
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF, ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("erro " + r.status));
  return j;
}

/* ---------- movimento: aurora + neve + micro-interações ---------- */
// Respeita prefers-reduced-motion e não usa nenhuma dependência externa.
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
function countUp(el, target, ms = 700) {
  if (REDUCED || !el || !Number.isFinite(Number(target))) { if (el) el.textContent = target; return; }
  const t0 = performance.now(), from = 0, to = Number(target);
  const step = (t) => {
    const p = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function staggerChildren(container, sel, base = 26, cap = 10) {
  if (REDUCED || !container) return;
  [...container.querySelectorAll(sel)].slice(0, cap).forEach((el, i) => {
    el.classList.remove("fx-in");
    el.style.animationDelay = Math.min(i * base, cap * base) + "ms";
    void el.offsetWidth;
    el.classList.add("fx-in");
  });
}
// Aurora boreal ("iglu"): 3 blobs de luz à deriva num canvas fixo atrás do app.

// Cena hero estilo igloo.inc: dunas de neve com brilho + iglu de blocos,
// névoa baixa e parallax no mouse. Tudo procedural em 2D (sem Three.js,
// sem CDN): leve o bastante para rodar no celular no registro matinal.
function initScene() {
  const cv = $("scene");
  if (!cv || REDUCED) { if (cv) cv.remove(); return; }
  const ctx = cv.getContext("2d");
  let W, H, t = Math.random() * 1000, mx = .5;
  const fit = () => {
    const d = Math.min(1.5, devicePixelRatio || 1);
    W = cv.width = cv.clientWidth * d || innerWidth * d;
    H = cv.height = cv.clientHeight * d || innerHeight * d;
  };
  fit(); addEventListener("resize", fit);
  addEventListener("pointermove", (e) => { mx = e.clientX / innerWidth; }, { passive: true });
  const dune = (base, amp, f1, f2, p1, p2) => (x) =>
    base + Math.sin(x * f1 + p1 + t * .00004) * amp + Math.sin(x * f2 + p2) * amp * .35;
  (function frame() {
    t += 16;
    ctx.clearRect(0, 0, W, H);
    const px = (mx - .5) * W * .02; // parallax sutil
    // céu gelo com vinheta fria
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#aeb7c6"); sky.addColorStop(.55, "#a2abb9"); sky.addColorStop(1, "#c6cdd8");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    // sol difuso atrás das dunas
    const sg = ctx.createRadialGradient(W * .72, H * .3, 0, W * .72, H * .3, W * .3);
    sg.addColorStop(0, "rgba(255,255,255,.5)"); sg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.translate(px, 0);
    // duna distante
    ctx.beginPath(); ctx.moveTo(-W * .05, H);
    for (let x = -W * .05; x <= W * 1.05; x += W / 90) ctx.lineTo(x, dune(H * .52, H * .045, 3 / W, 9 / W, 1.2, 4)(x));
    ctx.lineTo(W * 1.05, H); ctx.closePath();
    ctx.fillStyle = "#9aa4b4"; ctx.fill();
    // duna média com sombra fria
    ctx.beginPath(); ctx.moveTo(-W * .05, H);
    const mid = dune(H * .63, H * .05, 2.2 / W, 7 / W, 4, 1.5);
    for (let x = -W * .05; x <= W * 1.05; x += W / 90) ctx.lineTo(x, mid(x));
    ctx.lineTo(W * 1.05, H); ctx.closePath();
    const mg = ctx.createLinearGradient(0, H * .5, 0, H);
    mg.addColorStop(0, "#b6beca"); mg.addColorStop(1, "#cdd3dd");
    ctx.fillStyle = mg; ctx.fill();
    // primeiro plano claro
    ctx.beginPath(); ctx.moveTo(-W * .05, H);
    const front = dune(H * .76, H * .04, 1.6 / W, 5 / W, 2.4, .6);
    for (let x = -W * .05; x <= W * 1.05; x += W / 90) ctx.lineTo(x, front(x));
    ctx.lineTo(W * 1.05, H); ctx.closePath();
    ctx.fillStyle = "#dde3ec"; ctx.fill();
    // linha de luz no topo da duna frontal
    ctx.beginPath();
    for (let x = -W * .05; x <= W * 1.05; x += W / 90) { const y = front(x); x < 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = Math.max(1, H * .003); ctx.stroke();
    ctx.restore();
    drawIgloo(ctx, W * .5 + px * 2, front(W * .5), Math.min(W, H));
    // névoa baixa à deriva
    ctx.fillStyle = "rgba(238,246,255,.10)";
    for (let i = 0; i < 3; i++) {
      const y = H * (.72 + i * .06) + Math.sin(t * .0004 + i * 2) * H * .008;
      ctx.beginPath(); ctx.ellipse(W * .5 + Math.sin(t * .0002 + i) * W * .1, y, W * .45, H * .03, 0, 0, 6.29); ctx.fill();
    }
    requestAnimationFrame(frame);
  })();
}
// Iglu de blocos com sombra suave + túnel de entrada escuro.
function drawIgloo(ctx, cx, groundY, S) {
  const R = S * .30;
  ctx.save();
  ctx.translate(cx, groundY);
  // sombra no chão
  ctx.fillStyle = "rgba(20,26,38,.18)";
  ctx.beginPath(); ctx.ellipse(0, S * .012, R * 1.25, S * .035, 0, 0, 6.29); ctx.fill();
  // cúpula: anéis de blocos com rejunte
  const rows = 5;
  for (let r = 0; r < rows; r++) {
    const f = r / (rows - 1);                    // 0 base → 1 topo
    const w = R * 2 * Math.sqrt(Math.max(.08, 1 - f * f * .92));
    const y0 = -f * R * 1.02, h = (R * 1.02) / rows;
    const n = Math.max(3, Math.round(w / (R * .30)));
    for (let b = 0; b < n; b++) {
      const off = (r % 2) * (w / n / 2);
      const x = -w / 2 + (b + .5) * (w / n) + off * .3;
      const g = ctx.createLinearGradient(0, y0 - h, 0, y0);
      g.addColorStop(0, "#e8edf4"); g.addColorStop(1, "#b9c1cf");
      ctx.fillStyle = g;
      ctx.strokeStyle = "rgba(20,26,38,.22)"; ctx.lineWidth = Math.max(1, S * .0016);
      const bw = w / n * .92;
      roundRect(ctx, x - bw / 2, y0 - h, bw, h * .94, h * .22); ctx.fill(); ctx.stroke();
    }
  }
  // túnel de entrada
  const tw = R * .62, th = R * .52;
  const tg = ctx.createLinearGradient(0, -th, 0, 0);
  tg.addColorStop(0, "#c3cad6"); tg.addColorStop(1, "#aeb7c6");
  ctx.fillStyle = tg; ctx.strokeStyle = "rgba(20,26,38,.25)";
  roundRect(ctx, -tw / 2 + R * .18, -th, tw, th + S * .01, th * .45); ctx.fill(); ctx.stroke();
  // boca escura
  ctx.fillStyle = "#10141d";
  roundRect(ctx, -tw * .30 + R * .18, -th * .72, tw * .6, th * .74, th * .32); ctx.fill();
  // brilho do topo
  ctx.fillStyle = "rgba(255,255,255,.35)";
  ctx.beginPath(); ctx.ellipse(-R * .3, -R * .82, R * .3, R * .1, -.4, 0, 6.29); ctx.fill();
  ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
// "Click to explore": rola suave até o app (como o portal do igloo.inc).
function initExplore() {
  const b = $("explore");
  if (!b) return;
  b.onclick = () => {
    const app = $("app").classList.contains("hidden") ? $("login") : $("app");
    app.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
  };
}

function initAmbient() {
  const cv = $("ambient");
  if (!cv || REDUCED) { if (cv) cv.remove(); const sn = $("snow"); if (sn) sn.remove(); return; }
  const ctx = cv.getContext("2d");
  let W, H, t = Math.random() * 1000;
  const fit = () => {
    const d = Math.min(1.5, devicePixelRatio || 1);
    W = cv.width = innerWidth * d; H = cv.height = innerHeight * d;
    cv.style.width = innerWidth + "px"; cv.style.height = innerHeight + "px";
  };
  fit(); addEventListener("resize", fit);
  const blobs = [
    { h: 222, a: .20, r: .42, sx: .00016, sy: .00023, px: .18, py: .06 },
    { h: 205, a: .16, r: .38, sx: .00011, sy: .00019, px: .62, py: .02 },
    { h: 190, a: .14, r: .34, sx: .00013, sy: .00015, px: .85, py: .10 },
  ];
  let mx = .5, my = .3;
  addEventListener("pointermove", (e) => {
    mx = e.clientX / innerWidth; my = e.clientY / innerHeight;
  }, { passive: true });
  (function frame() {
    t += 16;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    blobs.forEach((b, i) => {
      const x = (b.px + Math.sin(t * b.sx + i * 2.1) * .14 + (mx - .5) * .06) * W;
      const y = (b.py + Math.cos(t * b.sy + i * 1.7) * .10 + (my - .3) * .04) * H;
      const r = b.r * Math.max(W, H);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `hsla(${b.h},80%,65%,${b.a})`);
      g.addColorStop(1, "hsla(0,0%,0%,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    });
    requestAnimationFrame(frame);
  })();
}
// Neve: flocos leves caindo com deriva senoidal (pausa fora da aba).
function initSnow() {
  const cv = $("snow");
  if (!cv || REDUCED || document.hidden) return;
  const ctx = cv.getContext("2d");
  const d = Math.min(1.5, devicePixelRatio || 1);
  cv.width = innerWidth * d; cv.height = innerHeight * d;
  const N = Math.min(90, Math.floor(innerWidth / 14));
  const flakes = Array.from({ length: N }, () => ({
    x: Math.random() * cv.width, y: Math.random() * cv.height,
    r: (.6 + Math.random() * 1.8) * d, s: (.25 + Math.random() * .7) * d,
    ph: Math.random() * 6.28, sw: (.3 + Math.random() * .8) * d, o: .25 + Math.random() * .5,
  }));
  let visible = true;
  document.addEventListener("visibilitychange", () => { visible = !document.hidden; if (visible) requestAnimationFrame(frame); });
  addEventListener("resize", () => { cv.width = innerWidth * d; cv.height = innerHeight * d; });
  (function frame() {
    if (!visible) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "#ffffff";
    for (const f of flakes) {
      f.y += f.s; f.ph += .008;
      f.x += Math.sin(f.ph) * f.sw * .3;
      if (f.y > cv.height + 4) { f.y = -4; f.x = Math.random() * cv.width; }
      ctx.globalAlpha = f.o;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 6.29); ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  })();
}
initAmbient();
initSnow();
initScene();
initExplore();
// Loader ASCII estilo igloo.inc: some com fade quando a cena está pronta.
addEventListener("load", () => setTimeout(() => $("loader") && $("loader").classList.add("done"), 250));
setTimeout(() => $("loader") && $("loader").classList.add("done"), 3500); // fallback

/* ---------- navegação por views ---------- */
const VIEWS = { overview: "Visão geral", entries: "Registros", compare: "Antes / Depois", goal: "Meta", forecast: "Estimativa", admin: "Usuários" };
function go(view) {
  for (const v of Object.keys(VIEWS)) {
    const el = $("view-" + v);
    const show = v === view;
    el.classList.toggle("hidden", !show);
    if (show) { el.style.animation = "none"; void el.offsetWidth; el.style.animation = ""; }
  }
  document.querySelectorAll("#sidenav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("crumb").textContent = VIEWS[view] || view;
  if (view === "compare") renderCompare(CACHE);
  if (view === "goal") renderGoal();
  if (view === "forecast") renderForecast();
}
document.querySelectorAll("#sidenav button").forEach((b) => { b.onclick = () => go(b.dataset.view); });
$("q").addEventListener("input", () => renderEntries(CACHE));
document.querySelectorAll("#win-seg button").forEach((b) => { b.onclick = () => {
  WIN = Number(b.dataset.w);
  document.querySelectorAll("#win-seg button").forEach((x) => x.classList.toggle("active", x === b));
  refresh();
};});

/* ---------- boot ---------- */
async function boot() {
  try {
    const me = await fetch("/api/me").then((r) => (r.ok ? r.json() : null));
    if (me && me.username) { CSRF = me.csrf; ME = me; showApp(); return; }
  } catch {}
  $("login").classList.remove("hidden");
}
function showApp() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  const initial = esc(ME.username).charAt(0).toUpperCase();
  $("userbox").innerHTML = `<span class="avatar">${initial}</span><span class="uname">${esc(ME.username)} · ${esc(ME.role)}</span>`;
  $("f-day").value = new Date().toISOString().slice(0, 10);
  api("/api/flags").then((j) => { FLAG_LABELS = j.flags || {}; }).catch(() => {}).finally(() => {
    $("f-flags").innerHTML = "<legend>Dia atípico? <span class='muted'>— pondera menos no cálculo</span></legend>" + flagsHTML(0);
    $("e-flags").innerHTML = "<legend>Dia atípico?</legend>" + flagsHTML(0);
  });
  if (ME.role === "admin") { $("nav-admin").classList.remove("hidden"); loadUsers(); }
  refresh();
}
$("out").onclick = async () => { await fetch("/api/logout", { method: "POST", headers: { "X-CSRF-Token": CSRF } }); location.reload(); };

$("l-btn").onclick = async () => {
  $("l-err").textContent = "";
  try {
    const j = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("l-user").value.trim(), password: $("l-pass").value }) }).then(async (r) => {
      const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || "falha"); return b;
    });
    CSRF = j.csrf; ME = { username: j.username, role: j.role }; showApp();
  } catch (e) { $("l-err").textContent = e.message; }
};
$("l-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("l-btn").click(); });
$("l-user").addEventListener("keydown", (e) => { if (e.key === "Enter") $("l-btn").click(); });

/* ---------- novo dia (modal) ---------- */
$("new-day").onclick = () => {
  $("f-err").textContent = "";
  $("f-day").value = new Date().toISOString().slice(0, 10);
  $("dlg-day").showModal();
};
$("day-form").addEventListener("submit", async (ev) => {
  if (ev.submitter && ev.submitter.value === "cancel") return; // fecha sem salvar
  ev.preventDefault();
  $("f-err").textContent = "";
  const btn = $("f-btn");
  try {
    btn.disabled = true; btn.textContent = "Salvando…";
    const created = await api("/api/entries", { method: "POST", body: JSON.stringify({
      day: $("f-day").value, weight_kg: Number($("f-weight").value),
      calories: Number($("f-cal").value), exercise_kcal: Number($("f-ex").value || 0),
      exercise_src: $("f-exsrc").value,
      note: $("f-note").value, flagsKeys: checkedFlags("#f-flags") }) });
    const files = $("f-media").files;
    let upErr = "";
    if (files && files.length) {
      for (const f of files) {
        const fd = new FormData(); fd.append("file", f);
        try {
          const r = await fetch(`/api/entries/${created.id}/media`, { method: "POST", headers: { "X-CSRF-Token": CSRF }, body: fd });
          if (!r.ok) upErr += ` ${(await r.json().catch(() => ({}))).error || "falha no upload"} (${f.name})`;
        } catch { upErr += ` erro de rede (${f.name})`; }
      }
    }
    $("f-weight").value = ""; $("f-cal").value = ""; $("f-ex").value = ""; $("f-note").value = ""; $("f-media").value = "";
    document.querySelectorAll("#f-flags input:checked").forEach((c) => (c.checked = false));
    $("dlg-day").close();
    await refresh();
    go("entries");
    if (upErr) { $("f-err").textContent = ""; await askConfirm("Anexos com erro", "Dia salvo, mas com erro no anexo:" + upErr, "OK"); }
  } catch (e) { $("f-err").textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = "Salvar"; }
});

/* ---------- editar dia (modal) ---------- */
let EDIT_ID = null;
function openEdit(e) {
  EDIT_ID = e.id;
  $("e-day").textContent = "· " + e.day;
  $("e-weight").value = e.weight_kg;
  $("e-cal").value = e.calories;
  $("e-ex").value = e.exercise_kcal || 0;
  $("e-exsrc").value = e.exercise_src || "est";
  $("e-note").value = e.note || "";
  $("e-flags").innerHTML = "<legend>Dia atípico?</legend>" + flagsHTML(e.flags | 0);
  $("e-err").textContent = "";
  $("dlg-edit").showModal();
}
$("edit-form").addEventListener("submit", async (ev) => {
  if (ev.submitter && ev.submitter.value === "cancel") return;
  ev.preventDefault();
  try {
    let flags = 0;
    for (const k of checkedFlags("#e-flags")) flags |= (1 << FLAGS_ORDER.indexOf(k));
    await api(`/api/entries/${EDIT_ID}`, { method: "PUT", body: JSON.stringify({
      weight_kg: Number($("e-weight").value), calories: Number($("e-cal").value),
      exercise_kcal: Number($("e-ex").value || 0), exercise_src: $("e-exsrc").value,
      note: $("e-note").value, flags }) });
    $("dlg-edit").close();
    refresh();
  } catch (e) { $("e-err").textContent = e.message; }
});

/* ---------- dados ---------- */
async function refresh() {
  const [stats, data, profile] = await Promise.all([
    api("/api/stats" + (WIN ? `?window=${WIN}` : "")),
    api("/api/entries"),
    api("/api/profile").catch(() => null),
  ]);
  STATS = stats; PROFILE = profile;
  CACHE = data.entries || [];
  $("nav-count").textContent = CACHE.length || "";
  renderStats(stats); renderChart(CACHE); renderEntries(CACHE); renderCompare(CACHE); renderGoal();
}

function renderStats(s) {
  const pill = $("conf-pill");
  if (!s.ready) {
    $("stats").innerHTML = `<p class="muted">${esc(s.message)}</p>`;
    pill.textContent = "aguardando dados"; pill.className = "pill";
    $("metodo").textContent = ""; return;
  }
  const warn = s.plausivel ? "" : `<p class="err">Valor fora da faixa plausível — confira pesos/calorias ou adicione mais dias.</p>`;
  const trend = (s.slopeKgDay * 7).toFixed(2);
  const dSign = s.deltaKg > 0 ? "+" : "";
  pill.textContent = "confiança " + s.confianca;
  pill.className = "pill " + (s.confianca === "alta" ? "ok" : s.confianca === "média" ? "warn" : "");
  $("stats").innerHTML = `
    <div class="hero"><b data-count="${s.tmbEstimada}">${s.tmbEstimada}</b><span>kcal/dia ± ${s.margemTmb}</span></div>
    <div class="range"><i style="width:100%"></i></div>
    <div class="range-lbl"><span>${s.tmbMin}</span><span>faixa de confiança 95%</span><span>${s.tmbMax}</span></div>
    <div class="props">
      <div class="prop"><small>Gasto diário</small><b>${s.gastoDiario}</b><span>${s.gastoMin}–${s.gastoMax} · ×${s.atividade}</span></div>
      <div class="prop"><small>Média líquida (véspera)</small><b>${s.avgLiquidas}</b><span>${s.avgCalories} ingeridas − ${s.avgExercicio} exercício</span></div>
      <div class="prop"><small>Tendência</small><b>${s.slopeKgDay > 0 ? "+" : ""}${trend} kg/sem</b><span>total ${dSign}${s.deltaKg} kg</span></div>
      <div class="prop"><small>Ruído típico</small><b>±${s.residuoTipicoKg} kg</b><span>R² ${s.r2} · n efetivo ${s.diasEfetivos}</span></div>
    </div>
    <p class="footline">${s.n} dias${s.totalN > s.n ? ` (últimos ${s.n} de ${s.totalN})` : ""} · ${s.diasAtipicos} atípico(s) · ${esc(s.firstWeight)} → ${esc(s.lastWeight)} kg</p>${warn}`;
  $("metodo").textContent = s.metodo;
  countUp(document.querySelector("#stats .hero b"), s.tmbEstimada);
  staggerChildren($("stats"), ".prop");
  // outliers → sugestão de marcar
  const ob = $("outliers");
  if (s.outliers && s.outliers.length) {
    ob.innerHTML = s.outliers.map((o, i) => `<div class="outlier" data-day="${esc(o.day)}">
      <span><b>${esc(o.day)}</b> (${esc(o.weight_kg)} kg) foge da tendência em ${o.residuo > 0 ? "+" : ""}${o.residuo} kg. Marcar como atípico?</span>
      <button class="btn-ghost" data-oi="${i}">Marcar</button></div>`).join("");
    ob.querySelectorAll("button").forEach((b) => { b.onclick = async () => {
      const o = s.outliers[Number(b.dataset.oi)];
      const cur = CACHE.find((x) => x.day === o.day);
      if (!cur) return;
      let flags = (cur.flags | 0) || 0;
      flags |= 1 << FLAGS_ORDER.indexOf("outro");
      await api(`/api/entries/${cur.id}`, { method: "PUT", body: JSON.stringify({
        weight_kg: cur.weight_kg, calories: cur.calories, exercise_kcal: cur.exercise_kcal || 0,
        exercise_src: cur.exercise_src || "est", note: cur.note, flags }) });
      refresh();
    };});
  } else ob.innerHTML = "";
  renderForecast();
}

function renderChart(entries) {
  const c = $("chart"), ctx = c.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = 900, H = 280;
  if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const pts = [...entries].reverse();
  if (!pts.length) { ctx.fillStyle = "#5c6474"; ctx.font = "12px Inter, sans-serif"; ctx.fillText("Registre o primeiro dia para ver o gráfico", 24, 44); return; }
  const ws = pts.map((e) => e.weight_kg);
  let min = Math.min(...ws), max = Math.max(...ws);
  if (max - min < 1) { min -= 0.5; max += 0.5; }
  const X = (i) => 52 + (i * (W - 72)) / Math.max(1, pts.length - 1);
  const Y = (w) => 22 + (1 - (w - min) / (max - min)) * (H - 56);
  // linha principal com brilho + desenho progressivo (efeito "draw");
  // re-desenha só quando os dados mudam; hover não re-anima.
  const drawKey = pts.map((e) => e.day + ":" + e.weight_kg).join("|");
  const same = renderChart._key === drawKey;
  renderChart._key = drawKey;
  if (REDUCED || same || pts.length < 2) {
    paintBase(); paintMain(1); paintOverlay();
  } else {
    const t0 = performance.now();
    const dur = Math.min(900, 300 + pts.length * 40);
    renderChart._raf && cancelAnimationFrame(renderChart._raf);
    const frame = () => {
      const p = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      ctx.clearRect(0, 0, W, H);
      paintBase(); paintMain(e); paintOverlay();
      if (p < 1) renderChart._raf = requestAnimationFrame(frame);
    };
    frame();
  }
  function paintBase() {
    ctx.font = "11px Inter, sans-serif";
    ctx.strokeStyle = "rgba(20,26,38,.10)"; ctx.fillStyle = "#828a99"; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) { const w = min + ((max - min) * g) / 4; ctx.beginPath(); ctx.moveTo(52, Y(w)); ctx.lineTo(W - 20, Y(w)); ctx.stroke(); ctx.fillText(w.toFixed(1), 10, Y(w) + 4); }
  }
  function paintMain(p) {
    const n = Math.max(2, Math.ceil(pts.length * p));
    const seg = pts.slice(0, n);
    // área (fade-in com o progresso)
    ctx.save();
    ctx.globalAlpha = .25 + .75 * p;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(61,71,184,.28)"); grad.addColorStop(1, "rgba(61,71,184,0)");
    ctx.beginPath();
    seg.forEach((e, i) => (i ? ctx.lineTo(X(i), Y(e.weight_kg)) : ctx.moveTo(X(i), Y(e.weight_kg))));
    ctx.lineTo(X(seg.length - 1), H - 26); ctx.lineTo(X(0), H - 26); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    ctx.restore();
    // brilho sob a linha + linha principal
    ctx.save();
    ctx.shadowColor = "rgba(61,71,184,.45)"; ctx.shadowBlur = 8;
    ctx.strokeStyle = "#3d47b8"; ctx.lineWidth = 2.2; ctx.lineJoin = "round"; ctx.beginPath();
    seg.forEach((e, i) => (i ? ctx.lineTo(X(i), Y(e.weight_kg)) : ctx.moveTo(X(i), Y(e.weight_kg))));
    ctx.stroke();
    ctx.restore();
    ctx.lineWidth = 1;
  }
  function paintOverlay() {
  // linha do ESPERADO (reta ajustada, pontilhada branca) a partir da trajetória
  const traj = (STATS && STATS.trajetoria) || [];
  const expByDay = Object.fromEntries(traj.map((t) => [t.day, t.esperado]));
  if (traj.length >= 2 && pts.some((e) => expByDay[e.day] !== undefined)) {
    ctx.strokeStyle = "rgba(60,68,84,.55)"; ctx.lineWidth = 1.5; ctx.setLineDash([2, 4]); ctx.beginPath();
    let started = false;
    pts.forEach((e, i) => {
      const v = expByDay[e.day];
      if (v === undefined) return;
      started && i ? ctx.lineTo(X(i), Y(v)) : (ctx.moveTo(X(i), Y(v)), started = true);
    });
    ctx.stroke(); ctx.setLineDash([]);
  }
  // faixa da projeção / dias de retenção do ciclo: fundo sutil
  pts.forEach((e, i) => {
    const t = expByDay[e.day] !== undefined ? traj.find((x) => x.day === e.day) : null;
    if (t && ["menstrual", "lutea"].includes(t.fase)) {
      ctx.fillStyle = "rgba(242,201,76,.07)";
      const bw = pts.length > 1 ? (X(1) - X(0)) : 20;
      ctx.fillRect(X(i) - bw / 2, 22, bw, H - 56);
    }
  });
  // média móvel de 7 dias (suaviza o ruído diário)
  if (pts.length >= 3) {
    ctx.strokeStyle = "#4cc38a"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.beginPath();
    pts.forEach((e, i) => {
      const a = Math.max(0, i - 6);
      const m = pts.slice(a, i + 1).reduce((s, v) => s + v.weight_kg, 0) / (i - a + 1);
      i ? ctx.lineTo(X(i), Y(m)) : ctx.moveTo(X(i), Y(m));
    });
    ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
  }
  pts.forEach((e, i) => {
    const flag = (e.flags | 0) !== 0;
    ctx.beginPath(); ctx.arc(X(i), Y(e.weight_kg), flag ? 5 : 3.5, 0, 7);
    ctx.fillStyle = flag ? "#b98a1d" : "#3d47b8"; ctx.fill();
    ctx.strokeStyle = "#f2f5fa"; ctx.stroke();
  });
  ctx.fillStyle = "#828a99";
  pts.forEach((e, i) => { if (i % Math.ceil(pts.length / 8) === 0) ctx.fillText(e.day.slice(5), X(i) - 12, H - 8); });
  } // paintOverlay
} // renderChart

/* ---------- registros como issues ---------- */
function filteredEntries(entries) {
  const q = $("q").value.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => (e.day + " " + (e.note || "") + " " + e.weight_kg + " " + flagNames(e.flags).join(" ")).toLowerCase().includes(q));
}
function miniHtml(m, extra) {
  if (m) {
    const src = "/media/" + encodeURIComponent(m.stored);
    return m.mime.startsWith("image/")
      ? `<img class="mini" src="${src}" loading="lazy" alt="">`
      : `<video class="mini" src="${src}" preload="metadata"></video>`;
  }
  return `<span class="mini more">${extra}</span>`;
}
function renderEntries(entries) {
  const box = $("entries");
  const list = filteredEntries(entries);
  if (!list.length) { box.innerHTML = `<div class="empty">${entries.length ? "Nada bate com o filtro." : "Nenhum registro. Clique em “+ Novo dia”."}</div>`; return; }
  box.innerHTML = list.map((e) => {
    const med = e.media || [];
    const thumbs = med.slice(0, 3).map((m) => miniHtml(m)).join("") + (med.length > 3 ? miniHtml(null, "+" + (med.length - 3)) : "");
    const bits = [];
    if (e.note) bits.push(esc(e.note));
    if ((e.exercise_kcal | 0) > 0) bits.push(`<span class="sub">−${e.exercise_kcal} exercício</span>`);
    const note = bits.length ? bits.join(" · ") : `<span class="sub">—</span>`;
    const at = (e.flags | 0) ? ` <span class="pill warn">atípico</span>` : "";
    const open = EXPANDED.has(e.id);
    return `
    <div class="rowline" data-id="${e.id}">
      <span class="rid">${esc(e.day)}</span>
      <span class="rw">${esc(e.weight_kg)} kg</span>
      <span class="rc" title="calorias da véspera (dia anterior)">${esc(e.calories)}</span>
      <span class="rn">${note}${at}</span>
      <span class="rm">${thumbs}
        <span class="ract">
          <button class="iconbtn" data-act="edit">Editar</button>
          <button class="iconbtn danger" data-act="del">Excluir</button>
        </span>
      </span>
    </div>
    ${open ? detailHtml(e) : ""}`;
  }).join("");
  staggerChildren(box, ".rowline");
  box.querySelectorAll(".rowline").forEach((el) => {
    const id = Number(el.dataset.id);
    el.onclick = (ev) => {
      if (ev.target.closest("button")) return;
      EXPANDED.has(id) ? EXPANDED.delete(id) : EXPANDED.add(id);
      renderEntries(CACHE);
    };
    el.querySelector('[data-act="edit"]').onclick = async () => {
      const cur = CACHE.find((x) => x.id === id);
      if (cur) openEdit(cur);
    };
    el.querySelector('[data-act="del"]').onclick = async () => {
      const ok = await askConfirm("Excluir este dia?", "O registro e todas as mídias dele serão apagados.", "Excluir");
      if (!ok) return;
      await api(`/api/entries/${id}`, { method: "DELETE" });
      EXPANDED.delete(id); refresh();
    };
  });
  box.querySelectorAll(".detail").forEach((d) => wireDetail(d));
}
function detailHtml(e) {
  const med = e.media || [];
  const items = med.map((x) => {
    const src = "/media/" + encodeURIComponent(x.stored);
    const view = x.mime.startsWith("image/")
      ? `<img src="${src}" loading="lazy" alt="">`
      : `<video src="${src}" preload="metadata"></video>`;
    return `<span class="thumb" data-mid="${x.id}">${view}<i title="excluir mídia">×</i></span>`;
  }).join("");
  const liq = (e.calories | 0) - (e.exercise_kcal | 0);
  return `<div class="detail" data-id="${e.id}">
    <div class="small" style="color:var(--mut)">Pesagem ${esc(e.day)} de manhã · líquidas da véspera: <b style="color:var(--ink2)">${liq} kcal</b> (${e.calories} ingeridas − ${e.exercise_kcal | 0} exercício)</div>
    ${(e.flags | 0) ? `<div class="flag-list">${esc(flagNames(e.flags).join(" · "))}</div>` : ""}
    ${e.note ? `<div class="small" style="color:var(--ink2)">${esc(e.note)}</div>` : ""}
    <div class="thumbs">${items || '<span class="muted small">Sem mídia neste dia.</span>'}</div>
    <div style="margin-top:10px;display:flex;gap:8px">
      <button class="btn-ghost" data-dact="up">Anexar foto/vídeo</button>
      <input type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm">
    </div>
  </div>`;
}
function wireDetail(d) {
  const id = d.dataset.id;
  const file = d.querySelector("input[type=file]");
  d.querySelector('[data-dact="up"]').onclick = () => file.click();
  file.onchange = async () => {
    if (!file.files[0]) return;
    const fd = new FormData(); fd.append("file", file.files[0]);
    const r = await fetch(`/api/entries/${id}/media`, { method: "POST", headers: { "X-CSRF-Token": CSRF }, body: fd });
    if (!r.ok) { $("f-err").textContent = ""; await askConfirm("Upload falhou", (await r.json().catch(() => ({}))).error || "falha no upload", "OK"); return; }
    refresh();
  };
  d.querySelectorAll(".thumb img").forEach((img) => { img.onclick = () => { $("lb-img").src = img.src; $("lightbox").showModal(); }; });
  d.querySelectorAll(".thumb video").forEach((v) => { v.onclick = () => v.paused ? v.play() : v.pause(); });
  d.querySelectorAll(".thumb i").forEach((x) => { x.onclick = async (ev) => {
    ev.stopPropagation();
    const ok = await askConfirm("Excluir esta mídia?", "O arquivo será apagado.", "Excluir");
    if (!ok) return;
    await api(`/api/media/${x.parentElement.dataset.mid}`, { method: "DELETE" }); refresh();
  };});
}
$("lb-close").onclick = () => $("lightbox").close();

/* ---------- antes / depois ---------- */
function renderCompare(entries) {
  const pts = [...entries].reverse();
  const opts = pts.map((e) => `<option value="${e.id}">${esc(e.day)} (${esc(e.weight_kg)}kg)</option>`).join("");
  const pa = $("cmp-a").value, pb = $("cmp-b").value;
  $("cmp-a").innerHTML = opts; $("cmp-b").innerHTML = opts;
  if (pts.length >= 2) {
    $("cmp-a").value = [...$("cmp-a").options].some((o) => o.value === pa) ? pa : pts[0].id;
    $("cmp-b").value = [...$("cmp-b").options].some((o) => o.value === pb) ? pb : pts[pts.length - 1].id;
  }
}
$("cmp-btn").onclick = async () => {
  const data = await api("/api/entries");
  const byId = Object.fromEntries(data.entries.map((e) => [e.id, e]));
  const a = byId[$("cmp-a").value], b = byId[$("cmp-b").value];
  if (!a || !b) return;
  const first = (e) => (e.media || []).filter((x) => x.mime.startsWith("image/"))[0] || (e.media || [])[0];
  const ma = first(a), mb = first(b);
  const dw = (b.weight_kg - a.weight_kg).toFixed(1);
  const cls = dw < 0 ? "delta-neg" : dw > 0 ? "delta-pos" : "";
  const sign = dw > 0 ? "+" : "";
  $("cmp").innerHTML = ["a", "b"].map((k) => {
    const e = k === "a" ? a : b, m = k === "a" ? ma : mb;
    const inner = m ? (m.mime.startsWith("image/") ? `<img src="/media/${esc(m.stored)}">` : `<video src="/media/${esc(m.stored)}" controls></video>`)
      : `<p class="muted small" style="padding:24px">sem mídia neste dia</p>`;
    const extra = k === "b" ? ` <span class="${cls}">(${sign}${dw} kg)</span>` : "";
    return `<figure><figcaption><b>${esc(e.day)}</b> — ${esc(e.weight_kg)} kg · ${esc(e.calories)} kcal${extra}</figcaption>${inner}</figure>`;
  }).join("");
};

/* ---------- admin ---------- */
async function loadUsers() {
  try {
    const { users } = await api("/api/users");
    $("users").innerHTML = `<table><tr><th>Usuário</th><th>Papel</th><th>Falhas</th><th>Bloqueio</th><th>Ações</th></tr>` +
      users.map((u) => `<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.role)}</td><td>${u.failed_attempts}</td>
        <td>${u.locked_until > Date.now() ? "bloqueado" : "—"}</td>
        <td><button class="btn-ghost" data-u="${u.id}" data-a="unlock">Desbloquear</button>
        <button class="btn-ghost" data-u="${u.id}" data-a="pw">Nova senha</button>
        <button class="btn-ghost" data-u="${u.id}" data-a="del">Excluir</button></td></tr>`).join("") + `</table>`;
    $("users").querySelectorAll("button").forEach((b) => { b.onclick = async () => {
      const id = b.dataset.u;
      if (b.dataset.a === "unlock") await api(`/api/users/${id}/unlock`, { method: "POST" });
      if (b.dataset.a === "pw") {
        const p = await askValue("Usuários", "Nova senha", "Senha (mínimo 12 caracteres)", "", "password");
        if (p === null || p === "") return;
        try { await api(`/api/users/${id}/reset-password`, { method: "POST", body: JSON.stringify({ password: p }) }); }
        catch (e) { await askConfirm("Erro", e.message, "OK"); return; }
      }
      if (b.dataset.a === "del") {
        const ok = await askConfirm("Excluir usuário?", "O usuário e TODOS os dados dele serão apagados.", "Excluir");
        if (!ok) return;
        try { await api(`/api/users/${id}`, { method: "DELETE" }); }
        catch (e) { await askConfirm("Erro", e.message, "OK"); return; }
      }
      loadUsers();
    };});
  } catch (e) { $("users").textContent = e.message; }
}
$("a-btn").onclick = async () => {
  $("a-err").textContent = "";
  try { await api("/api/users", { method: "POST", body: JSON.stringify({ username: $("a-user").value.trim(), password: $("a-pass").value, role: $("a-role").value }) });
    $("a-user").value = ""; $("a-pass").value = ""; loadUsers();
  } catch (e) { $("a-err").textContent = e.message; }
};

/* ---------- estimativa: esperado x real + projeção ---------- */
const FASE_LABEL = { menstrual: "Menstrual", folicular: "Folicular", ovulatoria: "Ovulatória", lutea: "Lútea" };
function renderForecast() {
  const fb = $("forecast-box"), pb = $("proj-box");
  const s = STATS;
  if (!s || !s.ready || !s.trajetoria) {
    fb.innerHTML = `<p class="muted small">Adicione pelo menos 2 dias de registros.</p>`;
    pb.innerHTML = "";
    return;
  }
  const rows = [...s.trajetoria].reverse().slice(0, 14).reverse();
  fb.innerHTML = `<table class="fc-table"><tr><th>Dia</th><th>Esperado</th><th>Real</th><th>Diferença</th><th>Fase</th></tr>` +
    rows.map((t) => {
      const d = t.real - t.esperado;
      const cls = Math.abs(d) <= (s.residuoTipicoKg || 0.3) ? "conf-alta" : Math.abs(d) <= 2 * (s.residuoTipicoKg || 0.3) ? "conf-media" : "err";
      const today = t.day === new Date().toISOString().slice(0, 10) ? ' class="today"' : "";
      const fase = t.fase ? `<span class="fc-badge${["menstrual", "lutea"].includes(t.fase) ? " ret" : ""}">${esc(FASE_LABEL[t.fase] || t.fase)}</span>` : "—";
      return `<tr${today}><td>${esc(t.day)}</td><td>${t.esperado.toFixed(1)} kg</td><td>${t.real.toFixed(1)} kg</td><td class="${cls}">${d > 0 ? "+" : ""}${d.toFixed(1)} kg</td><td>${fase}</td></tr>`;
    }).join("") + `</table>
    <p class="muted small">Diferença dentro do ruído típico (±${s.residuoTipicoKg} kg) = dia normal. Acima disso, considere marcar como atípico.</p>`;
  const proj = (s.projecao || []).filter((p, i) => i % 3 === 2 || i === (s.projecao || []).length - 1).slice(0, 10);
  pb.innerHTML = proj.length
    ? `<table class="fc-table"><tr><th>Dia</th><th>Esperado</th><th>Faixa</th></tr>` +
      proj.map((p) => `<tr><td>${esc(p.day)}</td><td><b>${p.esperado.toFixed(1)} kg</b></td><td class="muted">${p.min.toFixed(1)} – ${p.max.toFixed(1)}</td></tr>`).join("") + `</table>
      <p class="muted small">Ritmo atual de ${s.slopeKgDay > 0 ? "+" : ""}${(s.slopeKgDay * 7).toFixed(2)} kg/sem. A faixa alarga com o tempo — é a incerteza acumulada.</p>`
    : `<p class="muted small">Sem projeção.</p>`;
}

/* ---------- meta ---------- */
function renderGoal() {
  if (!PROFILE) return;
  $("g-kg").value = PROFILE.goal_kg ?? "";
  $("g-day").value = PROFILE.goal_day ?? "";
  const sel = $("g-act");
  if (!sel.options.length) {
    const levels = PROFILE.levels || [1.2, 1.375, 1.55, 1.725];
    sel.innerHTML = levels.map((v) => `<option value="${v}">${esc(ACT_LABELS[v] || ("×" + v))}</option>`).join("");
  }
  sel.value = String(PROFILE.activity ?? 1.2);
  // ciclo
  $("c-on").checked = !!PROFILE.cycle_enabled;
  $("c-last").value = PROFILE.cycle_last ?? "";
  $("c-len").value = PROFILE.cycle_len ?? 28;
  const box = $("goal-box");
  const s = STATS;
  if (!PROFILE.goal_kg) {
    box.innerHTML = `<p class="muted small">Defina um peso-alvo para ver a projeção: quando você chega lá no ritmo atual e quantas kcal/dia permitem chegar até o dia-alvo.</p>`;
    return;
  }
  if (!s || !s.ready || !s.goal) {
    box.innerHTML = `<p class="muted small">Adicione pelo menos 2 dias de registros para calcular a projeção.</p>`;
    return;
  }
  const g = s.goal;
  if (g.status === "atingida") {
    box.innerHTML = `<div class="goal-hero"><div class="prop"><small>Status</small><b class="conf-alta">Meta atingida</b><span>${g.atual} kg → alvo ${g.alvo} kg</span></div></div>`;
    return;
  }
  const ritmo = `<div class="prop"><small>Ritmo atual</small><b>${g.ritmoKgSem > 0 ? "+" : ""}${g.ritmoKgSem} kg/sem</b><span>${g.status === "no-ritmo" ? `chega em ~${g.diasRestantes} dias (${g.previsao})` : g.status === "retencao" ? "balança mascarada pela retenção do ciclo" : "na direção oposta à meta"}</span></div>`;
  const cur = `<div class="prop"><small>Agora → alvo</small><b>${g.atual} → ${g.alvo} kg</b><span>${g.diff > 0 ? "+" : ""}${g.diff} kg restantes</span></div>`;
  let plano = "";
  if (g.kcalPorDia !== undefined) {
    const ok = g.plausivel
      ? `<span class="conf-alta">faixa segura (≥1200 kcal)</span>`
      : `<span class="err">fora da faixa segura — ajuste o prazo ou o alvo</span>`;
    const adj = g.ajusteCiclo ? `<span> · ${esc(g.ajusteCiclo)}</span>` : "";
    plano = `<div class="prop"><small>Para chegar até ${esc(g.diaAlvo)} (${g.diasParaAlvo} dias)</small><b>${g.kcalPorDia} kcal/dia</b><span>${ok}${adj}</span></div>`;
  } else if (PROFILE.goal_day) {
    plano = `<p class="muted small">Dia-alvo no passado ou meta já atingida — ajuste a data.</p>`;
  } else {
    plano = `<p class="muted small">Dica: informe “até o dia” para calcular quantas kcal/dia permitem chegar lá.</p>`;
  }
  const margDet = (s.margemBalanca !== undefined)
    ? `margem ±${s.margemTmb} (balança ±${s.margemBalanca}${(s.margemExercicio | 0) > 0 ? ` + exercício ±${s.margemExercicio}` : ""})`
    : `TMB ${s.tmbEstimada} ± ${s.margemTmb}`;
  box.innerHTML = `<div class="goal-hero">${cur}${ritmo}${plano}</div>
    <p class="muted small">Baseado no seu gasto medido (${s.gastoDiario} kcal/dia) e ${margDet}. Estimativas, não orientação médica.</p>` +
    (s.ciclo && s.ciclo.ativo
      ? `<p class="muted small">Ciclo: fase <b>${esc(s.ciclo.faseAtualLabel || "—")}</b>${s.ciclo.diaCiclo ? ` (dia ${s.ciclo.diaCiclo}/${s.ciclo.duracao})` : ""}${s.ciclo.retencaoAgora ? " · <b>retenção hídrica esperada</b> — não se assuste com a balança" : ""}${s.ciclo.tmbFatorFase > 1 ? " · TMB +7% nesta fase" : ""}.</p>`
      : "");
  loadCycleEvents();
}
$("g-btn").onclick = async () => {
  $("g-err").textContent = "";
  try {
    const cycLen = $("c-len").value === "" ? 28 : Number($("c-len").value);
    await api("/api/profile", { method: "PUT", body: JSON.stringify({
      goal_kg: $("g-kg").value === "" ? null : Number($("g-kg").value),
      goal_day: $("g-day").value || null,
      activity: Number($("g-act").value),
      cycle_enabled: $("c-on").checked,
      cycle_last: $("c-last").value || null,
      cycle_len: cycLen,
    }) });
    await refresh();
  } catch (e) { $("g-err").textContent = e.message; }
};

/* ---------- ciclo: histórico de inícios ---------- */
async function loadCycleEvents() {
  const box = $("c-list");
  if (!box) return;
  let events = [];
  try { ({ events } = await api("/api/cycle/events")); } catch { events = []; }
  box.innerHTML = events.length
    ? events.map((e) => `<span class="fc-badge">${esc(e.day)} <a href="#" data-del="${e.id}" style="color:inherit;text-decoration:none">×</a></span>`).join(" ")
    : `<span>sem inícios registrados</span>`;
  box.querySelectorAll("[data-del]").forEach((a) => { a.onclick = async (ev) => {
    ev.preventDefault();
    const ok = await askConfirm("Excluir início?", "Remover este início de ciclo? As fases serão recalculadas.", "Excluir");
    if (ok) { await api(`/api/cycle/events/${a.dataset.del}`, { method: "DELETE" }); refresh(); }
  };});
}

$("c-today").onclick = async () => {
  $("g-err").textContent = "";
  try {
    await api("/api/cycle/events", { method: "POST", body: JSON.stringify({ day: new Date().toISOString().slice(0, 10) }) });
    refresh();
  } catch (e) { $("g-err").textContent = e.message; }
};

boot();


