# MyTems — Teams Lecture Companion Design Spec

Date: 2026-11-17
Target Browser: Helium (Chromium Manifest V3)

## 1. Overview & Goals
MyTems is a zero-backend Manifest V3 browser extension for Helium (Chromium) that records Microsoft Teams lectures locally at $0 cost and runs on-demand AI transcription, slide-keyframe extraction, and study note generation only for lectures the user chooses to process.

## 2. Global Constraints
- **Target runtime:** Helium Browser (Chromium MV3); zero external Node/Python runtime required by the extension itself; zero bundler (native ES modules loaded unpacked).
- **Audio capture:** Tab audio + video only (`chrome.tabCapture`); user microphone is NOT captured.
- **Language handling:** Strictly automatic (no user-facing language selector); STT auto-detects Romanian/English code-switching, and the summary LLM writes notes in the lecture's primary spoken language while preserving English technical terms.
- **Settings UI:** Modern modal dialog inside `dashboard.html` (accessible from `popup.html` via `#settings`); NO separate `options.html` page.
- **Notion export:** Generated strictly from final AI-processed structured notes (`notes.json`), never from raw STT transcript alone.
- **Whiteboard:** No Microsoft Whiteboard Fluid/DOM interception in v1; users use Teams' built-in `View > Focus on content`, `Fit to Screen` (bottom right), `Follow participant`, or `Open in browser` inside `tabCapture`, and can attach exported Whiteboard images (`Export whole whiteboard`) directly to a lecture's slides before summarizing.
- **Cloud storage:** Manual offload via 1-click file download (e.g., into macOS Google Drive Desktop) + 1-click "Free Media Space"; no Google Drive OAuth inside Helium.

## 3. Architecture & File Boundaries

```
manifest.json
src/
  shared/
    constants.js       # Storage keys, default settings, limits, API URLs
    sanitize.js        # Tab title -> lecture title & safe download filename
    storage.js         # chrome.storage.local wrapper (settings + lecture index)
    opfs.js            # OPFS helpers (read/write/delete lecture dirs & files)
    zip.js             # Zero-dependency store-only ZIP builder (CRC32 + headers)
    notion.js          # Final notes.json -> Notion-ready Markdown serializer
  background/
    background.js      # Service worker: recording lifecycle, badge, crash recovery
  offscreen/
    offscreen.html
    offscreen.js       # tabCapture getUserMedia, AudioContext pass-through, dual MediaRecorder
    opfs-writer.worker.js # SyncAccessHandle in-place chunk append + flush
  popup/
    popup.html
    popup.css
    popup.js           # Start/Stop capture, live timer, course hint, link to Dashboard/Settings
  dashboard/
    dashboard.html
    dashboard.css      # Modern dark/light adaptive CSS with <dialog> Settings Modal
    dashboard.js       # Main view wiring, player, filters, modal, triggers
    slides.js          # Hidden <video> frame-diff slide extractor + Snap Slide
    ai-client.js       # OpenRouter + primitive Local HTTP STT & Vision LLM calls + retries
    pipeline.js        # Orchestrates STT segments -> slide extraction -> LLM notes + cost receipt
tests/
  sanitize.test.js
  zip.test.js
  notion.test.js
  slides.test.js
  pipeline.test.js
```

## 4. Recording & Storage Design
- **Recording trigger:** `popup.js` gets current tab (`tab.id`, `tab.title`), obtains `streamId` via `chrome.tabCapture.getMediaStreamId({ targetTabId })`, and passes `streamId` + metadata to `background.js`, which ensures `offscreen.html` (`reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'WORKERS']`) and starts capture.
- **Media constraints & codecs:**
  - `getUserMedia`: `chromeMediaSource: 'tab'`, `maxWidth: 1920`, `maxHeight: 1080`, `maxFrameRate: 8`.
  - Audio playback pass-through via `AudioContext` -> `destination`.
  - Video `MediaRecorder`: `video/webm;codecs=vp9,opus` (fallback `vp8,opus`), `videoBitsPerSecond: 180000`, `audioBitsPerSecond: 16000`, `timeslice: 5000`.
  - Audio `MediaRecorder`: `audio/webm;codecs=opus`, `audioBitsPerSecond: 16000`, rolling cleanly into standalone valid WebM files (`audio/000.webm`, `001.webm`, ...) every `600000` ms (10 min) with a `300` ms overlap before stopping the prior recorder so zero words drop and every segment has a valid EBML header.
