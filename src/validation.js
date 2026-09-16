import { FLAGS } from "./config.js";

export function parseFlags(v) {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255) return v;
  if (!Array.isArray(v)) return 0;
  let f = 0;
  for (const k of v) if (FLAGS[k]) f |= FLAGS[k].bit;
  return f;
}

export function dayWeight(f) {
  let w = 1;
  for (const k of Object.keys(FLAGS)) if (f & FLAGS[k].bit) w = Math.min(w, FLAGS[k].w);
  return w;
}

export function validUsername(u) {
  return typeof u === "string" && /^[a-zA-Z0-9._-]{3,32}$/.test(u);
}

export function validPassword(p) {
  return typeof p === "string" && p.length >= 12 && p.length <= 128;
}

export function validDay(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  return d <= today && d.getFullYear() >= 2000;
}

export function validDateString(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function validExercise(v) {
  const n = Number(v ?? 0);
  return Number.isInteger(n) && n >= 0 && n <= 10000 ? n : null;
}

export function validExerciseSrc(v) {
  return v === "dev" || v === "nao" ? v : "est";
}

export function validWeight(w) {
  const n = Number(w);
  return n >= 20 && n <= 500;
}

export function validCalories(c) {
  const n = Number(c);
  return Number.isInteger(n) && n >= 0 && n <= 30000;
}
