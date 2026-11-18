# Lecture Groups, Collision-Free Naming, Batch Actions & Connected Lesson AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate `(1)/(2)` download collisions with local timestamped part filenames, organize recordings into a `Subject → Lesson (Day) → Parts` hierarchy with quick downloads and multi-select batch actions, and add connected multi-part transcription + unified Lesson AI notes.

**Architecture:** Keep `mytems_lectures` flat in `chrome.storage.local` with optional `subject`, `lessonId`, and `lessonTitle` fields, computing the 2-level library tree purely in `src/shared/grouping.js`. Store multi-part unified notes in OPFS under `lessons/<safeKey>/notes.json` while keeping per-part media, slides, and `transcript.json` under `lectures/<id>/`. Extend `pipeline.js` and `dashboard.js` so multi-part Lessons run cross-part STT continuity, unified LLM synthesis (with optional prior-day Subject summary), part-switching video cues (`[Pt 2 · 14:20]`), and sequential direct downloads/batch actions.

**Tech Stack:** Zero-bundler Chromium MV3 (native ES modules, HTML, CSS), OPFS, `chrome.storage.local`, `bun test` (`node:test` + `node:assert/strict`).

**Spec:** [2026-11-17-lecture-groups-naming-and-lesson-ai-design.md](file:///Users/lightandy/Documents/Projects/MyTems/docs/superpowers/specs/2026-11-17-lecture-groups-naming-and-lesson-ai-design.md)

## Global Constraints

- Zero-bundler Chromium Manifest V3 extension (native ES modules, HTML, CSS, Node/Bun tests, zero runtime dependencies).
- Keep `manifest.json` permissions unchanged (no `"downloads"` permission; use sequential `<a download>` blob downloads).
- Strictly omit `language` on all STT requests so RO/EN auto-detection stays intact.
- Preserve backwards compatibility for existing solo `lectures/<id>/notes.json` and `notesToNotionMarkdown(lecture, notes, string[])` callers.
- Follow `DESIGN.md` tokens (`--rail`, `--surface`, `--border`, `--accent`, `--radar-*`, `tabular-nums`, `150ms ease`).

---

## File Map

| File | Responsibility |
|---|---|
| `src/shared/sanitize.js` | Romanian transliteration in `toSafeFilename`, local date/time formatting, `buildDownloadFilename`, `buildTranscriptTailPrompt` |
| `src/shared/grouping.js` | Pure `Subject → Lesson → Parts` tree derivation, subject/lesson resolution, part indexing |
| `src/shared/storage.js` | Batch `updateLectures(ids, patchOrFn)` inside serialized `enqueueWrite` |
| `src/shared/opfs.js` | `readLessonJson`, `writeLessonJson`, `deleteLessonDir` under `lessons/<safeKey>/` |
| `src/shared/notion.js` | Multi-part cue formatting (`Pt k · MM:SS`) and `slides/ptk_<file>` links while keeping solo signature intact |
| `src/dashboard/ai-client.js` | Optional `prompt` forwarding in `transcribeAudioSegment` + optional `partIndex` normalization in `parseNotesJson` |
| `src/dashboard/pipeline.js` | Cross-part STT prompt chaining, `runLessonTranscription`, `buildLessonVisionMessages`, `runLessonPipeline` |
| `src/dashboard/dashboard.html` | Rail `Select` toggle + sticky batch bar, direct `Download .webm` button, part-switcher strip, move/group dialog |
| `src/dashboard/dashboard.css` | Collapsible Subject/Lesson rail styling, hover quick-download buttons, checkbox/batch bar, part-switcher pills |
| `src/dashboard/dashboard.js` | Tree rendering, quick/sequential downloads, multi-select batch actions, Lesson view & cross-part `[Pt k · MM:SS]` seeking |
| `tests/sanitize.test.js` | Tests for transliteration, local filename builder, `_ptN` suffixes, prompt tail helper |
| `tests/grouping.test.js` | Tests for auto-grouping, standalone ungrouping, manual lessons, subject resolution, chronological part ordering |
| `tests/storage.test.js` | Tests for `updateLectures` concurrency + OPFS `lessons/` JSON helpers |
| `tests/notion.test.js` | Tests for multi-part Lesson Markdown formatting & slide paths |
| `tests/pipeline.test.js` | Tests for STT `prompt` propagation, cross-part `runLessonTranscription`, `runLessonPipeline` + prior-day context |

---

### Task 1: Collision-Free File Naming & Prompt Tail Helpers

**Files:**
- Modify: `src/shared/sanitize.js:1-32`
- Test: `tests/sanitize.test.js:1-38`

**Interfaces:**
- Produces:
  - `toSafeFilename(title): string` (transliterates Romanian diacritics before sanitizing)
  - `formatLocalDateTimeParts(dateInput): { date: string, time: string, displayTime: string }`
  - `buildDownloadFilename(lecture, opts?: { partIndex?: number, totalParts?: number, kind?: 'video'|'notion-zip'|'lesson-zip', lessonTitle?: string }): string`
  - `buildTranscriptTailPrompt(text, maxChars?: number): string`

- [ ] **Step 1: Write failing tests in `tests/sanitize.test.js`**

Add the following imports and tests to `tests/sanitize.test.js`:

```js
import {
  deriveLectureTitle,
  toSafeFilename,
  formatTimestamp,
  createLectureId,
  formatLocalDateTimeParts,
  buildDownloadFilename,
  buildTranscriptTailPrompt,
} from '../src/shared/sanitize.js';

  it('transliterates Romanian diacritics in safe filenames', () => {
    assert.equal(
      toSafeFilename('Logică Matematică — Curs 3 (Ședință)'),
      'Logica_Matematica_Curs_3_Sedinta'
    );
  });

  it('formats local date/time parts and builds collision-free filenames', () => {
    const dt = new Date(2026, 10, 17, 14, 5, 0); // local 2026-11-17 14:05
    const parts = formatLocalDateTimeParts(dt);
    assert.deepEqual(parts, { date: '2026-11-17', time: '14-05', displayTime: '14:05' });

    const lec = { title: 'Mathematical Logic', createdAt: dt.toISOString(), startedAtMs: dt.getTime() };
    assert.equal(
      buildDownloadFilename(lec, { partIndex: 1, totalParts: 1, kind: 'video' }),
      '2026-11-17_14-05_Mathematical_Logic.webm'
    );
    assert.equal(
      buildDownloadFilename(lec, { partIndex: 2, totalParts: 3, kind: 'video' }),
      '2026-11-17_14-05_Mathematical_Logic_pt2.webm'
    );
    assert.equal(
      buildDownloadFilename(lec, { partIndex: 2, totalParts: 3, kind: 'notion-zip' }),
      '2026-11-17_14-05_Mathematical_Logic_pt2_notion.zip'
    );
    assert.equal(
      buildDownloadFilename(lec, { kind: 'lesson-zip', lessonTitle: 'Mathematical Logic' }),
      '2026-11-17_Mathematical_Logic_lesson_notion.zip'
    );
  });

  it('extracts trimmed tail prompt bounded by maxChars at word boundary', () => {
    assert.equal(buildTranscriptTailPrompt('   '), '');
    const longText = 'alpha beta gamma delta epsilon zeta';
    const tail = buildTranscriptTailPrompt(longText, 18);
    assert.ok(tail.length <= 18);
    assert.equal(tail, 'delta epsilon zeta');
  });
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/sanitize.test.js`
Expected: FAIL (`formatLocalDateTimeParts`, `buildDownloadFilename`, `buildTranscriptTailPrompt` not exported / diacritic test fails).

- [ ] **Step 3: Implement helpers in `src/shared/sanitize.js`**

Update `src/shared/sanitize.js`:

```js
const RO_MAP = {
  ă: 'a', â: 'a', î: 'i', ș: 's', ş: 's', ț: 't', ţ: 't',
  Ă: 'A', Â: 'A', Î: 'I', Ș: 'S', Ş: 'S', Ț: 'T', Ţ: 'T',
};

export function deriveLectureTitle(tabTitle) {
  const cleaned = String(tabTitle || '')
    .replace(/\s*\|\s*Microsoft Teams\s*$/i, '')
    .replace(/^\(\d+\)\s*/, '')
    .trim();
  return cleaned || 'Teams Lecture';
}

export function toSafeFilename(title) {
  const transliterated = String(title || '').replace(/[ăâîșşțţĂÂÎȘŞȚŢ]/g, (ch) => RO_MAP[ch] || ch);
  const safe = transliterated
    .replace(/[^a-zA-Z0-9+._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return safe || 'Teams_Lecture';
}

export function formatLocalDateTimeParts(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput || Date.now());
  const valid = Number.isFinite(d.getTime()) ? d : new Date(0);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${valid.getFullYear()}-${pad(valid.getMonth() + 1)}-${pad(valid.getDate())}`;
  const hh = pad(valid.getHours());
  const mm = pad(valid.getMinutes());
  return { date, time: `${hh}-${mm}`, displayTime: `${hh}:${mm}` };
}

