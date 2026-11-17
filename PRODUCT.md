# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Zero-bundler Chromium Manifest V3 extension (native ES modules, HTML, CSS, Node/Bun tests, zero runtime dependencies).

## Users

University students attending Microsoft Teams lectures in Romanian and English (often mixed in the same sentence) who want zero-cost local recording and selective, pay-per-lecture AI study notes.

## Product Purpose

MyTems separates recording from AI spend: it captures Teams tab video and segmented Opus audio locally to OPFS at $0 cost, then runs on-demand transcription (with optional transcription-only mode to avoid LLM cost), slide-keyframe extraction, structured notes with an Exam & Deadline Radar, and Notion Markdown/.zip export.

## Positioning

Unlike always-on meeting bots or raw speech-to-text wrappers, MyTems runs completely inside Helium Browser with zero backend server, tracks exact per-lecture STT and Vision LLM cents, supports OpenRouter provider routing (`sort: price` / explicit provider order) plus a local HTTP endpoint fallback, and pairs extracted slides with timestamps for direct video scrubbing.

## Operating Context

- Recorded inside Helium Browser (`chrome.tabCapture`, offscreen document + OPFS `SyncAccessHandle`).
- Studied on a desktop/laptop screen in adaptive daylight or evening study lighting.
- Romanian/English bilingual lectures; Microsoft Whiteboard handled via Teams `View > Focus on content` / `Fit to Screen` and manual `Attach Whiteboard / Slide Image`.

## Capabilities and Constraints

- Tab audio + video only (`chrome.tabCapture`); never captures user microphone.
- Strictly automatic RO/EN language detection; no user-facing language selector.
- Settings live in a `<dialog>` modal inside `dashboard.html` (`#settings`); no `options.html`.
- OpenRouter provider routing (`Default`, `Cheapest / price`, `Fastest / throughput`, optional provider slug order) + Local HTTP endpoint toggle.
- Two-stage on-demand actions: **Transcribe Only** ($0 LLM) and **Summarize** (auto-transcribes if missing, extracts slides, generates notes + Exam & Deadline Radar).
- Notion export (`Copy Notion MD`, `Export Notion .zip`) enabled strictly after AI-processed `notes.json` exists.
- Lecture names and downloaded files derive from the sanitized Teams tab title.

## Product Principles

1. **Zero waste by default:** Recording costs $0; transcription can run without LLM; media space is reclaimable in one click while keeping notes and slides.
2. **Clarity over chrome:** Every control names its exact action and cost/stage; clutter and hidden settings stay out of the main study flow.
3. **Jump straight to evidence:** Every bullet, definition, slide thumbnail, and Exam Radar item links directly to its second in the lecture video.
4. **Adaptive calm:** Crisp paper-like clarity in daylight, low-glare slate at night.
