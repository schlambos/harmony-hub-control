"use strict";

const {
  DEFAULT_CLIENT_ID,
  CatalogError,
  oauthRefresh,
} = require("./oauth");

const DISCOVERY_URL =
  "https://cf-svcs.myharmony.com/Discovery/Discovery.svc/json/GetJsonOperations";
const DISCOVERY_CLIENT_TYPE = "Redbull 1.0";
const HARMONY_SIGNIN_URL =
  "https://lb-svcs.myharmony.com/CompositeSecurityServices/Security.svc/json2/signin";
const SEARCH_DEVICE_BASE_URL =
  "https://svcs.myharmony.com/HarmonyPlatform/DeviceManager.svc/json2/SearchDevice";
const SEARCH_OPERATION = "DeviceManager/SearchGlobalDevices";
const GLOBAL_DEVICES_OPERATION = "DeviceManager/GetGlobalDevices";
const GLOBAL_LANGUAGE_COMMANDS_OPERATION =
  "DeviceManager/GetGlobalLanguageCommands";
const COMMANDS_OPERATION = "DeviceManager/GetCommands";
const PROTOCOL_LIST_OPERATION = "UserAccountDirector/ProtocolList";
const PROTOCOL_LIST_URL_RE =
  /^https:\/\/lb-svcs\.myharmony\.com\/UserAccountDirectorPlatform\/UserAccountDirector\.svc\/json2\/Account\/[A-Za-z0-9._-]+\/ProtocolList$/;
const ACCOUNT_ID_RE = /^[A-Za-z0-9._-]+$/;
const PACKAGE_SCHEMA = "0.2.0";
const PACKAGE_SOURCE = "logitech-catalog-via-melodious-desktop";
const DEFAULT_TIMEOUT_MS = 30_000;

const SECRET_KEY_RE =
  /(authorization|cookie|password|passwd|secret|access.?token|refresh.?token|id.?token|auth.?token|account.?id)/i;

const DEVICE_TYPE_LABELS = Object.freeze({
  1: "Television",
  2: "VCR",
  3: "CD player",
  4: "DVD",
  5: "Receiver",
  6: "Tape deck",
  7: "Projector",
  8: "Computer",
  9: "Game console",
  10: "Laptop",
  12: "Set-top box",
  13: "Monitor",
  14: "Cable box",
  16: "Satellite",
  18: "PVR",
  19: "Amplifier",
  22: "Game console",
  23: "Light controller",
  29: "AV switch",
  32: "Music server",
  33: "DVD recorder",
  34: "Media center PC",
  35: "Radio tuner",
  43: "Home appliance",
  44: "Climate control",
});

function formatDeviceType(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return DEVICE_TYPE_LABELS[value] || (value > 0 ? `Type ${value}` : "");
  }
  return "";
}

function decodeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

class JsonClient {
  constructor({
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    userAgent = process.env.MELODIOUS_USER_AGENT || "melodious-catalog/1.0",
  } = {}) {
    this._timeoutMs = timeoutMs;
    this._fetch = fetchImpl;
    this._userAgent = userAgent;
    this._cookies = new Map();
  }

  clearCookies() {
    this._cookies.clear();
  }

