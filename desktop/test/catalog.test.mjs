import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "catalog-fixtures.json"),
    "utf8"
  )
);

const {
  OAUTH_AUTHORIZE_URL,
  OAUTH_TOKEN_URL,
  OAUTH_REDIRECT_URI,
  DEFAULT_CLIENT_ID,
  CatalogError,
  base64url,
  pkcePair,
  authorizeUrl,
  parseCallback,
  buildExchangeForm,
  buildRefreshForm,
  oauthExchange,
  oauthRefresh,
} = require("../src/catalog/oauth.js");

const {
  DISCOVERY_URL,
  HARMONY_SIGNIN_URL,
  SEARCH_DEVICE_BASE_URL,
  PROTOCOL_LIST_OPERATION,
  ensureSession,
  loadBalancerAddress,
  parseOperations,
  isValidProtocolRecord,
  selectNeededProtocols,
  checkDeviceModel,
  redact,
  buildPackage,
  fetchPackage,
  createCatalogService,
  JsonClient,
} = require("../src/catalog/client.js");

const {
  runSignInWindow,
  isAllowedSignInNavigationUrl,
} = require("../src/catalog/signin-window.js");

test("PKCE pair generates 48-byte base64url verifier, S256 challenge, and 24-byte state", () => {
  const { verifier, challenge, state } = pkcePair();
  // 48 bytes -> 64 base64url chars; 32-byte SHA-256 -> 43 base64url chars; 24 bytes -> 32 base64url chars
  assert.match(verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(state, /^[A-Za-z0-9_-]{32}$/);

  const recomputed = base64url(
    crypto.createHash("sha256").update(verifier, "ascii").digest()
  );
  assert.equal(challenge, recomputed);
});

test("authorizeUrl builds the Logitech OAuth2 URL with PKCE S256, openid scope, and app redirect_uri", () => {
  const url = authorizeUrl({
    clientId: DEFAULT_CLIENT_ID,
    challenge: "ch_test_123",
    state: "st_test_456",
  });
  const parsed = new URL(url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, OAUTH_AUTHORIZE_URL);
  assert.equal(parsed.searchParams.get("client_id"), DEFAULT_CLIENT_ID);
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("code_challenge"), "ch_test_123");
  assert.equal(parsed.searchParams.get("state"), "st_test_456");
  assert.equal(parsed.searchParams.get("redirect_uri"), OAUTH_REDIRECT_URI);
  assert.equal(parsed.searchParams.get("scope"), "openid");
});

test("parseCallback enforces strict callback checks (wrong state, missing state, no code, bare string, logi.com page, error=)", () => {
  for (const bad of [
    "com.logitech.harmony://other?code=x&state=s",
    "com.logitech.harmony://lidsoauth/path?code=x&state=s",
    "com.logitech.harmony://lidsoauth?code=x&state=s&error=",
    "com.logitech.harmony://lidsoauth?code=x&code=y&state=s",
    "com.logitech.harmony://lidsoauth?code=x&state=s&state=s",
  ]) assert.throws(() => parseCallback(bad, { expectedState: "s" }));
  assert.equal(
    parseCallback(
      "com.logitech.harmony://lidsoauth?code=auth_code_99&state=expected_state_1",
      { expectedState: "expected_state_1" }
    ),
    "auth_code_99"
  );
  assert.equal(
    parseCallback("?code=auth_code_99&state=expected_state_1", {
      expectedState: "expected_state_1",
    }),
    "auth_code_99"
  );

  const rejectedCases = [
    ["empty string", "", "expected_state_1", /nothing was pasted/i],
    [
      "wrong state",
      "com.logitech.harmony://lidsoauth?code=auth_code_99&state=other_state",
      "expected_state_1",
      /different sign-in attempt/i,
    ],
    [
      "missing state in URL",
      "com.logitech.harmony://lidsoauth?code=auth_code_99",
      "expected_state_1",
      /different sign-in attempt/i,
    ],
    [
      "missing state in query",
      "code=auth_code_99",
      "expected_state_1",
      /different sign-in attempt/i,
    ],
    [
      "missing expectedState",
      "com.logitech.harmony://lidsoauth?code=auth_code_99&state=s1",
      "",
      /different sign-in attempt/i,
    ],
    [
      "no code",
      "com.logitech.harmony://lidsoauth?state=expected_state_1",
      "expected_state_1",
      /not the callback address/i,
    ],
    [
      "bare string / nonce",
      "bare_nonce_123456",
      "expected_state_1",
      /not the callback address/i,
    ],
    [
      "id.logi.com launch page",
      "https://id.logi.com/launch.html?nonce=abc123",
      "expected_state_1",
      /Logitech's own page/i,
    ],
    [
      "accounts.logi.com redirect page",
      "https://accounts.logi.com/identity/oauth2/authorize/redirect/abc123",
      "expected_state_1",
      /Logitech's own page/i,
    ],
    [
      "error callback",
      "com.logitech.harmony://lidsoauth?error=access_denied&error_description=User+denied&state=expected_state_1",
      "expected_state_1",
      /Logitech refused the sign-in; sign in again/i,
    ],
  ];

  for (const [label, input, expectedState, pattern] of rejectedCases) {
    assert.throws(
      () => parseCallback(input, { expectedState }),
      pattern,
      `Expected ${label} to throw matching ${pattern}`
    );
  }
});

