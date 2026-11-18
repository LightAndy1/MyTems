# MS Whiteboard Per-Meeting Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Microsoft Whiteboard frames directly from the authenticated Teams browser tab for matching meetings (e.g., math lectures) into OPFS `slides/` as clean PNGs for Vision AI parsing, with zero risk to existing `tabCapture` recording.

**Architecture:** Isolated, opt-in MV3 subsystem using `optional_permissions: ["scripting"]` and `optional_host_permissions` for Teams and MS Whiteboard origins so reloading the extension never disables the user's live install. `background.js` runs Whiteboard attachment strictly fire-and-forget *after* `tabCapture` + `offscreen.js` start succeeds; `src/content/whiteboard-capture.js` (`all_frames: true`) snapshots the largest `<svg>` or `<canvas>` surface inside the Whiteboard iframe on an interval, deduplicates unchanged frames via FNV-1a hashing, and streams PNG bytes to `offscreen.js` (`slides/001_45_wb.png`), plugging directly into `pipeline.js` (`buildVisionMessages`) and `dashboard.js` (`renderSlides`).

**Tech Stack:** Chromium Manifest V3 (`optional_permissions`, `optional_host_permissions`, `chrome.scripting.executeScript`), native ES modules (no bundler, zero runtime dependencies), OPFS (`src/shared/opfs.js`), `bun test`.

**Spec:** Extends [2026-11-17-teams-lecture-companion-design.md](file:///Users/lightandy/Documents/Projects/MyTems/docs/superpowers/specs/2026-11-17-teams-lecture-companion-design.md) with Approach 1 (direct Whiteboard iframe `<svg>`/`<canvas>` snapshot) and strict live-extension safety isolation.

## Global Constraints
- Target Helium Browser (Chromium MV3); zero bundler; zero external runtime dependencies.
- Never modify required `permissions` or `host_permissions` in `manifest.json` for Whiteboard/Teams — use `optional_permissions` and `optional_host_permissions` so existing installs stay enabled on reload.
- Core `tabCapture` + `offscreen.js` recording MUST NEVER block on, await, or fail because of Whiteboard injection or capture errors.
- Settings MUST stay inside the `<dialog>` modal in `src/dashboard/dashboard.html#settings` (no `options.html`).
- Whiteboard slides MUST use `${idx}_${sec}_wb.png` naming so `pipeline.js` and `dashboard.js` parse `filename.split('_')[1]?.split('.')[0]` identically to video slides.
- Develop in an isolated git worktree (`.worktrees/ms-whiteboard` on branch `feat/ms-whiteboard-capture`, or native `Workspace: "share"` for subagents) so the root `main` directory stays untouched for your live Helium extension install.

---

## File Structure

- Modify: `manifest.json` — add `optional_permissions` (`["scripting"]`) and `optional_host_permissions` (Teams + MS Whiteboard origins).
- Modify: `src/shared/constants.js` — add `WHITEBOARD_ORIGINS`, `WHITEBOARD_CONFIG`, and `DEFAULT_SETTINGS.whiteboardMode` / `DEFAULT_SETTINGS.whiteboardMeetings`.
- Create: `src/shared/whiteboard.js` — pure meeting matching, surface candidate selection, filename formatting, FNV-1a byte hashing, cooldown/cap gating, and base64 conversion helpers.
- Create: `src/content/whiteboard-capture.js` — self-contained injected frame script (`all_frames: true`) that detects `<svg>` or `<canvas>` Whiteboard surfaces, rasterizes to PNG, and streams frames back to `background.js`.
- Modify: `src/offscreen/offscreen.js` — add `OFFSCREEN_SAVE_WHITEBOARD_FRAME` message handler using `writeLectureFile` from `src/shared/opfs.js`.
- Modify: `src/background/background.js` — add fire-and-forget `maybeAttachWhiteboard`, `WHITEBOARD_FRAME` deduplication + forwarding, and `MYTEMS_WB_STOP` cleanup on `finalizeStop`.
- Modify: `src/dashboard/dashboard.html` & `src/dashboard/dashboard.js` — add Whiteboard mode + meeting keyword inputs inside `#settings` and request optional permissions on save.
- Modify: `src/popup/popup.html`, `src/popup/popup.css`, `src/popup/popup.js` — add pre-checked per-session `Capture MS Whiteboard` checkbox and permission check inside the Start button click gesture.
- Modify: `src/dashboard/pipeline.js` — skip redundant `video.webm` slide extraction when `lecture.hasWhiteboardCaptures` is true and `*_wb.png` slides already exist.
- Tests: `tests/whiteboard.test.js`, `tests/manifest.test.js`, `tests/pipeline.test.js`.

---

### Task 0: Worktree Isolation & Live Whiteboard DOM Verification (Pre-Code Gate)

**Files:**
- Create (when starting implementation): `.gitignore` (if missing, ignoring `.worktrees/`) and `.worktrees/ms-whiteboard`

- [ ] **Step 1: Set up an isolated git worktree before editing any code**

Ensure `.worktrees/` is ignored before creating the worktree (per `using-git-worktrees`):
```bash
grep -qxF '.worktrees/' .gitignore 2>/dev/null || printf '.worktrees/\n' >> .gitignore
git add .gitignore && git commit -m "chore: ignore local git worktrees"
git worktree add .worktrees/ms-whiteboard -b feat/ms-whiteboard-capture
cd .worktrees/ms-whiteboard && bun test
```
Expected: Root `/Users/lightandy/Documents/Projects/MyTems` stays cleanly on `main` for live lectures; `.worktrees/ms-whiteboard` runs `37 pass, 0 fail`. (If executing via Subagent-Driven development, invoke subagents with `Workspace: "share"` or inside `.worktrees/ms-whiteboard`.)

- [ ] **Step 2: Verify live MS Whiteboard iframe rendering in Helium DevTools**

During any Teams meeting with MS Whiteboard open, open DevTools (`Cmd+Opt+I`), switch the Console frame dropdown to the `whiteboard.office.com` / `whiteboard.microsoft.com` iframe, and run:
```js
({
  origin: location.origin,
  svgs: [...document.querySelectorAll('svg')].map((s) => ({
    w: Math.round(s.getBoundingClientRect().width),
    h: Math.round(s.getBoundingClientRect().height),
    paths: s.querySelectorAll('path, polyline, line, g').length,
  })),
  canvases: [...document.querySelectorAll('canvas')].map((c) => ({
    w: c.width,
    h: c.height,
    cssW: Math.round(c.getBoundingClientRect().width),
    cssH: Math.round(c.getBoundingClientRect().height),
  })),
})
```
Expected: Records exact `location.origin` (confirming `WHITEBOARD_ORIGINS` covers it) and whether the main surface is an `<svg>` or `<canvas>`. If a WebGL canvas returns blank on `canvas.toDataURL()`, note it before Task 4 so `world: 'MAIN'` `getContext` preservation or `preserveDrawingBuffer` handling can be added cleanly.

---

### Task 1: Constants & Pure Whiteboard Helpers (`constants.js` + `whiteboard.js`)

**Files:**
- Modify: `src/shared/constants.js:12-45`
- Create: `src/shared/whiteboard.js`
- Test: `tests/whiteboard.test.js`

**Interfaces:**
- Produces in `src/shared/constants.js`: `WHITEBOARD_ORIGINS`, `WHITEBOARD_CONFIG`, `DEFAULT_SETTINGS.whiteboardMode`, `DEFAULT_SETTINGS.whiteboardMeetings`
- Produces in `src/shared/whiteboard.js`:
  - `parseMeetingFilters(filterCsv: string): string[]`
  - `matchesWhiteboardMeeting(tabTitle: string, filterCsv: string): boolean`
  - `shouldEnableWhiteboard({ mode: string, tabTitle: string, filterCsv: string, override?: boolean|null }): boolean`
  - `formatWhiteboardFilename(seq: number, timestampSec: number): string`
  - `computeFnv1aHash(bytes: Uint8Array): number`
  - `shouldSaveWhiteboardFrame({ hash: number, prevHash: number|null, elapsedSinceLastSec: number, savedCount: number, minIntervalSec?: number, maxCaptures?: number }): boolean`
  - `pickWhiteboardSurface(candidates: Array<{ kind: 'svg'|'canvas', width: number, height: number, elementCount?: number, index: number }>): { kind: 'svg'|'canvas', index: number } | null`
  - `uint8ToBase64(bytes: Uint8Array): string`
  - `base64ToUint8(base64: string): Uint8Array`

- [ ] **Step 1: Write the failing tests in `tests/whiteboard.test.js`**

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64ToUint8,
  computeFnv1aHash,
  formatWhiteboardFilename,
  matchesWhiteboardMeeting,
  parseMeetingFilters,
  pickWhiteboardSurface,
  shouldEnableWhiteboard,
  shouldSaveWhiteboardFrame,
  uint8ToBase64,
} from '../src/shared/whiteboard.js';

