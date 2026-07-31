# Harmony Hub Control Design System

## 1. Atmosphere & Identity

A living-room AV **rack console** — the web surface of a rooted Harmony Hub.
Dense when operating a remote, calm when idle. Feels like pro AV gear on a
sideboard: charcoal panels, warm status LEDs, tactile keys. Not a SaaS
dashboard, not a marketing site, not purple “AI product” chrome.

**Signature:** the virtual remote — the **same Harmony remote JPEG and percent
hotspot map** already used on the hub IR Control page (`remote_skin_jpg.h` +
`IR_REMOTE_BUTTONS`). Do not invent a second handset. Everything else (nav,
editors, system) is subordinate infrastructure around that control surface.

Household members use this on a phone on the couch and a laptop at the desk.
Clarity of *what is on* and *what this button will do* beats feature density.

## 2. Color

Dark-mode native. Cool charcoal base, single warm accent (amber) for action,
teal reserved for “live / on air” status only.

### Palette

| Role | Token | Dark | Usage |
|------|-------|------|-------|
| Surface/canvas | `--surface-canvas` | `#0c0e10` | Page background |
| Surface/primary | `--surface-primary` | `#12151a` | Main content well |
| Surface/secondary | `--surface-secondary` | `#181c22` | Cards, side nav |
| Surface/elevated | `--surface-elevated` | `#1e242c` | Popovers, remote shell |
| Surface/inset | `--surface-inset` | `#0a0c0f` | Recessed remote body |
| Text/primary | `--text-primary` | `#e8eaed` | Headlines, body |
| Text/secondary | `--text-secondary` | `#9aa3ad` | Leads, meta |
| Text/tertiary | `--text-tertiary` | `#6b7380` | Disabled, captions |
| Text/inverse | `--text-inverse` | `#0c0e10` | Text on accent fills |
| Border/default | `--border-default` | `rgba(255,255,255,0.08)` | Dividers |
| Border/strong | `--border-strong` | `rgba(255,255,255,0.14)` | Focus rings base |
| Accent/primary | `--accent-primary` | `#e8a54b` | Primary CTAs, active key |
| Accent/hover | `--accent-hover` | `#f0b862` | Hover on accent |
| Accent/muted | `--accent-muted` | `rgba(232,165,75,0.14)` | Soft accent fills |
| Status/live | `--status-live` | `#3dcaa0` | Running activity, connected |
| Status/live-glow | `--status-live-glow` | `rgba(61,202,160,0.28)` | Pulse ring |
| Status/warn | `--status-warn` | `#d4a017` | Caution |
| Status/error | `--status-error` | `#e25c5c` | Errors, destructive |
| Status/info | `--status-info` | `#6b8caf` | Neutral info |
| Key/face | `--key-face` | `#252b34` | Remote button face |
| Key/face-hover | `--key-face-hover` | `#2f3742` | Key hover |
| Key/label | `--key-label` | `#d5dae0` | Key glyph/label |
| Key/disabled | `--key-disabled` | `#1a1f26` | Unmapped key |
| Shadow/remote | `--shadow-remote` | `0 24px 48px rgba(0,0,0,.45), 0 2px 0 rgba(255,255,255,.04) inset` | Remote body |
| Overlay | `--overlay` | `rgba(0,0,0,0.72)` | Modal scrim |

### Rules
- Accent (amber) is **only** for interactive primary actions and pressed keys.
- Live/on-air is **only** teal — never use amber for “running”.
- No purple, no blue-violet brand gradients, no pure `#000` canvas.
- Borders are opacity whites on dark — no muddy gray hex borders.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| Display | clamp(28px, 4vw, 40px) | 600 | 1.1 | -0.03em | “Now playing” name |
| H1 | 22px | 600 | 1.25 | -0.02em | Page title |
| H2 | 17px | 600 | 1.3 | -0.01em | Panel titles |
| H3 | 14px | 600 | 1.35 | 0 | Card titles |
| Body | 14px | 400 | 1.5 | 0 | Default |
| Body/sm | 13px | 400 | 1.45 | 0 | Secondary |
| Caption | 11px | 500 | 1.35 | 0.04em | Meta, overlines |
| Key | 11px | 600 | 1.1 | 0.02em | Remote key labels |
| Mono | 12px | 450 | 1.4 | 0 | IDs, JSON, logs |

### Font Stack
- Primary: `"IBM Plex Sans", "Segoe UI", system-ui, sans-serif`
- Mono: `"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace`
- Load via Google Fonts (sim only) or system fallbacks on hub.

### Rules
- Sentence case everywhere. No Title Case Headers.
- Tabular nums for IDs and counters (`font-variant-numeric: tabular-nums`).
- Body never below 13px on mobile; key labels may be 10–11px.

## 4. Spacing & Layout

