#!/usr/bin/env node
/**
 * Peso Tracker — painel privado de acompanhamento corporal
 * Zero dependências. Apenas Node.js >= 22.
 *
 * Uso:
 *   node server.js --init-admin        # cria admin (ou usa env ADMIN_USER/ADMIN_PASSWORD)
 *   node server.js                     # inicia em http://127.0.0.1:3000
 *   PORT=3000 BIND=127.0.0.1 node server.js
 *   node server.js --daemon [porta]    # modo serviço (estilo pm2): roda em background,
 *                                      # escolhe porta livre se omitida, gera senha admin
 *                                      # se não houver nenhum usuário. Sobrevive ao fim
 *                                      # desta sessão (detached). Gerencia com:
 *   node server.js --status            # mostra pid/porta/stats do serviço
 *   node server.js --stop              # para o serviço
 *
 * Atrás do Cloudflare Tunnel, rode ouvindo em 127.0.0.1 e aponte o tunnel para lá.
 */
import fs from "node:fs";
import http from "node:http";
import { BIND, PORT, PORT_FILE } from "./src/config.js";
import { db } from "./src/db.js";
import { json } from "./src/http.js";
import { handler } from "./src/router.js";
import { cmdDaemon, cmdStatus, cmdStop, ensureAdmin } from "./src/service.js";

const server = http.createServer((req, res) => handler(req, res).catch((e) => {
  try { json(res, 500, { error: "erro interno" }); } catch {}
}));

ensureAdmin();

const _args = process.argv.slice(2);
if (_args.includes("--status")) { cmdStatus(); process.exit(0); }
if (_args.includes("--stop")) { cmdStop(); process.exit(0); }
if (_args.includes("--daemon") || _args.includes("--service")) {
  const i = Math.max(_args.indexOf("--daemon"), _args.indexOf("--service"));
  const portArg = _args[i + 1] && /^\d+$/.test(_args[i + 1]) ? _args[i + 1] : null;
  await cmdDaemon(portArg);
}

server.listen(PORT, BIND, () => {
  try { fs.writeFileSync(PORT_FILE, String(PORT)); } catch {}
  console.log(`Peso Tracker em http://${BIND}:${PORT}  (exponha via Cloudflare Tunnel, veja tunnel.md)`);
});

// encerra limpo no SIGTERM/SIGINT (checkpoint do WAL, sem corromper o banco)
let _closing = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (_closing) return;
    _closing = true;
    try { server.close(); } catch {}
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    try { db.close(); } catch {}
    process.exit(0);
  });
}
