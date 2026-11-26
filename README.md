# MyTems: Teams Lecture Companion

> **Made with AI:** This project was designed and built with AI assistance.

MyTems is a free, local browser extension for Chrome, Edge, Brave, and Helium. It records Microsoft Teams lectures straight to your computer at \$0 cost, captures Microsoft Whiteboard drawings automatically, and lets you run AI transcription, slide extraction, study notes, and Notion exports only when you choose.

## How Recording Works (Zero Cost Local Capture)

MyTems separates recording from AI spending. Recording never uploads anything to a server and never uses your microphone.

* **Tab only capture:** Uses `chrome.tabCapture` and a hidden background page (`src/offscreen/offscreen.js`) to record only the active browser tab. Your own microphone and other desktop apps are never recorded.
* **Screen and audio or audio only:** In the extension popup, **Record screen** is checked by default (records video up to 1920x1080 at 8 frames per second and 180 kbps, plus 16 kbps Opus audio). Uncheck it to save disk space with audio only capture.
* **Private local storage (OPFS):** Video (`video.webm`) and 10 minute overlapping Opus audio segments (`audio/`) stream directly to your browser's Origin Private File System (`opfs-writer.worker.js`). Nothing leaves your device during a call.
* **Crash recovery:** A periodic heartbeat saves your recording progress so interrupted sessions recover cleanly if the browser restarts.
* **Reclaim disk space:** Inside the dashboard, **Free Media Space** deletes raw `video.webm` and `audio/` files while keeping your transcript, slides, and generated notes intact.

## How Microsoft Whiteboard Capture Works

Standard screen video at 8 frames per second can blur thin handwriting, or your professor may draw on a separate Microsoft Whiteboard tab. MyTems solves this by reading the whiteboard drawings directly from the page and saving crisp PNG images.

### 1. Setup and Capture Modes

MyTems supports whiteboards inside Teams (`teams.microsoft.com`, `teams.cloud.microsoft`) and standalone Microsoft Whiteboard (`whiteboard.office.com`, `*.whiteboard.microsoft.com`). In **Settings** (or via the **Capture MS Whiteboard** checkbox in the popup before you start recording), pick one of three modes:

* **Off:** Never attaches the whiteboard listener.
* **Matching Meetings Only:** Attaches automatically when the browser tab title matches any comma or newline separated keyword in **Whiteboard Meeting Keywords** (for example `Algebra, Calculus, Math`).
* **Always On:** Attaches to every recording.

Checking **Capture MS Whiteboard** in the popup overrides your saved setting for that single recording and asks for the optional `scripting` and whiteboard site permissions if not granted yet.

### 2. How It Reads and Renders the Board

When recording starts with whiteboard capture enabled, MyTems injects `src/content/whiteboard-capture.js` into the tab and all its nested frames:

1. **Stroke detection:** It looks for Microsoft Whiteboard's `#canvasContent` container and collects all `.canvasChildElement svg` drawing elements, ignoring background grids and rulers.
2. **Viewport framing:** It calculates the bounding box around only the strokes currently visible on your screen (plus 24 pixels of padding). Offscreen zoomed out history is ignored so your current equations stay sharp.
3. **Clean rasterization:** Each SVG stroke is cloned with its computed colors and line widths, drawn onto a white background canvas up to 1920x1080 pixels, and saved as a PNG image.
4. **Fallback surface:** If `#canvasContent` is absent (such as an embedded canvas whiteboard), it picks the largest active SVG or canvas element at least 250x250 pixels and captures that instead.

### 3. Smart Timing, Wipe Protection, and Deduplication

MyTems polls the board every 5 seconds and uses a settle controller (`createWhiteboardSettleController`) so you get clean boards instead of half drawn lines:

* **Settle delay (5 seconds):** Waits until the speaker stops drawing for 5 seconds before saving the frame.
* **Nonstop writing cap (60 seconds):** If the speaker writes continuously without pausing, MyTems flushes a frame after 60 seconds so long derivations are never missed.
* **Pre wipe capture:** If the number of strokes on screen suddenly drops below 50% of the pending frame (meaning the board was just erased or cleared), MyTems immediately saves the old board *before* tracking the new one.
* **Hash deduplication and cooldown:** The background service worker computes an FNV1a hash of every incoming PNG. Exact duplicates are skipped, a 10 second minimum cooldown applies between saved frames, and up to 240 whiteboard frames can be saved per lecture as `slides/001_<sec>_wb.png`.
* **Vision AI sampling:** When you generate notes, MyTems sends up to 60 slides chronologically (always keeping the first and last slide) to the AI model so diagrams and equations on the board correct speech recognition mistakes.

