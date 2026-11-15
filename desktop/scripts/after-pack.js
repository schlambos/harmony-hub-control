"use strict";

// electron-builder afterPack hook (runs before bundle-level signing):
//   1. Give the main macOS executable its own LC_UUID so macOS Local Network
//      privacy treats Melodious as its own app (see macho-uuid.js).
//   2. Verify staged macOS Root Wizard extraResources are present and ad-hoc
//      sign every nested Mach-O binary/dylib/.so (skipping symlinks and ELF
//      MIPS hub binaries such as dropbearmulti and codex_flash_free) before
//      electron-builder seals Contents/Resources into CodeResources.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { appUuid, patchExecutable } = require("./macho-uuid");

const ARCH_NAMES = { 1: "x64", 3: "arm64" }; // builder-util Arch enum

const THIN_MACHO_MAGICS_BE = new Set([
  0xfeedface, // MH_MAGIC (32-bit BE)
  0xcefaedfe, // MH_CIGAM (32-bit LE)
  0xfeedfacf, // MH_MAGIC_64 (64-bit BE)
  0xcffaedfe, // MH_CIGAM_64 (64-bit LE: arm64 / x86_64)
]);

const FAT_MACHO_MAGICS_BE = new Set([
  0xcafebabe, // FAT_MAGIC
  0xbebafeca, // FAT_CIGAM
  0xcafebabf, // FAT_MAGIC_64
  0xbfbafeca, // FAT_CIGAM_64
]);

const REQUIRED_WIZARD_RESOURCES = Object.freeze([
  ["wizard-python", "bin", "python3"],
  ["hub-root", "wizard_bridge.py"],
  ["hub-root", "dropbearmulti"],
  ["installer", "install_webui.py"],
  ["installer", "payload", "helpers", "codex_flash_free"],
  ["installer", "payload", "helpers", "hal_multiremote_patch.json"],
  ["installer", "payload", "helpers", "hal_remotes_patch.json"],
]);

function isMachOHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  const magic = buf.readUInt32BE(0);
  if (THIN_MACHO_MAGICS_BE.has(magic)) return true;
  if (FAT_MACHO_MAGICS_BE.has(magic)) {
    if (buf.length < 8) return false;
    const isLittle = magic === 0xbebafeca || magic === 0xbfbafeca;
    const nfatArch = isLittle ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
    // Distinguish fat Mach-O headers (small slice count) from Java .class files (0xcafebabe, major >= 45)
    return nfatArch >= 1 && nfatArch <= 20;
  }
  return false;
}

function isMachOFile(filePath, fsImpl = fs) {
  let st;
  try {
    st = fsImpl.lstatSync(filePath);
  } catch {
    return false;
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size < 4) return false;
  const header = Buffer.alloc(Math.min(32, st.size));
  let fd;
  try {
    fd = fsImpl.openSync(filePath, "r");
    const bytesRead = fsImpl.readSync(fd, header, 0, header.length, 0);
    return isMachOHeader(header.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fsImpl.closeSync(fd);
      } catch {}
    }
  }
}

function collectMachOFiles(rootDirs, fsImpl = fs) {
  const dirs = Array.isArray(rootDirs) ? rootDirs : [rootDirs];
  const found = [];

  const walk = (dirPath) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const fullPath = path.join(dirPath, ent.name);
      let lst;
      try {
        lst = fsImpl.lstatSync(fullPath);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) continue;
      if (lst.isDirectory()) {
        walk(fullPath);
      } else if (lst.isFile() && isMachOFile(fullPath, fsImpl)) {
        found.push(fullPath);
      }
    }
  };

  for (const dir of dirs) {
    if (!dir) continue;
    let lst;
    try {
      lst = fsImpl.lstatSync(dir);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) continue;
    if (lst.isDirectory()) walk(dir);
    else if (lst.isFile() && isMachOFile(dir, fsImpl)) found.push(dir);
  }

  // Sign shared libraries and Python C-extensions before executables.
  found.sort((a, b) => {
    const aLib = a.endsWith(".so") || a.endsWith(".dylib") ? 0 : 1;
    const bLib = b.endsWith(".so") || b.endsWith(".dylib") ? 0 : 1;
    if (aLib !== bLib) return aLib - bLib;
    return a.localeCompare(b);
  });
  return found;
}

function signMachOFiles(
  rootDirs,
  { execFileSyncImpl = execFileSync, fsImpl = fs } = {}
) {
  const files = collectMachOFiles(rootDirs, fsImpl);
  for (const filePath of files) {
    execFileSyncImpl("codesign", ["--force", "--sign", "-", filePath], {
      stdio: "pipe",
    });
  }
  return files;
}

function verifyBundledWizardResources(resourcesDir, fsImpl = fs) {
  for (const segments of REQUIRED_WIZARD_RESOURCES) {
    const target = path.join(resourcesDir, ...segments);
    if (!fsImpl.existsSync(target)) {
      throw new Error(
        `afterPack: missing required macOS wizard resource ${target} (run sh scripts/stage-wizard-runtime.sh first)`
      );
    }
  }
}

async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const arch = ARCH_NAMES[context.arch];
  if (!arch) throw new Error(`afterPack: unexpected arch ${context.arch}`);
  const { appInfo } = context.packager;
  const appBundle = path.join(context.appOutDir, `${appInfo.productFilename}.app`);
  const exe = path.join(appBundle, "Contents", "MacOS", appInfo.productFilename);
  const uuid = appUuid(appInfo.id, arch);
  const { before, after } = patchExecutable(exe, uuid);
  if (after !== uuid) throw new Error(`afterPack: LC_UUID is ${after}, expected ${uuid}`);
  console.log(`  • afterPack: ${arch} main executable LC_UUID ${before} -> ${after}`);

  const resourcesDir = path.join(appBundle, "Contents", "Resources");
  verifyBundledWizardResources(resourcesDir);
  const signedFiles = signMachOFiles([
    path.join(resourcesDir, "wizard-python"),
    path.join(resourcesDir, "hub-root"),
    path.join(resourcesDir, "installer"),
  ]);
  console.log(`  • afterPack: ${arch} ad-hoc signed ${signedFiles.length} bundled Mach-O binaries`);
}

module.exports = {
  default: afterPack,
  afterPack,
  isMachOHeader,
  isMachOFile,
  collectMachOFiles,
  signMachOFiles,
  verifyBundledWizardResources,
};
