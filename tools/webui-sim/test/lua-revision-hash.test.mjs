/* codexactivity.lua and codex_webui.c must print the same activity revision,
   or every save is refused as "activity resources changed since this editor
   loaded". The hub runs stock Lua 5.1 on 32-bit MIPS, where string.format
   converts a %x argument through a signed 32-bit long: any value at or above
   2^31 prints as 7fffffff. LuaJIT on a desktop does not, so the stub below
   reproduces the hub's conversion. Seen on hardware: C answered
   cc24e581-3e4b67d3-c4fccb89, the plugin 7fffffff-3e4b67d3-7fffffff. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const luaPath = new URL("../../../payload/activity/codexactivity.lua", import.meta.url).pathname;

/* resource_hash() in codex_webui.c, printed with %08x. */
function cHash(text) {
  let h = 2166136261;
  for (const b of Buffer.from(text, "utf8")) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/* Strings whose hashes cover both halves of the 32-bit range. */
const SAMPLES = ['{"Activities":[]}', '{"ButtonMaps":[]}', '{"FunctionMaps":[]}', "a", "", "hub"];

function luaRevision(act, map, fn) {
  const out = execFileSync("luajit", ["-e", `
    local realFormat = string.format
    string.format = function(fmt, ...)
      local args = { ... }
      local i = 0
      for spec in fmt:gmatch("%%[-0-9.]*(%a)") do
        i = i + 1
        if spec == "x" and type(args[i]) == "number" and args[i] > 2147483647 then
          args[i] = 2147483647 -- the hub's (long) conversion saturates
        end
      end
      return realFormat(fmt, unpack(args, 1, select("#", ...)))
    end
    local files = {
      ["/data/resources/ActivityList.json"] = ${JSON.stringify(act)},
      ["/data/resources/MapList.json"] = ${JSON.stringify(map)},
      ["/data/resources/FunctionList.json"] = ${JSON.stringify(fn)},
    }
    local realIoOpen = io.open
    io.open = function(p, m)
      if files[p] ~= nil then
        return { read = function() return files[p] end, close = function() end }
      end
      return realIoOpen(p, m)
    end
    package.preload["system"] = function() return { isMessageRegistered = function() return true end, sendMessage = function() return true end } end
    package.preload["json"] = function() return { decode = function() return {} end, encode = function() return "{}" end } end
    package.preload["log"] = function() return { logger = function() return { notice = function() end, error = function() end, warning = function() end } end } end
    package.preload["tasks.harmonywebservices.core.resourcemanager"] = function() return {
      getResource = function() return "200", '"e1"', {} end,
      getHubEtag = function() return "1" end,
      isAnySyncInProgress = function() return false end,
      saveResource = function() return true end,
    } end
    package.preload["tasks.harmonywebservices.core.statedigest"] = function() return { instance = function() return { configVersion = 1, saveStateDigest = function() end } end } end
    package.preload["tasks.connectserver.core.utils"] = function() return { createResponse = function() return {} end } end
    local src = assert(realIoOpen(${JSON.stringify(luaPath)}, "r")):read("*a")
    local chunk = assert(loadstring((src:gsub("local function currentActivityRevision", "function currentActivityRevision"))))
    chunk("codexactivity")
    io.write(_G.codexactivity.currentActivityRevision())
  `], { encoding: "utf8" });
  return out.trim();
}

describe("activity revision: codexactivity.lua matches codex_webui.c", () => {
  it("the samples include hashes at and above 2^31", () => {
    assert.ok(SAMPLES.some((s) => parseInt(cHash(s), 16) >= 2 ** 31));
    assert.ok(SAMPLES.some((s) => parseInt(cHash(s), 16) < 2 ** 31));
  });

  for (let i = 0; i + 2 < SAMPLES.length; i += 1) {
    const [act, map, fn] = SAMPLES.slice(i, i + 3);
    it(`agrees for ${cHash(act)}-${cHash(map)}-${cHash(fn)} under the hub's 32-bit %x`, () => {
      assert.equal(luaRevision(act, map, fn), `${cHash(act)}-${cHash(map)}-${cHash(fn)}`);
    });
  }
});