export function buildDownloadFilename(
  lecture,
  { partIndex = 1, totalParts = 1, kind = 'video', lessonTitle = '' } = {}
) {
  const lec = lecture || {};
  const { date, time } = formatLocalDateTimeParts(lec.startedAtMs || lec.createdAt);
  if (kind === 'lesson-zip') {
    const safeLesson = toSafeFilename(lessonTitle || lec.lessonTitle || lec.subject || lec.title);
    return `${date}_${safeLesson}_lesson_notion.zip`;
  }
  const safeTitle = toSafeFilename(lec.title);
  const partSuffix = totalParts > 1 ? `_pt${partIndex}` : '';
  const ext = kind === 'notion-zip' ? '_notion.zip' : '.webm';
  return `${date}_${time}_${safeTitle}${partSuffix}${ext}`;
}

export function buildTranscriptTailPrompt(text, maxChars = 220) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!clean || clean.length <= maxChars) return clean;
  const slice = clean.slice(-maxChars);
  const spaceIdx = slice.indexOf(' ');
  return spaceIdx > 0 && spaceIdx < slice.length - 1 ? slice.slice(spaceIdx + 1) : slice;
}
```

Keep `formatTimestamp` and `createLectureId` unchanged below.

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/sanitize.test.js`
Expected: PASS (all tests in `tests/sanitize.test.js`).

- [ ] **Step 5: Commit**

```bash
git add src/shared/sanitize.js tests/sanitize.test.js
git commit -m "feat: add transliterated collision-free filenames and STT prompt helper"
```

---

### Task 2: Two-Level Grouping Engine (`Subject → Lesson → Parts`)

**Files:**
- Create: `src/shared/grouping.js`
- Create: `tests/grouping.test.js`

**Interfaces:**
- Consumes: `formatLocalDateTimeParts`, `toSafeFilename` from `./sanitize.js`
- Produces:
  - `STANDALONE_PREFIX = 'standalone:'`
  - `normalizeGroupKey(value): string`
  - `resolveLectureSubject(lecture): string`
  - `resolveLectureDate(lecture): string` (local `YYYY-MM-DD`)
  - `buildLibraryTree(lectures): { subjects: SubjectNode[], lessonsById: Map<string, LessonNode>, partMetaById: Map<string, { lessonId: string, subject: string, partIndex: number, totalParts: number, isGroup: boolean }> }`
  - `findPreviousSubjectLesson(tree, subject, currentLessonId): LessonNode | null`

- [ ] **Step 1: Write failing tests in `tests/grouping.test.js`**

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STANDALONE_PREFIX,
  resolveLectureSubject,
  buildLibraryTree,
  findPreviousSubjectLesson,
} from '../src/shared/grouping.js';

