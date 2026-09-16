import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, "..");

export const DATA_DIR = path.join(ROOT_DIR, "data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const DB_PATH = path.join(DATA_DIR, "tracker.db");
export const PUBLIC_DIR = path.join(ROOT_DIR, "public");
export const PID_FILE = path.join(DATA_DIR, "service.pid");
export const PORT_FILE = path.join(DATA_DIR, "service.port");
export const LOG_FILE = path.join(DATA_DIR, "service.log");
export const BIND_FILE = path.join(DATA_DIR, "service.bind");
export const ROOT = ROOT_DIR;

export const PORT = parseInt(process.env.PORT || "3000", 10);
export const BIND = process.env.BIND || "127.0.0.1";
export const TRUST_PROXY = (process.env.TRUST_PROXY || "1") === "1";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const KCAL_PER_KG = 7700;
export const SEDENTARY_FACTOR = 1.2;

// Flags de "dia atípico": a balança oscila ±1–2 kg por água/glicogênio/conteúdo
// intestinal sem que isso seja gordura. Dias marcados entram no cálculo com
// peso menor (não são descartados) e alimentam a margem de erro.
export const FLAGS = {
  agua:    { bit: 1,  label: "Muita água antes de dormir",      w: 0.3 },
  inchaco: { bit: 2,  label: "Acordou inchado/a (retenção)",    w: 0.3 },
  jantar:  { bit: 4,  label: "Jantar pesado / tarde",           w: 0.5 },
  alcool:  { bit: 8,  label: "Álcool no dia anterior",          w: 0.4 },
  horario: { bit: 16, label: "Pesagem em horário diferente",    w: 0.5 },
  treino:  { bit: 32, label: "Fez exercício neste dia",         w: 0.3 },
  ciclo:   { bit: 128, label: "Período menstrual / TPM",         w: 0.5 },
  outro:   { bit: 64, label: "Outro motivo atípico",            w: 0.5 },
};

export const ACTIVITY_LEVELS = [1.2, 1.375, 1.55, 1.725];

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
