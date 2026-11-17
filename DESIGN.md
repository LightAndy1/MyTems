# Design System — MyTems

## Visual World
**Timecode Study Workbench** (`operate` mode): adaptive daylight paper and low-glare evening slate anchored by a cool tinted lecture rail (`#edf0f5` / `#11151e`), crisp 1px structural borders, tabular `MM:SS` cue chips, and a single amber lane reserved strictly for the **Exam & Deadline Radar**.

## Tokens

### Color Palette (Light / Dark via `prefers-color-scheme`)
| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#f6f7fa` | `#0d1017` | Application canvas |
| `--rail` | `#edf0f5` | `#11151e` | Left lecture rail / segmented tray |
| `--surface` | `#ffffff` | `#151923` | Cards, tabs, `<dialog>` modal, inputs |
| `--surface-subtle` | `#f8fafc` | `#1a202d` | Hover surface |
| `--border` | `#dce1ea` | `#252c3b` | 1px hairlines and control borders |
| `--ink` | `#111827` | `#f1f5f9` | Primary text |
| `--muted` | `#526075` | `#94a3b8` | Secondary metadata and labels |
| `--accent` | `#2563eb` | `#2563eb` | Primary CTA fill and focus rings (`#ffffff` text >= 4.5:1) |
| `--accent-ink` | `#1d4ed8` | `#93c5fd` | Cue chips and active tab ink |
| `--accent-soft` | `#eff6ff` | `rgba(37, 99, 235, 0.2)` | Cue chip & active tab surface |
| `--radar-bg` | `#fffbeb` | `rgba(245, 158, 11, 0.1)` | Exam & Deadline Radar surface |
| `--radar-border` | `#f59e0b` | `rgba(245, 158, 11, 0.45)` | Radar 1px frame |
| `--radar-ink` | `#92400e` | `#fcd34d` | Radar heading ink |
| `--ok` | `#059669` | `#10b981` | Ready lecture dot |
| `--danger` | `#dc2626` | `#f87171` | Recording live dot & destructive menu item |

### Typography & Numerics
- **Body / UI:** `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`, `14px/1.5` base (`13px` controls, `12px` metadata, `20px` lecture title, max measure `70ch`).
- **Tabular Data:** `ui-monospace, SFMono-Regular, Menlo, monospace` with `font-variant-numeric: tabular-nums` exclusively on `MM:SS` cue chips, timers, durations, file sizes, and `$0.0000` cost readouts.

### Layout & Components
- **Shell:** `272px` left lecture rail + `minmax(0, 1fr)` main desk (`<= 960px` stacks cleanly).
- **Header & Progressive Actions:** Title + metadata + inline Course hint; progressive `Transcribe Only ($0 LLM)` and `Generate Notes` buttons; `Copy Notion MD` / `Export .zip` (disabled until `notes.json` exists); `⋯` `<details>` Storage menu (`Download Video`, `Free Media Space`, `Delete Lecture`).
- **Workspace Split:** Left `video` + `Snap Slide` / `Attach Whiteboard / Slide` + Slide grid with active `timeupdate` highlight; Right **Exam & Deadline Radar** + tabbed **Study Notes / Transcript**.
- **Settings Modal:** `<dialog id="settingsModal">` with `Cloud (OpenRouter)` (including `Provider Routing` + `Preferred Providers`) vs `Local Endpoint` segmented toggle; zero language selector.
- **Icons & Motion:** Inline SVGs (`1.75px`–`2px` stroke); `150ms ease` state transitions disabled under `prefers-reduced-motion`.
