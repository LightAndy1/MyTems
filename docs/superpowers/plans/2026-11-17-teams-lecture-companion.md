# MyTems — Teams Lecture Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-backend Manifest V3 Chrome extension for Helium Browser that records Microsoft Teams tab video and segmented Opus audio crash-safely to OPFS, extracts changed slide frames on demand, runs Cloud (OpenRouter) or Local HTTP RO/EN transcription and Vision LLM study notes with an Exam & Deadline Radar, and exports final notes to Notion Markdown / `.zip`.

**Architecture:** Vanilla ES modules (`manifest_version: 3`, no bundler, no `node_modules` runtime dependencies). `popup` triggers `chrome.tabCapture.getMediaStreamId` and delegates capture to `background` -> `offscreen` + a dedicated Web Worker (`FileSystemSyncAccessHandle` in-place OPFS writes). `dashboard` handles playback, on-demand `<video>` canvas slide extraction, STT + Vision LLM orchestration, `<dialog>` Settings Modal, OPFS cleanup, and Notion export. Pure logic is tested with Node 22's built-in `node --test` runner.

**Tech Stack:** Chromium Manifest V3 (`tabCapture`, `offscreen`, `storage`, `unlimitedStorage`), Web `MediaRecorder` (`VP9`/`VP8` + `Opus`), OPFS (`FileSystemSyncAccessHandle`), native ESM + CSS, Node v22 `node --test`.

