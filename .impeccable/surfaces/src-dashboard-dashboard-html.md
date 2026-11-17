---
version: 1
slug: "src-dashboard-dashboard-html"
primary_target: "src/dashboard/dashboard.html"
related_targets: ["src/popup/popup.html"]
---

# Surface Brief: MyTems Study Dashboard & Recorder Popup

Mode: operate
Targets: `src/dashboard/dashboard.html`, `src/popup/popup.html`

## Direction contract

- **THESIS:** A quiet broadcast cue-sheet and study workbench that separates zero-cost capture from progressive two-step AI processing (**Transcribe Only** vs **Generate Notes**), refusing cluttered floating action bars and hidden storage traps.
- **OWN-WORLD:** Adaptive daylight study paper (`#F6F7FA` / `#FFFFFF`) and low-glare evening slate (`#0D1017` / `#151923`), cool tinted lecture rail (`#EDF0F5` / `#11151E`), primary cobalt action ink (`#2563EB` / `#60A5FA`), single amber semantic lane exclusively for the **Exam & Deadline Radar**, consistent 1px crisp borders, inline SVG icons (`1.75px` stroke), and tabular `MM:SS` cue chips.
- **STORY:** A student opens the dashboard right after class, sees their lecture named from the Teams tab, immediately understands whether to **Transcribe Only ($0 LLM)** or **Generate Notes**, clicks any cue chip or slide thumbnail to jump to that second in the video, and exports final AI notes to Notion or reclaims disk space via a tidy Storage menu.
- **FIRST VIEWPORT:** Left `268px` tinted lecture rail (search + clean status-badged list + Settings modal trigger) paired with a main header (`Title`, compact `date · duration · size · cost` subline, progressive `Transcribe` / `Generate Notes` controls, `Export` actions, and a `⋯` Storage menu), subtle inline Course hint, and a balanced two-column workspace: Video + Slide actions/strip on the left, **Exam & Deadline Radar** + tabbed **Notes / Transcript** on the right.
- **FORM:** Candidate 4 (Timecode Study Workbench, ranked #4 -> assigned, raised with `ikeda-datamatics` tabular numeric discipline, `vernacular-ephemera-boarding-pass-and-gate-board` persistent amber alert Radar, and `rw-centre-rail-reference-setting` `MM:SS` cue-margin clarity), `seed:2948fb9956e9f807`.
- **FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