test("JSON transport encodes forms, scopes cookies, refuses unexpected endpoints and never follows redirects", async () => {
  const calls = [];
  const client = new JsonClient({ fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return new Response('{"ok":true}', { headers: { "set-cookie": "session=fixture-cookie; Path=/" } });
  } });
  await client.postForm(OAUTH_TOKEN_URL, { grant_type: "authorization_code", code: "a +&b" });
  assert.equal(calls[0].headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(new URLSearchParams(calls[0].body).get("code"), "a +&b");
  await client.post(HARMONY_SIGNIN_URL, {}, { token: "fixture-bearer" });
  assert.equal(calls[1].headers.Cookie, undefined, "OAuth cookies never reach Harmony");
  await client.post("https://lb-svcs.myharmony.com/HarmonyPlatform/DeviceManager.svc/json2/SearchGlobalDevices", {});
  assert.equal(calls[2].headers.Cookie, "session=fixture-cookie");
  await client.get(`${SEARCH_DEVICE_BASE_URL}/manf/Sony/model/STR-DG720/iface/IR`);
  assert.equal(calls[3].headers.Cookie, undefined, "model check is anonymous");
  for (const call of calls) assert.equal(call.redirect, "error");
  await assert.rejects(client.post("https://untrusted.example/", {}, { token: "fixture-bearer" }), /unexpected catalog endpoint/);
  assert.equal(calls.length, 4);
});

function serviceFixture({ saved = true, denied = false, prompt = null } = {}) {
  const calls = [];
  let stored = saved ? { access_token: "fixture-access", id_token: "fixture-identity", refresh_token: "fixture-refresh" } : null;
  const service = createCatalogService({
    client: {
      clearCookies() { calls.push("clearCookies"); },
      async post(url) {
        if (url === HARMONY_SIGNIN_URL) { calls.push("signin"); return { status: 200, payload: { AccountId: "fixture-account" } }; }
        if (url === DISCOVERY_URL) { calls.push("discovery"); return { status: 200, payload: FIXTURES.discovery }; }
        calls.push("operation");
        return denied ? { status: 400, payload: { Message: "Access is denied." } } : { status: 200, payload: FIXTURES.searchGlobalDevices };
      },
      async postForm() {
        calls.push("refresh");
        return { status: 200, payload: { access_token: "fixture-renewed", id_token: "fixture-identity" } };
      },
      async get() { calls.push("check"); return { status: 200, payload: FIXTURES.searchDeviceFound }; },
    },
    settingsStore: {
      getLogitechTokens: () => stored,
      setLogitechTokens: (t) => { stored = t; },
      clearLogitechTokens: () => { stored = null; },
    },
    openSignInWindow: prompt || (async () => { calls.push("prompt"); return { cancelled: true }; }),
  });
  return { service, calls };
}

test("terminal access denial refreshes exactly once, clears saved credentials, and status never networks", async () => {
  const { service, calls } = serviceFixture({ denied: true });
  assert.deepEqual(await service.status(), { signedIn: true });
  assert.deepEqual(calls, []);
  await assert.rejects(service.search({ manufacturer: "Sony", model: "STR-DG7" }), /refused the catalog session/);
  assert.equal(calls.filter((c) => c === "refresh").length, 1);
  assert.equal(calls.filter((c) => c === "operation").length, 2);
  assert.equal(calls.includes("prompt"), false, "no interactive loop after retry denial");
  assert.deepEqual(await service.status(), { signedIn: false });
});

