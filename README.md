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

### For Colleagues (Quick Install, No Git Needed)

1. Download the latest release: [**`mytems.zip`**](https://github.com/LightAndy1/MyTems/releases/latest/download/mytems.zip)
2. Unzip it somewhere permanent (e.g. `Documents/MyTems`).
3. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`) in your browser.
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the unzipped `MyTems` folder.

### Updating Later

When the extension notifies you of a new version (or via **Settings → Check for Updates**):

1. Click **Download Update (.zip)**.
2. Unzip and **replace** your existing `MyTems` folder (keeping the same folder preserves all your recordings and settings).
3. Open `chrome://extensions` and click **Reload** (`↻`) on MyTems.

### For Developers

1. Clone the repository:
   ```sh
   git clone https://github.com/LightAndy1/MyTems.git
   ```
2. Open `chrome://extensions` (or `helium://extensions`) in your Chromium-based browser, enable **Developer mode**, and **Load unpacked** on the cloned `MyTems` directory.
3. Every push to `main` automatically runs `bun test`, bumps the patch version in `manifest.json`, tags `vX.Y.Z`, and publishes `mytems.zip` to GitHub Releases. (To ship a minor/major bump, update `"version"` in `manifest.json` before pushing; add `[skip release]` to a commit message to skip releasing.)

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