**Spec:** [2026-11-17-teams-lecture-companion-design.md](file:///Users/lightandy/Documents/Projects/MyTems/docs/superpowers/specs/2026-11-17-teams-lecture-companion-design.md)

## Global Constraints
- Target Helium Browser (Chromium MV3); zero bundler; zero external runtime dependencies.
- Capture Teams tab audio + video only (`chrome.tabCapture`); NEVER capture user microphone.
- Strictly automatic language detection (NO language selector in UI; NO `language` param sent to STT; LLM writes notes in the lecture's primary language preserving English technical terms).
- Settings MUST live in a modern `<dialog>` modal inside `dashboard.html` (accessible via `dashboard.html#settings`); NO separate `options.html` page.
- Notion export MUST be generated strictly from final `notes.json`, disabled when `notes.json` does not exist.
- Lecture titles and download filenames derive from the sanitized browser tab title (stripping `| Microsoft Teams`).

---

## File Structure

- `package.json`: `"type": "module"` + `"test": "node --test tests/*.test.js"`
- `manifest.json`: MV3 permissions, offscreen/popup/background declarations, icons
- `icons/`: generated 16/48/128 PNG icons
- `src/shared/constants.js`: `DEFAULT_SETTINGS`, `STORAGE_KEYS`, `RECORDING_CONFIG`, `SLIDE_CONFIG`
- `src/shared/sanitize.js`: `deriveLectureTitle`, `toSafeFilename`, `formatTimestamp`, `createLectureId`
- `src/shared/zip.js`: `buildStoreZip` (CRC-32 + store-only ZIP container)
- `src/shared/notion.js`: `notesToNotionMarkdown`
- `src/shared/storage.js`: `createStorage`, settings + lecture index + `recoverStaleRecordings`
- `src/shared/opfs.js`: OPFS directory/file helpers, `freeLectureMedia`, `deleteLectureDir`, `getLectureMediaBytes`
- `src/offscreen/opfs-writer.worker.js`: `SyncAccessHandle` open/append/flush/close worker
- `src/offscreen/offscreen.html` & `src/offscreen/offscreen.js`: tab capture, `AudioContext` pass-through, `VP9` video + rolling 10-min `Opus` audio recorders
- `src/background/background.js`: service worker lifecycle, badge updates, startup recovery
- `src/popup/popup.html`, `popup.css`, `popup.js`: Start/Stop capture, live timer, course tag, Dashboard/Settings links
- `src/dashboard/slides.js`: pixel diff calculation, cooldown/cap gate, hidden `<video>` slide extractor, manual frame snap
- `src/dashboard/ai-client.js`: OpenRouter + Local HTTP STT & chat/vision requests, 3x backoff retry, JSON parser/validator
- `src/dashboard/pipeline.js`: segment timestamp merger, Vision prompt builder, checkpointed `runLecturePipeline`
- `src/dashboard/dashboard.html`, `dashboard.css`, `dashboard.js`: full study UI, `<video>` player, Exam Radar, clickable notes/slides, transcript search, Notion export, `<dialog>` Settings Modal

---

### Task 1: Project Scaffolding, Manifest V3, Icons & Sanitizer Utilities

**Files:**
- Create: `package.json`
- Create: `manifest.json`
- Create: `icons/icon-16.png`, `icons/icon-48.png`, `icons/icon-128.png`
- Create: `src/shared/constants.js`
- Create: `src/shared/sanitize.js`
- Test: `tests/sanitize.test.js`

**Interfaces:**
- Produces `src/shared/constants.js`:
  - `STORAGE_KEYS = { SETTINGS: 'mytems_settings', LECTURES: 'mytems_lectures', ACTIVE_SESSION: 'mytems_active_session' }`
  - `DEFAULT_SETTINGS` object
  - `RECORDING_CONFIG` (`VIDEO_BPS`, `AUDIO_BPS`, `MAX_FPS`, `TIMESLICE_MS`, `AUDIO_SEGMENT_MS`, `AUDIO_OVERLAP_MS`)
  - `SLIDE_CONFIG` (`STEP_SEC`, `DIFF_THRESHOLD`, `MIN_COOLDOWN_SEC`, `MAX_SLIDES`, `JPEG_QUALITY`)
- Produces `src/shared/sanitize.js`:
  - `deriveLectureTitle(tabTitle: string): string`
  - `toSafeFilename(title: string): string`
  - `formatTimestamp(totalSec: number): string`
  - `createLectureId(now?: Date): string`

- [ ] **Step 1: Initialize git if needed and write `package.json` + failing `tests/sanitize.test.js`**

```json
{
  "name": "mytems",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/*.test.js"
  }
}
```

Write `tests/sanitize.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveLectureTitle,
  toSafeFilename,
  formatTimestamp,
  createLectureId,
} from '../src/shared/sanitize.js';

describe('sanitize helpers', () => {
  it('strips Microsoft Teams suffix and trims whitespace', () => {
    assert.equal(
      deriveLectureTitle('Distributed Systems Week 4 | Microsoft Teams'),
      'Distributed Systems Week 4'
    );
    assert.equal(deriveLectureTitle('   | Microsoft Teams  '), 'Teams Lecture');
    assert.equal(deriveLectureTitle(''), 'Teams Lecture');
  });

  it('produces filesystem-safe filenames', () => {
    assert.equal(
      toSafeFilename('CS101: Graphs / Trees? (RO+EN)'),
      'CS101_Graphs_Trees_RO+EN'
    );
    assert.equal(toSafeFilename('   '), 'Teams_Lecture');
  });

  it('formats seconds as MM:SS or HH:MM:SS', () => {
    assert.equal(formatTimestamp(0), '00:00');
    assert.equal(formatTimestamp(65.8), '01:05');
    assert.equal(formatTimestamp(3661), '1:01:01');
  });

  it('creates sortable unique lecture ids', () => {
    const id = createLectureId(new Date('2026-11-17T13:15:00.000Z'));
    assert.match(id, /^20261117-131500-[a-z0-9]{4}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL (`Cannot find module '../src/shared/sanitize.js'`).

- [ ] **Step 3: Create `manifest.json`, `src/shared/constants.js`, `src/shared/sanitize.js`, and valid PNG icons**

Write `manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "MyTems — Teams Lecture Companion",
  "version": "0.1.0",
  "description": "Free local lecture capture in Helium with on-demand OpenRouter/local AI notes, slide extraction, Exam Radar, and Notion export.",
  "permissions": [
    "tabCapture",
    "offscreen",
    "storage",
    "unlimitedStorage",
    "activeTab"
  ],
  "host_permissions": [
    "https://openrouter.ai/*",
    "http://localhost/*",
    "http://127.0.0.1/*"
  ],
  "background": {
    "service_worker": "src/background/background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "src/popup/popup.html",
    "default_title": "MyTems Recorder",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

Generate minimal valid solid-indigo PNG icons (`16`, `48`, `128`) using Node's built-in `zlib`:

```bash
node -e '
const fs = require("fs"), zlib = require("zlib");
fs.mkdirSync("icons", { recursive: true });
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
for (const size of [16, 48, 128]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    for (let x = 0; x < size; x++) {
      const p = row + 1 + x * 4;
      raw[p] = 79; raw[p + 1] = 70; raw[p + 2] = 229; raw[p + 3] = 255;
    }
  }
  const png = Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
  fs.writeFileSync(`icons/icon-${size}.png`, png);
}
'
```

Write `src/shared/constants.js`:

```js
export const STORAGE_KEYS = {
  SETTINGS: 'mytems_settings',
  LECTURES: 'mytems_lectures',
  ACTIVE_SESSION: 'mytems_active_session',
};

export const OPENROUTER_URLS = {
  TRANSCRIPTIONS: 'https://openrouter.ai/api/v1/audio/transcriptions',
  CHAT: 'https://openrouter.ai/api/v1/chat/completions',
};

export const DEFAULT_SETTINGS = {
  providerMode: 'cloud',
  openrouterApiKey: '',
  sttModel: 'openai/whisper-large-v3',
  llmModel: 'google/gemini-2.5-flash',
  localSttUrl: 'http://localhost:8080/v1/audio/transcriptions',
  localSttModel: 'whisper-1',
  localLlmUrl: 'http://localhost:11434/v1/chat/completions',
  localLlmModel: 'qwen2.5vl:7b',
  defaultCourseHint: '',
};

export const RECORDING_CONFIG = {
  VIDEO_BPS: 180_000,
  AUDIO_BPS: 16_000,
  MAX_WIDTH: 1920,
  MAX_HEIGHT: 1080,
  MAX_FPS: 8,
  TIMESLICE_MS: 5000,
  AUDIO_SEGMENT_MS: 600_000,
  AUDIO_OVERLAP_MS: 300,
};

export const SLIDE_CONFIG = {
  STEP_SEC: 4,
  DIFF_THRESHOLD: 0.04,
  MIN_COOLDOWN_SEC: 8,
  MAX_SLIDES: 50,
  JPEG_QUALITY: 0.85,
  COMPARE_WIDTH: 160,
  COMPARE_HEIGHT: 90,
};
```

Write `src/shared/sanitize.js`:

```js
export function deriveLectureTitle(tabTitle) {
  const cleaned = String(tabTitle || '')
    .replace(/\s*\|\s*Microsoft Teams\s*$/i, '')
    .replace(/^\(\d+\)\s*/, '')
    .trim();
  return cleaned || 'Teams Lecture';
}

export function toSafeFilename(title) {
  const safe = String(title || '')
    .replace(/[^a-zA-Z0-9+._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return safe || 'Teams_Lecture';
}

export function formatTimestamp(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

export function createLectureId(now = new Date()) {
  const iso = now.toISOString();
  const datePart = iso.slice(0, 10).replace(/-/g, '');
  const timePart = iso.slice(11, 19).replace(/:/g, '');
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${datePart}-${timePart}-${rand}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (4 tests in `tests/sanitize.test.js`).

- [ ] **Step 5: Commit**

```bash
git init
git add package.json manifest.json icons src/shared/constants.js src/shared/sanitize.js tests/sanitize.test.js
git commit -m "chore: scaffold MV3 manifest, constants, and sanitize helpers"
```

---

### Task 2: Store-Only ZIP Builder & Notion Markdown Serializer

**Files:**
- Create: `src/shared/zip.js`
- Create: `src/shared/notion.js`
- Test: `tests/zip.test.js`
- Test: `tests/notion.test.js`

**Interfaces:**
- Consumes: `formatTimestamp` from `src/shared/sanitize.js`
- Produces `src/shared/zip.js`:
  - `buildStoreZip(entries: Array<{ name: string, data: Uint8Array }>): Uint8Array`
- Produces `src/shared/notion.js`:
  - `notesToNotionMarkdown(lecture: object, notes: object, slideFilenames?: string[]): string`

- [ ] **Step 1: Write failing `tests/zip.test.js` and `tests/notion.test.js`**

Write `tests/zip.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStoreZip } from '../src/shared/zip.js';

describe('buildStoreZip', () => {
  it('writes valid local header, central directory, and EOCD signatures', () => {
    const zip = buildStoreZip([
      { name: 'notes.md', data: new TextEncoder().encode('# Hello') },
      { name: 'slides/001.jpg', data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    assert.equal(view.getUint32(0, true), 0x04034b50); // Local header signature
    const eocdOffset = zip.byteLength - 22;
    assert.equal(view.getUint32(eocdOffset, true), 0x06054b50); // EOCD signature
    assert.equal(view.getUint16(eocdOffset + 10, true), 2); // Total entries
  });
});
```

Write `tests/notion.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { notesToNotionMarkdown } from '../src/shared/notion.js';

describe('notesToNotionMarkdown', () => {
  it('rejects export when final AI notes are missing', () => {
    assert.throws(() => notesToNotionMarkdown({ title: 'OS' }, null), /AI-processed notes/);
  });

  it('formats Exam Radar, chapters, timestamps, definitions, and slide links', () => {
    const md = notesToNotionMarkdown(
      { title: 'OS Lecture 3', createdAt: '2026-11-17T10:00:00.000Z', courseHint: 'Operating Systems' },
      {
        summary: 'Covered page tables and TLB.',
        examRadar: [{ type: 'deadline', text: 'Lab 2 due Friday', timestampSec: 75, dueDate: '2026-11-20' }],
        chapters: [
          {
            title: 'Virtual Memory',
            startSec: 120,
            endSec: 600,
            bullets: ['Page size is 4KB'],
            formulas: ['VA = VPN + offset'],
            slideRefs: [0],
          },
        ],
        definitions: [{ term: 'TLB', definition: 'Translation Lookaside Buffer', timestampSec: 310 }],
        totalCostUsd: 0.064,
      },
      ['001_125.jpg']
    );
    assert.match(md, /# OS Lecture 3/);
    assert.match(md, /> \[!IMPORTANT\] Exam & Deadline Radar/);
    assert.match(md, /Lab 2 due Friday \(Due: 2026-11-20\) — `01:15`/);
    assert.match(md, /## Virtual Memory \(`02:00` - `10:00`\)/);
    assert.match(md, /!\[\]\(slides\/001_125\.jpg\)/);
    assert.match(md, /\*\*TLB\*\* \(`05:10`\): Translation Lookaside Buffer/);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test`
Expected: FAIL (`Cannot find module '../src/shared/zip.js'`).

- [ ] **Step 3: Implement `src/shared/zip.js` and `src/shared/notion.js`**

Write `src/shared/zip.js`:

```js
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function buildStoreZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    parts.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of [...parts, ...central, eocd]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
```

Write `src/shared/notion.js`:

```js
import { formatTimestamp } from './sanitize.js';

export function notesToNotionMarkdown(lecture, notes, slideFilenames = []) {
  if (!notes || !Array.isArray(notes.chapters)) {
    throw new Error('Notion export requires final AI-processed notes.');
  }
  const lines = [`# ${lecture.title || 'Teams Lecture'}`];
  const meta = [];
  if (lecture.createdAt) meta.push(`Date: ${lecture.createdAt.slice(0, 10)}`);
  if (lecture.courseHint) meta.push(`Course: ${lecture.courseHint}`);
  if (typeof notes.totalCostUsd === 'number') meta.push(`AI Cost: $${notes.totalCostUsd.toFixed(4)}`);
  if (meta.length) lines.push('', `_${meta.join(' · ')}_`);

  if (notes.summary) {
    lines.push('', '## Summary', notes.summary.trim());
  }

  if (Array.isArray(notes.examRadar) && notes.examRadar.length > 0) {
    lines.push('', '> [!IMPORTANT] Exam & Deadline Radar');
    for (const item of notes.examRadar) {
      const tag = String(item.type || 'note').toUpperCase();
      const due = item.dueDate ? ` (Due: ${item.dueDate})` : '';
      const ts = formatTimestamp(item.timestampSec);
      lines.push(`> - **[${tag}]** ${item.text}${due} — \`${ts}\``);
    }
  }

  for (const ch of notes.chapters) {
    lines.push('', `## ${ch.title} (\`${formatTimestamp(ch.startSec)}\` - \`${formatTimestamp(ch.endSec)}\`)`);
    for (const b of ch.bullets || []) lines.push(`- ${b}`);
    for (const f of ch.formulas || []) lines.push(`- Formula: \`${f}\``);
    for (const refIdx of ch.slideRefs || []) {
      const file = slideFilenames[refIdx];
      if (file) lines.push('', `![](slides/${file})`);
    }
  }

  if (Array.isArray(notes.definitions) && notes.definitions.length > 0) {
    lines.push('', '## Key Definitions');
    for (const d of notes.definitions) {
      lines.push(`- **${d.term}** (\`${formatTimestamp(d.timestampSec)}\`): ${d.definition}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS (all tests in `sanitize.test.js`, `zip.test.js`, `notion.test.js`).

- [ ] **Step 5: Commit**

```bash
git add src/shared/zip.js src/shared/notion.js tests/zip.test.js tests/notion.test.js
git commit -m "feat: add zero-dep store ZIP builder and Notion markdown serializer"
```

---

### Task 3: Storage Index, Crash Recovery & OPFS Manager

**Files:**
- Create: `src/shared/storage.js`
- Create: `src/shared/opfs.js`
- Test: `tests/storage.test.js`

**Interfaces:**
- Consumes: `DEFAULT_SETTINGS`, `STORAGE_KEYS` from `src/shared/constants.js`
- Produces `src/shared/storage.js`:
  - `createStorage(area)` -> `{ getSettings, saveSettings, listLectures, getLecture, upsertLecture, deleteLectureMeta, getActiveSession, setActiveSession, recoverStaleRecordings }`
  - Named default exports bound to `globalThis.chrome?.storage?.local`
- Produces `src/shared/opfs.js`:
  - `getLectureDir(id, create = false)`
  - `writeLectureFile(id, relPath, data)`
  - `readLectureFile(id, relPath)`
  - `readLectureJson(id, relPath)`
  - `writeLectureJson(id, relPath, obj)`
  - `listDirFiles(id, subDir)`
  - `freeLectureMedia(id)`
  - `deleteLectureDir(id)`
  - `getLectureMediaBytes(id)`

- [ ] **Step 1: Write failing `tests/storage.test.js`**

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../src/shared/storage.js';

function makeMemoryArea() {
  const store = {};
  return {
    async get(key) {
      return typeof key === 'string' ? { [key]: store[key] } : { ...store };
    },
    async set(obj) {
      Object.assign(store, obj);
    },
  };
}

describe('storage index and crash recovery', () => {
  it('merges saved settings over defaults and upserts lectures sorted newest first', async () => {
    const s = createStorage(makeMemoryArea());
    const initial = await s.getSettings();
    assert.equal(initial.providerMode, 'cloud');
    await s.saveSettings({ providerMode: 'local', openrouterApiKey: 'sk-test' });
    const updated = await s.getSettings();
    assert.equal(updated.providerMode, 'local');
    assert.equal(updated.openrouterApiKey, 'sk-test');

    await s.upsertLecture({ id: '1', title: 'Old', createdAt: '2026-11-16T10:00:00Z', status: 'ready' });
    await s.upsertLecture({ id: '2', title: 'New', createdAt: '2026-11-17T10:00:00Z', status: 'recorded' });
    const list = await s.listLectures();
    assert.deepEqual(list.map((l) => l.id), ['2', '1']);
  });

  it('recovers stale recording lectures when no active session owns them', async () => {
    const s = createStorage(makeMemoryArea());
    await s.upsertLecture({
      id: 'crashed',
      title: 'Math',
      createdAt: '2026-11-17T08:00:00.000Z',
      startedAtMs: 1_000_000,
      lastChunkAtMs: 1_125_000,
      status: 'recording',
    });
    const recovered = await s.recoverStaleRecordings(null);
    assert.equal(recovered, 1);
    const lec = await s.getLecture('crashed');
    assert.equal(lec.status, 'recorded');
    assert.equal(lec.recoveredFromCrash, true);
    assert.equal(lec.durationSec, 125);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test`
Expected: FAIL (`Cannot find module '../src/shared/storage.js'`).

- [ ] **Step 3: Implement `src/shared/storage.js` and `src/shared/opfs.js`**

Write `src/shared/storage.js`:

```js
import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';

export function createStorage(area) {
  async function getSettings() {
    const res = await area.get(STORAGE_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEYS.SETTINGS] || {}) };
  }

  async function saveSettings(patch) {
    const next = { ...(await getSettings()), ...patch };
    await area.set({ [STORAGE_KEYS.SETTINGS]: next });
    return next;
  }

  async function listLectures() {
    const res = await area.get(STORAGE_KEYS.LECTURES);
    const list = Array.isArray(res[STORAGE_KEYS.LECTURES]) ? res[STORAGE_KEYS.LECTURES] : [];
    return [...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async function getLecture(id) {
    const list = await listLectures();
    return list.find((l) => l.id === id) || null;
  }

  async function upsertLecture(entry) {
    const list = await listLectures();
    const idx = list.findIndex((l) => l.id === entry.id);
    const merged = idx >= 0 ? { ...list[idx], ...entry } : entry;
    if (idx >= 0) list[idx] = merged;
    else list.unshift(merged);
    await area.set({ [STORAGE_KEYS.LECTURES]: list });
    return merged;
  }

  async function deleteLectureMeta(id) {
    const list = (await listLectures()).filter((l) => l.id !== id);
    await area.set({ [STORAGE_KEYS.LECTURES]: list });
  }

  async function getActiveSession() {
    const res = await area.get(STORAGE_KEYS.ACTIVE_SESSION);
    return res[STORAGE_KEYS.ACTIVE_SESSION] || null;
  }

  async function setActiveSession(session) {
    await area.set({ [STORAGE_KEYS.ACTIVE_SESSION]: session });
  }

  async function recoverStaleRecordings(activeLectureId) {
    const list = await listLectures();
    let count = 0;
    const next = list.map((lec) => {
      if (lec.status !== 'recording' || lec.id === activeLectureId) return lec;
      count += 1;
      const elapsedSec =
        lec.lastChunkAtMs && lec.startedAtMs
          ? Math.max(1, Math.round((lec.lastChunkAtMs - lec.startedAtMs) / 1000))
          : lec.durationSec || 0;
      return {
        ...lec,
        status: 'recorded',
        recoveredFromCrash: true,
        durationSec: elapsedSec,
      };
    });
    if (count > 0) await area.set({ [STORAGE_KEYS.LECTURES]: next });
    return count;
  }

  return {
    getSettings,
    saveSettings,
    listLectures,
    getLecture,
    upsertLecture,
    deleteLectureMeta,
    getActiveSession,
    setActiveSession,
    recoverStaleRecordings,
  };
}

const defaultArea = {
  get: (k) => chrome.storage.local.get(k),
  set: (v) => chrome.storage.local.set(v),
};

export const {
  getSettings,
  saveSettings,
  listLectures,
  getLecture,
  upsertLecture,
  deleteLectureMeta,
  getActiveSession,
  setActiveSession,
  recoverStaleRecordings,
} = createStorage(defaultArea);
```

Write `src/shared/opfs.js`:

```js
async function resolveSubdir(root, segments, create) {
  let dir = root;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}

export async function getLectureDir(id, create = false) {
  const root = await navigator.storage.getDirectory();
  return resolveSubdir(root, ['lectures', id], create);
}

export async function writeLectureFile(id, relPath, data) {
  const parts = relPath.split('/').filter(Boolean);
  const fileName = parts.pop();
  const baseDir = await getLectureDir(id, true);
  const dir = parts.length ? await resolveSubdir(baseDir, parts, true) : baseDir;
  const fh = await dir.getFileHandle(fileName, { create: true });
  const writable = await fh.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function readLectureFile(id, relPath) {
  const parts = relPath.split('/').filter(Boolean);
  const fileName = parts.pop();
  const baseDir = await getLectureDir(id, false);
  const dir = parts.length ? await resolveSubdir(baseDir, parts, false) : baseDir;
  const fh = await dir.getFileHandle(fileName);
  return fh.getFile();
}

export async function readLectureJson(id, relPath) {
  try {
    const file = await readLectureFile(id, relPath);
    return JSON.parse(await file.text());
  } catch (err) {
    if (err?.name === 'NotFoundError') return null;
    throw err;
  }
}

export async function writeLectureJson(id, relPath, obj) {
  await writeLectureFile(id, relPath, JSON.stringify(obj, null, 2));
}

export async function listDirFiles(id, subDir) {
  try {
    const baseDir = await getLectureDir(id, false);
    const dir = subDir ? await baseDir.getDirectoryHandle(subDir) : baseDir;
    const files = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') files.push(name);
    }
    return files.sort();
  } catch (err) {
    if (err?.name === 'NotFoundError') return [];
    throw err;
  }
}

export async function freeLectureMedia(id) {
  const dir = await getLectureDir(id, false);
  for (const target of [
    { name: 'video.webm', recursive: false },
    { name: 'audio', recursive: true },
  ]) {
    try {
      await dir.removeEntry(target.name, { recursive: target.recursive });
    } catch (err) {
      if (err?.name !== 'NotFoundError') throw err;
    }
  }
}

export async function deleteLectureDir(id) {
  try {
    const root = await navigator.storage.getDirectory();
    const lecturesDir = await root.getDirectoryHandle('lectures');
    await lecturesDir.removeEntry(id, { recursive: true });
  } catch (err) {
    if (err?.name !== 'NotFoundError') throw err;
  }
}

async function sumDirBytes(dir) {
  let total = 0;
  for await (const [, handle] of dir.entries()) {
    if (handle.kind === 'file') total += (await handle.getFile()).size;
    else if (handle.kind === 'directory') total += await sumDirBytes(handle);
  }
  return total;
}

export async function getLectureMediaBytes(id) {
  try {
    const dir = await getLectureDir(id, false);
    return await sumDirBytes(dir);
  } catch (err) {
    if (err?.name === 'NotFoundError') return 0;
    throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS (all tests including `tests/storage.test.js`).

- [ ] **Step 5: Commit**

```bash
git add src/shared/storage.js src/shared/opfs.js tests/storage.test.js
git commit -m "feat: add storage index, crash recovery, and OPFS helpers"
```

---

### Task 4: Offscreen Recorder, SyncAccessHandle Worker & Background Service Worker

**Files:**
- Create: `src/offscreen/segment-math.js`
- Create: `src/offscreen/opfs-writer.worker.js`
- Create: `src/offscreen/offscreen.html`
- Create: `src/offscreen/offscreen.js`
- Create: `src/background/background.js`
- Test: `tests/recorder-segments.test.js`

**Interfaces:**
- Consumes: `RECORDING_CONFIG` from `src/shared/constants.js`; `createLectureId`, `deriveLectureTitle` from `src/shared/sanitize.js`; `getActiveSession`, `setActiveSession`, `upsertLecture`, `recoverStaleRecordings` from `src/shared/storage.js`
- Produces:
  - `src/offscreen/segment-math.js`: `formatSegmentFilename(index: number): string`, `computeOffsetSec(startedAtMs: number, segmentStartMs: number): number`, `pickVideoMimeType(isTypeSupported: (m: string) => boolean): string`
  - Message protocol (`background` <-> `offscreen`): `START_CAPTURE`, `STOP_CAPTURE`, `CAPTURE_CHUNK_HEARTBEAT`, `CAPTURE_ERROR`

- [ ] **Step 1: Write failing `tests/recorder-segments.test.js`**

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSegmentFilename,
  computeOffsetSec,
  pickVideoMimeType,
} from '../src/offscreen/segment-math.js';

describe('recorder segment helpers', () => {
  it('formats zero-padded audio segment filenames', () => {
    assert.equal(formatSegmentFilename(0), 'audio/000.webm');
    assert.equal(formatSegmentFilename(12), 'audio/012.webm');
  });

  it('computes non-negative segment offset seconds', () => {
    assert.equal(computeOffsetSec(10_000, 10_000), 0);
    assert.equal(computeOffsetSec(10_000, 609_700), 599.7);
  });

  it('prefers VP9 then VP8 then generic webm', () => {
    assert.equal(
      pickVideoMimeType((m) => m.includes('vp9')),
      'video/webm;codecs=vp9,opus'
    );
    assert.equal(
      pickVideoMimeType((m) => m.includes('vp8')),
      'video/webm;codecs=vp8,opus'
    );
    assert.equal(pickVideoMimeType(() => false), 'video/webm');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test`
Expected: FAIL (`Cannot find module '../src/offscreen/segment-math.js'`).

- [ ] **Step 3: Implement `segment-math.js`, `opfs-writer.worker.js`, `offscreen.html/js`, and `background.js`**

Write `src/offscreen/segment-math.js`:

```js
export function formatSegmentFilename(index) {
  return `audio/${String(index).padStart(3, '0')}.webm`;
}

export function computeOffsetSec(startedAtMs, segmentStartMs) {
  return Math.max(0, Number(((segmentStartMs - startedAtMs) / 1000).toFixed(2)));
}

export function pickVideoMimeType(isTypeSupported) {
  for (const mime of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus']) {
    if (isTypeSupported(mime)) return mime;
  }
  return 'video/webm';
}
```

Write `src/offscreen/opfs-writer.worker.js`:

```js
const handles = new Map();

async function getHandle(lectureId, relPath) {
  const key = `${lectureId}/${relPath}`;
  if (handles.has(key)) return handles.get(key);
  const root = await navigator.storage.getDirectory();
  const lectures = await root.getDirectoryHandle('lectures', { create: true });
  let dir = await lectures.getDirectoryHandle(lectureId, { create: true });
  const parts = relPath.split('/').filter(Boolean);
  const fileName = parts.pop();
  for (const seg of parts) dir = await dir.getDirectoryHandle(seg, { create: true });
  const fh = await dir.getFileHandle(fileName, { create: true });
  const access = await fh.createSyncAccessHandle();
  const state = { access, offset: access.getSize() };
  handles.set(key, state);
  return state;
}

self.onmessage = async (event) => {
  const { id, type, lectureId, relPath, bytes } = event.data;
  try {
    if (type === 'append') {
      const state = await getHandle(lectureId, relPath);
      const buf = new Uint8Array(bytes);
      state.access.write(buf, { at: state.offset });
      state.offset += buf.byteLength;
      state.access.flush();
    } else if (type === 'close') {
      const key = `${lectureId}/${relPath}`;
      const state = handles.get(key);
      if (state) {
        state.access.flush();
        state.access.close();
        handles.delete(key);
      }
    } else if (type === 'closeAll') {
      for (const [key, state] of handles.entries()) {
        state.access.flush();
        state.access.close();
        handles.delete(key);
      }
    }
    self.postMessage({ id, ok: true });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
```

Write `src/offscreen/offscreen.html`:

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <script type="module" src="./offscreen.js"></script>
  </body>
</html>
```

Write `src/offscreen/offscreen.js`:

```js
import { RECORDING_CONFIG } from '../shared/constants.js';
import { computeOffsetSec, formatSegmentFilename, pickVideoMimeType } from './segment-math.js';

const worker = new Worker(new URL('./opfs-writer.worker.js', import.meta.url));
let reqSeq = 0;
const pending = new Map();

worker.onmessage = (e) => {
  const resolver = pending.get(e.data.id);
  if (!resolver) return;
  pending.delete(e.data.id);
  if (e.data.ok) resolver.resolve();
  else resolver.reject(new Error(e.data.error));
};

function callWorker(payload, transfer = []) {
  const id = ++reqSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...payload }, transfer);
  });
}

let session = null;

function startAudioSegment(lectureId, audioStream, startedAtMs, index) {
  const relPath = formatSegmentFilename(index);
  const offsetSec = computeOffsetSec(startedAtMs, Date.now());
  const recorder = new MediaRecorder(audioStream, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: RECORDING_CONFIG.AUDIO_BPS,
  });
  let writeChain = Promise.resolve();
  recorder.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    writeChain = writeChain.then(async () => {
      const buf = await e.data.arrayBuffer();
      await callWorker({ type: 'append', lectureId, relPath, bytes: buf }, [buf]);
    });
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = async () => {
      await writeChain;
      await callWorker({ type: 'close', lectureId, relPath });
      resolve();
    };
  });
  recorder.start(RECORDING_CONFIG.TIMESLICE_MS);
  session.audioSegments.push({ filename: relPath, offsetSec });
  return { recorder, stopped };
}

async function startCapture({ lectureId, streamId }) {
  if (session) throw new Error('Capture already active');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        googDisableLocalEcho: false,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: RECORDING_CONFIG.MAX_WIDTH,
        maxHeight: RECORDING_CONFIG.MAX_HEIGHT,
        maxFrameRate: RECORDING_CONFIG.MAX_FPS,
      },
    },
  });

  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination);

  const startedAtMs = Date.now();
  const audioStream = new MediaStream(stream.getAudioTracks());

  const videoRecorder = new MediaRecorder(stream, {
    mimeType: pickVideoMimeType((m) => MediaRecorder.isTypeSupported(m)),
    videoBitsPerSecond: RECORDING_CONFIG.VIDEO_BPS,
    audioBitsPerSecond: RECORDING_CONFIG.AUDIO_BPS,
  });

  let videoChain = Promise.resolve();
  videoRecorder.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    videoChain = videoChain.then(async () => {
      const buf = await e.data.arrayBuffer();
      await callWorker({ type: 'append', lectureId, relPath: 'video.webm', bytes: buf }, [buf]);
      chrome.runtime.sendMessage({
        type: 'CAPTURE_HEARTBEAT',
        lectureId,
        lastChunkAtMs: Date.now(),
        audioSegments: session?.audioSegments || [],
      }).catch(() => {});
    });
  };

  const videoStopped = new Promise((resolve) => {
    videoRecorder.onstop = async () => {
      await videoChain;
      await callWorker({ type: 'close', lectureId, relPath: 'video.webm' });
      resolve();
    };
  });

  session = {
    lectureId,
    startedAtMs,
    stream,
    audioStream,
    audioCtx,
    videoRecorder,
    videoStopped,
    audioSegments: [],
    segmentIndex: 0,
    currentAudio: null,
    rolloverTimer: null,
  };

  session.currentAudio = startAudioSegment(lectureId, audioStream, startedAtMs, 0);
  videoRecorder.start(RECORDING_CONFIG.TIMESLICE_MS);

  session.rolloverTimer = setInterval(() => {
    if (!session) return;
    const prev = session.currentAudio;
    session.segmentIndex += 1;
    session.currentAudio = startAudioSegment(
      lectureId,
      audioStream,
      startedAtMs,
      session.segmentIndex
    );
    setTimeout(() => {
      if (prev?.recorder.state === 'recording') prev.recorder.stop();
    }, RECORDING_CONFIG.AUDIO_OVERLAP_MS);
  }, RECORDING_CONFIG.AUDIO_SEGMENT_MS);

  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    stopCapture().then((res) =>
      chrome.runtime.sendMessage({ type: 'CAPTURE_ENDED_EXTERNALLY', ...res }).catch(() => {})
    );
  });
}

