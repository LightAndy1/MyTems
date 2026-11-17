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
import { runLecturePipeline } from './pipeline.js';

const el = (id) => document.getElementById(id);
const SETTING_FIELDS = [
  'openrouterApiKey',
  'sttModel',
  'llmModel',
  'localSttUrl',
  'localSttModel',
  'localLlmUrl',
  'localLlmModel',
  'defaultCourseHint',
];

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
  const lectures = (await listLectures()).filter((l) => (l.title || '').toLowerCase().includes(filter));
  const listEl = el('lectureList');
  listEl.innerHTML = '';

  for (const lec of lectures) {
    const li = document.createElement('li');
    li.className = `lecture-item${lec.id === selectedId ? ' active' : ''}`;
    const titleEl = document.createElement('strong');
    titleEl.textContent = lec.title || 'Teams Lecture';
    const metaEl = document.createElement('div');
    metaEl.className = 'muted small';
    metaEl.textContent = `${String(lec.createdAt || '').slice(0, 10)} · ${formatTimestamp(lec.durationSec)} · ${lec.status}`;
    li.append(titleEl, metaEl);
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
    if (q && !(seg.text || '').toLowerCase().includes(q)) continue;
    const row = document.createElement('div');
    row.append(makeTimestampBtn(seg.startSec), document.createTextNode(` ${seg.text || ''}`));
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
    const img = document.createElement('img');
    img.src = url;
    img.alt = `Slide at ${formatTimestamp(sec)}`;
    const caption = document.createElement('span');
    caption.textContent = formatTimestamp(sec);
    btn.append(img, caption);
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

  const radarList = el('radarList');
  const chaptersEl = el('chaptersContainer');
  const defsEl = el('definitionsContainer');
  radarList.innerHTML = '';
  chaptersEl.innerHTML = '';
  defsEl.innerHTML = '';

  if (!hasNotes) {
    el('costReceipt').textContent = '';
    el('notesSummary').textContent = '';
    return;
  }

  el('costReceipt').textContent = `Cost: $${(notes.totalCostUsd || 0).toFixed(4)} (STT $${(notes.sttCostUsd || 0).toFixed(4)} + LLM $${(notes.llmCostUsd || 0).toFixed(4)})`;
  el('notesSummary').textContent = notes.summary || '';

  for (const item of notes.examRadar || []) {
    const li = document.createElement('li');
    const due = item.dueDate ? ` (Due: ${item.dueDate})` : '';
    li.append(
      document.createTextNode(`[${String(item.type || 'note').toUpperCase()}] ${item.text || ''}${due} `),
      makeTimestampBtn(item.timestampSec)
    );
    radarList.appendChild(li);
  }

  for (const ch of notes.chapters || []) {
    const sec = document.createElement('article');
    const h4 = document.createElement('h4');
    h4.append(document.createTextNode(`${ch.title || ''} `), makeTimestampBtn(ch.startSec));
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

  if (notes.definitions?.length) {
    const h4 = document.createElement('h4');
    h4.textContent = 'Definitions';
    defsEl.appendChild(h4);
    for (const d of notes.definitions) {
      const p = document.createElement('p');
      p.append(document.createTextNode(`${d.term || ''}: ${d.definition || ''} `), makeTimestampBtn(d.timestampSec));
      defsEl.appendChild(p);
    }
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
  el('lecTitle').textContent = lec.title || 'Teams Lecture';
  el('lecCourseHint').value = lec.courseHint || '';
  const bytes = await getLectureMediaBytes(id);
  el('lecMeta').textContent = `${String(lec.createdAt || '').slice(0, 10)} · ${formatTimestamp(lec.durationSec)} · ${(bytes / 1048576).toFixed(1)} MB · ${lec.status}`;
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
  await selectLecture(selectedId);
});

el('downloadVideoBtn').addEventListener('click', async () => {
  if (!selectedId) return;
  const [lec, file] = await Promise.all([getLecture(selectedId), readLectureFile(selectedId, 'video.webm')]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = `${String(lec?.createdAt || '').slice(0, 10)}_${toSafeFilename(lec?.title)}.webm`;
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
  const id = selectedId;
  selectedId = null;
  revokeObjectUrls();
  renderNotes(null);
  currentTranscript = null;
  await deleteLectureDir(id);
  await deleteLectureMeta(id);
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
  a.download = `${String(lec?.createdAt || '').slice(0, 10)}_${toSafeFilename(lec?.title)}_notion.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
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
  await saveSettings(patch);
  modal.close();
});

window.addEventListener('hashchange', () => {
  if (location.hash === '#settings') openSettingsModal();
});

async function init() {
  const contexts = await chrome.runtime?.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
  const active = contexts?.length ? await getActiveSession() : null;
  await recoverStaleRecordings(active?.lectureId || null);
  await renderLectureList();
  const list = await listLectures();
  if (list.length) await selectLecture(list[0].id);
  if (location.hash === '#settings') await openSettingsModal();
}

init();