test("catalog service serializes requests and does no work before an explicit call", async () => {
  let active = 0;
  let maximum = 0;
  let count = 0;
  const service = createCatalogService({ client: {
    async get() {
      count++; active++; maximum = Math.max(maximum, active);
      await new Promise((r) => setImmediate(r)); active--;
      return { status: 200, payload: FIXTURES.searchDeviceFound };
    },
  } });
  await new Promise((r) => setImmediate(r));
  assert.equal(count, 0);
  await Promise.all([1, 2, 3].map(() => service.checkModel({ manufacturer: "Sony", model: "STR-DG720" })));
  assert.equal(count, 3);
  assert.equal(maximum, 1);
});

test("cancel leaves signed out, concurrent signIn coalesces, and signOut cannot resurrect an in-flight session", async () => {
  let complete;
  const f = serviceFixture({ saved: false, prompt: () => new Promise((r) => { complete = r; }) });
  const first = f.service.signIn();
  const second = f.service.signIn();
  await new Promise((r) => setImmediate(r));
  complete({ cancelled: true });
  assert.deepEqual(await first, { signedIn: false });
  assert.deepEqual(await second, { signedIn: false });
  assert.deepEqual(await f.service.status(), { signedIn: false });
  const pending = f.service.signIn();
  await new Promise((r) => setImmediate(r));
  const signOut = f.service.signOut();
  complete({ tokens: { access_token: "fixture-access", id_token: "fixture-identity" } });
  await pending; await signOut;
  assert.deepEqual(await f.service.status(), { signedIn: false });
});

test("buildExchangeForm, buildRefreshForm, oauthExchange, and oauthRefresh send form-encoded bodies", async () => {
  assert.deepEqual(
    buildExchangeForm({
      clientId: "cid-1",
      code: "code-2",
      verifier: "ver-3",
    }),
    {
      grant_type: "authorization_code",
      client_id: "cid-1",
      code_verifier: "ver-3",
      redirect_uri: OAUTH_REDIRECT_URI,
      code: "code-2",
    }
  );

  assert.deepEqual(
    buildRefreshForm({
      clientId: "cid-1",
      refreshToken: "ref-4",
    }),
    {
      grant_type: "refresh_token",
      client_id: "cid-1",
      refresh_token: "ref-4",
    }
  );

  const calls = [];
  const fakeClient = {
    async postForm(url, fields) {
      calls.push({ url, fields });
      if (fields.grant_type === "authorization_code") {
        return {
          status: 200,
          payload: {
            access_token: "acc-new",
            id_token: "id-new",
            refresh_token: "ref-new",
          },
        };
      }
      return {
        status: 200,
        payload: {
          access_token: "acc-refreshed",
          id_token: "id-refreshed",
        },
      };
    },
  };

  const exchanged = await oauthExchange(fakeClient, {
    clientId: "cid-1",
    code: "code-2",
    verifier: "ver-3",
  });
  assert.equal(calls[0].url, OAUTH_TOKEN_URL);
  assert.equal(exchanged.access_token, "acc-new");
  assert.equal(exchanged.refresh_token, "ref-new");

  const refreshed = await oauthRefresh(fakeClient, exchanged, "cid-1");
  assert.equal(calls[1].url, OAUTH_TOKEN_URL);
  assert.equal(refreshed.access_token, "acc-refreshed");
  // Preserves refresh_token if the refresh response omits a rotated one
  assert.equal(refreshed.refresh_token, "ref-new");
});