async function stopCapture() {
  if (!session) return null;
  const active = session;
  session = null;
  clearInterval(active.rolloverTimer);

  if (active.videoRecorder.state === 'recording') active.videoRecorder.stop();
  if (active.currentAudio?.recorder.state === 'recording') active.currentAudio.recorder.stop();

  await Promise.all([active.videoStopped, active.currentAudio?.stopped]);
  await callWorker({ type: 'closeAll' });

  for (const t of active.stream.getTracks()) t.stop();
  await active.audioCtx.close().catch(() => {});

  return {
    lectureId: active.lectureId,
    durationSec: Math.max(1, Math.round((Date.now() - active.startedAtMs) / 1000)),
    audioSegments: active.audioSegments,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START_CAPTURE') {
    startCapture(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_STOP_CAPTURE') {
    stopCapture()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
});
```

Write `src/background/background.js`:

```js
import { createLectureId, deriveLectureTitle } from '../shared/sanitize.js';
import {
  getActiveSession,
  getLecture,
  recoverStaleRecordings,
  setActiveSession,
  upsertLecture,
} from '../shared/storage.js';

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'WORKERS'],
    justification: 'Record Teams tab media and flush chunks via OPFS worker.',
  });
}

async function updateBadge(recording) {
  await chrome.action.setBadgeText({ text: recording ? 'REC' : '' });
  if (recording) await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
}

