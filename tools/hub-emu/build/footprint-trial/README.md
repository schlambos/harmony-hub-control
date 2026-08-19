# footprint-trial (quarantine)

Scratch artifacts from the resource-footprint audit (docs/FOOTPRINT_AUDIT.md).
Not production. Safe to delete.

- `out/codex_webui.*` — MIPS trial embeds (BASELINE / FULL / DEDUP / DEDUP_MIN / GZIP_EMBED)
- `src/` — copied codex_webui.c + generated asset headers (payload/ untouched)
- `assets/` — bundled shell css/js and gz variants
- `request-census.json`, `action-census.json` — Playwright measurements vs hub-emu