  _recordResponseCookies(headers, url) {
    if (!headers) return;
    let rawCookies = [];
    if (typeof headers.getSetCookie === "function") {
      rawCookies = headers.getSetCookie();
    } else if (typeof headers.get === "function") {
      const single = headers.get("set-cookie");
      if (single) rawCookies = [single];
    } else if (Array.isArray(headers["set-cookie"])) {
      rawCookies = headers["set-cookie"];
    } else if (typeof headers["set-cookie"] === "string") {
      rawCookies = [headers["set-cookie"]];
    }
    for (const entry of rawCookies) {
      const firstPart = String(entry || "").split(";")[0].trim();
      const eq = firstPart.indexOf("=");
      if (eq > 0) {
        const name = firstPart.slice(0, eq).trim();
        const val = firstPart.slice(eq + 1).trim();
        // Honor domain/path/expiry without ever sharing Logi ID cookies with
        // Harmony. Anonymous checks explicitly omit this jar altogether.
        if (name) {
          const u = new URL(url);
          const attrDomain = /;\s*domain=([^;]+)/i.exec(entry)?.[1]?.trim().toLowerCase().replace(/^\./, "");
          const domain = attrDomain || u.hostname;
          if (domain !== u.hostname && !(domain === "myharmony.com" && u.hostname.endsWith(".myharmony.com"))) continue;
          const attrPath = /;\s*path=([^;]+)/i.exec(entry)?.[1]?.trim();
          const path = attrPath?.startsWith("/") ? attrPath : u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
          const maxAge = /;\s*max-age=(-?\d+)/i.exec(entry)?.[1];
          const expires = maxAge !== undefined ? Date.now() + Number(maxAge) * 1000 : Date.parse(/;\s*expires=([^;]+)/i.exec(entry)?.[1] || "");
          const key = `${domain}|${path}|${name}`;
          if (expires <= Date.now()) this._cookies.delete(key);
          else this._cookies.set(key, { domain, hostOnly: !attrDomain, path, name, val, expires });
        }
      }
    }
  }