async function finalizeStop(result) {
  if (!result) return null;
  const existing = await getLecture(result.lectureId);
  const updated = await upsertLecture({
    ...(existing || { id: result.lectureId }),
    status: 'recorded',
    durationSec: result.durationSec,
    audioSegments: result.audioSegments,
  });
  await setActiveSession(null);
  await updateBadge(false);
  await chrome.offscreen.closeDocument().catch(() => {});
  return updated;
}

async function handleStart({ tabId, tabTitle, streamId, courseHint }) {
  const active = await getActiveSession();
  if (active) throw new Error('Recording already in progress');
  await ensureOffscreen();

  const now = new Date();
  const lectureId = createLectureId(now);
  const title = deriveLectureTitle(tabTitle);
  const startedAtMs = now.getTime();

  await upsertLecture({
    id: lectureId,
    title,
    courseHint: (courseHint || '').trim(),
    createdAt: now.toISOString(),
    startedAtMs,
    lastChunkAtMs: startedAtMs,
    durationSec: 0,
    audioSegments: [],
    status: 'recording',
  });
  await setActiveSession({ lectureId, tabId, title, startedAtMs });

  const resp = await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_START_CAPTURE',
    lectureId,
    streamId,
  });
  if (!resp?.ok) {
    await upsertLecture({ id: lectureId, status: 'error', error: resp?.error || 'Capture failed' });
    await setActiveSession(null);
    await updateBadge(false);
    throw new Error(resp?.error || 'Capture failed');
  }
  await updateBadge(true);
  return { lectureId, title, startedAtMs };
}

async function handleStop() {
  const resp = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_CAPTURE' });
  if (!resp?.ok) throw new Error(resp?.error || 'Stop capture failed');
  return finalizeStop(resp.data);
}

chrome.runtime.onStartup.addListener(async () => {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  const active = contexts.length ? await getActiveSession() : null;
  await recoverStaleRecordings(active?.lectureId || null);
  if (!active) {
    await setActiveSession(null);
    await updateBadge(false);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await recoverStaleRecordings(null);
  await setActiveSession(null);
  await updateBadge(false);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    handleStart(msg)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg.type === 'STOP_RECORDING') {
    handleStop()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg.type === 'CAPTURE_HEARTBEAT') {
    upsertLecture({
      id: msg.lectureId,
      lastChunkAtMs: msg.lastChunkAtMs,
      audioSegments: msg.audioSegments,
    }).catch(() => {});
  }
  if (msg.type === 'CAPTURE_ENDED_EXTERNALLY') {
    finalizeStop(msg).catch(() => {});
  }
});
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS (all tests including `tests/recorder-segments.test.js`).

- [ ] **Step 5: Commit**

```bash
git add src/offscreen src/background tests/recorder-segments.test.js
git commit -m "feat: add MV3 offscreen recorder, OPFS sync worker, and background coordinator"
```

---

### Task 5: Popup UI (Start/Stop Capture, Live Timer, Dashboard & Modal Links)

**Files:**
- Create: `src/popup/popup.html`
- Create: `src/popup/popup.css`
- Create: `src/popup/popup.js`

**Interfaces:**
- Consumes: `deriveLectureTitle`, `formatTimestamp` from `src/shared/sanitize.js`; `getActiveSession`, `getSettings` from `src/shared/storage.js`; `START_RECORDING` / `STOP_RECORDING` messages to `background.js`.

- [ ] **Step 1: Create `src/popup/popup.html`, `src/popup/popup.css`, and `src/popup/popup.js`**

Write `src/popup/popup.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MyTems</title>
    <link rel="stylesheet" href="./popup.css" />
  </head>
  <body>
    <main class="popup">
      <header class="header">
        <span class="brand">MyTems</span>
        <button id="settingsBtn" class="icon-btn" title="Settings" aria-label="Open Settings">⚙</button>
      </header>

      <section class="card">
        <p id="tabTitle" class="tab-title">Detecting tab...</p>
        <input id="courseHint" type="text" placeholder="Optional course hint (e.g. Distributed Systems)" />
        <div id="timer" class="timer" hidden>00:00</div>
        <button id="toggleBtn" class="primary-btn">Start Recording</button>
        <p id="errorMsg" class="error" hidden></p>
      </section>

      <button id="dashboardBtn" class="secondary-btn">Open Saved Lectures →</button>
    </main>
    <script type="module" src="./popup.js"></script>
  </body>
</html>
```

Write `src/popup/popup.css`:

```css
:root {
  color-scheme: light dark;
  --bg: #0f1117;
  --surface: #181b24;
  --border: #2a2f3d;
  --text: #f3f4f6;
  --muted: #9ca3af;
  --accent: #6366f1;
  --danger: #dc2626;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f8fafc;
    --surface: #ffffff;
    --border: #e2e8f0;
    --text: #0f172a;
    --muted: #64748b;
  }
}
* { box-sizing: border-box; }
body { margin: 0; width: 320px; background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, sans-serif; }
.popup { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.header { display: flex; justify-content: space-between; align-items: center; }
.brand { font-weight: 700; letter-spacing: -0.02em; font-size: 16px; }
.icon-btn { background: transparent; border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 4px 8px; cursor: pointer; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.tab-title { margin: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
input { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text); font-size: 13px; }
.timer { font-variant-numeric: tabular-nums; font-size: 22px; font-weight: 700; text-align: center; color: #ef4444; }
.primary-btn { background: var(--accent); color: #fff; border: none; border-radius: 10px; padding: 10px; font-weight: 600; cursor: pointer; }
.primary-btn.recording { background: var(--danger); }
.secondary-btn { background: transparent; border: 1px solid var(--border); color: var(--text); border-radius: 10px; padding: 9px; font-weight: 500; cursor: pointer; }
.error { margin: 0; color: #f87171; font-size: 12px; }
```

Write `src/popup/popup.js`:

```js
import { deriveLectureTitle, formatTimestamp } from '../shared/sanitize.js';
import { getActiveSession, getSettings } from '../shared/storage.js';

const tabTitleEl = document.getElementById('tabTitle');
const courseHintEl = document.getElementById('courseHint');
const timerEl = document.getElementById('timer');
const toggleBtn = document.getElementById('toggleBtn');
const errorEl = document.getElementById('errorMsg');
const dashboardBtn = document.getElementById('dashboardBtn');
const settingsBtn = document.getElementById('settingsBtn');

let currentTab = null;
let timerInterval = null;

function setError(msg) {
  errorEl.textContent = msg || '';
  errorEl.hidden = !msg;
}

function renderSession(session) {
  clearInterval(timerInterval);
  if (session) {
    tabTitleEl.textContent = session.title;
    courseHintEl.hidden = true;
    timerEl.hidden = false;
    toggleBtn.textContent = 'Stop Recording';
    toggleBtn.classList.add('recording');
    const tick = () => {
      timerEl.textContent = formatTimestamp((Date.now() - session.startedAtMs) / 1000);
    };
    tick();
    timerInterval = setInterval(tick, 1000);
  } else {
    tabTitleEl.textContent = currentTab ? deriveLectureTitle(currentTab.title) : 'No active tab';
    courseHintEl.hidden = false;
    timerEl.hidden = true;
    toggleBtn.textContent = 'Start Recording';
    toggleBtn.classList.remove('recording');
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  const [session, settings] = await Promise.all([getActiveSession(), getSettings()]);
  if (settings.defaultCourseHint && !courseHintEl.value) {
    courseHintEl.value = settings.defaultCourseHint;
  }
  renderSession(session);
}

toggleBtn.addEventListener('click', async () => {
  setError('');
  toggleBtn.disabled = true;
  try {
    const active = await getActiveSession();
    if (active) {
      const resp = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
      if (!resp?.ok) throw new Error(resp?.error || 'Failed to stop');
      renderSession(null);
    } else {
      if (!currentTab?.id) throw new Error('Select a Teams tab first.');
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: currentTab.id });
      const resp = await chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        tabId: currentTab.id,
        tabTitle: currentTab.title || '',
        streamId,
        courseHint: courseHintEl.value,
      });
      if (!resp?.ok) throw new Error(resp?.error || 'Failed to start');
      renderSession(resp.data);
    }
  } catch (err) {
    setError(err?.message || String(err));
  } finally {
    toggleBtn.disabled = false;
  }
});

function openDashboard(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/dashboard/dashboard.html${hash}`) });
}

dashboardBtn.addEventListener('click', () => openDashboard(''));
settingsBtn.addEventListener('click', () => openDashboard('#settings'));

init();
```

- [ ] **Step 2: Commit**

```bash
git add src/popup
git commit -m "feat: add MV3 popup recorder controls and dashboard/settings launcher"
```

---

### Task 6: On-Demand Slide Keyframe Extractor

**Files:**
- Create: `src/dashboard/slides.js`
- Test: `tests/slides.test.js`

**Interfaces:**
- Consumes: `SLIDE_CONFIG` from `src/shared/constants.js`; `writeLectureFile`, `listDirFiles` from `src/shared/opfs.js`
- Produces `src/dashboard/slides.js`:
  - `computeMeanPixelDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number`
  - `shouldCaptureSlide(params: { diff: number, elapsedSec: number, slideCount: number, threshold?: number, minCooldownSec?: number, maxSlides?: number }): boolean`
  - `extractSlidesFromVideo(videoFile: File, lectureId: string, onProgress?: (pct: number) => void): Promise<Array<{ filename: string, timestampSec: number }>>`
  - `captureCurrentVideoFrame(videoEl: HTMLVideoElement, lectureId: string, timestampSec: number): Promise<{ filename: string, timestampSec: number }>`

- [ ] **Step 1: Write failing `tests/slides.test.js`**

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeMeanPixelDiff, shouldCaptureSlide } from '../src/dashboard/slides.js';

describe('slide frame diffing', () => {
  it('computes normalized mean RGB pixel difference', () => {
    const a = new Uint8ClampedArray([0, 0, 0, 255, 100, 100, 100, 255]);
    const b = new Uint8ClampedArray([255, 255, 255, 255, 100, 100, 100, 255]);
    assert.equal(computeMeanPixelDiff(a, a), 0);
    assert.ok(Math.abs(computeMeanPixelDiff(a, b) - 0.5) < 1e-6);
  });

  it('enforces threshold, cooldown, and max slide cap', () => {
    assert.equal(shouldCaptureSlide({ diff: 0.02, elapsedSec: 12, slideCount: 1 }), false);
    assert.equal(shouldCaptureSlide({ diff: 0.1, elapsedSec: 4, slideCount: 1 }), false);
    assert.equal(shouldCaptureSlide({ diff: 0.1, elapsedSec: 10, slideCount: 50 }), false);
    assert.equal(shouldCaptureSlide({ diff: 0.1, elapsedSec: 10, slideCount: 5 }), true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test`
