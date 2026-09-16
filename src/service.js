import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { BIND_FILE, LOG_FILE, PID_FILE, PORT_FILE, ROOT } from "./config.js";
import { db } from "./db.js";
import { genAdminPassword, hashPassword } from "./security.js";
import { validPassword, validUsername } from "./validation.js";

// ---------------- init admin ----------------
export function ensureAdmin() {
  const n = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  const envUser = process.env.ADMIN_USER, envPass = process.env.ADMIN_PASSWORD;
  if (process.argv.includes("--init-admin") || (n === 0 && (envUser || process.argv.includes("--init-admin")))) {
    const username = (envUser || "admin").trim();
    let password = envPass;
    if (!password) { password = "Admin-" + crypto.randomBytes(9).toString("base64url"); console.log("\n=============================================="); console.log(`  Usuário admin: ${username}`); console.log(`  Senha admin:  ${password}`); console.log("  Troque após o 1º login. Guarde em local seguro."); console.log("==============================================\n"); }
    if (!validUsername(username) || !validPassword(password)) { console.error("ADMIN_USER inválido ou ADMIN_PASSWORD < 12 chars"); process.exit(1); }
    const { hash, salt } = hashPassword(password);
    try { db.prepare("INSERT INTO users(username,pass_hash,pass_salt,role,created_at) VALUES(?,?,?,?,?)").run(username, hash, salt, "admin", Date.now()); console.log(`Admin '${username}' criado.`); }
    catch { const { hash: h2, salt: s2 } = hashPassword(password); db.prepare("UPDATE users SET pass_hash=?, pass_salt=?, role='admin', failed_attempts=0, locked_until=0 WHERE username=?").run(h2, s2, username); console.log(`Admin '${username}' atualizado.`); }
    if (process.argv.includes("--init-admin")) process.exit(0);
  } else if (n === 0) {
    console.log("\nNenhum usuário existe. Rode:  node server.js --init-admin");
    console.log("Ou defina ADMIN_USER/ADMIN_PASSWORD e reinicie.\n");
  }
}

export function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

export async function pickFreePort(preferred) {
  // tenta a porta pedida/default primeiro; senão varre a partir dela
  const start = preferred || 3000;
  for (let p = start; p < start + 500; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p)) return p;
  }
  throw new Error("nenhuma porta livre encontrada");
}

export function serviceInfo() {
  let pid = null, port = null;
  try { pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10) || null; } catch {}
  try { port = parseInt(fs.readFileSync(PORT_FILE, "utf8").trim(), 10) || null; } catch {}
  let alive = false;
  if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
  return { pid, port, alive };
}

export async function cmdDaemon(argPort) {
  const cur = serviceInfo();
  if (cur.alive) {
    console.log(`Serviço já rodando: pid=${cur.pid} porta=${cur.port} (http://127.0.0.1:${cur.port})`);
    process.exit(0);
  }
  const envBind = process.env.BIND || "127.0.0.1";
  const port = await pickFreePort(argPort ? parseInt(argPort, 10) : (process.env.PORT ? parseInt(process.env.PORT, 10) : 0) || 0);
  // garante senha admin quando o banco está vazio (sem ela o usuário não entra)
  let freshCreds = null;
  const nUsers = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  if (nUsers === 0) {
    const password = process.env.ADMIN_PASSWORD || genAdminPassword();
    const username = (process.env.ADMIN_USER || "admin").trim();
    const { hash, salt } = hashPassword(password);
    db.prepare("INSERT INTO users(username,pass_hash,pass_salt,role,created_at) VALUES(?,?,?,?,?)").run(username, hash, salt, "admin", Date.now());
    freshCreds = { username, password };
  }
  db.close();
  const log = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    detached: true, stdio: ["ignore", log, log],
    env: { ...process.env, PORT: String(port), BIND: envBind },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  fs.writeFileSync(PORT_FILE, String(port));
  fs.writeFileSync(BIND_FILE, envBind);
  // espera subir (health check)
  const t0 = Date.now();
  let up = false;
  const probeHost = envBind === "0.0.0.0" ? "127.0.0.1" : envBind;
  while (Date.now() - t0 < 15000) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      await new Promise((resolve, reject) => {
        const rq = http.get({ host: probeHost, port, path: "/", timeout: 1500 }, (rs) => { rs.resume(); rs.on("end", resolve); });
        rq.on("error", reject); rq.on("timeout", () => { rq.destroy(); reject(new Error("t")); });
      });
      up = true; break;
    } catch {}
  }
  console.log("\n==============================================");
  console.log(`  Peso Tracker rodando como serviço (pid ${child.pid})`);
  console.log(`  URL local:  http://${envBind}:${port}`);
  console.log(`  Cloudflare Tunnel →  http://${envBind === "0.0.0.0" ? "127.0.0.1" : envBind}:${port}  (use http, NÃO https)`);
  if (freshCreds) {
    console.log(`  Usuário admin: ${freshCreds.username}`);
    console.log(`  Senha admin:   ${freshCreds.password}`);
    console.log("  Guarde e troque após o 1º login.");
  } else {
    console.log("  Admin: use a senha já existente (banco já tinha usuários).");
  }
  console.log(`  Log: ${LOG_FILE} · status: node server.js --status`);
  console.log("==============================================\n");
  if (!up) { console.error("AVISO: serviço iniciado mas não respondeu em 15s — veja o log."); process.exit(1); }
  process.exit(0);
}

export function cmdStatus() {
  const { pid, port, alive } = serviceInfo();
  let bind = "127.0.0.1";
  try { bind = fs.readFileSync(BIND_FILE, "utf8").trim() || bind; } catch {}
  if (!port && !pid) { console.log("Serviço nunca iniciado (sem service.pid/service.port em data/)."); return; }
  console.log(alive ? `Rodando: pid=${pid} em http://${bind}:${port}` : `Parado (último pid=${pid} em ${bind}:${port}). Suba com: node server.js --daemon`);
}

export function cmdStop() {
  const { pid, alive } = serviceInfo();
  if (!alive || !pid) { console.log("Serviço não está rodando."); try { fs.unlinkSync(PID_FILE); } catch {} return; }
  try { process.kill(pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(pid, 0); try { process.kill(pid, "SIGKILL"); } catch {} } catch {} }, 2500).unref?.();
  try { fs.unlinkSync(PID_FILE); } catch {}
  console.log(`Sinal de parada enviado ao pid ${pid}.`);
}