## Slides, Manual Snaps, and Cleanup Tools

Even without Microsoft Whiteboard, MyTems extracts visual slides locally at \$0 cost:

* **Extract Slides (\$0):** Scans `video.webm` every 4 seconds, compares downscaled 160x90 frames, and saves a JPEG whenever at least 4% of pixels change (with an 8 second cooldown, up to 50 slides).
* **Snap Slide at Current Time:** Pause the video player on any frame and click **Snap Slide at Current Time** to save that exact moment.
* **Attach Whiteboard / Slide:** Upload any local image (screenshots, phone photos of a physical board, or PDF slide exports) straight into the lecture's slide strip.
* **Slide Viewer and Reordering:** Click any thumbnail to inspect it full size, jump the video to its timestamp, move frames left or right in order, or delete individual frames.
* **Dedupe Filter:** Scans your slide strip for duplicate or near duplicate frames using four sensitivity levels (`Exact`, `Near (0.3%)`, `Similar (1%)`, `Loose (3%)`) and lets you remove selected duplicates in one click.

## AI Toggle, Expert Mode, and Provider Routing

AI features are completely optional and run only when you click a processing button.

* **Global AI Toggle (`AI: On` / `AI: Off`):** Located in the dashboard header and in Settings. Turning AI off blocks all transcription and note generation network requests so MyTems acts purely as a \$0 local recorder and slide tool.
* **Automatic Bilingual Detection:** Romanian and English (including mixed sentences) are detected automatically by Whisper. There is no language selector to misconfigure.
* **Course Hint and Presets:** Type a short topic hint (or pick a preset like `RO Math (Inducție / Serii)`) so speech recognition and note generation spell technical terms accurately.
* **Multi speaker toggle:** Marks the recording as having multiple speakers so notes separate questions from answers and track who owns each action item.
* **Expert Mode:** Off by default to keep Settings uncluttered. Turn on **Expert Mode** in Settings to configure:
  * **Cloud Dispatch (OpenRouter):** Enter your OpenRouter API key, set custom STT (`openai/whisper-large-v3`) and Summary/Vision (`google/gemini-2.5-flash`) models, choose a **Provider Routing Strategy** (`Default (Auto)`, `Moritz Budget` for cheapest `sort: price`, or `Lenny Speed` for fastest `sort: throughput`), list **Preferred Providers**, and optionally enable **Experimental Exam Radar Calibration via OpenRouter Jev (`typesafe/jev-latest`)**.
  * **Local Basement Node:** Point MyTems at local HTTP OpenAI compatible servers (defaulting to `http://localhost:8080/v1/audio/transcriptions` for STT and `http://localhost:11434/v1/chat/completions` for Vision/LLM, such as whisper.cpp and Ollama) for 100% offline AI processing.
  * **Drop Relay URL:** Change the signaling server used for peer to peer sharing (defaults to `https://ntfy.sh`).

## Two Stage AI Pipeline and Note Modes

* **Transcribe Only (\$0 LLM):** Sends only audio segments to speech to text and builds a timestamped, searchable bilingual transcript (`transcript.json`).
* **Generate Notes:** Automatically transcribes if missing, extracts video slides if none exist, and generates structured `notes.json` containing a summary, timecoded chapters, key definitions, slide references, and an **Exam & Deadline Radar**, along with an exact per lecture cost receipt.
* **Four Note Modes:**
  * `Math / Theory`: Verifies derivations, flags board slips, and formats equations in LaTeX.
  * `Coding / CS`: Recovers exact code syntax, identifiers, CLI commands, and multi line code blocks.
  * `Architecture / Diagrams`: Treats block diagrams, datapaths, pipelines, circuits, and waveforms as primary truth and attaches them to chapters.
  * `Meeting / Sync`: Focuses on decisions, action items, owners, and deadlines.

## Catalog, Study Workbench, Multi Part Lessons, and Exam Radar

