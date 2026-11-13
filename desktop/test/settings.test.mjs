import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_CLIENT_ID,
  DEFAULT_PORT,
  basicAuthHeader,
  createSettingsStore,
} = require("../src/settings.js");

function makeFakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (str) =>
      Buffer.from(`ENC:${Buffer.from(str, "utf8").toString("base64")}`, "utf8"),
    decryptString: (buf) => {
      const text = Buffer.from(buf).toString("utf8");
      assert.ok(text.startsWith("ENC:"));
      return Buffer.from(text.slice(4), "base64").toString("utf8");
    },
  };
}

test("settings store persists hub host, port, and client_id override in settings.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-settings-test-"));
  try {
    const store = createSettingsStore({
      dir,
      safeStorage: makeFakeSafeStorage(true),
      env: {},
    });

    assert.equal(store.getHub(), null);
    assert.equal(store.getSettings().effectiveClientId, DEFAULT_CLIENT_ID);

    store.setHub({ host: "10.0.0.20", port: 8080 });
    assert.deepEqual(store.getHub(), { host: "10.0.0.20", port: DEFAULT_PORT });

    store.setClientId("custom-client-id-123");
    assert.equal(store.getSettings().clientId, "custom-client-id-123");
    assert.equal(store.getSettings().effectiveClientId, "custom-client-id-123");

    // Re-read with a new instance using env fallback when clientId cleared
    store.setClientId("");
    const storeWithEnv = createSettingsStore({
      dir,
      safeStorage: makeFakeSafeStorage(true),
      env: { MELODIOUS_CLIENT_ID: "env-client-id-456" },
    });
    assert.deepEqual(storeWithEnv.getHub(), { host: "10.0.0.20", port: 8080 });
    assert.equal(storeWithEnv.getSettings().effectiveClientId, "env-client-id-456");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hub password is encrypted with safeStorage and never stored if safeStorage is unavailable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-auth-test-"));
  try {
    const store = createSettingsStore({
      dir,
      safeStorage: makeFakeSafeStorage(true),
    });

    const saved = store.setHubAuth({ username: "admin", password: "secret-password" });
    assert.equal(saved.stored, true);
    assert.equal(saved.header, basicAuthHeader("admin", "secret-password"));

    // Encrypted file exists with 0600 permissions and does not contain plaintext password
    const authFile = path.join(dir, "hub-auth.bin");
    assert.equal(fs.existsSync(authFile), true);
    const rawOnDisk = fs.readFileSync(authFile, "utf8");
    assert.equal(rawOnDisk.includes("secret-password"), false);
    // Windows has no file modes; the profile folder's ACL covers the file there.
    const mode = fs.statSync(authFile).mode & 0o777;
    if (process.platform !== "win32") assert.equal(mode, 0o600);

    // Reloading reads back decrypted credentials
    const reloaded = createSettingsStore({
      dir,
      safeStorage: makeFakeSafeStorage(true),
    });
    assert.deepEqual(reloaded.getHubAuth(), {
      username: "admin",
      header: basicAuthHeader("admin", "secret-password"),
    });

    // When safeStorage is unavailable, nothing is stored
    const dirNoEnc = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-noenc-test-"));
    try {
      const noEncStore = createSettingsStore({
        dir: dirNoEnc,
        safeStorage: makeFakeSafeStorage(false),
      });
      const res = noEncStore.setHubAuth({ username: "admin", password: "secret-password" });
      assert.equal(res.stored, false);
      assert.equal(noEncStore.getHubAuth(), null);
      assert.equal(fs.existsSync(path.join(dirNoEnc, "hub-auth.bin")), false);
    } finally {
      fs.rmSync(dirNoEnc, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Logitech tokens are encrypted with safeStorage (0600) and never stored when safeStorage is unavailable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-tokens-test-"));
  try {
    const store = createSettingsStore({
      dir,
      safeStorage: makeFakeSafeStorage(true),
    });

    assert.equal(store.hasLogitechTokens(), false);
    const saved = store.setLogitechTokens({
      access_token: "acc-123",
      id_token: "id-456",
      refresh_token: "ref-789",
    });
    assert.equal(saved.stored, true);
    assert.equal(store.hasLogitechTokens(), true);

    const tokenFile = path.join(dir, "logitech-tokens.bin");
    assert.equal(fs.existsSync(tokenFile), true);
    const rawOnDisk = fs.readFileSync(tokenFile, "utf8");
    assert.equal(rawOnDisk.includes("acc-123"), false);
    assert.equal(rawOnDisk.includes("ref-789"), false);
    if (process.platform !== "win32") assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);

    const reloaded = createSettingsStore({
      dir,
      safeStorage: makeFakeSafeStorage(true),
    });
    assert.deepEqual(reloaded.getLogitechTokens(), {
      access_token: "acc-123",
      id_token: "id-456",
      refresh_token: "ref-789",
    });

    reloaded.clearLogitechTokens();
    assert.equal(reloaded.getLogitechTokens(), null);
    assert.equal(fs.existsSync(tokenFile), false);

    const denied = createSettingsStore({ dir, safeStorage: {
      ...makeFakeSafeStorage(true),
      encryptString() { throw new Error("Keychain access refused"); },
    } });
    assert.deepEqual(denied.setLogitechTokens({ access_token: "fixture-access", id_token: "fixture-identity" }), { stored: false });
    assert.equal(fs.existsSync(tokenFile), false);

    const dirNoEnc = fs.mkdtempSync(path.join(os.tmpdir(), "melodious-tokens-noenc-"));
    try {
      const noEncStore = createSettingsStore({
        dir: dirNoEnc,
        safeStorage: makeFakeSafeStorage(false),
      });
      const res = noEncStore.setLogitechTokens({
        access_token: "acc-123",
        id_token: "id-456",
        refresh_token: "ref-789",
      });
      assert.equal(res.stored, false);
      assert.equal(noEncStore.getLogitechTokens(), null);
      assert.equal(fs.existsSync(path.join(dirNoEnc, "logitech-tokens.bin")), false);
    } finally {
      fs.rmSync(dirNoEnc, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