test("ensureSession follows saved -> one silent refresh -> interactive sign-in once, never looping", async () => {
  // Case 1: Saved tokens work immediately -> no refresh, no prompt
  {
    const order = [];
    const client = {
      async post(url, body, { token }) {
        assert.equal(url, HARMONY_SIGNIN_URL);
        order.push(`signin:${token}`);
        return { status: 200, payload: { AccountId: "acct-1" } };
      },
      async postForm() {
        order.push("refresh");
        throw new Error("should not refresh");
      },
    };
    const session = await ensureSession(client, {
      loadTokens: () => ({
        access_token: "saved-acc",
        id_token: "saved-id",
        refresh_token: "saved-ref",
      }),
      saveTokens: () => order.push("save"),
      signIn: () => {
        order.push("prompt");
        throw new Error("should not prompt");
      },
    });
    assert.equal(session.accountId, "acct-1");
    assert.deepEqual(order, ["signin:saved-acc"]);
  }

  // Case 2: Saved tokens fail signin -> silent refresh succeeds -> no prompt
  {
    const order = [];
    const client = {
      async post(_url, _body, { token }) {
        order.push(`signin:${token}`);
        if (token === "stale-acc") {
          return { status: 401, payload: {} };
        }
        return { status: 200, payload: { AccountId: "acct-2" } };
      },
      async postForm(_url, fields) {
        order.push(`refresh:${fields.refresh_token}`);
        return {
          status: 200,
          payload: {
            access_token: "refreshed-acc",
            id_token: "refreshed-id",
            refresh_token: "refreshed-ref",
          },
        };
      },
    };
    const session = await ensureSession(client, {
      loadTokens: () => ({
        access_token: "stale-acc",
        id_token: "stale-id",
        refresh_token: "stale-ref",
      }),
      saveTokens: (t) => order.push(`save:${t.access_token}`),
      signIn: () => {
        order.push("prompt");
        throw new Error("should not prompt");
      },
    });
    assert.equal(session.accountId, "acct-2");
    assert.deepEqual(order, [
      "signin:stale-acc",
      "refresh:stale-ref",
      "save:refreshed-acc",
      "signin:refreshed-acc",
    ]);
  }

  // Case 3: Saved tokens fail + refresh fails -> prompts once and never loops even if prompt signin fails
  {
    const order = [];
    const client = {
      async post(_url, _body, { token }) {
        order.push(`signin:${token}`);
        return { status: 401, payload: {} };
      },
      async postForm(_url, fields) {
        order.push(`refresh:${fields.refresh_token}`);
        return { status: 400, payload: { error: "invalid_grant" } };
      },
    };
    await assert.rejects(
      () =>
        ensureSession(client, {
          loadTokens: () => ({
            access_token: "dead-acc",
            id_token: "dead-id",
            refresh_token: "dead-ref",
          }),
          saveTokens: (t) => order.push(`save:${t.access_token}`),
          signIn: async () => {
            order.push("prompt");
            return {
              tokens: {
                access_token: "prompt-acc",
                id_token: "prompt-id",
                refresh_token: "prompt-ref",
              },
            };
          },
        }),
      /Harmony rejected the bootstrap/
    );
    assert.deepEqual(order, [
      "signin:dead-acc",
      "refresh:dead-ref",
      "prompt",
      "save:prompt-acc",
      "signin:prompt-acc",
    ]);
  }
});

test("parseOperations and loadBalancerAddress swap svcs/cf-svcs to lb-svcs and /json/ to /json2/", () => {
  const ops = parseOperations(FIXTURES.discovery);
  assert.ok(ops["DeviceManager/SearchGlobalDevices"]);
  assert.equal(
    ops["DeviceManager/SearchGlobalDevices"].endpoint({ json2: true }),
    "https://cf-svcs.myharmony.com/HarmonyPlatform/DeviceManager.svc/json2/SearchGlobalDevices"
  );
  assert.equal(
    loadBalancerAddress(
      ops["DeviceManager/SearchGlobalDevices"].endpoint({ json2: true })
    ),
    "https://lb-svcs.myharmony.com/HarmonyPlatform/DeviceManager.svc/json2/SearchGlobalDevices"
  );
  assert.equal(
    loadBalancerAddress("http://revue.logitech.com/DigitalHome/tv/GetSupportPolicy2"),
    "http://revue.logitech.com/DigitalHome/tv/GetSupportPolicy2"
  );
});

