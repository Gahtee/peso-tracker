"use strict";
const $ = (id) => document.getElementById(id);
let CSRF = "", ME = null, FLAG_LABELS = {}, CACHE = [], EXPANDED = new Set();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const FLAGS_ORDER = ["agua","inchaco","jantar","alcool","horario","treino","outro"];

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

/* ---------- navegação por views ---------- */
const VIEWS = { overview: "Visão geral", entries: "Registros", compare: "Antes / Depois", admin: "Usuários" };
function go(view) {
  for (const v of Object.keys(VIEWS)) $("view-" + v).classList.toggle("hidden", v !== view);
  document.querySelectorAll("#sidenav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("crumb").textContent = VIEWS[view] || view;
  if (view === "compare") renderCompare(CACHE);
}
document.querySelectorAll("#sidenav button").forEach((b) => { b.onclick = () => go(b.dataset.view); });
$("q").addEventListener("input", () => renderEntries(CACHE));

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
      calories: Number($("f-cal").value), note: $("f-note").value,
      flagsKeys: checkedFlags("#f-flags") }) });
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
    $("f-weight").value = ""; $("f-cal").value = ""; $("f-note").value = ""; $("f-media").value = "";
    document.querySelectorAll("#f-flags input:checked").forEach((c) => (c.checked = false));
    $("dlg-day").close();
    await refresh();
    go("entries");
    if (upErr) alert("Dia salvo, mas com erro no anexo:" + upErr);
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
      note: $("e-note").value, flags }) });
    $("dlg-edit").close();
    refresh();
  } catch (e) { $("e-err").textContent = e.message; }
});

/* ---------- dados ---------- */
async function refresh() {
  const [stats, data] = await Promise.all([api("/api/stats"), api("/api/entries")]);
  CACHE = data.entries || [];
  $("nav-count").textContent = CACHE.length || "";
  renderStats(stats); renderChart(CACHE); renderEntries(CACHE); renderCompare(CACHE);
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
    <div class="hero"><b>${s.tmbEstimada}</b><span>kcal/dia ± ${s.margemTmb}</span></div>
    <div class="range"><i style="width:100%"></i></div>
    <div class="range-lbl"><span>${s.tmbMin}</span><span>faixa de confiança 95%</span><span>${s.tmbMax}</span></div>
    <div class="props">
      <div class="prop"><small>Gasto diário</small><b>${s.gastoDiario}</b><span>${s.gastoMin}–${s.gastoMax}</span></div>
      <div class="prop"><small>Média ingerida</small><b>${s.avgCalories}</b><span>kcal/dia</span></div>
      <div class="prop"><small>Tendência</small><b>${s.slopeKgDay > 0 ? "+" : ""}${trend} kg/sem</b><span>total ${dSign}${s.deltaKg} kg</span></div>
      <div class="prop"><small>Ruído típico</small><b>±${s.residuoTipicoKg} kg</b><span>R² ${s.r2} · n efetivo ${s.diasEfetivos}</span></div>
    </div>
    <p class="footline">${s.n} dias · ${s.diasAtipicos} atípico(s) · ${esc(s.firstWeight)} → ${esc(s.lastWeight)} kg</p>${warn}`;
  $("metodo").textContent = s.metodo;
}

function renderChart(entries) {
  const c = $("chart"), ctx = c.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = 900, H = 280;
  if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const pts = [...entries].reverse();
  if (!pts.length) { ctx.fillStyle = "#52565e"; ctx.font = "12px Inter, sans-serif"; ctx.fillText("Registre o primeiro dia para ver o gráfico", 24, 44); return; }
  const ws = pts.map((e) => e.weight_kg);
  let min = Math.min(...ws), max = Math.max(...ws);
  if (max - min < 1) { min -= 0.5; max += 0.5; }
  const X = (i) => 52 + (i * (W - 72)) / Math.max(1, pts.length - 1);
  const Y = (w) => 22 + (1 - (w - min) / (max - min)) * (H - 56);
  ctx.font = "11px Inter, sans-serif";
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "rgba(139,147,248,.25)"); grad.addColorStop(1, "rgba(139,147,248,0)");
  ctx.beginPath();
  pts.forEach((e, i) => (i ? ctx.lineTo(X(i), Y(e.weight_kg)) : ctx.moveTo(X(i), Y(e.weight_kg))));
  ctx.lineTo(X(pts.length - 1), H - 26); ctx.lineTo(X(0), H - 26); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.fillStyle = "#52565e"; ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) { const w = min + ((max - min) * g) / 4; ctx.beginPath(); ctx.moveTo(52, Y(w)); ctx.lineTo(W - 20, Y(w)); ctx.stroke(); ctx.fillText(w.toFixed(1), 10, Y(w) + 4); }
  ctx.strokeStyle = "#8b93f8"; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
  pts.forEach((e, i) => (i ? ctx.lineTo(X(i), Y(e.weight_kg)) : ctx.moveTo(X(i), Y(e.weight_kg))));
  ctx.stroke(); ctx.lineWidth = 1;
  pts.forEach((e, i) => {
    const flag = (e.flags | 0) !== 0;
    ctx.beginPath(); ctx.arc(X(i), Y(e.weight_kg), flag ? 5 : 3.5, 0, 7);
    ctx.fillStyle = flag ? "#f2c94c" : "#8b93f8"; ctx.fill();
    ctx.strokeStyle = "#0e0f11"; ctx.stroke();
  });
  ctx.fillStyle = "#52565e";
  pts.forEach((e, i) => { if (i % Math.ceil(pts.length / 8) === 0) ctx.fillText(e.day.slice(5), X(i) - 12, H - 8); });
}

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
    const note = e.note ? esc(e.note) : `<span class="sub">—</span>`;
    const at = (e.flags | 0) ? ` <span class="pill warn">atípico</span>` : "";
    const open = EXPANDED.has(e.id);
    return `
    <div class="rowline" data-id="${e.id}">
      <span class="rid">${esc(e.day)}</span>
      <span class="rw">${esc(e.weight_kg)} kg</span>
      <span class="rc">${esc(e.calories)}</span>
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
      if (!confirm("Excluir este dia e suas mídias?")) return;
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
  return `<div class="detail" data-id="${e.id}">
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
    if (!r.ok) { alert((await r.json().catch(() => ({}))).error || "falha no upload"); return; }
    refresh();
  };
  d.querySelectorAll(".thumb img").forEach((img) => { img.onclick = () => { $("lb-img").src = img.src; $("lightbox").showModal(); }; });
  d.querySelectorAll(".thumb video").forEach((v) => { v.onclick = () => v.paused ? v.play() : v.pause(); });
  d.querySelectorAll(".thumb i").forEach((x) => { x.onclick = async (ev) => {
    ev.stopPropagation();
    if (!confirm("Excluir esta mídia?")) return;
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
      if (b.dataset.a === "pw") { const p = prompt("Nova senha (mín 12 chars):"); if (!p) return; try { await api(`/api/users/${id}/reset-password`, { method: "POST", body: JSON.stringify({ password: p }) }); } catch (e) { alert(e.message); return; } }
      if (b.dataset.a === "del") { if (!confirm("Excluir usuário e TODOS os dados dele?")) return; try { await api(`/api/users/${id}`, { method: "DELETE" }); } catch (e) { alert(e.message); return; } }
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

boot();
