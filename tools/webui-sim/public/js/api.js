import { serializeForm, extractMsgDiv } from "./setup-parsers.js";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path, { method = "GET", body, form } = {}) {
  // Hub state must never be served stale from the browser cache.
  const options = { method, cache: "no-store", headers: {} };
  if (form !== undefined) {
    const params = form instanceof URLSearchParams ? form : new URLSearchParams(form);
    options.headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = params.toString();
  } else if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, options);
  } catch (networkError) {
    // fetch rejects with a TypeError when no server answers at all.
    throw new ApiError("Sim server not reachable", 0);
  }

  const raw = await response.text();
  let json = null;
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch (_) {
      throw new ApiError(raw.slice(0, 120) || `HTTP ${response.status}`, response.status);
    }
  }

  if (!response.ok || (json && json.ok === false)) {
    const message = (json && (json.error || json.message)) || `HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return json ?? { ok: true };
}

export function getConfig() {
  return request("/api/activity-config");
}

export function getState() {
  return request("/api/activity-state");
}

export function runActivity(activityId) {
  return request("/api/activity-run", {
    method: "POST",
    form: { activityId: String(activityId) },
  });
}

export function saveActivity({ baseRevision, activityList, mapList, functionList, syncRemote }) {
  return request("/api/activity-save", {
    method: "POST",
    body: { baseRevision, activityList, mapList, functionList, syncRemote },
  });
}

export function powerOff() {
  return runActivity(-1);
}

export function irSend({ deviceId, command, functionId, activityId }) {
  const form = {
    deviceId: String(deviceId),
    command: String(command),
  };
  if (functionId != null && functionId !== "") form.functionId = String(functionId);
  if (activityId != null && activityId !== "") form.activityId = String(activityId);
  return request("/api/ir-send", { method: "POST", form });
}

// Sim-only debug log, served by the dev tooling outside /api/. The path is
// assembled at runtime so no routable /sim/ URL survives into the production
// bundle; the production shell never calls this (gated on HARMONY_SIM).
export function getSimEvents() {
  return request(["/sim", "events"].join("/"));
}

/* ------------------------------------------------------------------ *
 *  Setup-page transport: JSON, text, and form-urlencoded HTML probes.
 *  Pure data shaping (form serialization, HTML parsing) lives in
 *  setup-parsers.js; this module only owns the network layer.
 * ------------------------------------------------------------------ */

export { serializeForm };

async function fetchSafe(path, options) {
  try {
    return await fetch(path, options);
  } catch (_) {
    throw new ApiError("Sim server not reachable", 0);
  }
}

export async function getJson(path, { authorization } = {}) {
  const headers = {};
  if (authorization) headers.Authorization = authorization;
  const response = await fetchSafe(path, { method: "GET", cache: "no-store", headers });
  const raw = await response.text();
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const json = JSON.parse(raw);
      message = json.error || json.message || message;
    } catch (_) {}
    throw new ApiError(message, response.status);
  }
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new ApiError(`Expected JSON but received: ${raw.slice(0, 80)}`, response.status);
  }
}

export async function getText(path, { authorization } = {}) {
  const headers = {};
  if (authorization) headers.Authorization = authorization;
  const response = await fetchSafe(path, { method: "GET", cache: "no-store", headers });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(text.slice(0, 120) || `HTTP ${response.status}`, response.status);
  }
  return text;
}

export async function postApiForm(path, fields, { authorization } = {}) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (authorization) headers.Authorization = authorization;
  const response = await fetchSafe(path, {
    method: "POST",
    cache: "no-store",
    headers,
    body: serializeForm(fields).toString(),
  });
  const raw = await response.text();
  let json = null;
  if (raw) {
    try { json = JSON.parse(raw); } catch (_) {}
  }
  if (!response.ok || (json && json.ok === false)) {
    const message = (json && (json.error || json.message)) || raw.slice(0, 120) || `HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return json ?? { ok: true };
}

/** POST form-urlencoded to a legacy hub HTML page (e.g. /system, /mqtt).
    Only response.ok (HTTP 2xx) counts as success; the legacy
    <div class='msg'> is extracted for the caller. Errors are honest —
    never "sim offline" for an HTTP failure.
    Optional authorization is for post-enable probes / disable-after-lock
    (explicit Basic header — never the browser's credential cache). */
export async function postHubForm(path, fields, { authorization } = {}) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (authorization) headers.Authorization = authorization;
  const response = await fetchSafe(path, {
    method: "POST",
    cache: "no-store",
    headers,
    body: serializeForm(fields).toString(),
  });
  const html = await response.text();
  if (!response.ok) {
    const msg = extractMsgDiv(html);
    throw new ApiError(msg || `HTTP ${response.status}`, response.status);
  }
  return { ok: true, html, msg: extractMsgDiv(html) };
}

/** GET probe with an explicit Basic Authorization header.
    Used only to verify credentials just written — never stores them. */
export async function probeBasicAuth(path, authorization) {
  const response = await fetchSafe(path, {
    method: "GET",
    cache: "no-store",
    headers: authorization ? { Authorization: authorization } : {},
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}