test("redact strips secret keys recursively and leaves command data intact", () => {
  const input = {
    Manufacturer: "Sony",
    access_token: "secret-1",
    RefreshToken: "secret-2",
    id_token: "secret-3",
    AccountId: "secret-4",
    nested: {
      Authorization: "Bearer xyz",
      Cookie: "sid=abc",
      Password: "pw",
      KeyCode: "G:Sony 15 Bit:()(0x3A0C)():3",
    },
    list: [{ secretKey: "hidden", Name: "PowerOn" }],
  };
  const out = redact(input);
  assert.equal(out.Manufacturer, "Sony");
  assert.equal(out.access_token, "[REDACTED]");
  assert.equal(out.RefreshToken, "[REDACTED]");
  assert.equal(out.id_token, "[REDACTED]");
  assert.equal(out.AccountId, "[REDACTED]");
  assert.equal(out.nested.Authorization, "[REDACTED]");
  assert.equal(out.nested.Cookie, "[REDACTED]");
  assert.equal(out.nested.Password, "[REDACTED]");
  assert.equal(out.nested.KeyCode, "G:Sony 15 Bit:()(0x3A0C)():3");
  assert.equal(out.list[0].secretKey, "[REDACTED]");
  assert.equal(out.list[0].Name, "PowerOn");
});