Expected: FAIL (`Cannot find module '../src/dashboard/slides.js'`).

- [ ] **Step 3: Implement `src/dashboard/slides.js`**

```js
import { SLIDE_CONFIG } from '../shared/constants.js';
import { listDirFiles, writeLectureFile } from '../shared/opfs.js';

export function computeMeanPixelDiff(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 1;
  let sum = 0;
  const pixels = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    sum += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / (3 * 255);
  }
  return sum / pixels;
}

export function shouldCaptureSlide({
  diff,
  elapsedSec,
  slideCount,
  threshold = SLIDE_CONFIG.DIFF_THRESHOLD,
  minCooldownSec = SLIDE_CONFIG.MIN_COOLDOWN_SEC,
  maxSlides = SLIDE_CONFIG.MAX_SLIDES,
}) {
  if (slideCount >= maxSlides) return false;
  if (slideCount === 0) return true;
  return diff >= threshold && elapsedSec >= minCooldownSec;
}

function seekVideo(video, sec) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Video seek failed')); };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = sec;
  });
}

async function encodeFrameJpeg(video) {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', SLIDE_CONFIG.JPEG_QUALITY));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function captureCurrentVideoFrame(videoEl, lectureId, timestampSec) {
  const existing = await listDirFiles(lectureId, 'slides');
  const nextIdx = String(existing.length + 1).padStart(3, '0');
  const secInt = Math.max(0, Math.floor(timestampSec));
  const filename = `${nextIdx}_${secInt}.jpg`;
  const jpeg = await encodeFrameJpeg(videoEl);
  await writeLectureFile(lectureId, `slides/${filename}`, jpeg);
  return { filename, timestampSec: secInt };
}

export async function extractSlidesFromVideo(videoFile, lectureId, onProgress = () => {}) {
  const url = URL.createObjectURL(videoFile);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;

  const cmpCanvas = document.createElement('canvas');
  cmpCanvas.width = SLIDE_CONFIG.COMPARE_WIDTH;
  cmpCanvas.height = SLIDE_CONFIG.COMPARE_HEIGHT;
  const cmpCtx = cmpCanvas.getContext('2d', { willReadFrequently: true });

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Could not decode video.webm'));
    });

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (duration === 0) return [];

    const slides = [];
    let prevPixels = null;
    let lastCaptureSec = -SLIDE_CONFIG.MIN_COOLDOWN_SEC;

    for (let t = 1; t < duration; t += SLIDE_CONFIG.STEP_SEC) {
      await seekVideo(video, t);
      cmpCtx.drawImage(video, 0, 0, cmpCanvas.width, cmpCanvas.height);
      const curr = cmpCtx.getImageData(0, 0, cmpCanvas.width, cmpCanvas.height).data;
      const diff = prevPixels ? computeMeanPixelDiff(prevPixels, curr) : 1;

      if (shouldCaptureSlide({ diff, elapsedSec: t - lastCaptureSec, slideCount: slides.length })) {
        const idx = String(slides.length + 1).padStart(3, '0');
        const secInt = Math.floor(t);
        const filename = `${idx}_${secInt}.jpg`;
        const jpeg = await encodeFrameJpeg(video);
        await writeLectureFile(lectureId, `slides/${filename}`, jpeg);
        slides.push({ filename, timestampSec: secInt });
        prevPixels = curr;
        lastCaptureSec = t;
      }
      onProgress(Math.min(1, t / duration));
      if (slides.length >= SLIDE_CONFIG.MAX_SLIDES) break;
    }
    onProgress(1);
    return slides;
  } finally {
    URL.revokeObjectURL(url);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS (all tests including `tests/slides.test.js`).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/slides.js tests/slides.test.js
git commit -m "feat: add on-demand video slide keyframe extractor and unit tests"
```

---

### Task 7: AI Client (OpenRouter + Local HTTP) & Checkpointed Pipeline

**Files:**
- Create: `src/dashboard/ai-client.js`
- Create: `src/dashboard/pipeline.js`
- Test: `tests/pipeline.test.js`

**Interfaces:**
- Consumes: `OPENROUTER_URLS` from `src/shared/constants.js`; `formatTimestamp` from `src/shared/sanitize.js`; `getLecture`, `getSettings`, `upsertLecture` from `src/shared/storage.js`; `readLectureFile`, `readLectureJson`, `writeLectureJson` from `src/shared/opfs.js`; `extractSlidesFromVideo` from `src/dashboard/slides.js`
- Produces `src/dashboard/ai-client.js`:
  - `fetchWithRetry(url: string, init: RequestInit, retries?: number, fetchImpl?: typeof fetch, sleepMs?: (ms: number) => Promise<void>): Promise<Response>`
  - `parseNotesJson(rawText: string): object`
  - `blobToBase64(blob: Blob): Promise<string>`
  - `transcribeAudioSegment({ settings, blob, filename }): Promise<{ text: string, segments: Array<{ startSec: number, endSec: number, text: string }>, language: string, costUsd: number }>`
  - `generateStructuredNotes({ settings, messages }): Promise<{ notes: object, costUsd: number }>`
- Produces `src/dashboard/pipeline.js`:
  - `mergeTranscriptSegments(chunkResults: Array<{ offsetSec: number, result: object }>): { segments: Array<{ startSec: number, endSec: number, text: string }>, fullText: string, detectedLanguage: string, sttCostUsd: number }`
  - `buildVisionMessages(transcript: object, slidePayloads: Array<{ filename: string, timestampSec: number, dataUrl: string }>, courseHint?: string): Array<object>`
  - `runLecturePipeline({ lectureId, courseHint, onStage, deps }): Promise<{ transcript: object, notes: object, slides: Array<{ filename: string, timestampSec: number }> }>`

- [ ] **Step 1: Write failing `tests/pipeline.test.js`**

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotesJson, fetchWithRetry } from '../src/dashboard/ai-client.js';
import { mergeTranscriptSegments, runLecturePipeline } from '../src/dashboard/pipeline.js';