  _cookieHeader(url) {
    if (this._cookies.size === 0) return "";
    const u = new URL(url);
    return [...this._cookies.values()]
      .filter((c) => !(c.expires <= Date.now()) && (u.hostname === c.domain || (!c.hostOnly && u.hostname.endsWith(`.${c.domain}`))) && (u.pathname === c.path || u.pathname.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`)))
      .map((c) => `${c.name}=${c.val}`)
      .join("; ");
  }

  async _request(
    url,
    { method = "GET", headers = {}, body = undefined, authenticated = false } = {}
  ) {
    const u = new URL(url);
    const deviceManager = "https://lb-svcs.myharmony.com/HarmonyPlatform/DeviceManager.svc/";
    const allowed =
      (method === "POST" &&
        (url === DISCOVERY_URL ||
          url === HARMONY_SIGNIN_URL ||
          url === "https://accounts.logi.com/identity/oauth2/token" ||
          [
            "json2/SearchGlobalDevices",
            "json2/GetGlobalDevices",
            "json/GetGlobalLanguageCommands",
          ].some((p) => url === deviceManager + p))) ||
      (method === "GET" &&
        !authenticated &&
        url.startsWith(`${SEARCH_DEVICE_BASE_URL}/manf/`)) ||
      (method === "GET" && authenticated && PROTOCOL_LIST_URL_RE.test(url));
    if (!allowed || u.protocol !== "https:" || u.username || u.password || u.hash) {
      throw new CatalogError("Refusing an unexpected catalog endpoint");
    }
    const reqHeaders = {
      Accept: "application/json",
      "User-Agent": this._userAgent,
      ...headers,
    };
    const sendCookies = method !== "GET" || authenticated;
    const cookieStr = sendCookies ? this._cookieHeader(url) : "";
    if (cookieStr && !reqHeaders.Cookie) {
      reqHeaders.Cookie = cookieStr;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      const response = await this._fetch(url, {
        method,
        headers: reqHeaders,
        body,
        signal: controller.signal,
        redirect: "error",
      });
      this._recordResponseCookies(response.headers, url);
      const text = await response.text();
      return {
        status: response.status,
        payload: decodeJson(text),
      };
    } catch {
      throw new CatalogError(`Could not reach ${u.hostname}; try again`);
    } finally {
      clearTimeout(timer);
    }
  }

  async get(url, { token = null, headers = {}, authenticated = false } = {}) {
    const reqHeaders = { ...headers };
    if (authenticated && token) {
      reqHeaders.Authorization = `Bearer ${token}`;
    }
    return this._request(url, {
      method: "GET",
      headers: reqHeaders,
      authenticated,
    });
  }

  async post(url, payload, { token = null, headers = {} } = {}) {
    const reqHeaders = {
      "Content-Type": "application/json",
      ...headers,
    };
    if (token) {
      reqHeaders.Authorization = `Bearer ${token}`;
    }
    return this._request(url, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(payload),
    });
  }

  async postForm(url, fields) {
    const body = new URLSearchParams(fields).toString();
    return this._request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  }
}

function rejectedMessage(what, status) {
  const hint =
    status === 401 || status === 403
      ? " -- the saved sign-in may have expired; the browser sign-in will run next"
      : "";
  return `${what}: HTTP ${status}${hint}`;
}

async function harmonySignin(client, tokens) {
  const { status, payload } = await client.post(
    HARMONY_SIGNIN_URL,
    {
      access_token: tokens.access_token,
      id_token: tokens.id_token,
    },
    { token: tokens.access_token }
  );
  if (status !== 200) {
    throw new CatalogError(rejectedMessage("Harmony rejected the bootstrap", status));
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CatalogError("Harmony's signin did not return an object");
  }
  const inner =
    payload.SigninResult && typeof payload.SigninResult === "object"
      ? payload.SigninResult
      : payload;
  const accountId = inner.AccountId ?? payload.AccountId;
  if (typeof accountId !== "string" || !accountId) {
    throw new CatalogError("Harmony's signin did not return an AccountId");
  }
  if (inner.IsLockedOut === true || payload.IsLockedOut === true) {
    throw new CatalogError("the Harmony account is locked");
  }
  return {
    accountId,
    tokens,
  };
}

/**
 * Establish a signed-in Harmony session:
 * 1. Saved tokens first
 * 2. One silent refresh if saved tokens fail
 * 3. Browser sign-in prompt once (never a loop)
 */
async function ensureSession(
  client,
  {
    loadTokens = null,
    saveTokens = null,
    clientId = DEFAULT_CLIENT_ID,
    signIn = null,
  } = {}
) {
  let tokens = typeof loadTokens === "function" ? await loadTokens() : null;
  if (tokens) {
    try {
      return await harmonySignin(client, tokens);
    } catch {
      // Saved access_token rejected; try one silent refresh next.
    }
    try {
      tokens = await oauthRefresh(client, tokens, clientId);
      if (typeof saveTokens === "function") {
        await saveTokens(tokens);
      }
      return await harmonySignin(client, tokens);
    } catch {
      // Silent refresh failed; fall through to interactive sign-in once.
    }
  }

  if (typeof signIn !== "function") {
    throw new CatalogError("Sign in to Logitech first");
  }

  const freshResult = await signIn();
  if (!freshResult || freshResult.cancelled) {
    throw new CatalogError("Sign in to Logitech first");
  }
  const freshTokens = freshResult.tokens || freshResult;
  if (typeof saveTokens === "function") {
    await saveTokens(freshTokens);
  }
  return harmonySignin(client, freshTokens);
}

function swapHost(address, hosts, newHost) {
  const hostSet = hosts instanceof Set ? hosts : new Set(hosts);
  try {
    const parsed = new URL(address);
    if (!hostSet.has(parsed.hostname)) {
      return address;
    }
    parsed.hostname = newHost;
    return parsed.toString();
  } catch {
    return address;
  }
}

function loadBalancerAddress(address) {
  return swapHost(
    address,
    new Set(["svcs.myharmony.com", "cf-svcs.myharmony.com"]),
    "lb-svcs.myharmony.com"
  );
}

function createOperation(identifier, address, name) {
  return {
    identifier,
    address,
    name,
    endpoint({ json2 = false } = {}) {
      let url = swapHost(
        this.address,
        new Set(["svcs.myharmony.com"]),
        "cf-svcs.myharmony.com"
      );
      if (json2) {
        url = url.replace("/json/", "/json2/");
      }
      return url + this.name;
    },
  };
}

function parseOperations(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray(payload.GetJsonOperationsResult)
  ) {
    throw new CatalogError("discovery did not return an operation table");
  }
  const operations = {};
  for (const item of payload.GetJsonOperationsResult) {
    if (!item || typeof item !== "object") continue;
    const { Identifier: identifier, Address: address, Name: name } = item;
    if (
      typeof identifier === "string" &&
      identifier &&
      typeof address === "string" &&
      address &&
      typeof name === "string" &&
      name
    ) {
      operations[identifier] = createOperation(identifier, address, name);
    }
  }
  if (Object.keys(operations).length === 0) {
    throw new CatalogError("discovery carried no usable operation");
  }
  return operations;
}

class GlobalCatalogClient {
  constructor(client, session, operationsCache = null) {
    this._client = client;
    this._session = session;
    this._operations = operationsCache;
  }

  get _bearer() {
    return this._session.tokens.access_token;
  }

  async signin() {
    this._session = await harmonySignin(this._client, this._session.tokens);
    return this._session;
  }

  async operations() {
    if (!this._operations) {
      const { status, payload } = await this._client.post(
        DISCOVERY_URL,
        { clientTypeId: DISCOVERY_CLIENT_TYPE },
        {
          token: this._bearer,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "x-logitech-api-version": "1",
          },
        }
      );
      if (status !== 200) {
        throw new CatalogError(`discovery failed with HTTP ${status}`);
      }
      this._operations = parseOperations(payload);
    }
    return { ...this._operations };
  }

  async _post(identifier, data, { json2 = false, fallbackName = null } = {}) {
    const table = await this.operations();
    let operation = table[identifier];
    if (!operation && fallbackName) {
      const sibling = table[COMMANDS_OPERATION];
      if (sibling) {
        operation = createOperation(identifier, sibling.address, fallbackName);
      }
    }
    if (!operation) {
      throw new CatalogError(`unknown catalog operation: ${identifier}`);
    }
    const endpoint = loadBalancerAddress(operation.endpoint({ json2 }));
    const { status, payload } = await this._client.post(endpoint, data, {
      token: this._bearer,
    });
    const message =
      payload && typeof payload === "object" ? payload.Message : null;
    if (
      status === 400 &&
      typeof message === "string" &&
      message.includes("Access is denied")
    ) {
      const err = new CatalogError(
        "Logitech refused the catalog session; sign in again"
      );
      err.accessDenied = true;
      throw err;
    }
    if (status !== 200) {
      throw new CatalogError(
        `${identifier} failed with HTTP ${status}`
      );
    }
    if (payload === null || payload === undefined) {
      throw new CatalogError(`${identifier} returned HTTP 200 without JSON`);
    }
    if (typeof payload === "object" && !Array.isArray(payload)) {
      const resultKey = `${operation.name}Result`;
      if (resultKey in payload) {
        return payload[resultKey];
      }
      if ("Data" in payload) {
        return payload.Data;
      }
    }
    return payload;
  }

  async search(manufacturer, model, { maxResults = 50 } = {}) {
    const mfr = String(manufacturer ?? "").trim();
    const mdl = String(model ?? "").trim();
    if (!mfr || !mdl) {
      throw new CatalogError(
        "the catalog searches by manufacturer AND model; both are needed (part of the model is enough)"
      );
    }
    return this._post(
      SEARCH_OPERATION,
      {
        manufacturer: mfr,
        modelNumber: mdl,
        deviceType: 0,
        searchType: 2,
        maxResults,
      },
      { json2: true }
    );
  }

  async globalDevices(deviceIds) {
    const ids = (Array.isArray(deviceIds) ? deviceIds : []).filter(
      (i) => i !== null && i !== undefined
    );
    return this._post(GLOBAL_DEVICES_OPERATION, ids, { json2: true });
  }

  async globalLanguageCommands(versionId) {
    if (versionId === null || versionId === undefined) {
      throw new CatalogError("the global language version id is missing");
    }
    return this._post(
      GLOBAL_LANGUAGE_COMMANDS_OPERATION,
      { globalLanguageVersionId: { Value: versionId } },
      { fallbackName: "GetGlobalLanguageCommands" }
    );
  }

  async protocolList() {
    const table = await this.operations();
    const operation = table[PROTOCOL_LIST_OPERATION];
    if (!operation) {
      return [];
    }
    const accountId = String(this._session?.accountId ?? "").trim();
    if (!accountId || !ACCOUNT_ID_RE.test(accountId)) {
      throw new CatalogError("the Harmony session carries an invalid AccountId");
    }
    const endpoint = loadBalancerAddress(
      operation
        .endpoint({ json2: true })
        .replace(/\{accountId\}|%7BaccountId%7D/gi, encodeURIComponent(accountId))
    );
    const { status, payload } = await this._client.get(endpoint, {
      token: this._bearer,
      headers: { "x-logitech-api-version": "1" },
      authenticated: true,
    });
    const message =
      payload && typeof payload === "object" ? payload.Message : null;
    if (
      status === 400 &&
      typeof message === "string" &&
      message.includes("Access is denied")
    ) {
      const err = new CatalogError(
        "Logitech refused the catalog session; sign in again"
      );
      err.accessDenied = true;
      throw err;
    }
    if (status !== 200) {
      throw new CatalogError(`${PROTOCOL_LIST_OPERATION} failed with HTTP ${status}`);
    }
    return extractProtocolList(payload);
  }
}

function extractProtocolList(payload) {
  if (Array.isArray(payload)) {
    return payload.filter((p) => p && typeof p === "object" && !Array.isArray(p));
  }
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["ProtocolListResult", "Data"]) {
    const inner = payload[key];
    if (inner && typeof inner === "object" && Array.isArray(inner.Protocols)) {
      return inner.Protocols.filter((p) => p && typeof p === "object" && !Array.isArray(p));
    }
    if (Array.isArray(inner)) {
      return inner.filter((p) => p && typeof p === "object" && !Array.isArray(p));
    }
  }
  if (Array.isArray(payload.Protocols)) {
    return payload.Protocols.filter((p) => p && typeof p === "object" && !Array.isArray(p));
  }
  return [];
}

function isValidProtocolRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.__type !== "IrProtocol") return false;
  const pid = record["Id-"];
  if (!Number.isInteger(pid) || pid <= 0 || pid > 999999) return false;
  const name = record.Name;
  if (typeof name !== "string" || !name || name.length > 127) return false;
  if (/[:\\"\u0000-\u001f\u007f]/.test(name)) return false;
  const freq = record.CarrierFrequency;
  if (typeof freq !== "number" || !Number.isFinite(freq) || freq < 10000 || freq > 500000) {
    return false;
  }
  if (!record.KeyCode || typeof record.KeyCode !== "object" || Array.isArray(record.KeyCode)) {
    return false;
  }
  if (!Array.isArray(record.IRSegments)) return false;
  if (record.CodeSegments !== undefined && record.CodeSegments !== null && !Array.isArray(record.CodeSegments)) {
    return false;
  }
  const hasIr = record.IRSegments.some((s) => s && typeof s === "object" && !Array.isArray(s));
  const hasCode =
    Array.isArray(record.CodeSegments) &&
    record.CodeSegments.some((s) => s && typeof s === "object" && !Array.isArray(s));
  return hasIr || hasCode;
}

function neededProtocolRefs(commands) {
  const ids = new Set();
  const names = new Set();
  if (!Array.isArray(commands)) return { ids, names };
  for (const cmd of commands) {
    if (!cmd || typeof cmd !== "object") continue;
    const keycode = cmd.KeyCode;
    if (typeof keycode === "string" && keycode.startsWith("G:")) {
      const name = keycode.slice(2).split(":", 1)[0];
      if (name) names.add(name);
      const pid = cmd.ProtocolId;
      if (Number.isInteger(pid) && pid > 0) ids.add(pid);
    }
  }
  return { ids, names };
}

function selectNeededProtocols(protocolList, commands) {
  const { ids, names } = neededProtocolRefs(commands);
  if (ids.size === 0 && names.size === 0) return [];
  const entries = Array.isArray(protocolList)
    ? protocolList.filter((p) => p && typeof p === "object" && !Array.isArray(p))
    : extractProtocolList(protocolList);
  const selected = [];
  const seenIds = new Set();
  const seenNames = new Set();
  for (const proto of entries) {
    if (!isValidProtocolRecord(proto)) continue;
    const pid = proto["Id-"];
    const name = proto.Name;
    if (!ids.has(pid) && !names.has(name)) continue;
    if (seenIds.has(pid) || seenNames.has(name)) continue;
    seenIds.add(pid);
    seenNames.add(name);
    selected.push(proto);
  }
  return selected;
}

async function checkDeviceModel(client, { manufacturer, model } = {}) {
  const mfr = String(manufacturer ?? "").trim();
  const mdl = String(model ?? "").trim();
  if (!mfr || !mdl) {
    throw new CatalogError("manufacturer and model are required");
  }
  const url = `${SEARCH_DEVICE_BASE_URL}/manf/${encodeURIComponent(mfr)}/model/${encodeURIComponent(mdl)}/iface/IR`;
  const { status, payload } = await client.get(url);
  if (status !== 200 || !payload || typeof payload !== "object") {
    throw new CatalogError("Logitech's model check is unavailable; try again");
  }
  const devices = Array.isArray(payload.devices)
    ? payload.devices
    : Array.isArray(payload.SearchDeviceResult?.devices)
      ? payload.SearchDeviceResult.devices
      : [];
  if (devices.length === 0) {
    return { found: false, manufacturer: mfr, model: mdl };
  }
  const first = devices[0] || {};
  const alias =
    Array.isArray(first.aliases) && first.aliases.length > 0
      ? first.aliases[0]
      : first;
  const canonicalManufacturer = String(
    alias?.manf || alias?.Manufacturer || mfr
  ).trim();
  const canonicalModel = String(
    alias?.model || alias?.Model || mdl
  ).trim();
  return {
    found: true,
    manufacturer: canonicalManufacturer || mfr,
    model: canonicalModel || mdl,
  };
}

function redact(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[String(k)] = SECRET_KEY_RE.test(String(k)) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}

function buildPackage({
  manufacturer,
  model,
  searchResult,
  selectedMatch,
  globalDevice,
  languageCommands,
  protocols = undefined,
  generatedAt = new Date().toISOString(),
  source = PACKAGE_SOURCE,
} = {}) {
  const resources = {
    search_result: redact(searchResult),
    selected_match: redact(selectedMatch),
    global_device: redact(globalDevice),
    global_language_commands: redact(languageCommands),
  };
  if (protocols !== undefined && protocols !== null) {
    resources.protocols = redact(protocols);
  }
  return {
    schema_version: PACKAGE_SCHEMA,
    generated_at: generatedAt,
    source,
    query: {
      manufacturer: String(manufacturer ?? ""),
      model: String(model ?? ""),
    },
    resources,
  };
}

function searchMatches(searchResult) {
  if (!searchResult || typeof searchResult !== "object" || Array.isArray(searchResult)) {
    throw new CatalogError("SearchGlobalDevices did not return an object");
  }
  const matches = searchResult.Matches;
  if (matches === null || matches === undefined) {
    throw new CatalogError(
      "Logitech's catalog did not search: it needs the manufacturer AND the model"
    );
  }
  if (!Array.isArray(matches)) {
    throw new CatalogError("SearchGlobalDevices did not return Matches");
  }
  return matches.filter((m) => m && typeof m === "object" && !Array.isArray(m));
}

function formatSearchMatches(matches, fallbackManufacturer = "", fallbackModel = "") {
  return matches
    .map((m) => {
      const rawId = m["Id-"] ?? m.Id;
      const id = typeof rawId === "number" ? rawId : Number(rawId);
      if (!Number.isInteger(id) || id <= 0) return null;
      const manufacturer = String(m.Manufacturer || fallbackManufacturer || "").trim();
      const model = String(m.DeviceModel || m.Model || fallbackModel || "").trim();
      const displayText = String(
        m.DisplayText || m.SelectedText || `${manufacturer} ${model}`.trim()
      ).trim();
      const deviceType = formatDeviceType(m.DeviceType);
      const description = m.Description ? String(m.Description).trim() : "";
      return {
        id,
        manufacturer,
        model,
        displayText,
        deviceType,
        description,
      };
    })
    .filter(Boolean);
}

function createCatalogService({
  client = new JsonClient(),
  settingsStore = null,
  getClientId = null,
  openSignInWindow = null,
} = {}) {
  let inMemoryTokens = null;
  let currentSession = null;
  let cachedOperations = null;
  let lastSearchContext = null;
  let signInPromise = null;
  let requestChain = Promise.resolve();

  function resolveClientId() {
    if (typeof getClientId === "function") {
      return getClientId() || DEFAULT_CLIENT_ID;
    }
    return settingsStore?.getSettings?.().effectiveClientId || DEFAULT_CLIENT_ID;
  }

  function loadStoredTokens() {
    if (inMemoryTokens) return inMemoryTokens;
    const stored = settingsStore?.getLogitechTokens?.() || null;
    if (stored) {
      inMemoryTokens = stored;
    }
    return stored;
  }

  function saveStoredTokens(tokens) {
    inMemoryTokens = tokens;
    settingsStore?.setLogitechTokens?.(tokens);
  }

  function clearStoredTokens() {
    inMemoryTokens = null;
    currentSession = null;
    cachedOperations = null;
    lastSearchContext = null;
    client.clearCookies?.();
    settingsStore?.clearLogitechTokens?.();
  }

  function runExclusive(fn) {
    const next = requestChain.then(fn, fn);
    requestChain = next.catch(() => {});
    return next;
  }

  async function ensureActiveSession() {
    if (currentSession) {
      return currentSession;
    }
    const cid = resolveClientId();
    try {
      currentSession = await ensureSession(client, {
        loadTokens: () => loadStoredTokens(),
        saveTokens: (t) => saveStoredTokens(t),
        clientId: cid,
        signIn: typeof openSignInWindow === "function"
          ? () => openSignInWindow({ client, clientId: cid })
          : null,
      });
    } catch (error) {
      clearStoredTokens();
      throw error;
    }
    return currentSession;
  }

  async function withCatalogRetry(action) {
    const session = await ensureActiveSession();
    let catalog = new GlobalCatalogClient(client, session, cachedOperations);
    try {
      const res = await action(catalog);
      cachedOperations = await catalog.operations();
      return res;
    } catch (err) {
      if (err && err.accessDenied && session?.tokens?.refresh_token) {
        // Exactly one silent refresh-and-retry on "Access is denied"
        try {
          const cid = resolveClientId();
          const refreshed = await oauthRefresh(client, session.tokens, cid);
          saveStoredTokens(refreshed);
          currentSession = await harmonySignin(client, refreshed);
          catalog = new GlobalCatalogClient(
            client,
            currentSession,
            cachedOperations
          );
          const res = await action(catalog);
          cachedOperations = await catalog.operations();
          return res;
        } catch {
          clearStoredTokens();
          throw new CatalogError(
            "Logitech refused the catalog session; sign in again"
          );
        }
      }
      if (err?.accessDenied) clearStoredTokens();
      throw err;
    }
  }

  function isSignedIn() {
    return Boolean(currentSession || loadStoredTokens());
  }

  async function status() {
    return { signedIn: isSignedIn() };
  }

  async function signIn() {
    if (signInPromise) {
      return signInPromise;
    }
    signInPromise = runExclusive(async () => {
      try {
        await ensureActiveSession();
        return { signedIn: true };
      } catch (error) {
        if (error?.message === "Sign in to Logitech first") return { signedIn: false };
        throw error;
      }
    });
    try {
      return await signInPromise;
    } finally {
      signInPromise = null;
    }
  }

  async function signOut() {
    return runExclusive(() => {
      clearStoredTokens();
      return { signedIn: false };
    });
  }

  async function checkModel({ manufacturer, model }) {
    return runExclusive(() =>
      checkDeviceModel(client, { manufacturer, model })
    );
  }

  async function search({ manufacturer, model }) {
    return runExclusive(async () => {
      lastSearchContext = null;
      const raw = await withCatalogRetry((catalog) =>
        catalog.search(manufacturer, model)
      );
      const matches = searchMatches(raw);
      if (matches.length === 0) {
        throw new CatalogError(
          `No catalog device matches ${manufacturer} ${model}`
        );
      }
      lastSearchContext = { manufacturer, model, raw, matches };
      return formatSearchMatches(matches, manufacturer, model);
    });
  }

  async function download({ id, manufacturer, model }) {
    return runExclusive(async () => {
      return withCatalogRetry(async (catalog) => {
        const result = await catalog.globalDevices([id]);
        if (
          !Array.isArray(result) ||
          result.length !== 1 ||
          !result[0] ||
          typeof result[0] !== "object"
        ) {
          throw new CatalogError("GetGlobalDevices did not return the device");
        }
        const globalDevice = result[0];
        if (Number(globalDevice.Id ?? globalDevice["Id-"]) !== id) {
          throw new CatalogError("The catalog returned a different device; search again");
        }
        const versionId = globalDevice.DefaultGlobalLanguageVersionId;
        if (
          (typeof versionId !== "number" && typeof versionId !== "string") ||
          typeof versionId === "boolean"
        ) {
          throw new CatalogError("the device carries no language version id");
        }
        const commands = await catalog.globalLanguageCommands(versionId);
        if (!Array.isArray(commands)) throw new CatalogError("The catalog returned no command list");
        let protocols = [];
        const refs = neededProtocolRefs(commands);
        if (refs.ids.size > 0 || refs.names.size > 0) {
          try {
            protocols = selectNeededProtocols(await catalog.protocolList(), commands);
          } catch (err) {
            if (err?.accessDenied) throw err;
            protocols = [];
          }
        }
        const matched =
          lastSearchContext?.matches?.find(
            (m) => Number(m["Id-"] ?? m.Id) === Number(id)
          ) || {
            "Id-": id,
            Manufacturer: manufacturer,
            DeviceModel: model,
          };
        const searchResult = lastSearchContext?.raw || {
          Matches: [matched],
          Status: 0,
        };
        return buildPackage({
          manufacturer,
          model,
          searchResult,
          selectedMatch: matched,
          globalDevice,
          languageCommands: commands,
          protocols,
        });
      });
    });
  }

  return {
    isSignedIn,
    status,
    signIn,
    signOut,
    checkModel,
    search,
    download,
  };
}

module.exports = {
  DISCOVERY_URL,
  DISCOVERY_CLIENT_TYPE,
  HARMONY_SIGNIN_URL,
  SEARCH_DEVICE_BASE_URL,
  SEARCH_OPERATION,
  GLOBAL_DEVICES_OPERATION,
  GLOBAL_LANGUAGE_COMMANDS_OPERATION,
  COMMANDS_OPERATION,
  PROTOCOL_LIST_OPERATION,
  PACKAGE_SCHEMA,
  PACKAGE_SOURCE,
  CatalogError,
  JsonClient,
  harmonySignin,
  ensureSession,
  swapHost,
  loadBalancerAddress,
  createOperation,
  parseOperations,
  GlobalCatalogClient,
  extractProtocolList,
  isValidProtocolRecord,
  neededProtocolRefs,
  selectNeededProtocols,
  checkDeviceModel,
  redact,
  buildPackage,
  searchMatches,
  formatSearchMatches,
  createCatalogService,
};
