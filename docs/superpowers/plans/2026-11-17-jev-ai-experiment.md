# Experimental Jev AI (via OpenRouter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional experimental toggle to use TypeSafe Jev via the existing OpenRouter API key (`typesafe/jev-latest` or `typesafe/jev-router`) to calibrate Exam Radar confidence scores, keeping zero separate API keys and $0 recording.

**Architecture:** Reuse existing `openRouterApiKey` and `callOpenRouter` infrastructure in `src/dashboard/ai-client.js`. Add an optional calibration pass for Exam Radar candidate items in `src/dashboard/pipeline.js` when `settings.jevEnabled` is active. Display calibrated confidence badges in `dashboard.html`.

**Tech Stack:** Native ES modules, Vanilla JS, Chromium Manifest V3, Bun test runner (`bun test`).

**Spec:** [PRODUCT.md](file:///Users/lightandy/Documents/Projects/MyTems/PRODUCT.md) & [DESIGN.md](file:///Users/lightandy/Documents/Projects/MyTems/DESIGN.md)

## Global Constraints

- Zero bundler, zero runtime npm dependencies.
- Zero extra API keys: uses the existing `openRouterApiKey`.
- Strict $0 local recording default: Jev is NEVER called during recording.
- Strictly optional: if `jevEnabled` is false, behavior is 100% identical to current code.
- Uses `fetchImpl` dependency injection for deterministic testing.

---

### Task 1: OpenRouter Jev Calibration Helper (`src/dashboard/ai-client.js`)

**Files:**
- Modify: `src/dashboard/ai-client.js:1-120`
- Test: `tests/jev.test.js`

**Interfaces:**
- Produces: `calibrateExamRadarWithJev(items, transcriptSummary, settings, options)`
- Consumes: existing `callOpenRouter` with model `typesafe/jev-latest`

- [ ] **Step 1: Write failing unit test in `tests/jev.test.js`**
  - Verify payload format sent to OpenRouter chat endpoint with `typesafe/jev-latest`.
  - Verify parsing of calibrated probability/scores onto radar items.
- [ ] **Step 2: Run test to confirm failure**
  - Run `bun test tests/jev.test.js`.
- [ ] **Step 3: Implement helper in `src/dashboard/ai-client.js`**
  - Call OpenRouter with system instructions for Jev structured decision outputs.
- [ ] **Step 4: Run test to confirm pass**
  - Run `bun test tests/jev.test.js`.
- [ ] **Step 5: Commit task**
  - Commit changes with message `feat(jev): add OpenRouter Jev calibration helper and unit tests`.

---

### Task 2: Settings Schema & Default Flag

**Files:**
- Modify: `src/shared/constants.js:1-50`
- Modify: `src/shared/storage.js:1-40`
- Test: `tests/storage.test.js`

**Interfaces:**
- Produces: `DEFAULT_SETTINGS.jevEnabled = false` and `DEFAULT_SETTINGS.jevModel = 'typesafe/jev-latest'`

- [ ] **Step 1: Add failing test in `tests/storage.test.js`**
  - Assert default settings include `jevEnabled: false` and `jevModel`.
- [ ] **Step 2: Update `constants.js` and `storage.js`**
- [ ] **Step 3: Run `bun test tests/storage.test.js`**
- [ ] **Step 4: Commit task**
  - Commit changes with message `feat(settings): add OpenRouter Jev configuration defaults`.

---

### Task 3: Pipeline Integration

**Files:**
- Modify: `src/dashboard/pipeline.js:1-120`
- Test: `tests/pipeline.test.js`

**Interfaces:**
- Produces: Conditionally attaches `confidence` (e.g. `0.94`) to `examRadar` items in `notes.json`

- [ ] **Step 1: Add unit test in `tests/pipeline.test.js`**
  - When `settings.jevEnabled: true`, calls Jev calibrator after notes generation.
  - When `settings.jevEnabled: false`, skips Jev call completely.
- [ ] **Step 2: Wire conditional step into `runPipeline`**
- [ ] **Step 3: Run `bun test tests/pipeline.test.js`**
- [ ] **Step 4: Commit task**
  - Commit changes with message `feat(pipeline): calibrate exam radar items via OpenRouter Jev`.

---

### Task 4: UI Settings Toggle & Radar Badge

**Files:**
- Modify: `src/dashboard/dashboard.html`
- Modify: `src/dashboard/dashboard.js`
- Modify: `src/dashboard/dashboard.css`

**Interfaces:**
- Produces:
  - Checkbox `#setting-jev-enabled` in Settings modal (grouped under OpenRouter).
  - Badge on Exam Radar cards displaying calibrated confidence percentage.

- [ ] **Step 1: Add toggle to `#settings` dialog in `dashboard.html`**
- [ ] **Step 2: Update `dashboard.js` to bind checkbox and display badge in `renderNotes()`**
- [ ] **Step 3: Update `dashboard.css` for badge pill styling**
- [ ] **Step 4: Run full test suite (`npm test`)**
- [ ] **Step 5: Commit task**
  - Commit changes with message `feat(ui): add OpenRouter Jev toggle and radar confidence badges`.