- **Crash-safe persistence:** `offscreen.js` posts `Uint8Array` chunks to `opfs-writer.worker.js`, which uses `FileSystemSyncAccessHandle.write()` + `flush()` in place inside OPFS `lectures/<id>/`. `lastChunkAt` updates in `chrome.storage.local` every 5s. On service worker startup or dashboard open, any entry stuck in `recording` without an active offscreen session recovers to `recorded` with computed approximate duration.
- **OPFS Layout per lecture (`lectures/<id>/`):**
  - `video.webm`
  - `audio/000.webm`, `001.webm`, ...
  - `slides/001_<sec>.jpg` ...
  - `transcript.json`: `{ segments: [{ startSec, endSec, text }], fullText, detectedLanguage, sttCostUsd }`
  - `notes.json`: `{ summary, chapters: [{ title, startSec, endSec, bullets, formulas, slideRefs }], definitions: [{ term, definition, timestampSec }], examRadar: [{ type, text, timestampSec, dueDate }], llmCostUsd, totalCostUsd, generatedAt }`
- **Cleanup actions:**
  - `Download Video`: downloads `video.webm` named `<YYYY-MM-DD>_<sanitized-tab-title>.webm`.
  - `Free Media Space`: removes `video.webm` and `audio/` directory inside OPFS, keeping `transcript.json`, `notes.json`, and `slides/`.
  - `Delete Lecture`: removes `lectures/<id>/` and index entry.

## 5. AI Pipeline & Slide Extraction
1. **Stage 1 — STT (skipped if `transcript.json` already exists):**
   - Reads `audioSegments: [{ filename, offsetSec }]` from lecture metadata (falling back to numeric sort of `audio/*.webm` at `index * 600`).
   - Cloud mode: `POST https://openrouter.ai/api/v1/audio/transcriptions` with JSON `{ model, input_audio: { data: base64, format: "webm" }, response_format: "verbose_json" }` (no `language` parameter).
   - Local mode: `POST <localSttUrl>` (`multipart/form-data` with `file`, `model`, `response_format=verbose_json`).
   - Shifts each segment's timestamps by its recorded `offsetSec`, deduplicating minor overlap text, sums `usage.cost`, and saves `transcript.json` immediately.
2. **Stage 2 — On-demand Slide Extraction:**
   - Runs in `slides.js` against `video.webm` using a hidden `<video>` stepping every 4s, drawing to a `160x90` offscreen canvas, computing mean normalized pixel diff vs the previous captured frame.
   - Triggers capture when diff > `0.04` and elapsed since previous capture >= `8s`, capped at `50` slides per lecture, encoded as JPEG (`0.85`). Also supports manual **Snap Slide** from the visible player.
3. **Stage 3 — Vision LLM Fusion:**
   - Sends timestamped transcript + timestamped slide JPEGs (`data:image/jpeg;base64,...`) + optional `courseHint` to `chat/completions` (OpenRouter or `<localLlmUrl>`), requesting JSON matching `notes.json` schema.
   - Retries 3x with exponential backoff on HTTP 429/5xx; parses/validates strict JSON (stripping accidental markdown fences).

## 6. Dashboard, Modal Settings & Notion Export
- **Settings Modal:** `<dialog>` inside `dashboard.html` with OpenRouter API key, STT/LLM model inputs, Cloud/Local segmented toggle, Local STT & LLM base URLs/models, and default course hint.
- **Study View:** `<video>` player (or audio/notes-only banner if media freed), **Attach Whiteboard / Slide Image** upload into `slides/`, pinned **Exam & Deadline Radar** callout, clickable **Chapters / Formulas / Definitions / Slide Strip** (`seekTo(sec)`), searchable **Transcript**, and **Cost Receipt**.
- **Notion Export (enabled only when `notes.json` exists):**
  - `Copy Notion Markdown`: writes Notion-formatted Markdown (callouts for Exam Radar, chapters, definitions, timestamp markers) to clipboard.
  - `Download Notion Bundle (.zip)`: generates uncompressed `.zip` containing `notes.md` (referencing `slides/<file>.jpg`) and `slides/*.jpg` ready for Notion *Import -> Markdown*.
