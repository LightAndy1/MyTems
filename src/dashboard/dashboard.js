import { WHITEBOARD_ORIGINS } from '../shared/constants.js';
import { formatTimestamp, toSafeFilename } from '../shared/sanitize.js';
import {
  deleteLectureMeta,
  getActiveSession,
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
import { runLecturePipeline, runTranscriptionOnly } from './pipeline.js';

const el = (id) => document.getElementById(id);
let selectedId = null;
let selectSeq = 0;
let currentVideoUrl = null;
let slideUrls = [];
let slideEntries = [];
let currentNotes = null;
let currentTranscript = null;
let activeTab = 'notes';

function revokeSlideUrls() {
  for (const u of slideUrls) URL.revokeObjectURL(u);
  slideUrls = [];
  slideEntries = [];
}

function revokeObjectUrls() {
  if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
  currentVideoUrl = null;
  revokeSlideUrls();
}

function setBanner(msg, isError = false) {
  const banner = el('statusBanner');
  banner.textContent = msg || '';
  banner.hidden = !msg;
  banner.classList.toggle('is-error', Boolean(msg && isError));
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
  btn.type = 'button';
  btn.className = 'ts-link';
  btn.textContent = formatTimestamp(sec);
  btn.addEventListener('click', () => seekTo(sec));
  return btn;
}

function setStudyTab(tab) {
  activeTab = tab;
  const isNotes = tab === 'notes';
  el('tabNotesBtn').classList.toggle('active', isNotes);
  el('tabNotesBtn').setAttribute('aria-selected', String(isNotes));
  el('tabTranscriptBtn').classList.toggle('active', !isNotes);
  el('tabTranscriptBtn').setAttribute('aria-selected', String(!isNotes));
  el('notesTabPanel').hidden = !isNotes;
  el('transcriptTabPanel').hidden = isNotes;
}

function highlightActiveSlide(currentSec) {
  let activeIdx = -1;
  for (let i = 0; i < slideEntries.length; i++) {
    if (slideEntries[i].sec <= currentSec + 0.5) activeIdx = i;
  }
  slideEntries.forEach((entry, i) => {
    entry.btn.classList.toggle('active', i === activeIdx);
  });
}

async function renderLectureList() {
  const filter = el('lectureFilter').value.trim().toLowerCase();
  const lectures = (await listLectures()).filter((l) => l.title.toLowerCase().includes(filter));
  const listEl = el('lectureList');
  listEl.innerHTML = '';

  for (const lec of lectures) {
    const li = document.createElement('li');
    li.className = `lecture-item${lec.id === selectedId ? ' active' : ''}`;

    const titleDiv = document.createElement('div');
    titleDiv.className = 'lecture-item-title';
    titleDiv.textContent = lec.title;

    const metaDiv = document.createElement('div');
    metaDiv.className = 'lecture-item-meta';
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    dot.dataset.status = lec.status;
    const text = document.createTextNode(
      `${lec.createdAt.slice(0, 10)} · ${formatTimestamp(lec.durationSec)} · ${lec.status}`
    );
    metaDiv.append(dot, text);

    li.append(titleDiv, metaDiv);
    li.addEventListener('click', () => selectLecture(lec.id));
    listEl.appendChild(li);
  }
}

function renderTranscript(query = '') {
  const container = el('transcriptLines');
  container.innerHTML = '';
  if (!currentTranscript?.segments?.length) return;
  const q = query.trim().toLowerCase();
  for (const seg of currentTranscript.segments) {
    if (q && !seg.text.toLowerCase().includes(q)) continue;
    const row = document.createElement('div');
    row.className = 'transcript-row';
    const textSpan = document.createElement('span');
    textSpan.textContent = seg.text;
    row.append(makeTimestampBtn(seg.startSec), textSpan);
    container.appendChild(row);
  }
}

async function renderSlides(lectureId, seq = selectSeq) {
  revokeSlideUrls();
  const files = await listDirFiles(lectureId, 'slides');
  if (seq !== selectSeq) return [];
  const grid = el('slidesGrid');
  grid.innerHTML = '';
  el('slidesStrip').hidden = files.length === 0;
  el('slidesCount').textContent = `${files.length}`;

  for (const f of files) {
    const file = await readLectureFile(lectureId, `slides/${f}`);
    if (seq !== selectSeq) {
      revokeSlideUrls();
      return [];
    }
    const url = URL.createObjectURL(file);
    slideUrls.push(url);
    const sec = Number(f.split('_')[1]?.split('.')[0] || 0);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slide-thumb';
    const img = document.createElement('img');
    img.src = url;
    img.alt = `Slide at ${formatTimestamp(sec)}`;
    const label = document.createElement('span');
    label.textContent = formatTimestamp(sec);
    btn.append(img, label);
    btn.addEventListener('click', () => seekTo(sec));
    grid.appendChild(btn);
    slideEntries.push({ sec, btn });
  }
  highlightActiveSlide(el('videoPlayer').currentTime || 0);
  return files;
}

function renderStudyDesk() {
  const hasNotes = Boolean(currentNotes);
  const hasTranscript = Boolean(currentTranscript?.segments?.length);

  el('copyNotionBtn').disabled = !hasNotes;
  el('zipNotionBtn').disabled = !hasNotes;
  el('transcribeOnlyBtn').textContent = hasTranscript ? 'Re-transcribe ($0 LLM)' : 'Transcribe Only ($0 LLM)';
  el('summarizeBtn').textContent = hasNotes ? 'Regenerate Notes' : 'Generate Notes';

  el('radarCard').hidden = !(currentNotes?.examRadar?.length);
  el('unprocessedCard').hidden = hasNotes || hasTranscript;
  el('studyCard').hidden = !(hasNotes || hasTranscript);
  el('tabNotesBtn').disabled = !hasNotes;
  el('tabTranscriptBtn').disabled = !hasTranscript;

  const costPill = el('costReceipt');
  if (hasNotes) {
    costPill.hidden = false;
    costPill.textContent = `$${(currentNotes.totalCostUsd || 0).toFixed(4)} (STT $${(currentNotes.sttCostUsd || 0).toFixed(4)} + LLM $${(currentNotes.llmCostUsd || 0).toFixed(4)})`;
  } else if (hasTranscript) {
    costPill.hidden = false;
    costPill.textContent = `STT $${(currentTranscript.sttCostUsd || 0).toFixed(4)} ($0 LLM)`;
  } else {
    costPill.hidden = true;
  }

  const radarList = el('radarList');
  radarList.innerHTML = '';
  const chaptersEl = el('chaptersContainer');
  chaptersEl.innerHTML = '';
  const defsEl = el('definitionsContainer');
  defsEl.innerHTML = '';
  el('notesSummary').textContent = '';

  if (hasNotes) {
    el('notesSummary').textContent = currentNotes.summary;
    for (const item of currentNotes.examRadar || []) {
      const li = document.createElement('li');
      const due = item.dueDate ? ` (Due: ${item.dueDate})` : '';
      li.append(
        document.createTextNode(`[${String(item.type).toUpperCase()}] ${item.text}${due} `),
        makeTimestampBtn(item.timestampSec)
      );
      radarList.appendChild(li);
    }

    for (const ch of currentNotes.chapters || []) {
      const sec = document.createElement('article');
      sec.className = 'chapter';
      const h4 = document.createElement('h4');
      h4.append(document.createTextNode(ch.title), makeTimestampBtn(ch.startSec));
      const ul = document.createElement('ul');
      for (const b of ch.bullets || []) {
        const li = document.createElement('li');
        li.textContent = b;
        ul.appendChild(li);
      }
      for (const f of ch.formulas || []) {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = f;
        li.appendChild(code);
        ul.appendChild(li);
      }
      sec.append(h4, ul);
      chaptersEl.appendChild(sec);
    }

    if (currentNotes.definitions?.length) {
      const defHeading = document.createElement('h4');
      defHeading.textContent = 'Key Definitions';
      defsEl.appendChild(defHeading);
      for (const d of currentNotes.definitions) {
        const p = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = d.term;
        p.append(strong, document.createTextNode(`: ${d.definition} `), makeTimestampBtn(d.timestampSec));
        defsEl.appendChild(p);
      }
    }
  }

  if (hasNotes && activeTab !== 'transcript') setStudyTab('notes');
  else if (hasTranscript && !hasNotes) setStudyTab('transcript');
  else if (hasNotes) setStudyTab(activeTab);
}

async function selectLecture(id) {
  const seq = ++selectSeq;
  selectedId = id;
  revokeObjectUrls();
  el('storageMenu').open = false;
  await renderLectureList();
  if (seq !== selectSeq) return;

  const lec = await getLecture(id);
  if (seq !== selectSeq) return;
  if (!lec) {
    el('emptyState').hidden = false;
    el('lectureView').hidden = true;
    return;
  }

  el('emptyState').hidden = true;
  el('lectureView').hidden = false;
  el('lecTitle').textContent = lec.title;
  el('lecCourseHint').value = lec.courseHint || '';
  const isRecording = lec.status === 'recording';
  el('freeMediaBtn').disabled = isRecording;
  el('deleteLectureBtn').disabled = isRecording;

  const bytes = await getLectureMediaBytes(id);
  if (seq !== selectSeq) return;
  el('lecMeta').textContent = `${lec.createdAt.slice(0, 10)} · ${formatTimestamp(lec.durationSec)} · ${(bytes / 1048576).toFixed(1)} MB · ${lec.status}`;
  setBanner(lec.error || '', Boolean(lec.error));

  const player = el('videoPlayer');
  try {
    const videoFile = await readLectureFile(id, 'video.webm');
    if (seq !== selectSeq) return;
    currentVideoUrl = URL.createObjectURL(videoFile);
    player.src = currentVideoUrl;
    player.hidden = false;
    el('mediaFreedNote').hidden = true;
    el('snapSlideBtn').hidden = false;
    el('downloadVideoBtn').disabled = false;
  } catch {
    if (seq !== selectSeq) return;
    player.hidden = true;
    player.removeAttribute('src');
    el('mediaFreedNote').hidden = false;
    el('snapSlideBtn').hidden = true;
    el('downloadVideoBtn').disabled = true;
  }

  const [transcript, notes] = await Promise.all([
    readLectureJson(id, 'transcript.json'),
    readLectureJson(id, 'notes.json'),
  ]);
  if (seq !== selectSeq) return;
  currentTranscript = transcript;
  currentNotes = notes;
  activeTab = notes ? 'notes' : 'transcript';
  renderTranscript(el('transcriptSearch').value);
  await renderSlides(id, seq);
  if (seq !== selectSeq) return;
  renderStudyDesk();
}

async function runWithBusyButtons(fn) {
  el('transcribeOnlyBtn').disabled = true;
  el('summarizeBtn').disabled = true;
  try {
    await fn();
  } finally {
    el('transcribeOnlyBtn').disabled = false;
    el('summarizeBtn').disabled = false;
  }
}

el('transcribeOnlyBtn').addEventListener('click', () => {
  if (!selectedId) return;
  const targetId = selectedId;
  const force = Boolean(currentTranscript);
  runWithBusyButtons(async () => {
    setBanner('Starting transcription ($0 LLM)...');
    try {
      await runTranscriptionOnly({
        lectureId: targetId,
        courseHint: el('lecCourseHint').value,
        force,
        onStage: (msg) => setBanner(msg),
      });
      activeTab = 'transcript';
      await selectLecture(targetId);
      setBanner('Transcription complete ($0 LLM spent). Switch to Generate Notes anytime.');
    } catch (err) {
      setBanner(err?.message || String(err), true);
    }
  });
});

el('summarizeBtn').addEventListener('click', () => {
  if (!selectedId) return;
  const targetId = selectedId;
  runWithBusyButtons(async () => {
    setBanner('Preparing AI pipeline...');
    try {
      await runLecturePipeline({
        lectureId: targetId,
        courseHint: el('lecCourseHint').value,
        onStage: (msg) => setBanner(msg),
      });
      activeTab = 'notes';
      await selectLecture(targetId);
    } catch (err) {
      setBanner(err?.message || String(err), true);
    }
  });
});

el('snapSlideBtn').addEventListener('click', async () => {
  if (!selectedId) return;
  try {
    const targetId = selectedId;
    const player = el('videoPlayer');
    await captureCurrentVideoFrame(player, targetId, player.currentTime);
    if (selectedId === targetId) await renderSlides(targetId);
  } catch (err) {
    setBanner(err?.message || String(err), true);
  }
});

el('attachImagesBtn').addEventListener('click', () => el('attachImagesInput').click());
el('attachImagesInput').addEventListener('change', async (e) => {
  const targetId = selectedId;
  if (!targetId || !e.target.files?.length) return;
  try {
    const existing = await listDirFiles(targetId, 'slides');
    let nextNum = existing.length + 1;
    const sec = Math.max(0, Math.floor(el('videoPlayer').currentTime || 0));
    for (const file of e.target.files) {
      const ext = file.name.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
      const filename = `${String(nextNum++).padStart(3, '0')}_${sec}.${ext}`;
      await writeLectureFile(targetId, `slides/${filename}`, new Uint8Array(await file.arrayBuffer()));
    }
    e.target.value = '';
    if (selectedId === targetId) await renderSlides(targetId);
  } catch (err) {
    setBanner(err?.message || String(err), true);
  }
});

el('downloadVideoBtn').addEventListener('click', async () => {
  el('storageMenu').open = false;
  if (!selectedId) return;
  try {
    const [lec, file] = await Promise.all([getLecture(selectedId), readLectureFile(selectedId, 'video.webm')]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = `${lec.createdAt.slice(0, 10)}_${toSafeFilename(lec.title)}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (err) {
    setBanner(err?.message || String(err), true);
  }
});

el('freeMediaBtn').addEventListener('click', async () => {
  el('storageMenu').open = false;
  if (!selectedId) return;
  try {
    await freeLectureMedia(selectedId);
    await selectLecture(selectedId);
  } catch (err) {
    setBanner(err?.message || String(err), true);
  }
});

el('deleteLectureBtn').addEventListener('click', async () => {
  el('storageMenu').open = false;
  if (!selectedId) return;
  try {
    const idToDelete = selectedId;
    selectSeq += 1;
    selectedId = null;
    currentNotes = null;
    currentTranscript = null;
    revokeObjectUrls();
    el('videoPlayer').removeAttribute('src');
    await deleteLectureDir(idToDelete);
    await deleteLectureMeta(idToDelete);
    el('emptyState').hidden = false;
    el('lectureView').hidden = true;
    await renderLectureList();
  } catch (err) {
    setBanner(err?.message || String(err), true);
  }
});

el('copyNotionBtn').addEventListener('click', async () => {
  if (!selectedId || !currentNotes) return;
  try {
    const [lec, slides] = await Promise.all([getLecture(selectedId), listDirFiles(selectedId, 'slides')]);
    await navigator.clipboard.writeText(notesToNotionMarkdown(lec, currentNotes, slides));
    setBanner('Copied Notion-ready Markdown to clipboard.');
  } catch (err) {
    setBanner(err?.message || String(err), true);
  }
});

el('zipNotionBtn').addEventListener('click', async () => {
  if (!selectedId || !currentNotes) return;
  try {
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
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (err) {
    setBanner(err?.message || String(err), true);
  }
});

el('tabNotesBtn').addEventListener('click', () => setStudyTab('notes'));
el('tabTranscriptBtn').addEventListener('click', () => setStudyTab('transcript'));
el('videoPlayer').addEventListener('timeupdate', () => highlightActiveSlide(el('videoPlayer').currentTime || 0));
el('lectureFilter').addEventListener('input', renderLectureList);
el('transcriptSearch').addEventListener('input', (e) => renderTranscript(e.target.value));

document.addEventListener('click', (e) => {
  const menu = el('storageMenu');
  if (menu.open && !menu.contains(e.target)) menu.open = false;
});

const modal = el('settingsModal');
const form = el('settingsForm');
const SETTING_FIELDS = [
  'openrouterApiKey',
  'sttModel',
  'llmModel',
  'providerRouting',
  'preferredProviders',
  'localSttUrl',
  'localSttModel',
  'localLlmUrl',
  'localLlmModel',
  'defaultCourseHint',
  'whiteboardMode',
  'whiteboardMeetings',
];
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
  for (const name of SETTING_FIELDS) {
    form.elements[name].value = s[name] || '';
  }
  syncModeUI(s.providerMode);
  if (!modal.open) modal.showModal();
}

for (const btn of form.querySelectorAll('.seg-btn')) {
  btn.addEventListener('click', () => syncModeUI(btn.dataset.mode));
}
el('openSettingsBtn').addEventListener('click', openSettingsModal);
el('closeSettingsBtn').addEventListener('click', () => modal.close());
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = { providerMode: modalMode };
  for (const name of SETTING_FIELDS) {
    patch[name] = form.elements[name].value.trim();
  }
  if (patch.whiteboardMode !== 'off' && chrome.permissions?.request) {
    let granted = false;
    try {
      granted = await chrome.permissions.request({
        permissions: ['scripting'],
        origins: WHITEBOARD_ORIGINS,
      });
    } catch {
      granted = false;
    }
    if (!granted) {
      patch.whiteboardMode = 'off';
      setBanner('Whiteboard permission denied; kept Off.', true);
    }
  }
  await saveSettings(patch);
  modal.close();
});

window.addEventListener('hashchange', () => {
  if (location.hash === '#settings') openSettingsModal();
});

async function init() {
  const contexts = chrome.runtime?.getContexts
    ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
    : [];
  const active = contexts.length ? await getActiveSession() : null;
  await recoverStaleRecordings(active?.lectureId || null);
  await renderLectureList();
  const list = await listLectures();
  if (list.length) await selectLecture(list[0].id);
  if (location.hash === '#settings') await openSettingsModal();
}

if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  init().catch((err) => setBanner(err?.message || String(err), true));
}
