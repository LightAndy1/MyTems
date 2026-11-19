# MyTems — Teams Lecture Companion

> **Made with AI:** This project was designed and built with AI assistance.

Zero-bundler Chromium Manifest V3 extension for capturing Microsoft Teams lectures locally at \$0 cost, with on-demand AI transcription, slide/whiteboard extraction, structured study notes, Exam & Deadline Radar, and Notion export.

## Features

- **Zero-cost local capture:** Records Teams tab video and segmented Opus audio directly to OPFS (`SyncAccessHandle`) via `chrome.tabCapture` and an offscreen document—no backend server and no microphone capture.
- **On-demand AI pipeline:**
  - **Transcribe Only** (\$0 LLM cost) using cloud or local HTTP STT endpoints with automatic Romanian/English bilingual detection.
  - **Summarize** to extract slide keyframes, generate structured notes (lecture, math, code, and meeting modes), and build an **Exam & Deadline Radar** with timestamp links to jump straight to the exact second in the video.
- **Whiteboard & slide capture:** Extracts slide keyframes locally from recorded video and supports Microsoft Whiteboard capture / manual slide attachment.
- **Multi-part lesson grouping:** Organizes recordings into `Subject → Lesson → Parts` and synthesizes connected multi-part lesson notes.
- **OpenRouter routing & local fallback:** Supports OpenRouter provider routing (`price` / `throughput` / custom provider order) as well as a local HTTP endpoint toggle, plus per-lecture cost tracking.
- **Notion export:** Exports structured notes and linked slide assets via **Copy Notion MD** or **Export Notion .zip**.

## Tech Stack

- Chromium Manifest V3 extension (`manifest.json`)
- Native ES modules, HTML, and CSS (zero runtime dependencies, no bundler)
- Storage: Chrome `storage` + Origin Private File System (OPFS)
- Tests: [Bun](https://bun.sh/) (`bun test`)

## Getting Started

1. Clone the repository:
   ```sh
   git clone https://github.com/LightAndy1/MyTems.git
   ```
2. Open `chrome://extensions` (or `helium://extensions`) in your Chromium-based browser.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the cloned `MyTems` directory.
5. Open the extension popup during a Microsoft Teams tab session to start recording, and open the dashboard to configure OpenRouter or local HTTP endpoints in **Settings**.

## Development & Testing

Run the test suite with Bun:

```sh
bun test
```

## Project Structure

- `manifest.json` — Manifest V3 configuration and permissions
- `src/background/` — Extension service worker
- `src/offscreen/` — Offscreen media capture and segment handling
- `src/popup/` — Extension popup UI
- `src/dashboard/` — Library, study desk, and settings modal
- `src/shared/` — Grouping, storage, pipeline, Notion export, and shared utilities
- `tests/` — Unit tests (`bun test`)