describe('Subject -> Lesson -> Parts grouping', () => {
  it('auto-groups same-day same-subject recordings chronologically and keeps singletons flat', () => {
    const t1 = new Date(2026, 10, 17, 10, 0, 0).getTime();
    const t2 = new Date(2026, 10, 17, 10, 40, 0).getTime();
    const t3 = new Date(2026, 10, 17, 11, 15, 0).getTime();
    const tOther = new Date(2026, 10, 16, 12, 0, 0).getTime();

    const lectures = [
      { id: 'p3', title: 'Mathematical Logic', createdAt: new Date(t3).toISOString(), startedAtMs: t3, durationSec: 600, status: 'recorded' },
      { id: 'p1', title: 'Mathematical Logic', createdAt: new Date(t1).toISOString(), startedAtMs: t1, durationSec: 1200, status: 'ready' },
      { id: 'p2', title: 'Mathematical Logic', createdAt: new Date(t2).toISOString(), startedAtMs: t2, durationSec: 900, status: 'transcribed' },
      { id: 'd1', title: 'Databases', createdAt: new Date(tOther).toISOString(), startedAtMs: tOther, durationSec: 1800, status: 'ready' },
    ];

    const tree = buildLibraryTree(lectures);
    assert.equal(tree.subjects.length, 2);
    assert.equal(tree.subjects[0].name, 'Mathematical Logic');
    assert.equal(tree.subjects[0].lessons.length, 1);

    const mathLesson = tree.subjects[0].lessons[0];
    assert.equal(mathLesson.isGroup, true);
    assert.deepEqual(mathLesson.parts.map((p) => p.id), ['p1', 'p2', 'p3']);
    assert.equal(mathLesson.totalDurationSec, 2700);

    assert.deepEqual(tree.partMetaById.get('p2'), {
      lessonId: mathLesson.lessonId,
      subject: 'Mathematical Logic',
      partIndex: 2,
      totalParts: 3,
      isGroup: true,
    });

    const dbLesson = tree.subjects[1].lessons[0];
    assert.equal(dbLesson.isGroup, false);
    assert.equal(tree.partMetaById.get('d1').totalParts, 1);
  });

  it('respects explicit standalone override, manual lessonId, and subject override', () => {
    const t1 = new Date(2026, 10, 17, 10, 0, 0).getTime();
    const t2 = new Date(2026, 10, 17, 11, 0, 0).getTime();
    const t3 = new Date(2026, 10, 18, 9, 0, 0).getTime();

    const lectures = [
      { id: 'a', title: 'Meeting', subject: 'Mathematical Logic', lessonId: 'manual-1', lessonTitle: 'Week 7 Logic', createdAt: new Date(t1).toISOString(), startedAtMs: t1 },
      { id: 'b', title: 'Meeting', subject: 'Mathematical Logic', lessonId: 'manual-1', createdAt: new Date(t3).toISOString(), startedAtMs: t3 },
      { id: 'c', title: 'Meeting', subject: 'Mathematical Logic', lessonId: `${STANDALONE_PREFIX}c`, createdAt: new Date(t2).toISOString(), startedAtMs: t2 },
    ];

    const tree = buildLibraryTree(lectures);
    assert.equal(tree.subjects.length, 1);
    assert.equal(tree.subjects[0].lessons.length, 2);
    const manual = tree.lessonsById.get('manual-1');
    assert.equal(manual.title, 'Week 7 Logic');
    assert.deepEqual(manual.parts.map((p) => p.id), ['a', 'b']);
    const standalone = tree.lessonsById.get(`${STANDALONE_PREFIX}c`);
    assert.equal(standalone.isGroup, false);
  });

  it('finds the most recent earlier lesson in the same subject', () => {
    const d1 = new Date(2026, 10, 10, 10, 0, 0).getTime();
    const d2 = new Date(2026, 10, 17, 10, 0, 0).getTime();
    const tree = buildLibraryTree([
      { id: 'old', title: 'Math Logic', subject: 'Math Logic', createdAt: new Date(d1).toISOString(), startedAtMs: d1 },
      { id: 'new1', title: 'Math Logic', subject: 'Math Logic', createdAt: new Date(d2).toISOString(), startedAtMs: d2 },
      { id: 'new2', title: 'Math Logic', subject: 'Math Logic', createdAt: new Date(d2 + 60000).toISOString(), startedAtMs: d2 + 60000 },
    ]);
    const todayId = tree.partMetaById.get('new1').lessonId;
    const prev = findPreviousSubjectLesson(tree, 'Math Logic', todayId);
    assert.equal(prev?.parts[0].id, 'old');
    assert.equal(findPreviousSubjectLesson(tree, 'Math Logic', prev.lessonId), null);
  });

  it('resolves subject from subject, then courseHint, then title', () => {
    assert.equal(resolveLectureSubject({ subject: 'Logic', courseHint: 'CS', title: 'Meet' }), 'Logic');
    assert.equal(resolveLectureSubject({ courseHint: 'CS', title: 'Meet' }), 'CS');
    assert.equal(resolveLectureSubject({ title: 'Meet' }), 'Meet');
    assert.equal(resolveLectureSubject({}), 'Teams Lecture');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/grouping.test.js`
Expected: FAIL (`Cannot find module '../src/shared/grouping.js'`).

- [ ] **Step 3: Implement `src/shared/grouping.js`**

```js
import { formatLocalDateTimeParts, toSafeFilename } from './sanitize.js';

export const STANDALONE_PREFIX = 'standalone:';

export function normalizeGroupKey(value) {
  return toSafeFilename(String(value || '').trim().toLowerCase()).toLowerCase();
}

export function resolveLectureSubject(lecture) {
  const s = String(lecture?.subject || lecture?.courseHint || lecture?.title || '').trim();
  return s || 'Teams Lecture';
}

export function resolveLectureDate(lecture) {
  return formatLocalDateTimeParts(lecture?.startedAtMs || lecture?.createdAt).date;
}

function lectureStartMs(lecture) {
  if (Number.isFinite(lecture?.startedAtMs)) return lecture.startedAtMs;
  const parsed = Date.parse(lecture?.createdAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveRawLessonKey(lecture, subject) {
  if (lecture?.lessonId) return String(lecture.lessonId);
  return `auto:${resolveLectureDate(lecture)}:${normalizeGroupKey(subject)}`;
}

export function buildLibraryTree(lectures = []) {
  const subjectBuckets = new Map();

  for (const lec of lectures) {
    const subject = resolveLectureSubject(lec);
    const subjKey = normalizeGroupKey(subject);
    if (!subjectBuckets.has(subjKey)) {
      subjectBuckets.set(subjKey, { name: subject, lessonsMap: new Map(), latestMs: 0 });
    }
    const subjBucket = subjectBuckets.get(subjKey);
    const ms = lectureStartMs(lec);
    if (ms > subjBucket.latestMs) {
      subjBucket.latestMs = ms;
      subjBucket.name = subject;
    }

    const lessonId = resolveRawLessonKey(lec, subject);
    if (!subjBucket.lessonsMap.has(lessonId)) {
      subjBucket.lessonsMap.set(lessonId, []);
    }
    subjBucket.lessonsMap.get(lessonId).push(lec);
  }

  const lessonsById = new Map();
  const partMetaById = new Map();

  const subjects = [...subjectBuckets.values()]
    .sort((a, b) => b.latestMs - a.latestMs)
    .map((subj) => {
      const lessons = [...subj.lessonsMap.entries()]
        .map(([lessonId, rawParts]) => {
          const parts = [...rawParts].sort((a, b) => lectureStartMs(a) - lectureStartMs(b));
          const latestMs = parts.reduce((max, p) => Math.max(max, lectureStartMs(p)), 0);
          const first = parts[0];
          const date = resolveLectureDate(first);
          const customTitle = parts.find((p) => p.lessonTitle?.trim())?.lessonTitle?.trim();
          const isGroup = parts.length > 1 || (!lessonId.startsWith('auto:') && !lessonId.startsWith(STANDALONE_PREFIX));
          const defaultTitle = isGroup ? `${date} · ${first.title || subj.name}` : (first.title || subj.name);
          const title = customTitle || defaultTitle;
          const totalDurationSec = parts.reduce((sum, p) => sum + Number(p.durationSec || 0), 0);

          const node = {
            lessonId,
            subject: subj.name,
            date,
            title,
            parts,
            isGroup,
            latestMs,
            totalDurationSec,
          };
          lessonsById.set(lessonId, node);
          parts.forEach((p, idx) => {
            partMetaById.set(p.id, {
              lessonId,
              subject: subj.name,
              partIndex: idx + 1,
              totalParts: parts.length,
              isGroup: parts.length > 1,
            });
          });
          return node;
        })
        .sort((a, b) => b.latestMs - a.latestMs);

      return { name: subj.name, latestMs: subj.latestMs, lessons };
    });

  return { subjects, lessonsById, partMetaById };
}

export function findPreviousSubjectLesson(tree, subject, currentLessonId) {
  const current = tree.lessonsById.get(currentLessonId);
  const subjNode = tree.subjects.find((s) => normalizeGroupKey(s.name) === normalizeGroupKey(subject));
  if (!subjNode || !current) return null;
  const currentStart = lectureStartMs(current.parts[0]);
  const earlier = subjNode.lessons
    .filter((l) => l.lessonId !== currentLessonId && lectureStartMs(l.parts[0]) < currentStart)
    .sort((a, b) => lectureStartMs(b.parts[0]) - lectureStartMs(a.parts[0]));
  return earlier[0] || null;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/grouping.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/grouping.js tests/grouping.test.js
git commit -m "feat: add Subject -> Lesson -> Parts grouping tree builder"
```

---

### Task 3: Storage Batch Updates & OPFS Lesson JSON Helpers

**Files:**
- Modify: `src/shared/storage.js:36-115`
- Modify: `src/shared/opfs.js:1-110`
- Test: `tests/storage.test.js:60-204`

**Interfaces:**
- Produces in `src/shared/storage.js`:
  - `updateLectures(ids: string[], patchOrFn: object | ((lecture) => object)): Promise<object[]>`
- Produces in `src/shared/opfs.js`:
  - `readLessonJson(lessonId, relPath): Promise<any | null>`
  - `writeLessonJson(lessonId, relPath, obj): Promise<void>`
  - `deleteLessonDir(lessonId): Promise<void>`

- [ ] **Step 1: Write failing tests in `tests/storage.test.js`**

Read the tail of `tests/storage.test.js` (lines 140-204) first during execution if needed, then add two tests:

```js
// In tests/storage.test.js
import {
  // existing imports...
  readLessonJson,
  writeLessonJson,
  deleteLessonDir,
} from '../src/shared/opfs.js';

  it('batch-updates selected lectures atomically with updateLectures', async () => {
    const s = createStorage(makeMemoryArea());
    await s.upsertLecture({ id: 'l1', title: 'Logic', createdAt: '2026-11-17T08:00:00Z' });
    await s.upsertLecture({ id: 'l2', title: 'Logic', createdAt: '2026-11-17T09:00:00Z' });
    await s.upsertLecture({ id: 'l3', title: 'Other', createdAt: '2026-11-17T10:00:00Z' });

    const updated = await s.updateLectures(['l1', 'l2'], (lec) => ({
      subject: 'Mathematical Logic',
      lessonId: 'manual-logic',
      lessonTitle: `Week 7 ${lec.title}`,
    }));
    assert.equal(updated.length, 2);
    assert.equal((await s.getLecture('l1')).subject, 'Mathematical Logic');
    assert.equal((await s.getLecture('l2')).lessonId, 'manual-logic');
    assert.equal((await s.getLecture('l3')).subject, undefined);
  });

  it('writes, reads, and deletes lesson-level JSON in OPFS lessons directory', async () => {
    await writeLessonJson('auto:2026-11-17:math', 'notes.json', { summary: 'Combined' });
    const loaded = await readLessonJson('auto:2026-11-17:math', 'notes.json');
    assert.deepEqual(loaded, { summary: 'Combined' });
    await deleteLessonDir('auto:2026-11-17:math');
    assert.equal(await readLessonJson('auto:2026-11-17:math', 'notes.json'), null);
  });
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/storage.test.js`
Expected: FAIL (`s.updateLectures is not a function`, `readLessonJson` not exported).

- [ ] **Step 3: Implement `updateLectures` in `src/shared/storage.js` and `lessons/` helpers in `src/shared/opfs.js`**

In `src/shared/storage.js` (inside `createStorage`):

```js
  function updateLectures(ids, patchOrFn) {
    const targetIds = new Set(ids || []);
    return enqueueWrite(async () => {
      if (targetIds.size === 0) return [];
      const list = await listLectures();
      const updated = [];
      const next = list.map((lec) => {
        if (!targetIds.has(lec.id)) return lec;
        const patch = typeof patchOrFn === 'function' ? patchOrFn(lec) : patchOrFn;
        const merged = { ...lec, ...patch };
        updated.push(merged);
        return merged;
      });
      if (updated.length > 0) await area.set({ [STORAGE_KEYS.LECTURES]: next });
      return updated;
    });
  }
```

Include `updateLectures` in the returned object and default export destructuring of `src/shared/storage.js`.

In `src/shared/opfs.js`:

```js
import { toSafeFilename } from './sanitize.js';

export async function getLessonDir(lessonId, create = false) {
  const root = await navigator.storage.getDirectory();
  return resolveSubdir(root, ['lessons', toSafeFilename(lessonId)], create);
}

export async function readLessonJson(lessonId, relPath) {
  try {
    const parts = relPath.split('/').filter(Boolean);
    const fileName = parts.pop();
    const baseDir = await getLessonDir(lessonId, false);
    const dir = parts.length ? await resolveSubdir(baseDir, parts, false) : baseDir;
    const fh = await dir.getFileHandle(fileName);
    return JSON.parse(await (await fh.getFile()).text());
  } catch (err) {
    if (err?.name === 'NotFoundError') return null;
    throw err;
  }
}

export async function writeLessonJson(lessonId, relPath, obj) {
  const parts = relPath.split('/').filter(Boolean);
  const fileName = parts.pop();
  const baseDir = await getLessonDir(lessonId, true);
  const dir = parts.length ? await resolveSubdir(baseDir, parts, true) : baseDir;
  const fh = await dir.getFileHandle(fileName, { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(obj, null, 2));
  await writable.close();
}

export async function deleteLessonDir(lessonId) {
  try {
    const root = await navigator.storage.getDirectory();
    const lessonsDir = await root.getDirectoryHandle('lessons');
    await lessonsDir.removeEntry(toSafeFilename(lessonId), { recursive: true });
  } catch (err) {
    if (err?.name !== 'NotFoundError') throw err;
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/storage.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/storage.js src/shared/opfs.js tests/storage.test.js
git commit -m "feat: add batch lecture updates and OPFS lesson notes storage"
```

---

### Task 4: Multi-Part Cue & Slide Links in Notion Export

**Files:**
- Modify: `src/shared/notion.js:1-54`
- Test: `tests/notion.test.js`

**Interfaces:**
- Produces: `notesToNotionMarkdown(lectureOrLesson, notes, slideEntries = [])`
  - Accepts `slideEntries` as either `string[]` (existing solo format) OR `Array<{ partIndex?: number, filename: string, zipPath?: string }>` (multi-part Lesson format).
  - Formats cues as `` `Pt 2 · 14:20` `` when `notes.isMultiPart || notes.partsMeta?.length > 1`, otherwise `` `14:20` ``.

- [ ] **Step 1: Write failing test in `tests/notion.test.js`**

Add a multi-part test to `tests/notion.test.js`:

```js
  it('formats multi-part Lesson cues with Pt prefix and nested slide zip paths', () => {
    const lesson = { title: 'Mathematical Logic (2026-11-17)', createdAt: '2026-11-17T10:00:00Z', subject: 'Mathematical Logic' };
    const notes = {
      isMultiPart: true,
      summary: 'Connected Part 1 and Part 2.',
      totalCostUsd: 0.0123,
      examRadar: [{ type: 'exam_hint', text: 'Proof on Friday', partIndex: 2, timestampSec: 125 }],
      chapters: [{ title: 'Completeness', partIndex: 2, startSec: 60, endSec: 300, bullets: ['Theorem'], formulas: [], slideRefs: [0] }],
      definitions: [{ term: 'Tautology', definition: 'Always true', partIndex: 1, timestampSec: 45 }],
    };
    const md = notesToNotionMarkdown(lesson, notes, [{ partIndex: 2, filename: '001_120.jpg', zipPath: 'slides/pt2_001_120.jpg' }]);
    assert.match(md, /Subject: Mathematical Logic/);
    assert.match(md, /`Pt 2 · 02:05`/);
    assert.match(md, /## Completeness \(`Pt 2 · 01:00` - `Pt 2 · 05:00`\)/);
    assert.match(md, /!\[\]\(slides\/pt2_001_120\.jpg\)/);
    assert.match(md, /\*\*Tautology\*\* \(`Pt 1 · 00:45`\)/);
  });
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/notion.test.js`
Expected: FAIL.

- [ ] **Step 3: Update `src/shared/notion.js`**

```js
import { formatTimestamp } from './sanitize.js';

function formatCue(sec, partIndex, isMultiPart) {
  const ts = formatTimestamp(sec);
  return isMultiPart ? `Pt ${partIndex || 1} · ${ts}` : ts;
}

function resolveSlidePath(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return `slides/${entry}`;
  return entry.zipPath || `slides/${entry.filename}`;
}

export function notesToNotionMarkdown(lecture, notes, slideEntries = []) {
  if (!notes || !Array.isArray(notes.chapters)) {
    throw new Error('Notion export requires final AI-processed notes.');
  }
  const lec = lecture || {};
  const isMultiPart = Boolean(notes.isMultiPart || (Array.isArray(notes.partsMeta) && notes.partsMeta.length > 1));
  const lines = [`# ${lec.title || 'Teams Lecture'}`];
  const meta = [];
  if (lec.createdAt) meta.push(`Date: ${lec.createdAt.slice(0, 10)}`);
  if (lec.subject) meta.push(`Subject: ${lec.subject}`);
  if (lec.courseHint && lec.courseHint !== lec.subject) meta.push(`Course: ${lec.courseHint}`);
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
      const cue = formatCue(item.timestampSec, item.partIndex, isMultiPart);
      lines.push(`> - **[${tag}]** ${item.text}${due} — \`${cue}\``);
    }
  }

  for (const ch of notes.chapters) {
    const startCue = formatCue(ch.startSec, ch.partIndex, isMultiPart);
    const endCue = formatCue(ch.endSec, ch.partIndex, isMultiPart);
    lines.push('', `## ${ch.title} (\`${startCue}\` - \`${endCue}\`)`);
    for (const b of ch.bullets || []) lines.push(`- ${b}`);
    for (const f of ch.formulas || []) lines.push(`- Formula: \`${f}\``);
    for (const refIdx of ch.slideRefs || []) {
      const path = resolveSlidePath(slideEntries[refIdx]);
      if (path) lines.push('', `![](${path})`);
    }
  }

  if (Array.isArray(notes.definitions) && notes.definitions.length > 0) {
    lines.push('', '## Key Definitions');
    for (const d of notes.definitions) {
      const cue = formatCue(d.timestampSec, d.partIndex, isMultiPart);
      lines.push(`- **${d.term}** (\`${cue}\`): ${d.definition}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test tests/notion.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/notion.js tests/notion.test.js
git commit -m "feat: support multi-part cues and slide paths in Notion export"
```

---

### Task 5: Cross-Part STT Continuity & Unified Lesson AI Pipeline

**Files:**
- Modify: `src/dashboard/ai-client.js:76-123`
- Modify: `src/dashboard/pipeline.js:1-252`
- Test: `tests/pipeline.test.js`

**Interfaces:**
- Consumes: `buildTranscriptTailPrompt`, `formatTimestamp` from `../shared/sanitize.js`; `readLessonJson`, `writeLessonJson` from `../shared/opfs.js`
- Produces:
  - `transcribeAudioSegment({ settings, blob, filename, prompt, fetchImpl })` (forwards non-empty `prompt`, omits `language`)
  - `buildLessonVisionMessages(partsPayload, { courseHint, subject, previousLessonSummary }): Array<{ role, content }>`
  - `runLessonTranscription({ lectureIds, courseHint, force, onStage, deps }): Promise<{ transcriptsById: Record<string, object> }>`
  - `runLessonPipeline({ lessonId, lectureIds, subject, courseHint, previousLessonSummary, onStage, deps }): Promise<{ notes: object, transcriptsById: Record<string, object>, slides: Array }>`

- [ ] **Step 1: Write failing tests in `tests/pipeline.test.js`**

Add tests for `prompt` forwarding and connected multi-part lesson transcription + unified notes generation:

```js
import {
  mergeTranscriptSegments,
  buildVisionMessages,
  buildLessonVisionMessages,
  runLecturePipeline,
  runTranscriptionOnly,
  runLessonTranscription,
  runLessonPipeline,
} from '../src/dashboard/pipeline.js';

  it('forwards optional STT continuity prompt without adding language param', async () => {
    let sentBody = null;
    const mockFetch = async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ text: 'Next part', segments: [{ start: 0, end: 2, text: 'Next part' }] }), { status: 200 });
    };
    await transcribeAudioSegment({
      settings: { providerMode: 'cloud', openrouterApiKey: 'sk-1', sttModel: 'openai/whisper-large-v3' },
      blob: new Blob(['x'], { type: 'audio/webm' }),
      filename: '000.webm',
      prompt: 'Mathematical Logic: modus ponens',
      fetchImpl: mockFetch,
    });
    assert.equal(sentBody.prompt, 'Mathematical Logic: modus ponens');
    assert.equal('language' in sentBody, false);
  });

  it('chains prior part transcript tail into subsequent parts during runLessonTranscription', async () => {
    const promptsSeen = [];
    const saved = {};
    const lectures = {
      p1: { id: 'p1', title: 'Math Logic', subject: 'Math Logic', audioSegments: [{ filename: 'audio/000.webm', offsetSec: 0 }] },
      p2: { id: 'p2', title: 'Math Logic', subject: 'Math Logic', audioSegments: [{ filename: 'audio/000.webm', offsetSec: 0 }] },
    };
    const deps = {
      getLecture: async (id) => lectures[id],
      getSettings: async () => ({ providerMode: 'cloud', openrouterApiKey: 'sk', sttModel: 'w', llmModel: 'g' }),
      upsertLecture: async (patch) => { lectures[patch.id] = { ...lectures[patch.id], ...patch }; return lectures[patch.id]; },
      readLectureJson: async (id, path) => saved[`${id}/${path}`] || null,
      writeLectureJson: async (id, path, data) => { saved[`${id}/${path}`] = data; },
      readLectureFile: async () => new Blob(['a'], { type: 'audio/webm' }),
      listDirFiles: async () => [],
      transcribeAudioSegment: async ({ prompt }) => {
        promptsSeen.push(prompt || '');
        const idx = promptsSeen.length;
        return {
          text: idx === 1 ? 'First part ends with Herbrand theorem.' : 'Second part continues proof.',
          segments: [{ startSec: 0, endSec: 5, text: idx === 1 ? 'First part ends with Herbrand theorem.' : 'Second part continues proof.' }],
          language: 'en',
          costUsd: 0.001,
        };
      },
    };
    await runLessonTranscription({ lectureIds: ['p1', 'p2'], courseHint: 'Math Logic', deps });
    assert.match(promptsSeen[0], /Math Logic/);
    assert.match(promptsSeen[1], /Herbrand theorem/);
    assert.equal(lectures.p1.status, 'transcribed');
    assert.equal(lectures.p2.status, 'transcribed');
  });

  it('synthesizes connected multi-part Lesson notes with prior-lesson context and partIndex tags', async () => {
    let sentMessages = null;
    const savedLesson = {};
    const lectures = {
      p1: { id: 'p1', title: 'Logic', subject: 'Math Logic', createdAt: '2026-11-17T10:00:00Z', durationSec: 300, slidesExtracted: true },
      p2: { id: 'p2', title: 'Logic', subject: 'Math Logic', createdAt: '2026-11-17T11:00:00Z', durationSec: 400, slidesExtracted: true },
    };
    const deps = {
      getLecture: async (id) => lectures[id],
      getSettings: async () => ({ providerMode: 'cloud', openrouterApiKey: 'sk', sttModel: 'w', llmModel: 'g' }),
      upsertLecture: async (patch) => { lectures[patch.id] = { ...lectures[patch.id], ...patch }; return lectures[patch.id]; },
      readLectureJson: async (id) => ({
        segments: [{ startSec: 12, endSec: 20, text: id === 'p1' ? 'Part one syntax' : 'Part two semantics' }],
        fullText: id === 'p1' ? 'Part one syntax' : 'Part two semantics',
        sttCostUsd: 0.002,
      }),
      writeLectureJson: async () => {},
      readLessonJson: async () => null,
      writeLessonJson: async (lid, path, obj) => { savedLesson[`${lid}/${path}`] = obj; },
      listDirFiles: async (id) => (id === 'p2' ? ['001_15.jpg'] : []),
      readLectureFile: async () => new Blob(['img'], { type: 'image/jpeg' }),
      blobToDataUrl: async () => 'data:image/jpeg;base64,AA==',
      generateStructuredNotes: async ({ messages }) => {
        sentMessages = messages;
        return {
          notes: {
            summary: 'Connected syntax and semantics.',
            chapters: [{ title: 'Semantics', partIndex: 2, startSec: 12, endSec: 20, bullets: ['Models'], formulas: [], slideRefs: [0] }],
            definitions: [{ term: 'Model', definition: 'Truth assignment', partIndex: 2, timestampSec: 12 }],
            examRadar: [{ type: 'deadline', text: 'HW3', partIndex: 1, timestampSec: 12, dueDate: '2026-11-24' }],
          },
          costUsd: 0.01,
        };
      },
    };
    const res = await runLessonPipeline({
      lessonId: 'auto:2026-11-17:math_logic',
      lectureIds: ['p1', 'p2'],
      subject: 'Math Logic',
      previousLessonSummary: 'Last week covered propositional calculus.',
      deps,
    });
    assert.match(sentMessages[1].content[0].text, /Last week covered propositional calculus/);
    assert.match(sentMessages[1].content[0].text, /\[Pt 1 · 00:12/);
    assert.match(sentMessages[1].content[0].text, /\[Pt 2 · 00:12/);
    assert.equal(res.notes.isMultiPart, true);
    assert.equal(res.notes.chapters[0].partId, 'p2');
    assert.equal(res.notes.totalCostUsd, 0.014);
    assert.ok(savedLesson['auto:2026-11-17:math_logic/notes.json']);
    assert.equal(lectures.p1.status, 'ready');
    assert.equal(lectures.p2.status, 'ready');
  });
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/pipeline.test.js`
Expected: FAIL.

- [ ] **Step 3: Update `src/dashboard/ai-client.js` and `src/dashboard/pipeline.js`**

In `src/dashboard/ai-client.js`:
- Add `prompt = ''` parameter to `transcribeAudioSegment({ settings, blob, filename, prompt = '', fetchImpl = fetch })`:
  - In `isLocal`: `if (prompt.trim()) form.append('prompt', prompt.trim());`
  - In cloud JSON body: `...(prompt.trim() ? { prompt: prompt.trim() } : {})`

In `src/dashboard/pipeline.js`:
- Add `readLessonJson` and `writeLessonJson` to `DEFAULT_DEPS`.
- Import `buildTranscriptTailPrompt` from `../shared/sanitize.js`.
- In `ensureTranscript({ ..., seedPrompt = '', resolvedDeps })`:
  - Pass `prompt: buildTranscriptTailPrompt([seedPrompt, ...chunkTexts].filter(Boolean).join(' '))` to each `transcribeAudioSegment` call so consecutive 10-minute chunks and consecutive parts carry vocabulary/context forward.
- Add `buildLessonVisionMessages(partsPayload, { courseHint = '', subject = '', previousLessonSummary = '' } = {})`:
  - Formats each part section (`--- Part 1 (Title) ---`) with lines `[Pt ${partIndex} · ${formatTimestamp(s.startSec)} | partIndex=${partIndex} | ${Math.floor(s.startSec)}s] ${s.text}`.
  - Formats flat slide index `Slide #${idx} @ Pt ${s.partIndex} ${formatTimestamp(s.timestampSec)} (${Math.floor(s.timestampSec)}s)`.
  - Includes `Subject: ${subject}`, `Course/Context hint: ${courseHint}`, and `Previous lesson context (for terminology continuity only): ${previousLessonSummary.slice(0, 1200)}` when present.
  - Instructs LLM to return `partIndex` (1-based integer) alongside `startSec`/`endSec`/`timestampSec` on `chapters`, `definitions`, and `examRadar`, connecting all parts coherently.
- Add `runLessonTranscription({ lectureIds, courseHint, force = false, onStage = () => {}, deps = DEFAULT_DEPS })`:
  - Iterates `lectureIds` in order, keeping `rollingPrompt = [subjectOrHint, prevTail].filter(Boolean).join(': ')`.
  - Updates each lecture status (`transcribed` or `ready` if notes exist) and returns `{ transcriptsById }`.
- Add `runLessonPipeline({ lessonId, lectureIds, subject = '', courseHint, previousLessonSummary = '', onStage = () => {}, deps = DEFAULT_DEPS })`:
  - If `lectureIds.length === 1`, delegates to `runLecturePipeline({ lectureId: lectureIds[0], courseHint, onStage, deps })` and returns normalized single-part result.
  - For 2+ parts:
    1. Runs `runLessonTranscription` across `lectureIds`.
    2. Extracts slides per part (preserving existing whiteboard/extracted check).
    3. Builds `slidePayloads` with `{ partId, partIndex, filename, timestampSec, dataUrl }`.
    4. Calls `buildLessonVisionMessages` + `generateStructuredNotes`.
    5. Normalizes every chapter/definition/examRadar item with `partIndex` (clamped `1..parts.length`) and `partId = lectureIds[partIndex - 1]`.
    6. Computes `sttCostUsd` (sum across parts), `llmCostUsd`, `totalCostUsd`, `isMultiPart: true`, `partsMeta`, `slides` (with `partId`, `partIndex`, `filename`, `timestampSec`).
    7. Writes to `lessons/<lessonId>/notes.json` via `resolvedDeps.writeLessonJson(lessonId, 'notes.json', notes)` and sets all parts `status: 'ready'`.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test tests/pipeline.test.js`
Expected: PASS (all existing + new pipeline tests).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/ai-client.js src/dashboard/pipeline.js tests/pipeline.test.js
git commit -m "feat: add cross-part STT prompt chaining and unified multi-part Lesson pipeline"
```

---

### Task 6: Dashboard HTML & CSS for Hierarchy, Quick Downloads, Multi-Select Batch Bar & Part Switcher

**Files:**
- Modify: `src/dashboard/dashboard.html:28-115`
- Modify: `src/dashboard/dashboard.css`

- [ ] **Step 1: Update `src/dashboard/dashboard.html`**

1. In `.rail`:
   - Wrap `#lectureFilter` with a row containing a `Select` toggle button (`#toggleSelectModeBtn`).
   - Add `<div id="batchBar" class="batch-bar" hidden>` right below `#lectureList` (sticky at bottom of rail) with selected count `#batchCount` and action buttons:
     - `#batchDownloadBtn` (`Download`)
     - `#batchZipBtn` (`Export .zips`)
     - `#batchGroupBtn` (`Group / Move`)
     - `#batchUngroupBtn` (`Ungroup`)
     - `#batchFreeBtn` (`Free Space`)
     - `#batchDeleteBtn` (`Delete`, `.btn-danger-outline`)
2. In `#lectureView` `.topbar`:
   - Add inline Subject input or pill alongside `#lecCourseHint` (e.g., `<input id="lecSubjectInput" ...>` or editable Subject badge) and a `#partSwitcher` bar (`<div id="partSwitcher" class="part-switcher" hidden></div>`) for multi-part Lessons.
   - Add direct `<button id="quickDownloadBtn" class="btn">Download .webm</button>` in `.actions` (before `#storageMenu`), keeping `#freeMediaBtn` and `#deleteLectureBtn` inside `#storageMenu` (plus `#renameLessonBtn` / `#ungroupLectureBtn` inside `#storageMenu`).
3. Add a compact `<dialog id="groupModal" class="modal">` at the bottom of `<body>` (same pattern as `#settingsModal`) for setting `Subject` and `Lesson title` when grouping/moving selected lectures.

- [ ] **Step 2: Add styles to `src/dashboard/dashboard.css`**

Follow `DESIGN.md` tokens (`--rail`, `--surface`, `--border`, `--ink`, `--muted`, `--accent`, `--accent-soft`, `--danger`, `tabular-nums`, `150ms ease`):
- `.rail-toolbar` (search input + `Select` button)
- `.subject-group`, `.subject-header`, `.lesson-group`, `.lesson-header`, `.lesson-parts` (clean 1px left thread line inside collapsible groups, compact chevron rotation)
- `.rail-quick-btn` (icon button revealed on hover/focus-within for 1-click download on any row or Lesson header)
- `.select-box` (shown when `.rail.is-selecting`)
- `.batch-bar` (sticky bottom tray in `.rail` with 2-column compact action grid)
- `.part-switcher` + `.part-pill` / `.part-pill.active` (`tabular-nums` pills `All Parts` / `Pt 1 · 10:00` / `Pt 2 · 10:40`)

- [ ] **Step 3: Verify HTML/CSS structure**

Run: `bun test tests/manifest.test.js` and visually inspect `dashboard.html` IDs against `dashboard.js` wiring in Task 7.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/dashboard.html src/dashboard/dashboard.css
git commit -m "feat: add rail hierarchy, batch action bar, quick download, and part switcher UI"
```

---

### Task 7: Dashboard Controller Wiring (Tree, Quick & Batch Downloads, Move/Group, Connected Lesson View)

**Files:**
- Modify: `src/dashboard/dashboard.js`

**Interfaces:**
- Consumes:
  - `buildDownloadFilename`, `formatLocalDateTimeParts` (`src/shared/sanitize.js`)
  - `STANDALONE_PREFIX`, `buildLibraryTree`, `findPreviousSubjectLesson` (`src/shared/grouping.js`)
  - `updateLectures` (`src/shared/storage.js`)
  - `readLessonJson`, `deleteLessonDir` (`src/shared/opfs.js`)
  - `runLessonTranscription`, `runLessonPipeline` (`src/dashboard/pipeline.js`)
  - `notesToNotionMarkdown` (`src/shared/notion.js`)

- [ ] **Step 1: Wire `buildLibraryTree` state & hierarchical rail rendering in `src/dashboard/dashboard.js`**

- Track `libraryTree`, `activeViewMode` (`'lecture'` vs `'lesson'`), `activeLessonId`, `selectedId` (currently loaded video part), `multiSelectMode`, `checkedIds = new Set()`, `collapsedSubjects = new Set()`, `collapsedLessons = new Set()`.
- `renderLectureList()` computes `libraryTree = buildLibraryTree(await listLectures())`, filters by `#lectureFilter`, and renders:
  - Subject collapsible `<section>` headers (checkbox in select mode, count badge, collapse toggle).
  - Inside each Subject:
    - Multi-part Lessons render a Lesson header row (`title`, `${parts.length} parts · ${formatTimestamp(totalDurationSec)}`, quick Download All icon button, click to open Lesson view) + nested Part rows (`Pt 1 · HH:MM · duration`, hover Download `.webm` icon, click to play that part while keeping Lesson context if in Lesson mode).
    - Standalone items render a single row with hover Download `.webm` icon.

- [ ] **Step 2: Implement collision-free sequential downloads & Notion zip export helpers**

- `triggerBlobDownload(blob, filename)` creates object URL, clicks `<a download=filename>`, revokes after 10s.
- `downloadLectureVideo(lectureId)`: looks up `partMetaById.get(lectureId)` and downloads `buildDownloadFilename(lec, { partIndex, totalParts, kind: 'video' })`.
- `downloadLecturesSequentially(ids, kind)`: loops sequentially with a `250ms` gap between clicks so Chromium triggers each download cleanly with zero `(1)` collisions; reports progress in `#statusBanner` and skips missing media gracefully.
- For `kind === 'lesson-zip'` (or multi-part Lesson `Export .zip`): collects slides across all parts into `slides/pt${partIndex}_${filename}` and builds `notes.md` via `notesToNotionMarkdown(lessonMeta, currentNotes, slideEntries)`.

- [ ] **Step 3: Wire multi-select batch bar & `#groupModal`**

- `toggleSelectModeBtn` toggles `.is-selecting` on `.rail`, resets/updates `#batchBar`.
- Subject/Lesson checkboxes toggle all child lecture IDs cleanly.
- Batch buttons:
  - `batchDownloadBtn`: `downloadLecturesSequentially([...checkedIds], 'video')`
  - `batchZipBtn`: exports ready Notion zips for selected lectures/lessons
  - `batchGroupBtn`: opens `#groupModal` prefilled with common `subject` and `lessonTitle`, on submit runs `updateLectures([...checkedIds], { subject, lessonId: newLessonId, lessonTitle })`
  - `batchUngroupBtn`: runs `updateLectures([...checkedIds], (l) => ({ lessonId: `${STANDALONE_PREFIX}${l.id}`, lessonTitle: '' }))`
  - `batchFreeBtn`: calls `freeLectureMedia(id)` for each non-recording selected ID
  - `batchDeleteBtn`: confirms `Delete ${count} selected recording(s)?` and deletes OPFS dirs + metadata (cleaning up empty `lessons/<id>` dir if all parts of a lesson were deleted)

- [ ] **Step 4: Wire Connected Lesson View, Part Switcher & `[Pt k · MM:SS]` Seeking**

- `selectLesson(lessonId, focusPartId = null)`:
  - Loads all parts in `lesson.parts`.
  - Sets `#partSwitcher` pills (`Pt 1`, `Pt 2`, ...), loads `focusPartId || parts[0].id` into `<video>`.
  - Loads unified notes from `readLessonJson(lessonId, 'notes.json')` (or `readLectureJson(parts[0].id, 'notes.json')` if 1-part), merges slides across all parts (`partId`, `partIndex`, `sec`, `url`), and renders transcript tabs (showing active part's transcript or all parts with `[Pt k · MM:SS]` buttons).
  - `seekTo(sec, partId)`: if `partId && partId !== selectedId`, switches video source to `partId` and waits for `loadedmetadata` once before setting `player.currentTime = sec` and calling `player.play()`.
  - `transcribeOnlyBtn` / `summarizeBtn`: when viewing a multi-part Lesson, runs `runLessonTranscription` / `runLessonPipeline` (auto-passing `previousLessonSummary` from `findPreviousSubjectLesson` when available!).
  - Inline `#lecSubjectInput` change saves `subject` on the lecture (or all parts in the Lesson) via `updateLectures`.

- [ ] **Step 5: Run full test suite & verify syntax/imports**

Run: `bun test`
Expected: PASS (all existing + new tests pass, 0 failures).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/dashboard.js
git commit -m "feat: wire grouped library, quick/batch actions, and multi-part lesson study desk"
```

---

## Self-Review

1. **Spec coverage:**
   - Collision-free local naming + Romanian transliteration + `_ptN` → Task 1 & Task 7.
   - `Subject → Lesson (Day) → Parts` hierarchy + manual move/group/ungroup/rename → Task 2, Task 3, Task 6, Task 7.
   - Direct header `Download .webm` + rail hover download + `Select` multi-select batch bar (Download, Export .zips, Group/Move, Ungroup, Free Space, Delete) → Task 6 & Task 7.
   - Connected multi-part STT (`prompt` tail continuity) + unified Lesson LLM notes (with optional prior-day Subject summary) + `[Pt k · MM:SS]` video switching + Notion export → Task 3, Task 4, Task 5, Task 7.
2. **Placeholder scan:** No `TBD`/`TODO` or unimplemented helper references; every exported helper signature matches across tasks (`buildLibraryTree`, `findPreviousSubjectLesson`, `updateLectures`, `readLessonJson`, `writeLessonJson`, `deleteLessonDir`, `buildDownloadFilename`, `runLessonTranscription`, `runLessonPipeline`).
3. **Type consistency:** `partMetaById` returns `{ lessonId, subject, partIndex, totalParts, isGroup }`, matching `buildDownloadFilename(lec, partMeta)` and `notesToNotionMarkdown`.