test("checkDeviceModel, search, download, package building, and one-shot Access is denied retry against fixtures", async () => {
  let denyOnce = false;
  const calls = [];

  const fakeClient = {
    clearCookies() {},
    async get(url) {
      calls.push({ method: "GET", url });
      if (url.includes("/manf/Sony/model/STR-DG720/")) {
        return { status: 200, payload: FIXTURES.searchDeviceFound };
      }
      return { status: 200, payload: FIXTURES.searchDeviceNotFound };
    },
    async post(url, body, { token } = {}) {
      calls.push({ method: "POST", url, body, token });
      if (url === HARMONY_SIGNIN_URL) {
        return { status: 200, payload: { AccountId: "acct-fixture" } };
      }
      if (url === DISCOVERY_URL) {
        return { status: 200, payload: FIXTURES.discovery };
      }
      if (denyOnce) {
        denyOnce = false;
        return {
          status: 400,
          payload: { ErrorCode: 5, Message: "Access is denied." },
        };
      }
      if (url.endsWith("/json2/SearchGlobalDevices")) {
        return { status: 200, payload: FIXTURES.searchGlobalDevices };
      }
      if (url.endsWith("/json2/GetGlobalDevices")) {
        return { status: 200, payload: FIXTURES.getGlobalDevices };
      }
      if (url.endsWith("/json/GetGlobalLanguageCommands")) {
        return { status: 200, payload: FIXTURES.getGlobalLanguageCommands };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    async postForm(url, fields) {
      calls.push({ method: "POST_FORM", url, fields });
      return {
        status: 200,
        payload: {
          access_token: "tok-refreshed",
          id_token: "id-refreshed",
          refresh_token: "ref-refreshed",
        },
      };
    },
  };

  // 1. Anonymous model check
  const found = await checkDeviceModel(fakeClient, {
    manufacturer: "Sony",
    model: "STR-DG720",
  });
  assert.deepEqual(found, {
    found: true,
    manufacturer: "Sony",
    model: "STR-DG720",
  });
  const missing = await checkDeviceModel(fakeClient, {
    manufacturer: "Sony",
    model: "UNKNOWN",
  });
  assert.deepEqual(missing, {
    found: false,
    manufacturer: "Sony",
    model: "UNKNOWN",
  });

  // 2. CatalogService with saved tokens, search, Access-is-denied single refresh-and-retry, and download
  let storedTokens = {
    access_token: "tok-initial",
    id_token: "id-initial",
    refresh_token: "ref-initial",
  };
  const service = createCatalogService({
    client: fakeClient,
    settingsStore: {
      getSettings: () => ({ effectiveClientId: DEFAULT_CLIENT_ID }),
      getLogitechTokens: () => storedTokens,
      setLogitechTokens: (t) => {
        storedTokens = t;
      },
      clearLogitechTokens: () => {
        storedTokens = null;
      },
      hasLogitechTokens: () => Boolean(storedTokens),
    },
  });

  assert.deepEqual(await service.status(), { signedIn: true });

  denyOnce = true;
  const searchResults = await service.search({
    manufacturer: "Sony",
    model: "STR-DG7",
  });
  assert.equal(searchResults.length, 1);
  assert.deepEqual(searchResults[0], {
    id: 167856,
    manufacturer: "Sony",
    model: "STR-DG720",
    displayText: "Sony STR-DG720",
    deviceType: "Receiver",
    description: "",
  });
  // Verify token was refreshed once after Access is denied
  assert.equal(storedTokens.access_token, "tok-refreshed");

  const pkg = await service.download({
    id: 167856,
    manufacturer: "Sony",
    model: "STR-DG720",
  });
  assert.equal(pkg.schema_version, "0.2.0");
  assert.equal(pkg.source, "logitech-catalog-via-melodious-desktop");
  assert.deepEqual(pkg.query, { manufacturer: "Sony", model: "STR-DG720" });
  assert.equal(pkg.resources.global_language_commands.length, 5);
  assert.equal(
    JSON.stringify(pkg).includes("tok-refreshed"),
    false,
    "Package must never contain tokens"
  );
  assert.equal(
    JSON.stringify(pkg).includes("acct-fixture"),
    false,
    "Package must never contain AccountId"
  );
});

test("runSignInWindow catches first callback via will-redirect, ignores duplicate 2.5s redirect, and handles cancel cleanly", async () => {
  // 1. Successful sign-in with duplicate redirect ignored
  let exchangeCalls = 0;
  const fakeClient = {
    async postForm(_url, fields) {
      exchangeCalls += 1;
      return {
        status: 200,
        payload: {
          access_token: `acc-${fields.code}`,
          id_token: "id-1",
          refresh_token: "ref-1",
        },
      };
    },
  };

  let createdWin = null;
  const fakeSession = {
    clearStorageData: async () => {},
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
    webRequest: {
      onBeforeRedirect: () => {},
    },
  };

  const signInPromise = runSignInWindow({
    client: fakeClient,
    pkce: {
      verifier: "v".repeat(64),
      challenge: "c".repeat(43),
      state: "state123",
    },
    getSession: () => fakeSession,
    createWindow: () => {
      const wc = new EventEmitter();
      wc.setWindowOpenHandler = () => {};
      const win = new EventEmitter();
      win.webContents = wc;
      win.destroyed = false;
      win.isDestroyed = () => win.destroyed;
      win.close = () => {
        win.destroyed = true;
        win.emit("closed");
      };
      win.loadURL = async () => {
        const callbackUrl =
          "com.logitech.harmony://lidsoauth?code=first_code&state=state123";
        wc.emit("will-redirect", { preventDefault() {} }, callbackUrl);
        // Simulate Logi ID's second redirect ~2.5s later
        wc.emit(
          "will-redirect",
          { preventDefault() {} },
          "com.logitech.harmony://lidsoauth?code=second_code&state=state123"
        );
      };
      createdWin = win;
      return win;
    },
  });

  const res = await signInPromise;
  assert.equal(res.cancelled, false);
  assert.equal(res.tokens.access_token, "acc-first_code");
  assert.equal(exchangeCalls, 1);
  assert.equal(createdWin.isDestroyed(), true);

  // 2. Cancelled window resolves with { cancelled: true, tokens: null } and no error loop
  const cancelRes = await runSignInWindow({
    client: fakeClient,
    getSession: () => fakeSession,
    createWindow: () => {
      const wc = new EventEmitter();
      wc.setWindowOpenHandler = () => {};
      const win = new EventEmitter();
      win.webContents = wc;
      win.isDestroyed = () => false;
      win.close = () => {};
      win.loadURL = async () => {
        win.emit("closed");
      };
      return win;
    },
  });
  assert.deepEqual(cancelRes, { cancelled: true, tokens: null });

  // 3. Sign-in window navigation guard allows only https: and about:blank
  assert.equal(isAllowedSignInNavigationUrl("https://accounts.logi.com/"), true);
  assert.equal(isAllowedSignInNavigationUrl("https://accounts.google.com/"), true);
  assert.equal(isAllowedSignInNavigationUrl("about:blank"), true);
  assert.equal(isAllowedSignInNavigationUrl("http://accounts.logi.com/"), false);
  assert.equal(isAllowedSignInNavigationUrl("file:///etc/passwd"), false);
});

test("sign-in guards popup session isolation, every callback hook, permissions and invalid-state refusal", async () => {
  for (const via of ["will-navigate", "will-frame-navigate", "onBeforeRedirect", "popup", "wrong-state"]) {
    let win;
    let options;
    let beforeRedirect;
    let clearCount = 0;
    let exchanged = 0;
    const ses = new EventEmitter();
    ses.clearStorageData = async () => { clearCount++; };
    ses.setPermissionRequestHandler = (fn) => { fn({}, "camera", (granted) => assert.equal(granted, false)); };
    ses.setPermissionCheckHandler = (fn) => assert.equal(fn(), false);
    ses.webRequest = { onBeforeRedirect: (fn) => { beforeRedirect = fn; } };
    const pending = runSignInWindow({
      client: { postForm: async () => { exchanged++; return { status: 200, payload: { access_token: "fixture-access", id_token: "fixture-identity" } }; } },
      pkce: { verifier: "v", challenge: "c", state: "expected" },
      getSession: (partition) => { assert.equal(partition, "logitech-signin"); return ses; },
      createWindow: (opts) => {
        options = opts;
        win = new EventEmitter();
        win.webContents = new EventEmitter();
        win.webContents.setWindowOpenHandler = (fn) => { win.openHandler = fn; };
        win.loadURL = async () => {};
        win.close = () => { win.closed = true; win.emit("closed"); };
        win.isDestroyed = () => Boolean(win.closed);
        return win;
      },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(clearCount, 1);
    assert.equal(options.webPreferences.session, ses);
    assert.equal(options.webPreferences.sandbox, true);
    assert.equal(options.webPreferences.contextIsolation, true);
    assert.equal(options.webPreferences.nodeIntegration, false);
    assert.equal(options.webPreferences.preload, undefined);
    const popup = win.openHandler({ url: "https://accounts.google.com/" });
    assert.equal(popup.action, "allow");
    assert.equal(popup.overrideBrowserWindowOptions.webPreferences.session, ses);
    assert.equal(win.openHandler({ url: "file:///not-allowed" }).action, "deny");
    assert.equal(win.openHandler({ url: "http://not-allowed.example/" }).action, "deny");
    let prevented = false;
    const url = `com.logitech.harmony://lidsoauth?code=fixture&state=${via === "wrong-state" ? "wrong" : "expected"}`;
    const event = { url, preventDefault: () => { prevented = true; } };
    if (via === "onBeforeRedirect") beforeRedirect({ redirectURL: url });
    else if (via === "popup") assert.equal(win.openHandler({ url }).action, "deny");
    else win.webContents.emit(via === "wrong-state" ? "will-navigate" : via, event);
    if (via === "wrong-state") { await assert.rejects(pending, /different sign-in attempt/); assert.equal(exchanged, 0); }
    else { assert.equal((await pending).cancelled, false); assert.equal(exchanged, 1); }
    if (!["onBeforeRedirect", "popup"].includes(via)) assert.equal(prevented, true);
    assert.equal(win.closed, true);
    assert.equal(beforeRedirect, null);
  }
});

test("ProtocolList fetch bundles matching IrProtocol records, preserves cookie isolation, and enforces allowlist", async () => {
  const fixtureCustomProto = {
    __type: "IrProtocol",
    "Id-": 999,
    Name: "RC6 Mode 0",
    CarrierFrequency: 36000,
    IRSegments: [{ Header: [{ Value: 2666, Type: 1 }], Payload: { NumberOfBits: 16, Encodings: [] }, Trailer: [], TotalLength: 107000, Name: "RC6 Mode 0" }],
    CodeSegments: [],
    KeyCode: { Start: null, Repeat: [{ SegmentType: 1, SegmentName: "RC6 Mode 0" }], Finish: null },
  };
  const fixtureUnusedProto = {
    __type: "IrProtocol",
    "Id-": 555,
    Name: "Unused Protocol",
    CarrierFrequency: 38000,
    IRSegments: [{ Header: [{ Value: 4000, Type: 1 }], Payload: { NumberOfBits: 12, Encodings: [] }, Trailer: [], TotalLength: 45000, Name: "Unused Protocol" }],
    CodeSegments: [],
    KeyCode: { Start: null, Repeat: [{ SegmentType: 1, SegmentName: "Unused Protocol" }], Finish: null },
  };
  assert.equal(isValidProtocolRecord(fixtureCustomProto), true);
  assert.deepEqual(
    selectNeededProtocols({ Protocols: [fixtureUnusedProto, fixtureCustomProto] }, FIXTURES.getGlobalLanguageCommands.GetGlobalLanguageCommandsResult),
    [fixtureCustomProto]
  );

  // Verify JsonClient allowlist and cookie scoping on real fetch mock:
  // - Authenticated GET to UserAccountDirector/ProtocolList is allowed and sends Cookie + Bearer.
  // - Anonymous SearchDevice GET still sends no Cookie.
  // - Unauthenticated ProtocolList GET or query string is refused.
  const seen = [];
  const client = new JsonClient({
    fetchImpl: async (url, init) => {
      seen.push({ url, method: init.method, headers: init.headers });
      const headers = new Headers();
      if (url === HARMONY_SIGNIN_URL) {
        headers.set("set-cookie", "session=fixture-cookie; Path=/");
        return { status: 200, headers, text: async () => JSON.stringify({ AccountId: "acct-42" }) };
      }
      if (url === DISCOVERY_URL) {
        return {
          status: 200,
          headers,
          text: async () => JSON.stringify({
            GetJsonOperationsResult: [
              ...FIXTURES.discovery.GetJsonOperationsResult,
              {
                Identifier: PROTOCOL_LIST_OPERATION,
                Address: "https://svcs.myharmony.com/UserAccountDirectorPlatform/UserAccountDirector.svc/json/Account/{accountId}/",
                Name: "ProtocolList",
              },
            ],
          }),
        };
      }
      if (url.endsWith("/json2/GetGlobalDevices")) {
        return { status: 200, headers, text: async () => JSON.stringify(FIXTURES.getGlobalDevices) };
      }
      if (url.endsWith("/json/GetGlobalLanguageCommands")) {
        return { status: 200, headers, text: async () => JSON.stringify(FIXTURES.getGlobalLanguageCommands) };
      }
      if (url.endsWith("/Account/acct-42/ProtocolList")) {
        return {
          status: 200,
          headers,
          text: async () => JSON.stringify({ Protocols: [fixtureUnusedProto, fixtureCustomProto, { __type: "HidProtocol", "Id-": 999997, Name: "HID 16 Bit" }] }),
        };
      }
      if (url.startsWith(`${SEARCH_DEVICE_BASE_URL}/manf/`)) {
        return { status: 200, headers, text: async () => JSON.stringify(FIXTURES.searchDeviceFound) };
      }
      throw new Error(`Unexpected fetch ${url}`);
    },
  });

  await assert.rejects(
    () => client.get("https://lb-svcs.myharmony.com/UserAccountDirectorPlatform/UserAccountDirector.svc/json2/Account/acct-42/ProtocolList"),
    /unexpected catalog endpoint/
  );
  await assert.rejects(
    () => client.get("https://lb-svcs.myharmony.com/UserAccountDirectorPlatform/UserAccountDirector.svc/json2/Account/acct-42/ProtocolList?extra=1", { authenticated: true }),
    /unexpected catalog endpoint/
  );

  const service = createCatalogService({
    client,
    settingsStore: {
      getSettings: () => ({ effectiveClientId: DEFAULT_CLIENT_ID }),
      getLogitechTokens: () => ({ access_token: "tok-proto", id_token: "id-proto", refresh_token: "ref-proto" }),
      setLogitechTokens: () => {},
      clearLogitechTokens: () => {},
    },
  });
  const pkg = await service.download({ id: 167856, manufacturer: "Sony", model: "STR-DG720" });
  assert.deepEqual(pkg.resources.protocols, [fixtureCustomProto]);
  assert.equal(JSON.stringify(pkg).includes("acct-42"), false);

  const protoReq = seen.find((r) => r.url.endsWith("/Account/acct-42/ProtocolList"));
  assert.equal(protoReq.method, "GET");
  assert.equal(protoReq.headers.Cookie, "session=fixture-cookie");
  assert.equal(protoReq.headers.Authorization, "Bearer tok-proto");
  assert.equal(protoReq.headers["x-logitech-api-version"], "1");

  await service.checkModel({ manufacturer: "Sony", model: "STR-DG720" });
  const searchReq = seen.find((r) => r.url.startsWith(`${SEARCH_DEVICE_BASE_URL}/manf/`));
  assert.equal(searchReq.headers.Cookie, undefined);
  assert.equal(searchReq.headers.Authorization, undefined);
});