* **Catalog View:** Browse all recordings with instant search and status filters (`All Drops`, `Notes Ready`, `STT Only ($0 LLM)`, `Raw Capture`).
* **Study Workbench:** Watch the recorded video alongside your slide strip, Study Notes or Transcript tabs, and Exam & Deadline Radar. Clicking any `MM:SS` timestamp, chapter, definition, slide, or radar item jumps the video directly to that second.
* **Subject and Multi Part Grouping:** Organize recordings into `Subject -> Lesson -> Parts` using the Subject field, **Group / Rename Lesson**, or multi select batch actions. Generating notes on a multi part lesson synthesizes all parts into one connected study guide without repeating introductions.
* **Global Exam & Deadline Radar:** A dedicated sidebar view that collects every exam hint, homework assignment, and deadline across all your lectures in one place.
* **Darknet Mode:** Switch between light paper mode and dark mode from the top bar.

## Notion and ZIP Export

* **Copy Notion MD:** Available once AI notes exist. Copies clean Notion ready Markdown with callout blocks for Exam Radar, LaTeX math, fenced code blocks, and timestamps.
* **Export .zip:** Packages `notes.md` (or `transcript.txt` if unparsed), all `slides/` images, and audio segments (for audio only recordings) into a single `.zip` file.
* **Download .webm / Audio:** Downloads the raw recorded video file directly, or a `.zip` of audio segments for audio only sessions.

## Dead Drop P2P Sharing and `.mytems` Bundles

Share lectures directly with classmates without uploading files to any cloud drive.

* **Selective Layer Sharing:** Pick which lesson parts and which layers to include (`Video`, `Audio Segments`, `Slides & Whiteboard`, `Transcript`, `Notes & Exam Radar`) with live payload size totals.
* **Live P2P Drop Code:** Generates an 8 character code (for example `BUBA-4829`), exchanges connection signals via `ntfy.sh` (or your custom relay), and transfers data directly browser to browser over WebRTC DataChannels.
* **Offline `.mytems` Bundles:** Export a `.mytems` archive file or import one via **Receive Drop**, complete with a content preview and duplicate handling (`Keep as Copy`, `Overwrite Existing Local Drop`, `Skip Duplicates`).

## Tech Stack

* Chromium Manifest V3 extension (`manifest.json`)
* Native ES modules, HTML, and CSS (zero runtime dependencies, no bundler)
* Storage: Chrome `storage` and Origin Private File System (OPFS)
* Tests: [Bun](https://bun.sh/) (`bun test`)

## Getting Started

### For Colleagues (Quick Install, No Git Needed)

1. Download the latest release: [**`mytems.zip`**](https://github.com/LightAndy1/MyTems/releases/latest/download/mytems.zip)
2. Unzip it somewhere permanent (for example `Documents/MyTems`).
3. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`) in your browser.
4. Turn on **Developer mode** (top right toggle).
5. Click **Load unpacked** and select the unzipped `MyTems` folder.

### Updating Later

When the extension notifies you of a new version (or via **Settings -> Check for Updates**):

1. Click **Download Update (.zip)**.
2. Unzip and **replace** your existing `MyTems` folder (keeping the same folder preserves all your recordings and settings).
3. Open `chrome://extensions` and click **Reload** (`↻`) on MyTems.

### For Developers

1. Clone the repository:
   ```sh
   git clone https://github.com/LightAndy1/MyTems.git
   ```
2. Open `chrome://extensions` (or `helium://extensions`) in your Chromium browser, enable **Developer mode**, and click **Load unpacked** on the cloned `MyTems` directory.
3. Every push to `main` automatically runs `bun test`, bumps the patch version in `manifest.json`, tags `vX.Y.Z`, and publishes `mytems.zip` to GitHub Releases. To ship a minor or major bump, update `"version"` in `manifest.json` before pushing; add `[skip release]` to a commit message to skip releasing.

## Development and Testing

Run the test suite with Bun:

```sh
bun test
```

## Project Structure

* `manifest.json`: Manifest V3 configuration and permissions
* `src/background/`: Extension service worker and whiteboard frame tracker
* `src/content/`: Injected Microsoft Whiteboard DOM/SVG/canvas capture script
* `src/offscreen/`: Offscreen media capture and OPFS segment writer
* `src/popup/`: Extension popup UI
* `src/dashboard/`: Catalog, study workbench, global Exam Radar, Dead Drop modals, and settings
* `src/shared/`: Grouping, storage, OPFS helpers, whiteboard logic, P2P Dead Drop, Notion export, and updater
* `tests/`: Unit tests (`bun test`)
