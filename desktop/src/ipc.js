"use strict";

const { isTrustedIpcSender } = require("./security");
const { redact, CatalogError } = require("./catalog/client");
const { createPictureFetcher } = require("./catalog/pictures");

const CATALOG_CHANNELS = Object.freeze({
  status: "catalog:status",
  signIn: "catalog:sign-in",
  signOut: "catalog:sign-out",
  checkModel: "catalog:check-model",
  search: "catalog:search",
  download: "catalog:download",
  remotePicture: "catalog:remote-picture",
});

function validateCatalogString(value, fieldName) {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${fieldName}: must be a string of 1 to 64 characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${fieldName}: control characters are not allowed`);
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 64) {
    throw new Error(`Invalid ${fieldName}: must be 1 to 64 characters`);
  }
  return trimmed;
}

function validateCatalogId(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Invalid catalog device id: must be a positive integer");
  }
  return value;
}

function validateCatalogQuery(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Invalid catalog arguments");
  }
  if (Object.keys(args).some((k) => !["manufacturer", "model"].includes(k))) throw new Error("Invalid catalog arguments");
  return {
    manufacturer: validateCatalogString(args.manufacturer, "manufacturer"),
    model: validateCatalogString(args.model, "model"),
  };
}

function validateCatalogDownloadArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Invalid catalog download arguments");
  }
  if (Object.keys(args).some((k) => !["id", "manufacturer", "model"].includes(k))) throw new Error("Invalid catalog download arguments");
  return {
    id: validateCatalogId(args.id),
    manufacturer: validateCatalogString(args.manufacturer, "manufacturer"),
    model: validateCatalogString(args.model, "model"),
  };
}

function sanitizeErrorMessage(err) {
  const raw = err instanceof CatalogError || /^(Invalid |Sign in to Logitech first|No catalog device matches |Could not open Logitech sign-in)/.test(err?.message || "")
    ? err.message : "Catalog request failed; try again";
  // Strip any accidental bearer/cookie/token header fragments
  return raw.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]") || "Catalog request failed";
}

function sanitizeSearchItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const id = Number(item.id);
      if (!Number.isSafeInteger(id) || id <= 0) return null;
      return {
        id,
        manufacturer: String(item.manufacturer ?? "").trim(),
        model: String(item.model ?? "").trim(),
        displayText: String(item.displayText ?? "").trim(),
        deviceType: String(item.deviceType ?? "").trim(),
        description: String(item.description ?? "").trim(),
      };
    })
    .filter(Boolean);
}

function sanitizePackage(pkg) {
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw new Error("Invalid catalog package");
  }
  return redact(pkg);
}

function createCatalogIpcHandlers({ getMainWindow, getCatalogService, pictureFetcher = createPictureFetcher() } = {}) {
  const ensureTrusted = (event) => {
    const win = typeof getMainWindow === "function" ? getMainWindow() : null;
    if (!isTrustedIpcSender(event, win)) {
      throw new Error("Untrusted IPC sender");
    }
  };

  const service = () => {
    const svc =
      typeof getCatalogService === "function"
        ? getCatalogService()
        : getCatalogService;
    if (!svc) {
      throw new Error("Catalog service is not ready");
    }
    return svc;
  };

  const wrap = (fn) => async (event, args) => {
    ensureTrusted(event);
    try {
      return await fn(args);
    } catch (err) {
      throw new Error(sanitizeErrorMessage(err));
    }
  };

  return {
    [CATALOG_CHANNELS.status]: wrap(async (args) => {
      if (args !== undefined) throw new Error("Invalid catalog arguments");
      const res = await service().status();
      return { signedIn: Boolean(res?.signedIn) };
    }),
    [CATALOG_CHANNELS.signIn]: wrap(async (args) => {
      if (args !== undefined) throw new Error("Invalid catalog arguments");
      const res = await service().signIn();
      return { signedIn: Boolean(res?.signedIn) };
    }),
    [CATALOG_CHANNELS.signOut]: wrap(async (args) => {
      if (args !== undefined) throw new Error("Invalid catalog arguments");
      await service().signOut();
      return { signedIn: false };
    }),
    [CATALOG_CHANNELS.checkModel]: wrap(async (args) => {
      const query = validateCatalogQuery(args);
      const res = await service().checkModel(query);
      return {
        found: Boolean(res?.found),
        manufacturer: String(res?.manufacturer ?? query.manufacturer).trim(),
        model: String(res?.model ?? query.model).trim(),
      };
    }),
    [CATALOG_CHANNELS.search]: wrap(async (args) => {
      const query = validateCatalogQuery(args);
      const res = await service().search(query);
      return sanitizeSearchItems(res);
    }),
    [CATALOG_CHANNELS.download]: wrap(async (args) => {
      const dlArgs = validateCatalogDownloadArgs(args);
      const pkg = await service().download(dlArgs);
      return sanitizePackage(pkg);
    }),
    // An activity icon or channel logo for the hub (catalog/pictures.js).
    // Needs no Logitech sign-in, so no catalog service either.
    [CATALOG_CHANNELS.remotePicture]: wrap(async (args) => {
      const res = await pictureFetcher.fetch(args);
      const image = String(res?.image ?? "");
      if (!image.startsWith("data:image/png;base64,")) throw new Error("Invalid picture answer");
      return { image };
    }),
  };
}

function registerCatalogIpcHandlers({ ipcMain, getMainWindow, getCatalogService, pictureFetcher } = {}) {
  const handlers = createCatalogIpcHandlers({ getMainWindow, getCatalogService, pictureFetcher });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler);
  }
  return handlers;
}

module.exports = {
  CATALOG_CHANNELS,
  validateCatalogString,
  validateCatalogId,
  validateCatalogQuery,
  validateCatalogDownloadArgs,
  sanitizeSearchItems,
  sanitizePackage,
  createCatalogIpcHandlers,
  registerCatalogIpcHandlers,
};