### Base Unit
**4px**

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Icon gaps |
| `--space-2` | 8px | Compact stacks |
| `--space-3` | 12px | Field padding |
| `--space-4` | 16px | Card padding default |
| `--space-5` | 20px | Section inner |
| `--space-6` | 24px | Panel padding |
| `--space-8` | 32px | Between panels |
| `--space-10` | 40px | Major breaks |
| `--space-12` | 48px | Page rhythm |

### Grid
- Max content width: `1280px`
- Shell: sticky left rail `220px` + fluid main (collapse rail to top chips &lt; 840px)
- Control view: `minmax(280px, 360px)` remote column + fluid command list
- Breakpoints: `sm 640`, `md 840`, `lg 1024`, `xl 1280`

### Rules
- No magic spacing. Every gap maps to a token.
- Remote column is optically centered in its panel, not full-bleed edge-to-edge.

## 5. Components

### App shell
- Top bar: brand mark + product name + offline/sim pill + live activity chip
- Side nav: icon + label + one-line purpose; active = amber left hairline + elevated surface
- Content: single active view; hash routing (`#control`, `#activities`, …)

### Pill / badge
- Quiet outline by default; `.live` uses teal fill + glow; `.sim` uses amber muted fill

### Button
- Primary: amber fill, dark text, 10px radius, min-height 40px
- Secondary: elevated surface + border, primary text
- Ghost: transparent, secondary text
- Quiet: transparent, tertiary text, hairline border; reveals amber on hover —
  for repeatable row actions (Run, Start) so one screen has at most one amber
- Danger: error text, transparent/error border — also used for Power off,
  the one globally destructive action; Power off is never amber
- Pressed: `transform: scale(0.98)`; transition 120ms transform/opacity only

### Panel / card
- `--surface-secondary`, 1px `--border-default`, radius 12px, padding `--space-6`
- No drop shadow on ordinary cards; remote shell may use `--shadow-remote`

### Virtual remote
- **Asset:** `/assets/remote-skin.jpg` extracted from `remote_skin_jpg.h`
- **Geometry:** `IR_REMOTE_BUTTONS` percent `x,y,w,h` over aspect-ratio `591/1280`
- Structure: `.ir-remote-shell` > `.ir-remote-skin` > `img` + absolute `.remote-hotspot`
- **The photo is the interface.** Hotspots are invisible at rest — no fill,
  no border. Mappedness is communicated by response, like the physical handset
- Hover/focus: amber glow ring (`box-shadow` only, no fill). Press: brief
  amber flash (35% fill) that fades. Hold window: glow intensifies
- Hold-capable tick: 4px amber dot, revealed only on hover/focus of that key
- Unmapped: transparent, no pointer (photo shows the physical key underneath)
- Percent geometry is sacred — no min-size overrides on mobile; enlarged
  targets overlap neighboring keys and mislead taps
- Status line sits **above** the remote, pinned under the now-strip:
  last command + device target in mono — feedback must be visible without scrolling
- Soft buttons (MenuItem, no hard ButtonKey): chip row under the skin, not invented keys
- Resolved-actions list and send log live in a single **Inspector** panel,
  collapsed by default (persisted) — debug truth available, never in the way

### Activity hero (“now running”)
- Full-width panel, inset surface, live dot + display name + Power off
- Not a gradient hero blob — restrained status strip

### Forms
- Labels: caption weight 500, secondary color
- Inputs: inset surface, border default, focus = amber 2px ring
- Selects match inputs

### Notices
- Inline, not `alert()`. `.ok` / `.warn` / `.error` left border + muted fill

### Iconography
- Inline SVG only (16/20px stroke 1.75). No emoji icons.

## 6. Motion

| Token | Value | Usage |
|-------|-------|-------|
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | Most UI |
| `--dur-fast` | 120ms | Keys, toggles |
| `--dur-med` | 200ms | Panels, nav |
| `--dur-slow` | 320ms | View enter |

- Animate **only** `transform` and `opacity`.
- Live dot: gentle opacity pulse 1.6s, paused when `prefers-reduced-motion`.
- View switch: 160ms fade; no slide-over gimmicks.

## 7. Do / Don't

### Do
- Lead every control screen with **what is running** and a one-tap Power off.
- Show the **resolved action** under a remote key (device · command) on hover/focus.
- Prefer one primary action per toolbar.
- Keep sim mode obvious: persistent “Simulated hub” pill; never look like production cloud.
- Preserve activity-editor contracts (no action-less buttons, identity rules).

### Don't
- Purple gradients, glassmorphism stacks, Inter/Roboto as brand, three equal feature cards.
- Emoji as icons or status.
- Modal confirmations for ordinary sends; reserve dialogs for delete/destructive.
- Hide the difference between Device control and Activity control.
- Contact the live hub from the sim (localhost fixtures only).

---

**Implementation note:** Production UI still embeds into `codex_webui`. The
redesign lands first in `tools/webui-sim/` against a mock API. Tokens in
`tools/webui-sim/public/css/tokens.css` are the runtime source of truth and must
match this document.