describe('AI pipeline & client helpers', () => {
  it('strips markdown fences and validates notes schema', () => {
    const parsed = parseNotesJson('```json\n{"summary":"S","chapters":[],"definitions":[],"examRadar":[]}\n```');
    assert.equal(parsed.summary, 'S');
    assert.throws(() => parseNotesJson('{"summary":"missing chapters"}'), /Invalid notes JSON/);
  });

  it('retries 429/5xx responses with backoff and succeeds', async () => {
    let calls = 0;
    const mockFetch = async () => {
      calls += 1;
      if (calls < 3) return new Response('rate limited', { status: 429 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const res = await fetchWithRetry('https://example.test', {}, 3, mockFetch, async () => {});
    assert.equal(calls, 3);
    assert.equal(res.status, 200);
  });

  it('shifts segment timestamps by chunk offset and merges text', () => {
    const merged = mergeTranscriptSegments([
      {
        offsetSec: 0,
        result: {
          language: 'ro',
          text: 'Bună ziua',
          segments: [{ startSec: 0, endSec: 3, text: 'Bună ziua' }],
          costUsd: 0.01,
        },
      },
      {
        offsetSec: 599.7,
        result: {
          language: 'ro',
          text: 'continuăm cu graphs',
          segments: [{ startSec: 1.3, endSec: 4.3, text: 'continuăm cu graphs' }],
          costUsd: 0.01,
        },
      },
    ]);
    assert.equal(merged.segments[1].startSec, 601);
    assert.equal(merged.segments[1].endSec, 604);
    assert.equal(merged.sttCostUsd, 0.02);
    assert.equal(merged.detectedLanguage, 'ro');
  });

  it('skips STT when transcript.json already exists (retry checkpoint)', async () => {
    let sttCalls = 0;
    const stored = {
      transcript: {
        segments: [{ startSec: 0, endSec: 5, text: 'Hello' }],
        fullText: 'Hello',
        detectedLanguage: 'en',
        sttCostUsd: 0.02,
      },
      notes: null,
    };
    const res = await runLecturePipeline({
      lectureId: 'lec-1',
      deps: {
        getLecture: async () => ({ id: 'lec-1', courseHint: 'CS', audioSegments: [] }),
        getSettings: async () => ({ providerMode: 'cloud', openrouterApiKey: 'sk' }),
        upsertLecture: async () => {},
        readLectureJson: async (_id, path) => (path === 'transcript.json' ? stored.transcript : null),
        writeLectureJson: async (_id, path, obj) => { stored[path] = obj; },
        readLectureFile: async () => { throw new Error('NotFoundError'); },
        listDirFiles: async () => [],
        transcribeAudioSegment: async () => { sttCalls += 1; },
        extractSlidesFromVideo: async () => [],
        generateStructuredNotes: async () => ({
          notes: { summary: 'Done', chapters: [], definitions: [], examRadar: [] },
          costUsd: 0.03,
        }),
        blobToDataUrl: async () => '',
      },
    });
    assert.equal(sttCalls, 0);
    assert.equal(res.notes.totalCostUsd, 0.05);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test`
Expected: FAIL (`Cannot find module '../src/dashboard/ai-client.js'`).

- [ ] **Step 3: Implement `src/dashboard/ai-client.js` and `src/dashboard/pipeline.js`**

Write `src/dashboard/ai-client.js`:

```js
import { OPENROUTER_URLS } from '../shared/constants.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(url, init, retries = 3, fetchImpl = fetch, sleep = defaultSleep) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, init);
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const errBody = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    } catch (err) {
      lastError = err;
      if (attempt < retries && !String(err.message).startsWith('HTTP 4')) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export async function blobToDataUrl(blob, mimeHint = 'image/jpeg') {
  return `data:${blob.type || mimeHint};base64,${await blobToBase64(blob)}`;
}

export function parseNotesJson(rawText) {
  const cleaned = String(rawText || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.chapters)) {
    throw new Error('Invalid notes JSON structure');
  }
  return {
    summary: parsed.summary,
    chapters: parsed.chapters,
    definitions: Array.isArray(parsed.definitions) ? parsed.definitions : [],
    examRadar: Array.isArray(parsed.examRadar) ? parsed.examRadar : [],
  };
}

export async function transcribeAudioSegment({ settings, blob, filename }) {
  const isLocal = settings.providerMode === 'local';
  let res;
  if (isLocal) {
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('model', settings.localSttModel);
    form.append('response_format', 'verbose_json');
    res = await fetchWithRetry(settings.localSttUrl, { method: 'POST', body: form });
  } else {
    if (!settings.openrouterApiKey) throw new Error('Missing OpenRouter API key in Settings.');
    const data = await blobToBase64(blob);
    res = await fetchWithRetry(OPENROUTER_URLS.TRANSCRIPTIONS, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.openrouterApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.sttModel,
        input_audio: { data, format: 'webm' },
        response_format: 'verbose_json',
      }),
    });
  }
  const json = await res.json();
  const segments = Array.isArray(json.segments) && json.segments.length
    ? json.segments.map((s) => ({
        startSec: Number(s.start ?? 0),
        endSec: Number(s.end ?? s.start ?? 0),
        text: String(s.text || '').trim(),
      }))
    : [{ startSec: 0, endSec: Number(json.usage?.seconds || 0), text: String(json.text || '').trim() }];

  return {
    text: String(json.text || segments.map((s) => s.text).join(' ')).trim(),
    segments: segments.filter((s) => s.text),
    language: json.language || 'auto',
    costUsd: Number(json.usage?.cost || 0),
  };
}

export async function generateStructuredNotes({ settings, messages }) {
  const isLocal = settings.providerMode === 'local';
  const url = isLocal ? settings.localLlmUrl : OPENROUTER_URLS.CHAT;
  const headers = { 'Content-Type': 'application/json' };
  if (!isLocal) {
    if (!settings.openrouterApiKey) throw new Error('Missing OpenRouter API key in Settings.');
    headers.Authorization = `Bearer ${settings.openrouterApiKey}`;
  }
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: isLocal ? settings.localLlmModel : settings.llmModel,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  });
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from LLM');
  return {
    notes: parseNotesJson(content),
    costUsd: Number(json.usage?.cost || 0),
  };
}
```

Write `src/dashboard/pipeline.js`:

```js
import { formatTimestamp } from '../shared/sanitize.js';
import { getLecture, getSettings, upsertLecture } from '../shared/storage.js';
import { listDirFiles, readLectureFile, readLectureJson, writeLectureJson } from '../shared/opfs.js';
import { extractSlidesFromVideo } from './slides.js';
import { blobToDataUrl, generateStructuredNotes, transcribeAudioSegment } from './ai-client.js';

export function mergeTranscriptSegments(chunkResults) {
  const segments = [];
  let sttCostUsd = 0;
  let detectedLanguage = 'auto';

  for (const { offsetSec, result } of chunkResults) {
    if (result.language && result.language !== 'auto') detectedLanguage = result.language;
    sttCostUsd += Number(result.costUsd || 0);
    for (const seg of result.segments || []) {
      segments.push({
        startSec: Number((offsetSec + seg.startSec).toFixed(2)),
        endSec: Number((offsetSec + seg.endSec).toFixed(2)),
        text: seg.text,
      });
    }
  }
  return {
    segments,
    fullText: segments.map((s) => s.text).join(' '),
    detectedLanguage,
    sttCostUsd: Number(sttCostUsd.toFixed(6)),
  };
}

export function buildVisionMessages(transcript, slidePayloads, courseHint = '') {
  const transcriptLines = transcript.segments
    .map((s) => `[${formatTimestamp(s.startSec)} | ${Math.floor(s.startSec)}s] ${s.text}`)
    .join('\n');

  const slideIndex = slidePayloads
    .map((s, idx) => `Slide #${idx} @ ${formatTimestamp(s.timestampSec)} (${Math.floor(s.timestampSec)}s)`)
    .join('\n');

  const system = [
    'You are an expert university lecture note-taker.',
    'Write notes automatically in the lecture primary spoken language (Romanian or English), preserving English technical terms verbatim.',
    'Return ONLY valid JSON matching: { "summary": string, "chapters": [{ "title": string, "startSec": number, "endSec": number, "bullets": string[], "formulas": string[], "slideRefs": number[] }], "definitions": [{ "term": string, "definition": string, "timestampSec": number }], "examRadar": [{ "type": "exam_hint"|"deadline"|"homework", "text": string, "timestampSec": number, "dueDate": string|null }] }.',
  ].join(' ');

  const userContent = [
    {
      type: 'text',
      text: [
        courseHint ? `Course/Context hint: ${courseHint}` : '',
        'Slide timestamps (0-based index for slideRefs):',
        slideIndex || '(no slides extracted)',
        '\nTimestamped transcript:\n',
        transcriptLines,
      ]
        .filter(Boolean)
        .join('\n'),
    },
    ...slidePayloads.map((s) => ({ type: 'image_url', image_url: { url: s.dataUrl } })),
  ];

  return [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];
}

export async function runLecturePipeline({
  lectureId,
  courseHint,
  onStage = () => {},
  deps = {
    getLecture,
    getSettings,
    upsertLecture,
    readLectureJson,
    writeLectureJson,
    readLectureFile,
    listDirFiles,
    transcribeAudioSegment,
    extractSlidesFromVideo,
    generateStructuredNotes,
    blobToDataUrl,
  },
}) {
  const [lecture, settings] = await Promise.all([
    deps.getLecture(lectureId),
    deps.getSettings(),
  ]);
  if (!lecture) throw new Error(`Lecture ${lectureId} not found`);
  const activeHint = (courseHint ?? lecture.courseHint ?? settings.defaultCourseHint ?? '').trim();

  try {
    let transcript = await deps.readLectureJson(lectureId, 'transcript.json');
    if (!transcript) {
      await deps.upsertLecture({ id: lectureId, status: 'transcribing', courseHint: activeHint, error: '' });
      onStage('Transcribing audio...');

      let segmentsMeta = lecture.audioSegments?.length
        ? lecture.audioSegments
        : (await deps.listDirFiles(lectureId, 'audio')).map((f, i) => ({
            filename: `audio/${f}`,
            offsetSec: i * 600,
          }));

      const chunkResults = [];
      for (let i = 0; i < segmentsMeta.length; i++) {
        onStage(`Transcribing part ${i + 1}/${segmentsMeta.length}...`);
        const seg = segmentsMeta[i];
        const blob = await deps.readLectureFile(lectureId, seg.filename);
        const result = await deps.transcribeAudioSegment({
          settings,
          blob,
          filename: seg.filename.split('/').pop(),
        });
        chunkResults.push({ offsetSec: seg.offsetSec, result });
      }
      transcript = mergeTranscriptSegments(chunkResults);
      await deps.writeLectureJson(lectureId, 'transcript.json', transcript);
    }

    onStage('Extracting slides...');
    await deps.upsertLecture({ id: lectureId, status: 'extracting_slides' });
    if (!lecture.slidesExtracted) {
      try {
        const videoFile = await deps.readLectureFile(lectureId, 'video.webm');
        await deps.extractSlidesFromVideo(videoFile, lectureId, (p) =>
          onStage(`Extracting slides (${Math.round(p * 100)}%)...`)
        );
        await deps.upsertLecture({ id: lectureId, slidesExtracted: true });
      } catch (err) {
        if (err?.name !== 'NotFoundError' && !String(err?.message).includes('NotFoundError')) throw err;
      }
    }
    const slides = (await deps.listDirFiles(lectureId, 'slides')).map((filename) => ({
      filename,
      timestampSec: Number(filename.split('_')[1]?.split('.')[0] || 0),
    }));

    onStage('Generating study notes & Exam Radar...');
    await deps.upsertLecture({ id: lectureId, status: 'summarizing' });
    const slidePayloads = [];
    for (const s of slides) {
      const file = await deps.readLectureFile(lectureId, `slides/${s.filename}`);
      const mime = s.filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      slidePayloads.push({ ...s, dataUrl: await deps.blobToDataUrl(file, mime) });
    }

    const messages = buildVisionMessages(transcript, slidePayloads, activeHint);
    const { notes: rawNotes, costUsd } = await deps.generateStructuredNotes({ settings, messages });
    const notes = {
      ...rawNotes,
      slides,
      sttCostUsd: transcript.sttCostUsd || 0,
      llmCostUsd: Number(costUsd.toFixed(6)),
      totalCostUsd: Number(((transcript.sttCostUsd || 0) + costUsd).toFixed(6)),
      generatedAt: new Date().toISOString(),
    };
    await deps.writeLectureJson(lectureId, 'notes.json', notes);
    await deps.upsertLecture({ id: lectureId, status: 'ready', courseHint: activeHint, error: '' });
    return { transcript, notes, slides };
  } catch (err) {
    await deps.upsertLecture({ id: lectureId, status: 'error', error: err?.message || String(err) });
    throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS (all tests including `tests/pipeline.test.js`).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/ai-client.js src/dashboard/pipeline.js tests/pipeline.test.js
git commit -m "feat: add OpenRouter/local AI client, retry logic, and checkpointed pipeline"
```

---

### Task 8: Study Dashboard UI, Video Player, Exam Radar, Notion Export & Settings Modal

**Files:**
- Create: `src/dashboard/dashboard.html`
- Create: `src/dashboard/dashboard.css`
- Create: `src/dashboard/dashboard.js`

**Interfaces:**
- Consumes: `formatTimestamp`, `toSafeFilename` from `src/shared/sanitize.js`; `getLecture`, `getSettings`, `listLectures`, `recoverStaleRecordings`, `saveSettings`, `upsertLecture`, `deleteLectureMeta` from `src/shared/storage.js`; `deleteLectureDir`, `freeLectureMedia`, `getLectureMediaBytes`, `listDirFiles`, `readLectureFile`, `readLectureJson`, `writeLectureFile` from `src/shared/opfs.js`; `notesToNotionMarkdown` from `src/shared/notion.js`; `buildStoreZip` from `src/shared/zip.js`; `captureCurrentVideoFrame` from `src/dashboard/slides.js`; `runLecturePipeline` from `src/dashboard/pipeline.js`.

- [ ] **Step 1: Create `src/dashboard/dashboard.html` and `src/dashboard/dashboard.css`**

Write `src/dashboard/dashboard.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MyTems — Saved Lectures</title>
    <link rel="stylesheet" href="./dashboard.css" />
  </head>
  <body>
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-head">
          <h1>MyTems</h1>
          <button id="openSettingsBtn" class="ghost-btn" title="Settings">⚙ Settings</button>
        </div>
        <input id="lectureFilter" class="search-input" type="search" placeholder="Filter lectures..." />
        <ul id="lectureList" class="lecture-list"></ul>
      </aside>

      <main id="detailPane" class="detail-pane">
        <div id="emptyState" class="empty-state">
          <h2>Select a lecture</h2>
          <p>Record a Teams lecture from the toolbar, then transcribe and summarize on demand.</p>
        </div>

        <section id="lectureView" class="lecture-view" hidden>
          <header class="lecture-header">
            <div>
              <h2 id="lecTitle"></h2>
              <p id="lecMeta" class="muted"></p>
            </div>
            <div class="actions">
              <button id="downloadVideoBtn" class="ghost-btn">Download Video</button>
              <button id="freeMediaBtn" class="ghost-btn">Free Media Space</button>
              <button id="deleteLectureBtn" class="danger-btn">Delete</button>
            </div>
          </header>

          <div class="controls-bar">
            <input id="lecCourseHint" type="text" placeholder="Course hint (optional, improves RO+EN terms)" />
            <button id="summarizeBtn" class="primary-btn">Transcribe & Summarize</button>
            <button id="copyNotionBtn" class="ghost-btn" disabled>Copy Notion MD</button>
            <button id="zipNotionBtn" class="ghost-btn" disabled>Export Notion .zip</button>
          </div>
          <p id="statusBanner" class="status-banner" hidden></p>

          <div class="player-wrap">
            <video id="videoPlayer" controls></video>
            <div id="mediaFreedNote" class="media-freed" hidden>Raw video/audio freed — notes, transcript, and slides remain saved locally.</div>
            <div class="actions">
              <button id="snapSlideBtn" class="ghost-btn" hidden>Snap Slide at Current Time</button>
              <button id="attachImagesBtn" class="ghost-btn">Attach Whiteboard / Slide Image</button>
              <input id="attachImagesInput" type="file" accept="image/*" multiple hidden />
            </div>
          </div>

          <section id="radarCard" class="radar-card" hidden>
            <h3>Exam & Deadline Radar</h3>
            <ul id="radarList"></ul>
          </section>

          <section id="slidesStrip" class="slides-strip" hidden>
            <h3>Extracted Slides</h3>
            <div id="slidesGrid" class="slides-grid"></div>
          </section>

          <section id="notesSection" class="notes-section" hidden>
            <div class="notes-head">
              <h3>Study Notes</h3>
              <span id="costReceipt" class="cost-pill"></span>
            </div>
            <p id="notesSummary"></p>
            <div id="chaptersContainer"></div>
            <div id="definitionsContainer"></div>
          </section>

          <section id="transcriptSection" class="transcript-section" hidden>
            <div class="notes-head">
              <h3>Transcript</h3>
              <input id="transcriptSearch" type="search" placeholder="Search transcript..." />
            </div>
            <div id="transcriptLines" class="transcript-lines"></div>
          </section>
        </section>
      </main>
    </div>

    <dialog id="settingsModal" class="modal">
      <form id="settingsForm" method="dialog" class="modal-card">
        <header class="modal-head">
          <h2>Settings</h2>
          <button type="button" id="closeSettingsBtn" class="ghost-btn">✕</button>
        </header>

        <div class="segmented" role="group" aria-label="AI Provider Mode">
          <button type="button" data-mode="cloud" class="seg-btn active">Cloud (OpenRouter)</button>
          <button type="button" data-mode="local" class="seg-btn">Local Endpoint</button>
        </div>

        <div id="cloudFields" class="field-group">
          <label>OpenRouter API Key <input name="openrouterApiKey" type="password" placeholder="sk-or-v1-..." /></label>
          <label>STT Model <input name="sttModel" type="text" /></label>
          <label>Vision / Summary Model <input name="llmModel" type="text" /></label>
        </div>

        <div id="localFields" class="field-group" hidden>
          <label>Local STT URL <input name="localSttUrl" type="url" /></label>
          <label>Local STT Model <input name="localSttModel" type="text" /></label>
          <label>Local LLM URL <input name="localLlmUrl" type="url" /></label>
          <label>Local Vision/LLM Model <input name="localLlmModel" type="text" /></label>
        </div>

        <label>Default Course Hint <input name="defaultCourseHint" type="text" placeholder="e.g. Algorithms" /></label>
        <p class="muted small">Language detection and note output language are automatic (RO/EN).</p>

        <footer class="modal-foot">
          <button type="submit" class="primary-btn">Save Settings</button>
        </footer>
      </form>
    </dialog>

    <script type="module" src="./dashboard.js"></script>
  </body>
</html>
```

Write `src/dashboard/dashboard.css`:

```css
:root {
  color-scheme: light dark;
  --bg: #0c0e14;
  --panel: #151822;
  --card: #1c2030;
  --border: #2b3144;
  --text: #f3f4f6;
  --muted: #9ca3af;
  --accent: #6366f1;
  --danger: #dc2626;
  --radar: #f59e0b;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f1f5f9;
    --panel: #ffffff;
    --card: #f8fafc;
    --border: #cbd5e1;
    --text: #0f172a;
    --muted: #64748b;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
.app-shell { display: grid; grid-template-columns: 300px 1fr; min-height: 100vh; }
.sidebar { background: var(--panel); border-right: 1px solid var(--border); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.sidebar-head { display: flex; justify-content: space-between; align-items: center; }
.sidebar-head h1 { margin: 0; font-size: 18px; }
input { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text); }
.lecture-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
.lecture-item { padding: 10px; border: 1px solid var(--border); border-radius: 10px; cursor: pointer; background: var(--card); }
.lecture-item.active { border-color: var(--accent); }
.detail-pane { padding: 24px; max-width: 1040px; }
.lecture-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.lecture-header h2 { margin: 0; }
.muted { color: var(--muted); margin: 4px 0 0; }
.small { font-size: 12px; }
.actions, .controls-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
.controls-bar input { flex: 1; min-width: 220px; }
button { font: inherit; cursor: pointer; border-radius: 8px; padding: 8px 12px; }
.primary-btn { background: var(--accent); color: #fff; border: none; font-weight: 600; }
.ghost-btn { background: transparent; border: 1px solid var(--border); color: var(--text); }
.danger-btn { background: transparent; border: 1px solid var(--danger); color: #f87171; }
button:disabled { opacity: 0.45; cursor: not-allowed; }
.status-banner { padding: 10px 12px; border-radius: 8px; background: var(--card); border: 1px solid var(--border); }
.player-wrap { margin-top: 16px; display: flex; flex-direction: column; gap: 8px; }
video { width: 100%; max-height: 440px; border-radius: 12px; background: #000; }
.media-freed { padding: 14px; border-radius: 10px; border: 1px dashed var(--border); color: var(--muted); }
.radar-card { margin-top: 18px; padding: 14px; border-radius: 12px; border: 1px solid var(--radar); background: rgba(245, 158, 11, 0.08); }
.radar-card h3 { margin: 0 0 8px; }
.slides-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
.slide-thumb { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; cursor: pointer; background: var(--card); padding: 0; color: inherit; text-align: left; }
.slide-thumb img { width: 100%; display: block; aspect-ratio: 16 / 9; object-fit: cover; }
.slide-thumb span { display: block; padding: 4px 8px; font-size: 12px; color: var(--muted); }
.notes-section, .transcript-section, .slides-strip { margin-top: 22px; }
.notes-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.cost-pill { font-size: 12px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
.ts-link { background: rgba(99, 102, 241, 0.16); color: #a5b4fc; border: none; padding: 2px 6px; border-radius: 6px; font-size: 12px; }
.transcript-lines { max-height: 360px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.modal { border: none; padding: 0; border-radius: 16px; background: var(--panel); color: var(--text); width: min(480px, 92vw); box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45); }
.modal::backdrop { background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px); }
.modal-card { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.modal-head, .modal-foot { display: flex; justify-content: space-between; align-items: center; }
.modal-head h2 { margin: 0; font-size: 18px; }
.segmented { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 4px; background: var(--card); border-radius: 10px; border: 1px solid var(--border); }
.seg-btn { border: none; background: transparent; color: var(--muted); padding: 8px; border-radius: 7px; }
.seg-btn.active { background: var(--accent); color: #fff; font-weight: 600; }
.field-group { display: flex; flex-direction: column; gap: 10px; }
.field-group[hidden] { display: none; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
```

- [ ] **Step 2: Create `src/dashboard/dashboard.js`**

Write `src/dashboard/dashboard.js`:

```js
import { formatTimestamp, toSafeFilename } from '../shared/sanitize.js';
import {
  deleteLectureMeta,
  getLecture,
  getSettings,
  listLectures,
  recoverStaleRecordings,
  saveSettings,
} from '../shared/storage.js';
import {
  deleteLectureDir,
  freeLectureMedia,
  getLectureMediaBytes,
  listDirFiles,
  readLectureFile,
  readLectureJson,
  writeLectureFile,
} from '../shared/opfs.js';
import { notesToNotionMarkdown } from '../shared/notion.js';
import { buildStoreZip } from '../shared/zip.js';
import { captureCurrentVideoFrame } from './slides.js';
import { runLecturePipeline } from './pipeline.js';

const el = (id) => document.getElementById(id);
let selectedId = null;
let currentVideoUrl = null;
let slideUrls = [];
let currentNotes = null;
let currentTranscript = null;

function revokeObjectUrls() {
  if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
  currentVideoUrl = null;
  for (const u of slideUrls) URL.revokeObjectURL(u);
  slideUrls = [];
}

function seekTo(sec) {
  const player = el('videoPlayer');
  if (!player.hidden && player.src) {
    player.currentTime = Math.max(0, sec);
    player.play().catch(() => {});
  }
}

function makeTimestampBtn(sec) {
  const btn = document.createElement('button');
  btn.className = 'ts-link';
  btn.textContent = formatTimestamp(sec);
  btn.addEventListener('click', () => seekTo(sec));
  return btn;
}

async function renderLectureList() {
  const filter = el('lectureFilter').value.trim().toLowerCase();
  const lectures = (await listLectures()).filter((l) => l.title.toLowerCase().includes(filter));
  const listEl = el('lectureList');
  listEl.innerHTML = '';

  for (const lec of lectures) {
    const li = document.createElement('li');
    li.className = `lecture-item${lec.id === selectedId ? ' active' : ''}`;
    li.innerHTML = `<strong>${lec.title}</strong><div class="muted small">${lec.createdAt.slice(0, 10)} · ${formatTimestamp(lec.durationSec)} · ${lec.status}</div>`;
    li.addEventListener('click', () => selectLecture(lec.id));
    listEl.appendChild(li);
  }
}

function renderTranscript(query = '') {
  const container = el('transcriptLines');
  container.innerHTML = '';
  if (!currentTranscript?.segments?.length) {
    el('transcriptSection').hidden = true;
    return;
  }
  el('transcriptSection').hidden = false;
  const q = query.trim().toLowerCase();
  for (const seg of currentTranscript.segments) {
    if (q && !seg.text.toLowerCase().includes(q)) continue;
    const row = document.createElement('div');
    row.append(makeTimestampBtn(seg.startSec), document.createTextNode(` ${seg.text}`));
    container.appendChild(row);
  }
}

async function renderSlides(lectureId) {
  const files = await listDirFiles(lectureId, 'slides');
  const grid = el('slidesGrid');
  grid.innerHTML = '';
  el('slidesStrip').hidden = files.length === 0;
  for (const f of files) {
    const file = await readLectureFile(lectureId, `slides/${f}`);
    const url = URL.createObjectURL(file);
    slideUrls.push(url);
    const sec = Number(f.split('_')[1]?.split('.')[0] || 0);
    const btn = document.createElement('button');
    btn.className = 'slide-thumb';
    btn.innerHTML = `<img src="${url}" alt="Slide at ${formatTimestamp(sec)}" /><span>${formatTimestamp(sec)}</span>`;
    btn.addEventListener('click', () => seekTo(sec));
    grid.appendChild(btn);
  }
  return files;
}

function renderNotes(notes) {
  currentNotes = notes;
  const hasNotes = Boolean(notes);
  el('copyNotionBtn').disabled = !hasNotes;
  el('zipNotionBtn').disabled = !hasNotes;
  el('notesSection').hidden = !hasNotes;
  el('radarCard').hidden = !(notes?.examRadar?.length);
  if (!hasNotes) return;

  el('costReceipt').textContent = `Cost: $${(notes.totalCostUsd || 0).toFixed(4)} (STT $${(notes.sttCostUsd || 0).toFixed(4)} + LLM $${(notes.llmCostUsd || 0).toFixed(4)})`;
  el('notesSummary').textContent = notes.summary;

  const radarList = el('radarList');
  radarList.innerHTML = '';
  for (const item of notes.examRadar || []) {
    const li = document.createElement('li');
    const due = item.dueDate ? ` (Due: ${item.dueDate})` : '';
    li.append(
      document.createTextNode(`[${String(item.type).toUpperCase()}] ${item.text}${due} `),
      makeTimestampBtn(item.timestampSec)
    );
    radarList.appendChild(li);
  }

  const chaptersEl = el('chaptersContainer');
  chaptersEl.innerHTML = '';
  for (const ch of notes.chapters || []) {
    const sec = document.createElement('article');
    const h4 = document.createElement('h4');
    h4.append(document.createTextNode(`${ch.title} `), makeTimestampBtn(ch.startSec));
    const ul = document.createElement('ul');
    for (const b of ch.bullets || []) {
      const li = document.createElement('li');
      li.textContent = b;
      ul.appendChild(li);
    }
    for (const f of ch.formulas || []) {
      const li = document.createElement('li');
      li.innerHTML = `<code>${f}</code>`;
      ul.appendChild(li);
    }
    sec.append(h4, ul);
    chaptersEl.appendChild(sec);
  }

  const defsEl = el('definitionsContainer');
  defsEl.innerHTML = notes.definitions?.length ? '<h4>Definitions</h4>' : '';
  for (const d of notes.definitions || []) {
    const p = document.createElement('p');
    p.append(document.createTextNode(`${d.term}: ${d.definition} `), makeTimestampBtn(d.timestampSec));
    defsEl.appendChild(p);
  }
}

async function selectLecture(id) {
  selectedId = id;
  revokeObjectUrls();
  await renderLectureList();

  const lec = await getLecture(id);
  if (!lec) {
    el('emptyState').hidden = false;
    el('lectureView').hidden = true;
    return;
  }

  el('emptyState').hidden = true;
  el('lectureView').hidden = false;
  el('lecTitle').textContent = lec.title;
  el('lecCourseHint').value = lec.courseHint || '';
  const bytes = await getLectureMediaBytes(id);
  el('lecMeta').textContent = `${lec.createdAt.slice(0, 10)} · ${formatTimestamp(lec.durationSec)} · ${(bytes / 1048576).toFixed(1)} MB · ${lec.status}`;
  el('statusBanner').hidden = !lec.error;
  el('statusBanner').textContent = lec.error || '';

  const player = el('videoPlayer');
  try {
    const videoFile = await readLectureFile(id, 'video.webm');
    currentVideoUrl = URL.createObjectURL(videoFile);
    player.src = currentVideoUrl;
    player.hidden = false;
    el('mediaFreedNote').hidden = true;
    el('snapSlideBtn').hidden = false;
    el('downloadVideoBtn').disabled = false;
  } catch {
    player.hidden = true;
    player.removeAttribute('src');
    el('mediaFreedNote').hidden = false;
    el('snapSlideBtn').hidden = true;
    el('downloadVideoBtn').disabled = true;
  }

  currentTranscript = await readLectureJson(id, 'transcript.json');
  renderTranscript(el('transcriptSearch').value);
  await renderSlides(id);
  renderNotes(await readLectureJson(id, 'notes.json'));
}

el('summarizeBtn').addEventListener('click', async () => {
  if (!selectedId) return;
  el('summarizeBtn').disabled = true;
  el('statusBanner').hidden = false;
  try {
    await runLecturePipeline({
      lectureId: selectedId,
      courseHint: el('lecCourseHint').value,
      onStage: (msg) => { el('statusBanner').textContent = msg; },
    });
    await selectLecture(selectedId);
  } catch (err) {
    el('statusBanner').textContent = err?.message || String(err);
  } finally {
    el('summarizeBtn').disabled = false;
  }
});

el('snapSlideBtn').addEventListener('click', async () => {
  if (!selectedId) return;
  const player = el('videoPlayer');
  await captureCurrentVideoFrame(player, selectedId, player.currentTime);
  revokeObjectUrls();
  await selectLecture(selectedId);
});

el('attachImagesBtn').addEventListener('click', () => el('attachImagesInput').click());
el('attachImagesInput').addEventListener('change', async (e) => {
  if (!selectedId || !e.target.files?.length) return;
  const existing = await listDirFiles(selectedId, 'slides');
  let nextNum = existing.length + 1;
  const sec = Math.max(0, Math.floor(el('videoPlayer').currentTime || 0));
  for (const file of e.target.files) {
    const ext = file.name.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
    const filename = `${String(nextNum++).padStart(3, '0')}_${sec}.${ext}`;
    await writeLectureFile(selectedId, `slides/${filename}`, new Uint8Array(await file.arrayBuffer()));
  }
  e.target.value = '';
  revokeObjectUrls();
  await selectLecture(selectedId);
});

el('downloadVideoBtn').addEventListener('click', async () => {
  if (!selectedId) return;
  const [lec, file] = await Promise.all([getLecture(selectedId), readLectureFile(selectedId, 'video.webm')]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = `${lec.createdAt.slice(0, 10)}_${toSafeFilename(lec.title)}.webm`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

el('freeMediaBtn').addEventListener('click', async () => {
  if (!selectedId) return;
  await freeLectureMedia(selectedId);
  await selectLecture(selectedId);
});

el('deleteLectureBtn').addEventListener('click', async () => {
  if (!selectedId) return;
  await deleteLectureDir(selectedId);
  await deleteLectureMeta(selectedId);
  selectedId = null;
  el('emptyState').hidden = false;
  el('lectureView').hidden = true;
  await renderLectureList();
});

el('copyNotionBtn').addEventListener('click', async () => {
  if (!selectedId || !currentNotes) return;
  const [lec, slides] = await Promise.all([getLecture(selectedId), listDirFiles(selectedId, 'slides')]);
  await navigator.clipboard.writeText(notesToNotionMarkdown(lec, currentNotes, slides));
  el('statusBanner').hidden = false;
  el('statusBanner').textContent = 'Copied Notion-ready Markdown to clipboard.';
});

el('zipNotionBtn').addEventListener('click', async () => {
  if (!selectedId || !currentNotes) return;
  const [lec, slideFiles] = await Promise.all([getLecture(selectedId), listDirFiles(selectedId, 'slides')]);
  const md = notesToNotionMarkdown(lec, currentNotes, slideFiles);
  const entries = [{ name: 'notes.md', data: new TextEncoder().encode(md) }];
  for (const f of slideFiles) {
    const file = await readLectureFile(selectedId, `slides/${f}`);
    entries.push({ name: `slides/${f}`, data: new Uint8Array(await file.arrayBuffer()) });
  }
  const zipBytes = buildStoreZip(entries);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([zipBytes], { type: 'application/zip' }));
  a.download = `${lec.createdAt.slice(0, 10)}_${toSafeFilename(lec.title)}_notion.zip`;
  a.click();
});

el('lectureFilter').addEventListener('input', renderLectureList);
el('transcriptSearch').addEventListener('input', (e) => renderTranscript(e.target.value));

// Settings Modal
const modal = el('settingsModal');
const form = el('settingsForm');
let modalMode = 'cloud';

function syncModeUI(mode) {
  modalMode = mode;
  el('cloudFields').hidden = mode !== 'cloud';
  el('localFields').hidden = mode !== 'local';
  for (const btn of form.querySelectorAll('.seg-btn')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
}

async function openSettingsModal() {
  const s = await getSettings();
  for (const name of ['openrouterApiKey', 'sttModel', 'llmModel', 'localSttUrl', 'localSttModel', 'localLlmUrl', 'localLlmModel', 'defaultCourseHint']) {
    form.elements[name].value = s[name] || '';
  }
  syncModeUI(s.providerMode);
  modal.showModal();
}

for (const btn of form.querySelectorAll('.seg-btn')) {
  btn.addEventListener('click', () => syncModeUI(btn.dataset.mode));
}
el('openSettingsBtn').addEventListener('click', openSettingsModal);
el('closeSettingsBtn').addEventListener('click', () => modal.close());
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = { providerMode: modalMode };
  for (const name of ['openrouterApiKey', 'sttModel', 'llmModel', 'localSttUrl', 'localSttModel', 'localLlmUrl', 'localLlmModel', 'defaultCourseHint']) {
    patch[name] = form.elements[name].value.trim();
  }
  await saveSettings(patch);
  modal.close();
});

async function init() {
  await recoverStaleRecordings(null);
  await renderLectureList();
  const list = await listLectures();
  if (list.length) await selectLecture(list[0].id);
  if (location.hash === '#settings') await openSettingsModal();
}

init();
```

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/dashboard.html src/dashboard/dashboard.css src/dashboard/dashboard.js
git commit -m "feat: add study dashboard, Exam Radar, Notion export, and Settings modal"
```

---

### Task 9: Manifest Validation, Automated Suite & Helium E2E Verification

**Files:**
- Test: `tests/manifest.test.js`

- [ ] **Step 1: Add `tests/manifest.test.js` verifying `manifest.json` integrity and referenced file existence**

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('manifest.json integrity', () => {
  it('references existing files and obeys global MV3 constraints', () => {
    const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.options_page, undefined);
    assert.ok(!manifest.permissions.includes('identity'));
    assert.ok(fs.existsSync(manifest.background.service_worker));
    assert.ok(fs.existsSync(manifest.action.default_popup));
    for (const p of Object.values(manifest.icons)) {
      assert.ok(fs.existsSync(p), `Missing icon: ${p}`);
    }
  });
});
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: PASS (all tests across `sanitize`, `zip`, `notion`, `storage`, `recorder-segments`, `slides`, `pipeline`, `manifest`).

- [ ] **Step 3: Manual Helium E2E verification checklist**

1. Open Helium -> `chrome://extensions` -> enable **Developer mode** -> **Load unpacked** -> select `/Users/lightandy/Documents/Projects/MyTems`.
2. Join a Microsoft Teams meeting tab (or play a test video tab with audio). Click **MyTems** toolbar icon -> verify sanitized tab title appears -> click **Start Recording**. Confirm `REC` badge shows and tab audio remains audible.
3. Wait 15s (or switch browser tabs / scroll slides), click **Stop Recording** -> open **Saved Lectures**.
4. Verify `<video>` plays smoothly in `dashboard.html` and disk usage matches ~140–180 MB/2h pace.
5. Click gear **⚙ Settings** -> confirm modal opens (also test `dashboard.html#settings`) -> enter OpenRouter key -> **Save Settings**.
6. Click **Transcribe & Summarize** -> confirm `transcript.json`, `slides/*.jpg`, **Exam & Deadline Radar**, **Study Notes**, and **Cost Receipt** populate automatically in the lecture's spoken language.
7. Click timestamps & slide thumbnails -> confirm `<video>` seeks to exact second.
8. Click **Copy Notion MD** and **Export Notion .zip** -> verify Notion markdown includes Exam Radar, chapters, and slide links.
9. Click **Free Media Space** -> confirm video/audio deleted and notes + slides remain intact.

- [ ] **Step 4: Commit**

```bash
git add tests/manifest.test.js
git commit -m "test: verify MV3 manifest integrity and referenced extension assets"
```

---

## Plan Self-Review

1. **Spec coverage:**
   - MV3 Helium extension (`manifest.json`, zero bundler, icons, permissions): Task 1, Task 9.
   - Tab capture + pass-through + low-fps `VP9` + rolling 10-min `16 kbps` `Opus` + `SyncAccessHandle` worker + crash recovery: Task 3, Task 4.
   - Tab-title filename sanitization: Task 1, Task 5, Task 8.
   - OPFS cleanup (`Download Video`, `Free Media Space`, `Delete Lecture`): Task 3, Task 8.
   - On-demand `<video>` frame-diff slides + manual `Snap Slide`: Task 6, Task 8.
   - OpenRouter + primitive Local HTTP toggle + 3x retry + `transcript.json` checkpoint + auto RO/EN language + Exam Radar + cost receipt: Task 7.
   - Settings `<dialog>` modal (no `options.html`), Study Dashboard, Notion `.md` copy & `.zip` export strictly post-AI: Task 2, Task 8.
2. **Placeholder scan:** No `TBD`, `TODO`, or omitted implementations; every code step includes runnable source and tests.
3. **Type consistency:** All function names and signatures match across `Interfaces` blocks and implementations (`deriveLectureTitle`, `toSafeFilename`, `formatTimestamp`, `createLectureId`, `buildStoreZip`, `notesToNotionMarkdown`, `createStorage`, `extractSlidesFromVideo`, `captureCurrentVideoFrame`, `runLecturePipeline`, `parseNotesJson`, `mergeTranscriptSegments`).
