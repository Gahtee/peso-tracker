import { json, readJson } from "../http.js";

export async function readBody(req, res) {
  try {
    return await readJson(req);
  } catch (e) {
    json(res, e.code === 413 ? 413 : 400, { error: e.message });
    return null;
  }
}

export function requireAdmin(sess, res) {
  if (sess.role !== "admin") {
    json(res, 403, { error: "só administrador" });
    return false;
  }
  return true;
}
