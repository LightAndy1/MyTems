# Lecture Groups, Collision-Free Naming, Batch Actions & Connected Lesson AI

**Date:** 2026-11-17
**Status:** Approved

## Goals

1. **Collision-free local file naming** so multiple recordings from the same day/meeting never overwrite or get browser `(1)`, `(2)` suffixes.
2. **Two-level library hierarchy (`Subject → Lesson (Day) → Parts`)** with automatic same-day grouping for break-split meetings and manual move/rename/group/ungroup controls.
3. **One-click downloads & multi-select batch actions** in the dashboard without drilling into `⋯` per recording.
4. **Connected multi-part AI pipeline** for multi-part Lessons: cross-part STT context continuity, unified Lesson Study Notes + Exam Radar across all parts, optional previous-day Subject context, part-aware timestamp seeking (`[Pt 2 · 14:20]`), and unified Notion export.

## Global Constraints

- Zero-bundler Chromium Manifest V3 extension (`native ES modules`, HTML, CSS, `bun test`, zero runtime dependencies).
- Keep `manifest.json` permissions unchanged (no `"downloads"` permission required; sequential `<a download>` blob downloads stream directly from OPFS without in-memory multi-video `.zip` buffering).
- Preserve strict automatic RO/EN language detection (never send a `language` parameter in STT calls; optional STT `prompt` carries prior context/terms only).
- Existing single-part recordings, `lectures/<id>/transcript.json`, `lectures/<id>/notes.json`, and `notesToNotionMarkdown(lecture, notes, string[])` remain backwards compatible with zero data migration.
- All UI changes follow `DESIGN.md` tokens (`#f6f7fa`/`#0d1017`, `tabular-nums`, amber reserved for Exam & Deadline Radar, `150ms ease` motion).

## Architecture

### 1. Naming (`src/shared/sanitize.js`)
- Transliterate Romanian diacritics (`ăâîșşțţĂÂÎȘŞȚŢ` → `aaisttAAISTT`) inside `toSafeFilename()`.
- Format timestamps in **local** wall-clock time (`YYYY-MM-DD`, `HH-MM`) via `formatLocalDateTimeParts(dateInput)`.
- Build download names via `buildDownloadFilename(lecture, { partIndex, totalParts, kind, lessonTitle })`:
  - Video (`kind: 'video'`): `YYYY-MM-DD_HH-MM_<SafeTitle>[_ptN].webm`
  - Lecture Notion zip (`kind: 'notion-zip'`): `YYYY-MM-DD_HH-MM_<SafeTitle>[_ptN]_notion.zip`
  - Unified Lesson Notion zip (`kind: 'lesson-zip'`): `YYYY-MM-DD_<SafeLessonTitle>_lesson_notion.zip`
  - `_ptN` is appended whenever `totalParts > 1`.

### 2. Hierarchy & Grouping (`src/shared/grouping.js`, `src/shared/storage.js`)
- `mytems_lectures` remains flat with 3 optional fields on each lecture record:
  - `subject?: string` — course/subject name (defaults to `courseHint` if present, else `lecture.title`).
  - `lessonId?: string` — `'standalone:<id>'` forces ungrouped; custom string groups manually; `undefined/null` auto-groups by `auto:${localDate}:${normalizeGroupKey(subject)}`.
  - `lessonTitle?: string` — custom display title for the Lesson.
- `buildLibraryTree(lectures)` derives `{ subjects, lessonIndex, lectureMetaById }`:
  - Auto-keys with **>= 2** recordings form a multi-part Lesson (`isGroup: true`); auto-keys with 1 recording remain standalone (`isGroup: false`).
  - Parts inside a Lesson sort chronologically (`startedAtMs || createdAt` ascending) and receive 1-based `partIndex` and `totalParts`.
  - Subjects and Lessons inside each Subject sort newest-activity-first.
- `storage.js` adds `updateLectures(ids, patchOrFn)` serialized inside `enqueueWrite` for atomic batch moves/renames/grouping.

### 3. OPFS Storage (`src/shared/opfs.js`)
- Solo Lessons (`parts.length === 1`) keep `lectures/<id>/notes.json`.
- Multi-part Lessons (`parts.length > 1`) store unified notes at `lessons/<safeLessonKey>/notes.json` via `readLessonJson`, `writeLessonJson`, and `deleteLessonDir`.
- Each part retains its own `lectures/<id>/video.webm`, `audio/`, `slides/`, and `transcript.json`.

### 4. Connected Multi-Part AI & Notion Export (`src/dashboard/ai-client.js`, `src/dashboard/pipeline.js`, `src/shared/notion.js`)
- `transcribeAudioSegment` accepts optional `prompt` (appended to FormData for local STT and JSON body for OpenRouter STT when non-empty).
- `runLessonTranscription({ lectureIds, courseHint, force, onStage, deps })` runs STT part-by-part in chronological order, seeding each chunk/part with the trailing ~220 chars of the previous transcript (plus Subject/course hint).
- `runLessonPipeline({ lessonId, lectureIds, subject, courseHint, onStage, deps })`:
  1. Ensures transcripts across all parts with cross-part continuity prompts.
  2. Extracts slides for each part (skipping when `slidesExtracted` or `_wb.` whiteboard captures already exist).
  3. Optionally loads the most recent prior Lesson's `summary` in the same `subject` (capped at 1,200 chars) as continuity context.
  4. Sends all parts' tagged transcripts (`[Pt k · MM:SS | partIndex=k | Xs]`) and labeled slides (`Slide #i @ Pt k MM:SS`) to `generateStructuredNotes`.
  5. Normalizes `partIndex` (default `1`) and `partId` onto chapters, definitions, and Exam Radar items, sums STT + LLM costs across parts, and writes unified `notes.json` (plus updates part statuses to `'ready'`).
- `notesToNotionMarkdown` accepts optional `partSlideMap` / multi-part slide entries `{ partIndex, filename, zipPath }` and formats multi-part cues as `` `Pt 2 · 14:20` `` when `notes.isMultiPart` or `partsMeta?.length > 1`.

### 5. Dashboard UI (`src/dashboard/dashboard.html`, `src/dashboard/dashboard.js`, `src/dashboard/dashboard.css`)
- **Rail:** Collapsible Subject folders → collapsible multi-part Lesson groups + standalone items; hover download icons on items and Lesson headers; `Select` toggle activating per-Subject / per-Lesson / per-Part checkboxes and a sticky batch action bar (**Download**, **Export .zips**, **Group / Move**, **Ungroup**, **Free Space**, **Delete**).
- **Topbar & Study Desk:** Direct `Download .webm` button in `.actions`; when inspecting a multi-part Lesson, a compact **Part Switcher** (`Pt 1`, `Pt 2`, ...) lets users scrub any part's video while reading unified Lesson notes/slides, and clicking any `[Pt k · MM:SS]` chip or slide automatically loads part `k` and seeks to `MM:SS`.