describe('whiteboard meeting matching', () => {
  it('parses comma/newline filters and matches sanitized or raw tab titles case-insensitively', () => {
    assert.deepEqual(parseMeetingFilters(' Algebra, , Calculus \n '), ['algebra', 'calculus']);
    assert.equal(matchesWhiteboardMeeting('Calculus II | Microsoft Teams', 'algebra, calculus'), true);
    assert.equal(matchesWhiteboardMeeting('Distributed Systems | Microsoft Teams', 'algebra, calculus'), false);
    assert.equal(matchesWhiteboardMeeting('Calculus II | Microsoft Teams', ''), false);
  });

  it('respects explicit override before mode rules', () => {
    assert.equal(
      shouldEnableWhiteboard({ mode: 'off', tabTitle: 'Calculus', filterCsv: 'Calculus', override: true }),
      true
    );
    assert.equal(
      shouldEnableWhiteboard({ mode: 'always', tabTitle: 'Calculus', filterCsv: 'Calculus', override: false }),
      false
    );
    assert.equal(
      shouldEnableWhiteboard({ mode: 'match', tabTitle: 'Linear Algebra | Microsoft Teams', filterCsv: 'algebra' }),
      true
    );
    assert.equal(
      shouldEnableWhiteboard({ mode: 'match', tabTitle: 'OS Lecture | Microsoft Teams', filterCsv: 'algebra' }),
      false
    );
    assert.equal(
      shouldEnableWhiteboard({ mode: 'off', tabTitle: 'Linear Algebra | Microsoft Teams', filterCsv: 'algebra' }),
      false
    );
  });
});

