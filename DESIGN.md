# Design System — MyTems

## Visual World
**Clearnet Storefront Deck** (`operate` mode): airy daylight paper (`#F5F7FB` / `#FFFFFF`) with a sleek Darknet toggle (`#090D15` / `#131B2B`), anchored by a slim `76px` left icon dock (`Catalog`, `Study`, `Radar`, `Settings`), the **MyTems × HTSDOF capsule-play emblem**, electric cobalt (`#0057FF`), mint local-vault badges (`#00B873` / `#047857`), cyan STT indicators (`#0E7490`), and a single amber lane reserved strictly for the **Exam & Deadline Radar**.

## Tokens

### Color Palette (`Light` default / `Darknet` toggle or `prefers-color-scheme`)
| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#f5f7fb` | `#090d15` | Application canvas |
| `--dock` / `--rail` | `#ffffff` | `#0f1522` | Left icon dock & collapsible lecture library |
| `--surface` | `#ffffff` | `#131b2b` | Cards, tabs, `<dialog>` modals, inputs |
| `--surface-soft` | `#f0f4fa` | `#1a2438` | Inputs, routing cards, subtle containers |
| `--border` | `#e2e8f2` | `#243047` | 1px hairlines and control borders |
| `--ink` | `#0f172a` | `#f8fafc` | Primary text |
| `--muted` | `#475569` | `#94a3b8` | Secondary metadata and labels (>= 4.5:1 contrast) |
| `--accent` | `#0057ff` | `#2563eb` | Primary CTA fill and focus rings |
| `--accent-ink` | `#0044cc` | `#93c5fd` | Cue chips, active dock/routing card ink |
| `--accent-soft` | `#e9f1ff` | `rgba(59, 130, 246, 0.18)` | Cue chip & active tab surface |
| `--mint-ink` | `#047857` | `#6ee7b7` | Notes Ready & OPFS Local Vault badges |
| `--cyan` | `#0e7490` | `#22d3ee` | STT-only ($0 LLM) status badges |
| `--radar-bg` | `#fffbeb` | `rgba(245, 158, 11, 0.1)` | Exam & Deadline Radar surface |
| `--radar-border` | `#f59e0b` | `rgba(245, 158, 11, 0.45)` | Radar 1px frame |
| `--radar-ink` | `#92400e` | `#fcd34d` | Radar heading ink |
| `--danger` | `#be123c` | `#fb7185` | Recording live dot & destructive actions |

### Typography & Numerics
- **Body / UI:** `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`, `14px/1.5` base (`13px` controls, `12px` metadata, `20px–22px` headings, max reading measure `70ch`).
- **Tabular Data:** `ui-monospace, SFMono-Regular, Menlo, monospace` with `font-variant-numeric: tabular-nums` exclusively on `MM:SS` cue chips, timers, durations, file sizes, and `$0.0000` cost readouts.

### Layout & Components
- **Shell:** `76px` icon dock (`Catalog`, `Study`, `Radar`, `Settings`) + `minmax(0, 1fr)` main stage (`<= 720px` stacks top bar cleanly).
- **Catalog View:** Filterable drop cards (`All Drops`, `Notes Ready`, `STT Only ($0 LLM)`, `Raw Capture`) + search + one-click `Open Workbench` / `Export .zip` / `Transcribe ($0)`.
- **Study Workbench:** Collapsible `288px` Subject → Lesson → Parts library rail (`Hide Library` toggle, multi-select batch bar) + deck top (`16:9` video + horizontal slide carousel) + reading-first **Study Notes / Transcript** beside **Exam & Deadline Radar**.
- **Global Radar View:** Aggregates all Exam & Deadline Radar entries across OPFS lectures with clickable `MM:SS` jump cues.
- **Command-Card Settings Modal:** `<dialog id="settingsModal">` with `Cloud Dispatch (OpenRouter)` vs `Local Basement Node` segmented switch, clickable `Provider Routing Strategy` cards (`Default`, `Moritz Budget`, `Lenny Speed`), Jev calibration toggle, and MS Whiteboard settings.
- **Icons & Motion:** MyTems capsule-play brand mark + `1.8px` inline SVGs; `150ms ease` transitions disabled under `prefers-reduced-motion`.