describe('whiteboard filenames, deduplication, and binary encoding', () => {
  it('formats filenames compatible with pipeline.js timestamp parsing', () => {
    const name = formatWhiteboardFilename(3, 125.9);
    assert.equal(name, '003_125_wb.png');
    assert.equal(Number(name.split('_')[1]?.split('.')[0] || 0), 125);
  });

  it('deduplicates identical hashes and enforces cooldown and max capture cap', () => {
    const h1 = computeFnv1aHash(new Uint8Array([1, 2, 3, 4]));
    const h2 = computeFnv1aHash(new Uint8Array([1, 2, 3, 5]));
    assert.notEqual(h1, h2);

    assert.equal(
      shouldSaveWhiteboardFrame({ hash: h1, prevHash: null, elapsedSinceLastSec: 0, savedCount: 0 }),
      true
    );
    assert.equal(
      shouldSaveWhiteboardFrame({ hash: h1, prevHash: h1, elapsedSinceLastSec: 30, savedCount: 1 }),
      false
    );
    assert.equal(
      shouldSaveWhiteboardFrame({ hash: h2, prevHash: h1, elapsedSinceLastSec: 5, savedCount: 1, minIntervalSec: 15 }),
      false
    );
    assert.equal(
      shouldSaveWhiteboardFrame({ hash: h2, prevHash: h1, elapsedSinceLastSec: 20, savedCount: 50, maxCaptures: 50 }),
      false
    );
    assert.equal(
      shouldSaveWhiteboardFrame({ hash: h2, prevHash: h1, elapsedSinceLastSec: 20, savedCount: 1, minIntervalSec: 15, maxCaptures: 50 }),
      true
    );
  });

  it('picks largest valid Whiteboard surface above minimum dimensions', () => {
    const picked = pickWhiteboardSurface([
      { kind: 'svg', width: 24, height: 24, elementCount: 2, index: 0 },
      { kind: 'canvas', width: 1200, height: 800, index: 1 },
      { kind: 'svg', width: 1400, height: 900, elementCount: 18, index: 2 },
    ]);
    assert.deepEqual(picked, { kind: 'svg', index: 2 });

    assert.equal(
      pickWhiteboardSurface([{ kind: 'svg', width: 100, height: 100, elementCount: 1, index: 0 }]),
      null
    );
  });

  it('round-trips Uint8Array through base64 without data loss', () => {
    const orig = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const restored = base64ToUint8(uint8ToBase64(orig));
    assert.deepEqual(restored, orig);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/whiteboard.test.js`
Expected: FAIL (`Cannot find module '../src/shared/whiteboard.js'`).

- [ ] **Step 3: Update `src/shared/constants.js` and implement `src/shared/whiteboard.js`**

Add to `src/shared/constants.js`:
```js
export const WHITEBOARD_ORIGINS = [
  'https://teams.microsoft.com/*',
  'https://teams.cloud.microsoft/*',
  'https://whiteboard.office.com/*',
  'https://*.whiteboard.microsoft.com/*',
];

export const WHITEBOARD_CONFIG = {
  INTERVAL_MS: 25_000,
  MIN_COOLDOWN_SEC: 15,
  MAX_CAPTURES: 50,
  EXPORT_WIDTH: 1920,
  EXPORT_HEIGHT: 1080,
};
```
And inside `DEFAULT_SETTINGS` in `src/shared/constants.js`:
```js
  whiteboardMode: 'off',
  whiteboardMeetings: '',
```

Create `src/shared/whiteboard.js`:
```js
import { WHITEBOARD_CONFIG } from './constants.js';
import { deriveLectureTitle } from './sanitize.js';

export function parseMeetingFilters(filterCsv) {
  return String(filterCsv || '')
    .split(/[,\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function matchesWhiteboardMeeting(tabTitle, filterCsv) {
  const tokens = parseMeetingFilters(filterCsv);
  if (!tokens.length) return false;
  const raw = String(tabTitle || '').toLowerCase();
  const clean = deriveLectureTitle(tabTitle).toLowerCase();
  return tokens.some((tok) => raw.includes(tok) || clean.includes(tok));
}

export function shouldEnableWhiteboard({ mode, tabTitle, filterCsv, override = null }) {
  if (override === true) return true;
  if (override === false) return false;
  if (mode === 'always') return true;
  if (mode === 'match') return matchesWhiteboardMeeting(tabTitle, filterCsv);
  return false;
}

export function formatWhiteboardFilename(seq, timestampSec) {
  const idx = String(Math.max(1, Math.floor(seq))).padStart(3, '0');
  const sec = Math.max(0, Math.floor(timestampSec || 0));
  return `${idx}_${sec}_wb.png`;
}

export function computeFnv1aHash(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function shouldSaveWhiteboardFrame({
  hash,
  prevHash,
  elapsedSinceLastSec,
  savedCount,
  minIntervalSec = WHITEBOARD_CONFIG.MIN_COOLDOWN_SEC,
  maxCaptures = WHITEBOARD_CONFIG.MAX_CAPTURES,
}) {
  if (savedCount >= maxCaptures) return false;
  if (prevHash === null || prevHash === undefined) return true;
  if (hash === prevHash) return false;
  return elapsedSinceLastSec >= minIntervalSec;
}

export function pickWhiteboardSurface(candidates) {
  let best = null;
  let bestScore = 0;
  for (const c of candidates || []) {
    if (!c || c.width < 250 || c.height < 250) continue;
    if (c.kind === 'svg' && (c.elementCount || 0) === 0) continue;
    const area = c.width * c.height;
    const vectorBonus = c.kind === 'svg' ? 1.2 : 1;
    const score = area * vectorBonus;
    if (score > bestScore) {
      bestScore = score;
      best = { kind: c.kind, index: c.index };
    }
  }
  return best;
}

export function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToUint8(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/whiteboard.test.js`
Expected: `PASS` (all 5 tests in `tests/whiteboard.test.js`).

- [ ] **Step 5: Commit**

```bash
git add src/shared/constants.js src/shared/whiteboard.js tests/whiteboard.test.js
git commit -m "feat: add pure whiteboard matching, dedupe, and surface helpers"
```

---

### Task 2: Optional MV3 Permissions in `manifest.json`

**Files:**
- Modify: `manifest.json:6-17`
- Modify: `tests/manifest.test.js`

**Interfaces:**
- Consumes: `WHITEBOARD_ORIGINS` pattern in `src/shared/constants.js`
- Produces: `optional_permissions: ["scripting"]`, `optional_host_permissions: [...]` in `manifest.json`

- [ ] **Step 1: Write the failing manifest assertion in `tests/manifest.test.js`**

Update `tests/manifest.test.js` to check optional permissions while asserting required `permissions` / `host_permissions` remain minimal:
```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WHITEBOARD_ORIGINS } from '../src/shared/constants.js';

describe('manifest.json integrity', () => {
  it('references existing files and obeys global MV3 constraints', () => {
    const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.options_page, undefined);
    assert.ok(!manifest.permissions.includes('identity'));
    assert.ok(!manifest.permissions.includes('scripting'));
    assert.ok(manifest.optional_permissions?.includes('scripting'));
    assert.deepEqual(manifest.optional_host_permissions, WHITEBOARD_ORIGINS);
    assert.ok(fs.existsSync(manifest.background.service_worker));
    assert.ok(fs.existsSync(manifest.action.default_popup));
    for (const p of Object.values(manifest.icons)) {
      assert.ok(fs.existsSync(p), `Missing icon: ${p}`);
    }
    for (const p of Object.values(manifest.action.default_icon)) {
      assert.ok(fs.existsSync(p), `Missing action default_icon: ${p}`);
    }
    assert.ok(fs.existsSync('src/offscreen/offscreen.html'), 'Missing src/offscreen/offscreen.html');
    assert.ok(fs.existsSync('src/dashboard/dashboard.html'), 'Missing src/dashboard/dashboard.html');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/manifest.test.js`
Expected: FAIL (`optional_permissions` undefined).

- [ ] **Step 3: Update `manifest.json`**

Add after `host_permissions` in `manifest.json`:
```json
  "optional_permissions": [
    "scripting"
  ],
  "optional_host_permissions": [
    "https://teams.microsoft.com/*",
    "https://teams.cloud.microsoft/*",
    "https://whiteboard.office.com/*",
    "https://*.whiteboard.microsoft.com/*"
  ],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/manifest.test.js`
Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add manifest.json tests/manifest.test.js
git commit -m "feat: declare optional scripting and whiteboard host permissions"
```

---

### Task 3: Offscreen OPFS Whiteboard Slide Writer

**Files:**
- Modify: `src/offscreen/offscreen.js:1-3,237-250`
- Test: `tests/whiteboard.test.js`

**Interfaces:**
- Consumes: `writeLectureFile` (`src/shared/opfs.js`), `base64ToUint8` (`src/shared/whiteboard.js`)
- Produces: `OFFSCREEN_SAVE_WHITEBOARD_FRAME` message handler in `src/offscreen/offscreen.js` accepting `{ lectureId, filename, base64 }` and replying `{ ok: true }` or `{ ok: false, error }`

- [ ] **Step 1: Add a unit test for slide byte persistence wrapper in `tests/whiteboard.test.js`**

Export a tiny testable helper from `src/shared/whiteboard.js` (or `src/offscreen/offscreen.js`? Keep `offscreen.js` clean of top-level DOM side effects in tests by placing `saveWhiteboardSlide` in `src/shared/whiteboard.js` with injected `writeFile`!):

Add to `tests/whiteboard.test.js`:
```js
import { saveWhiteboardSlide } from '../src/shared/whiteboard.js';

describe('saveWhiteboardSlide', () => {
  it('decodes base64 PNG and writes to slides/<filename>', async () => {
    const writes = [];
    const bytes = new Uint8Array([137, 80, 78, 71]);
    await saveWhiteboardSlide(
      { lectureId: 'lec_1', filename: '001_12_wb.png', base64: uint8ToBase64(bytes) },
      async (id, relPath, data) => writes.push({ id, relPath, data })
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].id, 'lec_1');
    assert.equal(writes[0].relPath, 'slides/001_12_wb.png');
    assert.deepEqual(writes[0].data, bytes);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/whiteboard.test.js`
Expected: FAIL (`saveWhiteboardSlide` not exported).

- [ ] **Step 3: Implement `saveWhiteboardSlide` in `src/shared/whiteboard.js` and wire `OFFSCREEN_SAVE_WHITEBOARD_FRAME` in `src/offscreen/offscreen.js`**

In `src/shared/whiteboard.js`:
```js
export async function saveWhiteboardSlide({ lectureId, filename, base64 }, writeFileFn) {
  if (!lectureId || !filename || !base64) throw new Error('Invalid whiteboard frame payload');
  const bytes = base64ToUint8(base64);
  await writeFileFn(lectureId, `slides/${filename}`, bytes);
}
```

In `src/offscreen/offscreen.js` (imports at top):
```js
import { writeLectureFile } from '../shared/opfs.js';
import { saveWhiteboardSlide } from '../shared/whiteboard.js';
```
And inside `chrome.runtime.onMessage.addListener` (`src/offscreen/offscreen.js:237-250`):
```js
  if (msg.type === 'OFFSCREEN_SAVE_WHITEBOARD_FRAME') {
    saveWhiteboardSlide(msg, writeLectureFile)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/whiteboard.test.js`
Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/whiteboard.js src/offscreen/offscreen.js tests/whiteboard.test.js
git commit -m "feat: handle OFFSCREEN_SAVE_WHITEBOARD_FRAME in offscreen OPFS writer"
```

---

### Task 4: Injected Whiteboard Frame Snapshotter (`src/content/whiteboard-capture.js`)

**Files:**
- Create: `src/content/whiteboard-capture.js`

**Interfaces:**
- Consumes: `MYTEMS_WB_START` (`{ lectureId, startedAtMs, intervalMs }`) and `MYTEMS_WB_STOP` messages from `background.js`
- Produces: `WHITEBOARD_FRAME` messages (`{ type: 'WHITEBOARD_FRAME', lectureId, elapsedSec, base64 }`) sent via `chrome.runtime.sendMessage`

Note: Chrome `executeScript({ files: [...] })` runs non-module classic scripts in content-script worlds, so `src/content/whiteboard-capture.js` MUST be self-contained (zero `import` statements) and guarded against duplicate injection.

- [ ] **Step 1: Create `src/content/whiteboard-capture.js`**

```js
(() => {
  if (window.__mytemsWhiteboardInstalled) return;
  window.__mytemsWhiteboardInstalled = true;

  let timerId = null;
  let activeLectureId = null;
  let activeStartedAtMs = 0;
  let inFlight = false;

  function pickSurface() {
    const svgs = [...document.querySelectorAll('svg')];
    const canvases = [...document.querySelectorAll('canvas')];
    const candidates = [];

    svgs.forEach((el, idx) => {
      const rect = el.getBoundingClientRect();
      candidates.push({
        kind: 'svg',
        index: idx,
        width: rect.width,
        height: rect.height,
        elementCount: el.querySelectorAll('path, polyline, line, rect, circle, text, g').length,
      });
    });

    canvases.forEach((el, idx) => {
      const rect = el.getBoundingClientRect();
      candidates.push({
        kind: 'canvas',
        index: idx,
        width: Math.max(el.width || 0, rect.width),
        height: Math.max(el.height || 0, rect.height),
      });
    });

    let best = null;
    let bestScore = 0;
    for (const c of candidates) {
      if (c.width < 250 || c.height < 250) continue;
      if (c.kind === 'svg' && c.elementCount === 0) continue;
      const score = c.width * c.height * (c.kind === 'svg' ? 1.2 : 1);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) return null;
    return best.kind === 'svg'
      ? { kind: 'svg', el: svgs[best.index] }
      : { kind: 'canvas', el: canvases[best.index] };
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : '');
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  async function rasterizeSvgToPngBase64(svgEl) {
    const rect = svgEl.getBoundingClientRect();
    const width = Math.min(1920, Math.max(800, Math.round(rect.width)));
    const height = Math.min(1080, Math.max(450, Math.round(rect.height)));

    const clone = svgEl.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clone.getAttribute('viewBox') && rect.width > 0 && rect.height > 0) {
      clone.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    }
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));

    const xml = new XMLSerializer().serializeToString(clone);
    const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('SVG rasterization failed'));
        i.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!pngBlob) return null;
      return await blobToBase64(pngBlob);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function canvasToPngBase64(srcCanvas) {
    const out = document.createElement('canvas');
    const scale = Math.min(1, 1920 / Math.max(1, srcCanvas.width));
    out.width = Math.max(1, Math.round(srcCanvas.width * scale));
    out.height = Math.max(1, Math.round(srcCanvas.height * scale));
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(srcCanvas, 0, 0, out.width, out.height);
    const pngBlob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
    if (!pngBlob) return null;
    return await blobToBase64(pngBlob);
  }

  async function captureOnce() {
    if (!activeLectureId || inFlight) return;
    inFlight = true;
    try {
      const surface = pickSurface();
      if (!surface) return;
      const base64 =
        surface.kind === 'svg'
          ? await rasterizeSvgToPngBase64(surface.el)
          : await canvasToPngBase64(surface.el);
      if (!base64) return;
      const elapsedSec = Math.max(0, Math.floor((Date.now() - activeStartedAtMs) / 1000));
      chrome.runtime
        .sendMessage({
          type: 'WHITEBOARD_FRAME',
          lectureId: activeLectureId,
          elapsedSec,
          base64,
        })
        .catch(() => {});
    } catch {
      // Never disturb the host Teams/Whiteboard page on transient DOM/taint errors.
    } finally {
      inFlight = false;
    }
  }

  function stopMonitor() {
    clearInterval(timerId);
    timerId = null;
    activeLectureId = null;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'MYTEMS_WB_START') {
      stopMonitor();
      activeLectureId = msg.lectureId;
      activeStartedAtMs = msg.startedAtMs || Date.now();
      const intervalMs = Math.max(5000, Number(msg.intervalMs) || 25000);
      setTimeout(captureOnce, 2500);
      timerId = setInterval(captureOnce, intervalMs);
    } else if (msg?.type === 'MYTEMS_WB_STOP') {
      stopMonitor();
    }
  });

  window.addEventListener('pagehide', stopMonitor);
})();
```

- [ ] **Step 2: Verify syntax with `bun` / `node --check`**

Run: `node --check src/content/whiteboard-capture.js`
Expected: Exit code `0`, no syntax errors.

- [ ] **Step 3: Commit**

```bash
git add src/content/whiteboard-capture.js
git commit -m "feat: add self-contained whiteboard SVG/canvas frame snapshotter"
```

---

### Task 5: Non-Blocking Background Orchestration (`src/background/background.js`)

**Files:**
- Modify: `src/background/background.js`
- Test: `tests/whiteboard.test.js`

**Interfaces:**
- Consumes: `WHITEBOARD_CONFIG`, `WHITEBOARD_ORIGINS` (`src/shared/constants.js`), `base64ToUint8`, `computeFnv1aHash`, `formatWhiteboardFilename`, `shouldEnableWhiteboard`, `shouldSaveWhiteboardFrame` (`src/shared/whiteboard.js`), `getSettings` (`src/shared/storage.js`)
- Produces: Fire-and-forget `maybeAttachWhiteboard`, `WHITEBOARD_FRAME` dedupe/dispatch to `OFFSCREEN_SAVE_WHITEBOARD_FRAME`, `MYTEMS_WB_STOP` on `finalizeStop`

- [ ] **Step 1: Write unit test for stateful Whiteboard frame tracker in `tests/whiteboard.test.js`**

Add a pure `createWhiteboardTracker()` helper in `src/shared/whiteboard.js` so background deduplication state is tested directly without needing Chrome APIs:
```js
import { createWhiteboardTracker } from '../src/shared/whiteboard.js';

describe('createWhiteboardTracker', () => {
  it('assigns sequential filenames, deduplicates repeated frames, and enforces cap', () => {
    const tracker = createWhiteboardTracker('lec_99', { minIntervalSec: 15, maxCaptures: 2 });
    const imgA = uint8ToBase64(new Uint8Array([1, 2, 3]));
    const imgB = uint8ToBase64(new Uint8Array([1, 2, 4]));
    const imgC = uint8ToBase64(new Uint8Array([1, 2, 5]));

    assert.equal(tracker.accept('lec_other', 10, imgA), null);
    assert.equal(tracker.accept('lec_99', 10, imgA), '001_10_wb.png');
    assert.equal(tracker.accept('lec_99', 40, imgA), null); // same hash
    assert.equal(tracker.accept('lec_99', 18, imgB), null); // < 15s cooldown
    assert.equal(tracker.accept('lec_99', 30, imgB), '002_30_wb.png');
    assert.equal(tracker.accept('lec_99', 60, imgC), null); // maxCaptures = 2
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/whiteboard.test.js`
Expected: FAIL (`createWhiteboardTracker` not exported).

- [ ] **Step 3: Add `createWhiteboardTracker` to `src/shared/whiteboard.js` and wire `src/background/background.js`**

In `src/shared/whiteboard.js`:
```js
export function createWhiteboardTracker(lectureId, opts = {}) {
  let seq = opts.initialSeq || 0;
  let prevHash = opts.prevHash ?? null;
  let lastSavedSec = opts.lastSavedSec ?? -Infinity;

  return {
    accept(targetLectureId, elapsedSec, base64) {
      if (!targetLectureId || targetLectureId !== lectureId || !base64) return null;
      const hash = computeFnv1aHash(base64ToUint8(base64));
      const ok = shouldSaveWhiteboardFrame({
        hash,
        prevHash,
        elapsedSinceLastSec: elapsedSec - lastSavedSec,
        savedCount: seq,
        minIntervalSec: opts.minIntervalSec,
        maxCaptures: opts.maxCaptures,
      });
      if (!ok) return null;
      seq += 1;
      prevHash = hash;
      lastSavedSec = elapsedSec;
      return formatWhiteboardFilename(seq, elapsedSec);
    },
    snapshot() {
      return { lectureId, initialSeq: seq, prevHash, lastSavedSec };
    },
  };
}
```

In `src/background/background.js`:
```js
import { WHITEBOARD_CONFIG, WHITEBOARD_ORIGINS } from '../shared/constants.js';
import { createWhiteboardTracker, shouldEnableWhiteboard } from '../shared/whiteboard.js';
import {
  getActiveSession,
  getLecture,
  getSettings,
  recoverStaleRecordings,
  setActiveSession,
  upsertLecture,
} from '../shared/storage.js';

const WB_SESSION_KEY = 'mytems_wb_tracker';
let wbTracker = null;
let wbTabId = null;

async function getOrRestoreTracker(lectureId) {
  if (wbTracker && wbTracker.snapshot().lectureId === lectureId) return wbTracker;
  const saved = (await chrome.storage.session?.get(WB_SESSION_KEY).catch(() => null))?.[WB_SESSION_KEY];
  if (saved?.lectureId === lectureId) {
    wbTracker = createWhiteboardTracker(lectureId, saved);
    return wbTracker;
  }
  const active = await getActiveSession();
  if (active?.lectureId === lectureId) {
    wbTracker = createWhiteboardTracker(lectureId);
    return wbTracker;
  }
  return null;
}

async function maybeAttachWhiteboard({ tabId, tabTitle, lectureId, startedAtMs, whiteboardOverride }) {
  try {
    const settings = await getSettings();
    const enabled = shouldEnableWhiteboard({
      mode: settings.whiteboardMode,
      tabTitle,
      filterCsv: settings.whiteboardMeetings,
      override: whiteboardOverride ?? null,
    });
    if (!enabled || !tabId) return;

    const granted = await chrome.permissions.contains({
      permissions: ['scripting'],
      origins: WHITEBOARD_ORIGINS,
    });
    if (!granted || !chrome.scripting?.executeScript) return;

    wbTracker = createWhiteboardTracker(lectureId);
    wbTabId = tabId;
    await chrome.storage.session?.set({ [WB_SESSION_KEY]: wbTracker.snapshot() }).catch(() => {});
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/content/whiteboard-capture.js'],
    });
    await chrome.tabs.sendMessage(tabId, {
      type: 'MYTEMS_WB_START',
      lectureId,
      startedAtMs,
      intervalMs: WHITEBOARD_CONFIG.INTERVAL_MS,
    });
  } catch (err) {
    console.warn('Whiteboard attach skipped:', err?.message || err);
  }
}
```
Call `maybeAttachWhiteboard({ tabId, tabTitle, lectureId, startedAtMs, whiteboardOverride: msg.whiteboardOverride })` in `handleStart` **after** `await updateBadge(true)` (without `await` blocking the return, or caught internally so `handleStart` always succeeds).
In `finalizeStop(result)`:
```js
  const active = await getActiveSession().catch(() => null);
  const targetTabId = wbTabId || active?.tabId;
  if (targetTabId) {
    chrome.tabs.sendMessage(targetTabId, { type: 'MYTEMS_WB_STOP' }).catch(() => {});
  }
  wbTracker = null;
  wbTabId = null;
  await chrome.storage.session?.remove(WB_SESSION_KEY).catch(() => {});
```
In `chrome.runtime.onMessage.addListener`:
```js
  if (msg.type === 'WHITEBOARD_FRAME') {
    getOrRestoreTracker(msg.lectureId)
      .then((tracker) => {
        const filename = tracker?.accept(msg.lectureId, msg.elapsedSec, msg.base64);
        if (!filename) return null;
        chrome.storage.session?.set({ [WB_SESSION_KEY]: tracker.snapshot() }).catch(() => {});
        return chrome.runtime.sendMessage({
          type: 'OFFSCREEN_SAVE_WHITEBOARD_FRAME',
          lectureId: msg.lectureId,
          filename,
          base64: msg.base64,
        });
      })
      .then((resp) => {
        if (resp?.ok) {
          upsertLecture({ id: msg.lectureId, hasWhiteboardCaptures: true }).catch(() => {});
        }
      })
      .catch(() => {});
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/whiteboard.test.js`
Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/whiteboard.js src/background/background.js tests/whiteboard.test.js
git commit -m "feat: attach non-blocking whiteboard monitor and deduplicate frames"
```

---

### Task 6: Settings Modal & Popup Per-Session Toggle

**Files:**
- Modify: `src/dashboard/dashboard.html:197-205`
- Modify: `src/dashboard/dashboard.js:498-543`
- Modify: `src/popup/popup.html:35-37`
- Modify: `src/popup/popup.css` (style `.wb-toggle`)
- Modify: `src/popup/popup.js:1-86`

**Interfaces:**
- Consumes: `WHITEBOARD_ORIGINS` (`src/shared/constants.js`), `shouldEnableWhiteboard` (`src/shared/whiteboard.js`)
- Produces: Settings persistence for `whiteboardMode` + `whiteboardMeetings`; popup `whiteboardOverride` boolean passed in `START_RECORDING` message; optional permissions requested strictly inside user click/submit gestures.

- [ ] **Step 1: Add Whiteboard settings fields to `src/dashboard/dashboard.html` and `src/dashboard/dashboard.js`**

In `src/dashboard/dashboard.html` (right above `<p class="helper-note">`):
```html
        <div class="two-col">
          <label>
            <span>MS Whiteboard Capture</span>
            <select name="whiteboardMode">
              <option value="off">Off</option>
              <option value="match">Matching Meetings Only</option>
              <option value="always">Always On</option>
            </select>
          </label>
          <label>
            <span>Whiteboard Meeting Keywords</span>
            <input name="whiteboardMeetings" type="text" placeholder="e.g. Algebra, Calculus, Math" />
          </label>
        </div>
```

In `src/dashboard/dashboard.js`:
1. Import `WHITEBOARD_ORIGINS` from `../shared/constants.js`.
2. Add `'whiteboardMode'` and `'whiteboardMeetings'` to `SETTING_FIELDS`.
3. Inside `form.addEventListener('submit', ...)`: if `patch.whiteboardMode !== 'off'` and `chrome.permissions?.request`, request `{ permissions: ['scripting'], origins: WHITEBOARD_ORIGINS }` inside a non-fatal `try/catch` (if denied, reset `patch.whiteboardMode = 'off'` and warn via `setBanner('Whiteboard permission denied; kept Off.', true)`).

- [ ] **Step 2: Add per-session checkbox to `src/popup/popup.html`, `popup.css`, and `src/popup/popup.js`**

In `src/popup/popup.html` (between `#courseHint` and `#toggleBtn`):
```html
        <label id="wbToggleRow" class="wb-toggle">
          <input id="wbCaptureCheck" type="checkbox" />
          <span>Capture MS Whiteboard</span>
        </label>
```
In `src/popup/popup.css`:
```css
.wb-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--ink-muted, #52525b);
  cursor: pointer;
}
.wb-toggle[hidden] {
  display: none;
}
```
In `src/popup/popup.js`:
- Import `WHITEBOARD_ORIGINS` and `shouldEnableWhiteboard`.
- Hide `wbToggleRow` when `session` is active in `renderSession(session)`.
- In `init()`, pre-check `wbCaptureCheck.checked = shouldEnableWhiteboard({ mode: settings.whiteboardMode, tabTitle: currentTab?.title, filterCsv: settings.whiteboardMeetings })`.
- In `toggleBtn` click handler (before `START_RECORDING`):
  ```js
  let whiteboardOverride = wbCaptureCheck.checked;
  if (whiteboardOverride && chrome.permissions?.request) {
    const ok = await chrome.permissions
      .request({ permissions: ['scripting'], origins: WHITEBOARD_ORIGINS })
      .catch(() => false);
    if (!ok) whiteboardOverride = false;
  }
  ```
  Pass `whiteboardOverride` inside the `START_RECORDING` message payload.

- [ ] **Step 3: Check syntax on modified JS files and run `bun test`**

Run:
```bash
node --check src/dashboard/dashboard.js && node --check src/popup/popup.js && bun test
```
Expected: Syntax OK; all unit tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/dashboard.html src/dashboard/dashboard.js src/popup/popup.html src/popup/popup.css src/popup/popup.js
git commit -m "feat: add per-meeting whiteboard settings and popup session toggle"
```

---

### Task 7: Skip Redundant Video Extraction When Whiteboard Slides Exist (`pipeline.js`)

**Files:**
- Modify: `src/dashboard/pipeline.js:200-220`
- Modify: `tests/pipeline.test.js`

**Interfaces:**
- Consumes: `lecture.hasWhiteboardCaptures` (`src/background/background.js`), `listDirFiles(lectureId, 'slides')`
- Produces: Skips `extractSlidesFromVideo` when `lecture.hasWhiteboardCaptures` is true and `slides/` contains `*_wb.png` files; still extracts from `video.webm` otherwise.

- [ ] **Step 1: Add failing test in `tests/pipeline.test.js`**

Append a test inside `describe('AI pipeline & client helpers', ...)`:
```js
  it('skips video slide extraction when whiteboard captures already exist in slides/', async () => {
    let extractCalled = false;
    const result = await runLecturePipeline({
      lectureId: 'lec_wb',
      deps: {
        getLecture: async () => ({
          id: 'lec_wb',
          courseHint: 'Calculus',
          hasWhiteboardCaptures: true,
        }),
        getSettings: async () => ({
          providerMode: 'cloud',
          openrouterApiKey: 'sk-test',
          sttModel: 'openai/whisper-large-v3',
          llmModel: 'google/gemini-2.5-flash',
        }),
        upsertLecture: async () => ({}),
        readLectureJson: async (_id, name) =>
          name === 'transcript.json'
            ? { text: 'Derivative of x squared', segments: [{ startSec: 5, text: 'Derivative of x squared' }], sttCostUsd: 0 }
            : null,
        writeLectureJson: async () => {},
        listDirFiles: async (_id, dir) => (dir === 'slides' ? ['001_15_wb.png'] : []),
        readLectureFile: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
        blobToDataUrl: async () => 'data:image/png;base64,AQID',
        extractSlidesFromVideo: async () => {
          extractCalled = true;
          return [];
        },
        chatCompletionCloud: async () => ({
          data: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: 'Derivatives',
                    chapters: [{ title: 'Power Rule', startSec: 0, endSec: 60, bullets: ['2x'], formulas: ['(x^2)\'=2x'], slideRefs: [0] }],
                    definitions: [],
                    examRadar: [],
                  }),
                },
              },
            ],
            usage: { cost: 0.001 },
          },
        }),
      },
    });
    assert.equal(extractCalled, false);
    assert.equal(result.notes.chapters[0].formulas[0], '(x^2)\'=2x');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/pipeline.test.js`
Expected: FAIL (`extractCalled` is `true` because `hasWhiteboardCaptures` is ignored).

- [ ] **Step 3: Update `src/dashboard/pipeline.js:200-216`**

```js
    onStage('Extracting slides...');
    await resolvedDeps.upsertLecture({ id: lectureId, status: 'extracting_slides' });
    const existingSlideFiles = await resolvedDeps.listDirFiles(lectureId, 'slides');
    const skipVideoSlides =
      lecture.slidesExtracted ||
      (lecture.hasWhiteboardCaptures && existingSlideFiles.some((f) => f.includes('_wb.')));

    if (!skipVideoSlides) {
      try {
        const videoFile = await resolvedDeps.readLectureFile(lectureId, 'video.webm');
        await resolvedDeps.extractSlidesFromVideo(
          videoFile,
          lectureId,
          (p) => onStage(`Extracting slides (${Math.round(p * 100)}%)...`),
          lecture.durationSec
        );
        await resolvedDeps.upsertLecture({ id: lectureId, slidesExtracted: true });
      } catch (err) {
        if (err?.name !== 'NotFoundError' && !String(err?.message).includes('NotFoundError')) throw err;
      }
    }
    const slides = (await resolvedDeps.listDirFiles(lectureId, 'slides')).map((filename) => ({
      filename,
      timestampSec: Number(filename.split('_')[1]?.split('.')[0] || 0),
    }));
```

- [ ] **Step 4: Run full test suite to verify all tests pass**

Run: `bun test`
Expected: `PASS` across all test files (0 failures).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/pipeline.js tests/pipeline.test.js
git commit -m "feat: skip redundant video slide extraction when whiteboard captures exist"
```

---

### Task 8: Safe Helium Verification Before Merging to `main`

**Files:**
- None (manual verification in Helium Browser)

- [ ] **Step 1: Test regression safety first (`Capture MS Whiteboard` unchecked)**
1. In Helium Browser, load `.worktrees/ms-whiteboard` as a separate unpacked test extension (leaving your main `MyTems` install untouched on `main`).
2. Confirm the experimental extension loads **without** being disabled for new permissions.
3. Record a 20s tab with `Capture MS Whiteboard` unchecked: verify `video.webm`, `audio/*.webm`, transcription, and slide extraction work identically to `main`.

- [ ] **Step 2: Test live MS Whiteboard capture on a Teams meeting**
1. Open `#settings` on the test extension, set `MS Whiteboard Capture` to `Matching Meetings Only`, enter a keyword matching your math meeting title, click `Save Settings`, and accept the permission prompt.
2. Open a Teams meeting with MS Whiteboard, open popup, confirm `Capture MS Whiteboard` auto-checks, start recording, draw/erase on the board across 30s, then stop recording.
3. Open Dashboard: confirm `001_<sec>_wb.png`, `002_<sec>_wb.png` appear in `Slides & Attachments` with clickable video timestamps, and `Generate Notes` parses the math formulas cleanly.

- [ ] **Step 3: Merge only after live verification passes, then remove worktree**

```bash
git checkout main
git merge --ff-only feat/ms-whiteboard-capture
git worktree remove .worktrees/ms-whiteboard
git branch -d feat/ms-whiteboard-capture
```
