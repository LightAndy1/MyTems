import { HINT_PRESETS, NOTE_MODES, WHITEBOARD_ORIGINS, resolveNoteMode } from '../shared/constants.js';
import {
  buildDownloadFilename,
  formatLocalDateTimeParts,
  formatTimestamp,
  toSafeFilename,
} from '../shared/sanitize.js';
import {
  STANDALONE_PREFIX,
  buildLibraryTree,
  findPreviousSubjectLesson,
  resolveLectureSubject,
} from '../shared/grouping.js';
import {
  deleteLectureMeta,
  getActiveSession,
  getLecture,
  getSettings,
  listLectures,
  recoverStaleRecordings,
  saveSettings,
  updateLectures,
} from '../shared/storage.js';
import {
  deleteLectureDir,
  deleteLessonDir,
  freeLectureMedia,
  getLectureMediaBytes,
  listDirFiles,
  readLectureFile,
  readLectureJson,
  readLessonJson,
  writeLectureFile,
} from '../shared/opfs.js';
import { notesToNotionMarkdown } from '../shared/notion.js';
import { buildStoreZip } from '../shared/zip.js';
import { captureCurrentVideoFrame } from './slides.js';
import {
  runLecturePipeline,
  runLessonPipeline,
  runLessonTranscription,
  runSlidesOnly,
  runTranscriptionOnly,
} from './pipeline.js';

const el = (id) => document.getElementById(id);

let libraryTree = { subjects: [], lessonsById: new Map(), partMetaById: new Map() };
let activeStoreView = 'catalog';
let catalogStatusFilter = 'all';
let activeViewMode = 'lecture';
let activeLessonId = null;
let selectedId = null;
let focusedPartId = null;
let selectSeq = 0;
let currentVideoUrl = null;
let slideUrls = [];
let slideEntries = [];
let currentNotes = null;
let currentTranscript = null;
let activeTab = 'notes';
let multiSelectMode = false;
let checkedIds = new Set();
const collapsedSubjects = new Set();
const collapsedLessons = new Set();
let groupModalTargetIds = [];

const STORE_VIEW_TITLES = {
  catalog: 'MyTems Clearnet Catalog',
  workbench: 'Study Workbench',
  radar: 'Exam & Deadline Radar',
};

function switchStoreView(view) {
  activeStoreView = view;
  el('catalogView').hidden = view !== 'catalog';
  el('workbenchView').hidden = view !== 'workbench';
  el('radarView').hidden = view !== 'radar';
  el('toggleRailBtn').hidden = view !== 'workbench';
  el('storeViewTitle').textContent = STORE_VIEW_TITLES[view] || 'MyTems';
  for (const btn of document.querySelectorAll('.dock-btn[data-store-view]')) {
    btn.classList.toggle('active', btn.dataset.storeView === view);
  }
  if (view === 'radar') {
    renderGlobalRadar().catch((err) => setBanner(err?.message || String(err), true));
  }
}

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const btn = el('themeToggleBtn');
  if (btn) {
    const isDark =
      theme === 'dark' ||
      (!theme && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    btn.textContent = isDark ? 'Clearnet Light' : 'Darknet Mode';
  }
}

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

function triggerBlobDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function syncActiveRailSelection() {
  const highlightedPartId = activeViewMode === 'lesson' ? focusedPartId : selectedId;
  for (const item of el('lectureList').querySelectorAll('.lecture-item')) {
    item.classList.toggle('active', item.dataset.lectureId === highlightedPartId);
  }
  for (const header of el('lectureList').querySelectorAll('.lesson-header')) {
    header.classList.toggle(
      'active',
      activeViewMode === 'lesson' && header.dataset.lessonId === activeLessonId
    );
  }
}

async function seekTo(sec, partId = null) {
  const player = el('videoPlayer');
  if (partId && partId !== selectedId) {
    const seq = selectSeq;
    selectedId = partId;
    if (activeViewMode === 'lesson') focusedPartId = partId;
    const lesson = activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
    renderPartSwitcher(lesson);
    syncActiveRailSelection();
    await loadVideoPart(partId, seq);
    if (seq !== selectSeq) return;
    currentTranscript = await readLectureJson(partId, 'transcript.json');
    if (seq !== selectSeq) return;
    renderTranscript(el('transcriptSearch').value);
    if (!player.hidden && player.src) {
      await new Promise((resolve) => {
        if (player.readyState >= 1) return resolve();
        player.addEventListener('loadedmetadata', resolve, { once: true });
      });
    }
  }
  highlightActiveSlide(sec);
  if (!player.hidden && player.src) {
    player.currentTime = Math.max(0, sec);
    player.play().catch(() => {});
  }
}

function makeTimestampBtn(sec, partId = null, partIndex = null) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ts-link';
  const showPart = activeViewMode === 'lesson' && Number.isFinite(Number(partIndex));
  btn.textContent = showPart ? `Pt ${partIndex} · ${formatTimestamp(sec)}` : formatTimestamp(sec);
  btn.addEventListener('click', () => seekTo(sec, partId));
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
    const entry = slideEntries[i];
    if (entry.partId && entry.partId !== selectedId) continue;
    if (entry.sec <= currentSec + 0.5) activeIdx = i;
  }
  slideEntries.forEach((entry, i) => {
    entry.btn.classList.toggle('active', i === activeIdx);
  });
}

function makeChevronSvg() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 9l6 6 6-6');
  svg.appendChild(path);
  return svg;
}

function makeQuickDownloadBtn(title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rail-quick-btn';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p1.setAttribute('d', 'M12 3v12m0 0l-4-4m4 4l4-4');
  const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p2.setAttribute('d', 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2');
  svg.append(p1, p2);
  btn.appendChild(svg);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function makeSelectCheckbox(checked, indeterminate, onChange) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'select-box';
  cb.checked = checked;
  cb.indeterminate = indeterminate;
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', (e) => onChange(e.target.checked));
  return cb;
}

function syncBatchBar() {
  const bar = el('batchBar');
  bar.hidden = !multiSelectMode;
  el('batchCount').textContent = `${checkedIds.size} selected`;
  const empty = checkedIds.size === 0;
  for (const id of [
    'batchDownloadBtn',
    'batchZipBtn',
    'batchGroupBtn',
    'batchUngroupBtn',
    'batchFreeBtn',
    'batchDeleteBtn',
  ]) {
    el(id).disabled = empty;
  }
}

function toggleCheckedIds(ids, checked) {
  for (const id of ids) {
    if (checked) checkedIds.add(id);
    else checkedIds.delete(id);
  }
  syncBatchBar();
  renderLectureList();
}

function renderPartRow(lec, meta, lesson) {
  const wrap = document.createElement('div');
  wrap.className = 'lecture-row-wrap';

  const cb = makeSelectCheckbox(checkedIds.has(lec.id), false, (checked) => toggleCheckedIds([lec.id], checked));

  const item = document.createElement('div');
  const highlightedPartId = activeViewMode === 'lesson' ? focusedPartId : selectedId;
  item.className = `lecture-item${lec.id === highlightedPartId ? ' active' : ''}`;
  item.dataset.lectureId = lec.id;

  const main = document.createElement('div');
  main.className = 'lecture-item-main';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'lecture-item-title';
  const { displayTime } = formatLocalDateTimeParts(lec.startedAtMs || lec.createdAt);
  titleDiv.textContent = meta?.isGroup ? `Pt ${meta.partIndex} · ${displayTime}` : lec.title;

  const metaDiv = document.createElement('div');
  metaDiv.className = 'lecture-item-meta';
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  dot.dataset.status = lec.status;
  const dateLabel = meta?.isGroup ? displayTime : formatLocalDateTimeParts(lec.startedAtMs || lec.createdAt).date;
  metaDiv.append(dot, document.createTextNode(`${dateLabel} · ${formatTimestamp(lec.durationSec)} · ${lec.status}`));

  main.append(titleDiv, metaDiv);
  const dlBtn = makeQuickDownloadBtn('Download .webm', () => downloadLectureVideo(lec.id));
  item.append(main, dlBtn);
  item.addEventListener('click', () => {
    if (lesson.isGroup) {
      const isSameFocused = activeViewMode === 'lesson' && activeLessonId === lesson.lessonId && focusedPartId === lec.id;
      selectLesson(lesson.lessonId, isSameFocused ? null : lec.id);
    } else {
      selectLecture(lec.id);
    }
  });

  wrap.append(cb, item);
  return wrap;
}

async function renderLectureList() {
  const filter = el('lectureFilter').value.trim().toLowerCase();
  const lectures = await listLectures();
  libraryTree = buildLibraryTree(lectures);
  const listEl = el('lectureList');
  listEl.innerHTML = '';

  for (const subj of libraryTree.subjects) {
    const matchingLessons = subj.lessons
      .map((lesson) => {
        if (!filter) return lesson;
        const subjMatch = subj.name.toLowerCase().includes(filter);
        const lessonMatch = lesson.title.toLowerCase().includes(filter);
        if (subjMatch || lessonMatch) return lesson;
        const matchedParts = lesson.parts.filter((p) => p.title.toLowerCase().includes(filter));
        return matchedParts.length ? { ...lesson, parts: matchedParts } : null;
      })
      .filter(Boolean);

    if (matchingLessons.length === 0) continue;

    const subjSec = document.createElement('section');
    subjSec.className = `subject-group${collapsedSubjects.has(subj.name) ? ' is-collapsed' : ''}`;

    const subjIds = matchingLessons.flatMap((l) => l.parts.map((p) => p.id));
    const subjChecked = subjIds.filter((id) => checkedIds.has(id)).length;
    const subjHeader = document.createElement('div');
    subjHeader.className = 'subject-header';

    const subjCb = makeSelectCheckbox(
      subjChecked === subjIds.length && subjIds.length > 0,
      subjChecked > 0 && subjChecked < subjIds.length,
      (checked) => toggleCheckedIds(subjIds, checked)
    );
    const subjToggle = document.createElement('button');
    subjToggle.type = 'button';
    subjToggle.className = 'subject-toggle';
    subjToggle.setAttribute('aria-label', `Toggle ${subj.name}`);
    subjToggle.appendChild(makeChevronSvg());

    const subjName = document.createElement('span');
    subjName.className = 'subject-name';
    subjName.textContent = subj.name;

    const subjCount = document.createElement('span');
    subjCount.className = 'subject-count';
    subjCount.textContent = String(subjIds.length);

    subjHeader.append(subjCb, subjToggle, subjName, subjCount);
    subjHeader.addEventListener('click', () => {
      if (collapsedSubjects.has(subj.name)) collapsedSubjects.delete(subj.name);
      else collapsedSubjects.add(subj.name);
      subjSec.classList.toggle('is-collapsed');
    });

    const lessonsWrap = document.createElement('div');
    lessonsWrap.className = 'subject-lessons';

    for (const lesson of matchingLessons) {
      if (lesson.isGroup) {
        const lessonGroup = document.createElement('div');
        lessonGroup.className = `lesson-group${collapsedLessons.has(lesson.lessonId) ? ' is-collapsed' : ''}`;

        const lessonIds = lesson.parts.map((p) => p.id);
        const lessonChecked = lessonIds.filter((id) => checkedIds.has(id)).length;
        const lessonHeader = document.createElement('div');
        lessonHeader.className = `lesson-header${activeViewMode === 'lesson' && activeLessonId === lesson.lessonId ? ' active' : ''}`;
        lessonHeader.dataset.lessonId = lesson.lessonId;

        const lessonCb = makeSelectCheckbox(
          lessonChecked === lessonIds.length && lessonIds.length > 0,
          lessonChecked > 0 && lessonChecked < lessonIds.length,
          (checked) => toggleCheckedIds(lessonIds, checked)
        );
        const lessonToggle = document.createElement('button');
        lessonToggle.type = 'button';
        lessonToggle.className = 'lesson-toggle';
        lessonToggle.setAttribute('aria-label', `Toggle ${lesson.title}`);
        lessonToggle.appendChild(makeChevronSvg());
        lessonToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          if (collapsedLessons.has(lesson.lessonId)) collapsedLessons.delete(lesson.lessonId);
          else collapsedLessons.add(lesson.lessonId);
          lessonGroup.classList.toggle('is-collapsed');
        });

        const titleWrap = document.createElement('div');
        titleWrap.className = 'lesson-title-wrap';
        const lTitle = document.createElement('span');
        lTitle.className = 'lesson-title';
        lTitle.textContent = lesson.title;
        const lMeta = document.createElement('span');
        lMeta.className = 'lesson-meta';
        lMeta.textContent = `${lesson.parts.length} parts · ${formatTimestamp(lesson.totalDurationSec)}`;
        titleWrap.append(lTitle, lMeta);

        const dlAllBtn = makeQuickDownloadBtn('Download all parts (.webm)', () =>
          downloadLecturesSequentially(lessonIds, 'video')
        );

        lessonHeader.append(lessonCb, lessonToggle, titleWrap, dlAllBtn);
        lessonHeader.addEventListener('click', () => selectLesson(lesson.lessonId));

        const partsWrap = document.createElement('div');
        partsWrap.className = 'lesson-parts';
        for (const part of lesson.parts) {
          partsWrap.appendChild(renderPartRow(part, libraryTree.partMetaById.get(part.id), lesson));
        }
        lessonGroup.append(lessonHeader, partsWrap);
        lessonsWrap.appendChild(lessonGroup);
      } else {
        const solo = lesson.parts[0];
        lessonsWrap.appendChild(renderPartRow(solo, libraryTree.partMetaById.get(solo.id), lesson));
      }
    }

    subjSec.append(subjHeader, lessonsWrap);
    listEl.appendChild(subjSec);
  }
  renderCatalogGrid();
  refreshVaultSummary(lectures);
}

function renderTranscript(query = '') {
  const container = el('transcriptLines');
  container.innerHTML = '';
  if (!currentTranscript?.segments?.length) return;
  const q = query.trim().toLowerCase();
  const meta = selectedId ? libraryTree.partMetaById.get(selectedId) : null;
  const speakerIdx = new Map();
  for (const seg of currentTranscript.segments) {
    const speaker = String(seg.speaker || '').trim();
    if (speaker && !speakerIdx.has(speaker)) speakerIdx.set(speaker, speakerIdx.size % 6);
    if (q && !seg.text.toLowerCase().includes(q) && !speaker.toLowerCase().includes(q)) continue;
    const row = document.createElement('div');
    row.className = 'transcript-row';
    const body = document.createElement('div');
    body.className = 'transcript-body';
    if (speaker) {
      const badge = document.createElement('span');
      badge.className = 'speaker-tag';
      badge.dataset.speakerIdx = String(speakerIdx.get(speaker));
      badge.textContent = speaker;
      body.append(badge);
    }
    const textSpan = document.createElement('span');
    textSpan.textContent = seg.text;
    body.append(textSpan);
    row.append(makeTimestampBtn(seg.startSec, selectedId, meta?.partIndex), body);
    container.appendChild(row);
  }
}

async function renderSlidesForParts(parts, seq = selectSeq) {
  revokeSlideUrls();
  const grid = el('slidesGrid');
  grid.innerHTML = '';
  let totalCount = 0;
  const showPartBadge = parts.length > 1;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const files = await listDirFiles(part.id, 'slides');
    if (seq !== selectSeq) {
      revokeSlideUrls();
      return;
    }
    for (const f of files) {
      const file = await readLectureFile(part.id, `slides/${f}`);
      if (seq !== selectSeq) {
        revokeSlideUrls();
        return;
      }
      const url = URL.createObjectURL(file);
      slideUrls.push(url);
      const sec = Number(f.split('_')[1]?.split('.')[0] || 0);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slide-thumb';
      const img = document.createElement('img');
      img.src = url;
      img.alt = showPartBadge ? `Pt ${i + 1} slide at ${formatTimestamp(sec)}` : `Slide at ${formatTimestamp(sec)}`;
      const label = document.createElement('span');
      label.textContent = showPartBadge ? `Pt ${i + 1} · ${formatTimestamp(sec)}` : formatTimestamp(sec);
      btn.append(img, label);
      btn.addEventListener('click', () => seekTo(sec, part.id));
      grid.appendChild(btn);
      slideEntries.push({ partId: part.id, partIndex: i + 1, sec, btn });
      totalCount += 1;
    }
  }

  el('slidesStrip').hidden = totalCount === 0;
  el('slidesEmptyHint').hidden = totalCount > 0;
  el('slidesCount').textContent = String(totalCount);
  highlightActiveSlide(el('videoPlayer').currentTime || 0);
}

function getDropStatus(parts) {
  if (parts.some((p) => p.status === 'recording')) return 'recording';
  if (parts.some((p) => p.status === 'ready')) return 'ready';
  if (parts.some((p) => p.status === 'transcribed')) return 'transcribed';
  return 'recorded';
}

function getDropBadge(status) {
  if (status === 'ready') return { cls: 'badge', label: 'Notes Ready' };
  if (status === 'transcribed') return { cls: 'badge badge-cyan', label: 'Transcribed · $0 LLM' };
  if (status === 'recording') return { cls: 'badge badge-danger', label: 'Recording Live' };
  return { cls: 'badge badge-neutral', label: 'Raw OPFS Drop · $0' };
}

async function refreshVaultSummary(lectures) {
  const pill = el('vaultSummaryPill');
  if (!pill) return;
  let totalBytes = 0;
  try {
    const sizes = await Promise.all(lectures.map((l) => getLectureMediaBytes(l.id).catch(() => 0)));
    totalBytes = sizes.reduce((a, b) => a + b, 0);
  } catch {
    totalBytes = 0;
  }
  const mb = (totalBytes / 1048576).toFixed(1);
  pill.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = 'dot';
  pill.append(dot, document.createTextNode(`${lectures.length} drop${lectures.length === 1 ? '' : 's'} · ${mb} MB OPFS · 0 B Server Upload`));
}

function renderCatalogGrid() {
  const grid = el('catalogGrid');
  if (!grid) return;
  const q = (el('catalogSearch')?.value || '').trim().toLowerCase();
  grid.innerHTML = '';
  let rendered = 0;

  for (const subj of libraryTree.subjects) {
    for (const lesson of subj.lessons) {
      const status = getDropStatus(lesson.parts);
      if (catalogStatusFilter !== 'all' && status !== catalogStatusFilter) continue;
      const searchBlob = `${subj.name} ${lesson.title} ${lesson.parts.map((p) => p.title).join(' ')}`.toLowerCase();
      if (q && !searchBlob.includes(q)) continue;

      const card = document.createElement('article');
      card.className = 'drop-card';

      const top = document.createElement('div');
      const topRow = document.createElement('div');
      topRow.className = 'drop-top';

      const subjPill = document.createElement('span');
      subjPill.className = 'drop-subject';
      subjPill.textContent = subj.name;

      const badgeMeta = getDropBadge(status);
      const badge = document.createElement('span');
      badge.className = badgeMeta.cls;
      const dot = document.createElement('span');
      dot.className = 'dot';
      badge.append(dot, document.createTextNode(badgeMeta.label));
      topRow.append(subjPill, badge);

      const h2 = document.createElement('h2');
      h2.textContent = lesson.title;

      const specs = document.createElement('p');
      specs.className = 'drop-specs mono';
      const partText = lesson.isGroup ? `${lesson.parts.length} parts` : '1 part';
      specs.textContent = `${lesson.date} · ${formatTimestamp(lesson.totalDurationSec)} · ${partText}`;

      top.append(topRow, h2, specs);

      const foot = document.createElement('div');
      foot.className = 'drop-foot';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn btn-sm btn-primary';
      openBtn.textContent = status === 'ready' ? 'Open Workbench' : 'Inspect Drop';
      openBtn.addEventListener('click', async () => {
        switchStoreView('workbench');
        if (lesson.isGroup) await selectLesson(lesson.lessonId);
        else await selectLecture(lesson.parts[0].id);
      });

      const quickBtn = document.createElement('button');
      quickBtn.type = 'button';
      quickBtn.className = 'btn btn-sm';
      if (status === 'ready') {
        quickBtn.textContent = 'Export .zip';
        quickBtn.addEventListener('click', async () => {
          if (lesson.isGroup) await selectLesson(lesson.lessonId);
          else await selectLecture(lesson.parts[0].id);
          await exportNotionZipForCurrent();
        });
      } else {
        quickBtn.textContent = status === 'transcribed' ? 'Generate Notes' : 'Transcribe ($0)';
        quickBtn.addEventListener('click', async () => {
          switchStoreView('workbench');
          if (lesson.isGroup) await selectLesson(lesson.lessonId);
          else await selectLecture(lesson.parts[0].id);
          el(status === 'transcribed' ? 'summarizeBtn' : 'transcribeOnlyBtn').click();
        });
      }

      foot.append(openBtn, quickBtn);
      card.append(top, foot);
      grid.appendChild(card);
      rendered += 1;
    }
  }

  if (rendered === 0) {
    const empty = document.createElement('div');
    empty.className = 'card catalog-empty';
    const h2 = document.createElement('h2');
    h2.textContent = 'No drops match this filter';
    const p = document.createElement('p');
    p.style.color = 'var(--muted)';
    p.textContent = 'Click the MyTems capsule icon on any Microsoft Teams tab to record at $0, or switch filters above.';
    empty.append(h2, p);
    grid.appendChild(empty);
  }
}

async function renderGlobalRadar() {
  const listEl = el('globalRadarList');
  const countEl = el('globalRadarCount');
  if (!listEl || !countEl) return;
  listEl.innerHTML = '';
  const entries = [];

  for (const subj of libraryTree.subjects) {
    for (const lesson of subj.lessons) {
      const notes = lesson.isGroup
        ? await readLessonJson(lesson.lessonId, 'notes.json').catch(() => null)
        : await readLectureJson(lesson.parts[0].id, 'notes.json').catch(() => null);
      if (!notes?.examRadar?.length) continue;
      for (const item of notes.examRadar) {
        entries.push({ subj: subj.name, lesson, item });
      }
    }
  }

  countEl.textContent = `${entries.length} item${entries.length === 1 ? '' : 's'}`;
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'global-radar-row';
    empty.textContent = 'No Exam & Deadline Radar items yet. Run Generate Notes on a lecture to extract exam traps and deadlines.';
    listEl.appendChild(empty);
    return;
  }

  for (const { subj, lesson, item } of entries) {
    const row = document.createElement('div');
    row.className = 'global-radar-row';

    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${subj} — ${lesson.title}`;
    const detail = document.createElement('div');
    const due = item.dueDate ? ` (Due: ${item.dueDate})` : '';
    detail.textContent = `[${String(item.type).toUpperCase()}] ${item.text}${due}`;
    info.append(title, detail);

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '8px';

    if (typeof item.confidence === 'number' && Number.isFinite(item.confidence)) {
      const conf = document.createElement('span');
      conf.className = 'radar-confidence-badge';
      conf.textContent = `${Math.round(item.confidence * 100)}%`;
      right.appendChild(conf);
    }

    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'ts-link';
    jump.textContent = formatTimestamp(item.timestampSec || 0);
    jump.addEventListener('click', async () => {
      switchStoreView('workbench');
      if (lesson.isGroup) await selectLesson(lesson.lessonId, item.partId || lesson.parts[0].id);
      else await selectLecture(lesson.parts[0].id);
      await seekTo(item.timestampSec || 0, item.partId || null);
    });
    right.appendChild(jump);

    row.append(info, right);
    listEl.appendChild(row);
  }
}

function renderPartSwitcher(lesson) {
  const bar = el('partSwitcher');
  bar.innerHTML = '';
  if (!lesson || lesson.parts.length <= 1) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const label = document.createElement('span');
  label.className = 'part-switcher-label';
  label.textContent = `Preview video (actions process all ${lesson.parts.length} parts):`;
  bar.appendChild(label);
  lesson.parts.forEach((p, idx) => {
    const { displayTime } = formatLocalDateTimeParts(p.startedAtMs || p.createdAt);
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `part-pill${p.id === selectedId ? ' active' : ''}`;
    pill.textContent = `Pt ${idx + 1} · ${displayTime}`;
    pill.addEventListener('click', () => selectLesson(lesson.lessonId, p.id));
    bar.appendChild(pill);
  });
}

function renderStudyDesk() {
  const hasNotes = Boolean(currentNotes);
  const hasTranscript = Boolean(currentTranscript?.segments?.length);
  const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
  const partCount = lesson && lesson.parts.length > 1 ? lesson.parts.length : 0;

  el('copyNotionBtn').disabled = !hasNotes;
  el('zipNotionBtn').disabled = !hasNotes;
  el('extractSlidesBtn').textContent = partCount ? `Extract Slides (All ${partCount} Parts · $0)` : 'Extract Slides ($0)';
  el('transcribeOnlyBtn').textContent = partCount
    ? (hasTranscript ? `Re-transcribe All ${partCount} Parts ($0 LLM)` : `Transcribe All ${partCount} Parts ($0 LLM)`)
    : (hasTranscript ? 'Re-transcribe ($0 LLM)' : 'Transcribe Only ($0 LLM)');
  el('summarizeBtn').textContent = partCount
    ? (hasNotes ? `Regenerate Lesson Notes (${partCount} Parts)` : `Generate Lesson Notes (${partCount} Parts)`)
    : (hasNotes ? 'Regenerate Notes' : 'Generate Notes');

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
        makeTimestampBtn(item.timestampSec, item.partId, item.partIndex)
      );
      if (typeof item.confidence === 'number' && Number.isFinite(item.confidence)) {
        const badge = document.createElement('span');
        badge.className = 'radar-confidence-badge';
        badge.textContent = `${Math.round(item.confidence * 100)}%`;
        badge.title = 'Jev calibrated confidence';
        li.append(document.createTextNode(' '), badge);
      }
      radarList.appendChild(li);
    }

    for (const ch of currentNotes.chapters || []) {
      const sec = document.createElement('article');
      sec.className = 'chapter';
      const h4 = document.createElement('h4');
      h4.append(document.createTextNode(ch.title), makeTimestampBtn(ch.startSec, ch.partId, ch.partIndex));
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
      for (const cb of ch.codeBlocks || []) {
        const raw = typeof cb === 'string' ? cb : cb?.code;
        if (!String(raw || '').trim()) continue;
        const pre = document.createElement('pre');
        pre.className = 'chapter-code mono';
        const code = document.createElement('code');
        code.textContent = raw;
        pre.appendChild(code);
        sec.appendChild(pre);
      }
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
        p.append(strong, document.createTextNode(`: ${d.definition} `), makeTimestampBtn(d.timestampSec, d.partId, d.partIndex));
        defsEl.appendChild(p);
      }
    }
  }

  if (hasNotes && activeTab !== 'transcript') setStudyTab('notes');
  else if (hasTranscript && !hasNotes) setStudyTab('transcript');
  else if (hasNotes) setStudyTab(activeTab);
}

async function loadVideoPart(id, seq) {
  if (currentVideoUrl) {
    URL.revokeObjectURL(currentVideoUrl);
    currentVideoUrl = null;
  }
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
    el('quickDownloadBtn').disabled = false;
  } catch {
    if (seq !== selectSeq) return;
    const [lec, audioFiles] = await Promise.all([getLecture(id), listDirFiles(id, 'audio')]);
    if (seq !== selectSeq) return;
    const audioOnly = lec?.recordScreen === false && audioFiles.length > 0;
    const noteEl = el('mediaFreedNote');
    noteEl.querySelector('strong').textContent = audioOnly
      ? 'Audio-only recording (screen capture was off).'
      : 'Raw video and audio cleared from OPFS to save space.';
    noteEl.querySelector('span').textContent = audioOnly
      ? 'Audio segments remain saved locally for transcription and notes.'
      : 'Notes, transcript, and extracted slides remain saved locally.';
    player.hidden = true;
    player.removeAttribute('src');
    noteEl.hidden = false;
    el('snapSlideBtn').hidden = true;
    el('downloadVideoBtn').disabled = true;
    el('quickDownloadBtn').disabled = true;
  }
}

async function selectLecture(id) {
  const seq = ++selectSeq;
  activeViewMode = 'lecture';
  activeLessonId = null;
  selectedId = id;
  focusedPartId = id;
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
  el('lecSubjectInput').value = resolveLectureSubject(lec);
  el('lecCourseHint').value = lec.courseHint || '';
  el('noteModeSelect').value = resolveNoteMode(lec.noteMode);
  el('multiSpeakerToggle').checked = Boolean(lec.multiSpeaker);
  syncHintPresetSelect(el('lecCourseHint').value);
  renderPartSwitcher(null);

  const isRecording = lec.status === 'recording';
  el('freeMediaBtn').disabled = isRecording;
  el('deleteLectureBtn').disabled = isRecording;

  const bytes = await getLectureMediaBytes(id);
  if (seq !== selectSeq) return;
  const { date, displayTime } = formatLocalDateTimeParts(lec.startedAtMs || lec.createdAt);
  el('lecMeta').textContent = `${date} ${displayTime} · ${formatTimestamp(lec.durationSec)} · ${(bytes / 1048576).toFixed(1)} MB · ${lec.status}`;
  setBanner(lec.error || '', Boolean(lec.error));

  await loadVideoPart(id, seq);
  if (seq !== selectSeq) return;

  const [transcript, notes] = await Promise.all([
    readLectureJson(id, 'transcript.json'),
    readLectureJson(id, 'notes.json'),
  ]);
  if (seq !== selectSeq) return;
  currentTranscript = transcript;
  currentNotes = notes;
  activeTab = notes ? 'notes' : 'transcript';
  renderTranscript(el('transcriptSearch').value);
  await renderSlidesForParts([lec], seq);
  if (seq !== selectSeq) return;
  renderStudyDesk();
}

async function selectLesson(lessonId, focusPartId = null) {
  const seq = ++selectSeq;
  activeViewMode = 'lesson';
  activeLessonId = lessonId;
  focusedPartId = focusPartId || null;
  revokeObjectUrls();
  el('storageMenu').open = false;
  await renderLectureList();
  if (seq !== selectSeq) return;

  const lesson = libraryTree.lessonsById.get(lessonId);
  if (!lesson || !lesson.parts.length) {
    el('emptyState').hidden = false;
    el('lectureView').hidden = true;
    return;
  }
  const part = lesson.parts.find((p) => p.id === focusPartId) || lesson.parts[0];
  selectedId = part.id;
  syncActiveRailSelection();

  el('emptyState').hidden = true;
  el('lectureView').hidden = false;
  el('lecTitle').textContent = lesson.title;
  el('lecSubjectInput').value = lesson.subject;
  el('lecCourseHint').value = part.courseHint || '';
  el('noteModeSelect').value = resolveNoteMode(part.noteMode);
  el('multiSpeakerToggle').checked = Boolean(part.multiSpeaker);
  syncHintPresetSelect(el('lecCourseHint').value);
  renderPartSwitcher(lesson);

  const anyRecording = lesson.parts.some((p) => p.status === 'recording');
  el('freeMediaBtn').disabled = anyRecording;
  el('deleteLectureBtn').disabled = anyRecording;

  const byteList = await Promise.all(lesson.parts.map((p) => getLectureMediaBytes(p.id)));
  if (seq !== selectSeq) return;
  const totalBytes = byteList.reduce((a, b) => a + b, 0);
  el('lecMeta').textContent = `${lesson.date} · ${lesson.parts.length} parts · ${formatTimestamp(lesson.totalDurationSec)} · ${(totalBytes / 1048576).toFixed(1)} MB`;
  const errPart = lesson.parts.find((p) => p.error);
  setBanner(errPart?.error || '', Boolean(errPart?.error));

  await loadVideoPart(selectedId, seq);
  if (seq !== selectSeq) return;

  const [transcript, notes] = await Promise.all([
    readLectureJson(selectedId, 'transcript.json'),
    lesson.parts.length > 1
      ? readLessonJson(lessonId, 'notes.json')
      : readLectureJson(selectedId, 'notes.json'),
  ]);
  if (seq !== selectSeq) return;
  currentTranscript = transcript;
  currentNotes = notes;
  activeTab = notes ? 'notes' : 'transcript';
  renderTranscript(el('transcriptSearch').value);
  await renderSlidesForParts(lesson.parts, seq);
  if (seq !== selectSeq) return;
  renderStudyDesk();
}

async function downloadLectureVideo(lectureId) {
  try {
    const [lec, file] = await Promise.all([getLecture(lectureId), readLectureFile(lectureId, 'video.webm')]);
    if (!lec) return false;
    const meta = libraryTree.partMetaById.get(lectureId) || { partIndex: 1, totalParts: 1 };
    const filename = buildDownloadFilename(lec, {
      partIndex: meta.partIndex,
      totalParts: meta.totalParts,
      kind: 'video',
    });
    triggerBlobDownload(file, filename);
    return true;
  } catch {
    return false;
  }
}

async function exportNotionZipForCurrent() {
  if (!selectedId || !currentNotes) return;
  const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
  if (lesson && lesson.parts.length > 1) {
    const slideEntriesMeta = [];
    const zipEntries = [];
    for (let i = 0; i < lesson.parts.length; i++) {
      const part = lesson.parts[i];
      const files = await listDirFiles(part.id, 'slides');
      for (const f of files) {
        const zipPath = `slides/pt${i + 1}_${f}`;
        slideEntriesMeta.push({ partIndex: i + 1, filename: f, zipPath });
        const file = await readLectureFile(part.id, `slides/${f}`);
        zipEntries.push({ name: zipPath, data: new Uint8Array(await file.arrayBuffer()) });
      }
    }
    const lessonMeta = {
      title: lesson.title,
      subject: lesson.subject,
      createdAt: lesson.parts[0].createdAt,
      courseHint: el('lecCourseHint').value.trim(),
    };
    const md = notesToNotionMarkdown(lessonMeta, currentNotes, slideEntriesMeta);
    zipEntries.unshift({ name: 'notes.md', data: new TextEncoder().encode(md) });
    const filename = buildDownloadFilename(lesson.parts[0], { kind: 'lesson-zip', lessonTitle: lesson.title });
    triggerBlobDownload(new Blob([buildStoreZip(zipEntries)], { type: 'application/zip' }), filename);
    return;
  }

  const [lec, slideFiles] = await Promise.all([getLecture(selectedId), listDirFiles(selectedId, 'slides')]);
  const md = notesToNotionMarkdown(lec, currentNotes, slideFiles);
  const entries = [{ name: 'notes.md', data: new TextEncoder().encode(md) }];
  for (const f of slideFiles) {
    const file = await readLectureFile(selectedId, `slides/${f}`);
    entries.push({ name: `slides/${f}`, data: new Uint8Array(await file.arrayBuffer()) });
  }
  const meta = libraryTree.partMetaById.get(selectedId) || { partIndex: 1, totalParts: 1 };
  const filename = buildDownloadFilename(lec, {
    partIndex: meta.partIndex,
    totalParts: meta.totalParts,
    kind: 'notion-zip',
  });
  triggerBlobDownload(new Blob([buildStoreZip(entries)], { type: 'application/zip' }), filename);
}

async function downloadLecturesSequentially(ids, kind = 'video') {
  const list = [...new Set(ids)];
  let done = 0;
  for (let i = 0; i < list.length; i++) {
    const id = list[i];
    setBanner(`Downloading ${i + 1}/${list.length}...`);
    if (kind === 'video') {
      if (await downloadLectureVideo(id)) done += 1;
    } else if (kind === 'notion-zip') {
      const [lec, notes, slideFiles] = await Promise.all([
        getLecture(id),
        readLectureJson(id, 'notes.json'),
        listDirFiles(id, 'slides'),
      ]);
      if (lec && notes) {
        const md = notesToNotionMarkdown(lec, notes, slideFiles);
        const entries = [{ name: 'notes.md', data: new TextEncoder().encode(md) }];
        for (const f of slideFiles) {
          const file = await readLectureFile(id, `slides/${f}`);
          entries.push({ name: `slides/${f}`, data: new Uint8Array(await file.arrayBuffer()) });
        }
        const meta = libraryTree.partMetaById.get(id) || { partIndex: 1, totalParts: 1 };
        const filename = buildDownloadFilename(lec, {
          partIndex: meta.partIndex,
          totalParts: meta.totalParts,
          kind: 'notion-zip',
        });
        triggerBlobDownload(new Blob([buildStoreZip(entries)], { type: 'application/zip' }), filename);
        done += 1;
      }
    }
    if (i < list.length - 1) await new Promise((r) => setTimeout(r, 250));
  }
  setBanner(`Downloaded ${done}/${list.length} file(s).`);
}

async function runWithBusyButtons(fn) {
  el('extractSlidesBtn').disabled = true;
  el('transcribeOnlyBtn').disabled = true;
  el('summarizeBtn').disabled = true;
  try {
    await fn();
  } finally {
    el('extractSlidesBtn').disabled = false;
    el('transcribeOnlyBtn').disabled = false;
    el('summarizeBtn').disabled = false;
  }
}

el('extractSlidesBtn').addEventListener('click', () => {
  if (!selectedId) return;
  const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
  const targetId = selectedId;
  const lectureIds = lesson && lesson.parts.length > 1 ? lesson.parts.map((p) => p.id) : [targetId];
  runWithBusyButtons(async () => {
    setBanner('Starting local slide extraction ($0)...');
    try {
      const { totalSlides } = await runSlidesOnly({
        lectureIds,
        onStage: (msg) => setBanner(msg),
      });
      if (lesson && lesson.parts.length > 1) await selectLesson(lesson.lessonId, focusedPartId);
      else await selectLecture(targetId);
      setBanner(`Slide extraction finished ($0 spent): ${totalSlides} slide(s) ready in Slides & Attachments.`);
    } catch (err) {
      setBanner(err?.message || String(err), true);
    }
  });
});

el('transcribeOnlyBtn').addEventListener('click', () => {
  if (!selectedId) return;
  const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
  const targetId = selectedId;
  const force = Boolean(currentTranscript);
  runWithBusyButtons(async () => {
    setBanner('Starting transcription ($0 LLM)...');
    try {
      if (lesson && lesson.parts.length > 1) {
        await runLessonTranscription({
          lectureIds: lesson.parts.map((p) => p.id),
          courseHint: el('lecCourseHint').value,
          force,
          onStage: (msg) => setBanner(msg),
        });
        activeTab = 'transcript';
        await selectLesson(lesson.lessonId, focusedPartId);
      } else {
        await runTranscriptionOnly({
          lectureId: targetId,
          courseHint: el('lecCourseHint').value,
          force,
          onStage: (msg) => setBanner(msg),
        });
        activeTab = 'transcript';
        await selectLecture(targetId);
      }
      setBanner('Transcription complete ($0 LLM spent). Switch to Generate Notes anytime.');
    } catch (err) {
      setBanner(err?.message || String(err), true);
    }
  });
});

el('summarizeBtn').addEventListener('click', () => {
  if (!selectedId) return;
  const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
  const targetId = selectedId;
  runWithBusyButtons(async () => {
    setBanner('Preparing AI pipeline...');
    try {
      if (lesson && lesson.parts.length > 1) {
        const prevLesson = findPreviousSubjectLesson(libraryTree, lesson.subject, lesson.lessonId);
        let previousLessonSummary = '';
        if (prevLesson) {
          const prevNotes =
            prevLesson.parts.length > 1
              ? await readLessonJson(prevLesson.lessonId, 'notes.json')
              : await readLectureJson(prevLesson.parts[0].id, 'notes.json');
          previousLessonSummary = prevNotes?.summary || '';
        }
        await runLessonPipeline({
          lessonId: lesson.lessonId,
          lectureIds: lesson.parts.map((p) => p.id),
          subject: lesson.subject,
          courseHint: el('lecCourseHint').value,
          noteMode: el('noteModeSelect').value,
          multiSpeaker: el('multiSpeakerToggle').checked,
          previousLessonSummary,
          onStage: (msg) => setBanner(msg),
        });
        activeTab = 'notes';
        await selectLesson(lesson.lessonId, focusedPartId);
      } else {
        await runLecturePipeline({
          lectureId: targetId,
          courseHint: el('lecCourseHint').value,
          noteMode: el('noteModeSelect').value,
          multiSpeaker: el('multiSpeakerToggle').checked,
          onStage: (msg) => setBanner(msg),
        });
        activeTab = 'notes';
        await selectLecture(targetId);
      }
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
    if (selectedId === targetId) {
      const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
      await renderSlidesForParts(lesson ? lesson.parts : [await getLecture(targetId)]);
    }
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
    if (selectedId === targetId) {
      const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
      await renderSlidesForParts(lesson ? lesson.parts : [await getLecture(targetId)]);
    }
  } catch (err) {
    setBanner(err?.message || String(err), true);
  }
});

async function handleQuickDownload() {
  el('storageMenu').open = false;
  if (!selectedId) return;
  const ok = await downloadLectureVideo(selectedId);
  if (!ok) setBanner('Video file not found for this recording.', true);
}

el('quickDownloadBtn').addEventListener('click', handleQuickDownload);
el('downloadVideoBtn').addEventListener('click', handleQuickDownload);

el('freeMediaBtn').addEventListener('click', async () => {
  el('storageMenu').open = false;
  if (!selectedId) return;
  try {
    const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
    const ids = lesson ? lesson.parts.map((p) => p.id) : [selectedId];
    for (const id of ids) await freeLectureMedia(id);
    if (lesson) await selectLesson(lesson.lessonId, focusedPartId);
    else await selectLecture(selectedId);
  } catch (err) {
    setBanner(err?.message || String(err), true);
  }
});

el('deleteLectureBtn').addEventListener('click', async () => {
  el('storageMenu').open = false;
  if (!selectedId) return;
  try {
    const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
    const idsToDelete = lesson ? lesson.parts.map((p) => p.id) : [selectedId];
    selectSeq += 1;
    selectedId = null;
    focusedPartId = null;
    activeLessonId = null;
    currentNotes = null;
    currentTranscript = null;
    revokeObjectUrls();
    el('videoPlayer').removeAttribute('src');
    for (const id of idsToDelete) {
      await deleteLectureDir(id);
      await deleteLectureMeta(id);
    }
    if (lesson) await deleteLessonDir(lesson.lessonId);
    el('emptyState').hidden = false;
    el('lectureView').hidden = true;
    await renderLectureList();
  } catch (err) {
    setBanner(err?.message || String(err), true);
  }
});

function syncHintPresetSelect(hintValue) {
  const select = el('hintPresetSelect');
  if (!select) return;
  const trimmed = String(hintValue || '').trim();
  const match = HINT_PRESETS.find((p) => p.hint === trimmed);
  select.value = match ? match.id : '';
}

const noteModeSelect = el('noteModeSelect');
if (noteModeSelect) {
  for (const mode of NOTE_MODES) {
    const opt = document.createElement('option');
    opt.value = mode.id;
    opt.textContent = mode.label;
    noteModeSelect.appendChild(opt);
  }
  noteModeSelect.addEventListener('change', async () => {
    if (!selectedId) return;
    const noteMode = resolveNoteMode(noteModeSelect.value);
    const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
    const ids = lesson ? lesson.parts.map((p) => p.id) : [selectedId];
    await updateLectures(ids, { noteMode });
  });
}

el('multiSpeakerToggle')?.addEventListener('change', async (e) => {
  if (!selectedId) return;
  const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
  const ids = lesson ? lesson.parts.map((p) => p.id) : [selectedId];
  await updateLectures(ids, { multiSpeaker: Boolean(e.target.checked) });
});

const hintPresetSelect = el('hintPresetSelect');
if (hintPresetSelect) {
  for (const preset of HINT_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.label;
    hintPresetSelect.appendChild(opt);
  }
  hintPresetSelect.addEventListener('change', async () => {
    const preset = HINT_PRESETS.find((p) => p.id === hintPresetSelect.value);
    if (!preset) return;
    el('lecCourseHint').value = preset.hint;
    if (!selectedId) return;
    const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
    const ids = lesson ? lesson.parts.map((p) => p.id) : [selectedId];
    await updateLectures(ids, { courseHint: preset.hint });
  });
}

el('lecCourseHint').addEventListener('input', (e) => syncHintPresetSelect(e.target.value));

el('lecSubjectInput').addEventListener('change', async () => {
  if (!selectedId) return;
  const subject = el('lecSubjectInput').value.trim();
  if (!subject) return;
  const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
  const ids = lesson ? lesson.parts.map((p) => p.id) : [selectedId];
  await updateLectures(ids, { subject });
  await renderLectureList();
});

const groupModal = el('groupModal');
const groupForm = el('groupForm');

function openGroupModal(ids) {
  if (!ids.length) return;
  groupModalTargetIds = ids;
  const firstMeta = libraryTree.partMetaById.get(ids[0]);
  const firstLesson = firstMeta ? libraryTree.lessonsById.get(firstMeta.lessonId) : null;
  el('groupSubjectInput').value = firstMeta?.subject || '';
  el('groupLessonTitleInput').value = firstLesson?.isGroup ? firstLesson.title : '';
  if (!groupModal.open) groupModal.showModal();
}

el('closeGroupBtn').addEventListener('click', () => groupModal.close());
groupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const subject = el('groupSubjectInput').value.trim();
  const lessonTitle = el('groupLessonTitleInput').value.trim();
  if (!subject || !groupModalTargetIds.length) return;
  const newLessonId = `manual:${Date.now()}`;
  await updateLectures(groupModalTargetIds, {
    subject,
    lessonId: newLessonId,
    lessonTitle,
  });
  groupModal.close();
  await renderLectureList();
  if (groupModalTargetIds.includes(selectedId)) {
    await selectLesson(newLessonId, selectedId);
  }
});

el('renameLessonBtn').addEventListener('click', () => {
  el('storageMenu').open = false;
  if (!selectedId) return;
  const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
  openGroupModal(lesson ? lesson.parts.map((p) => p.id) : [selectedId]);
});

el('ungroupLectureBtn').addEventListener('click', async () => {
  el('storageMenu').open = false;
  if (!selectedId) return;
  const targetId = selectedId;
  await updateLectures([targetId], (l) => ({ lessonId: `${STANDALONE_PREFIX}${l.id}`, lessonTitle: '' }));
  await selectLecture(targetId);
});

el('toggleSelectModeBtn').addEventListener('click', () => {
  multiSelectMode = !multiSelectMode;
  el('toggleSelectModeBtn').setAttribute('aria-pressed', String(multiSelectMode));
  document.querySelector('.rail').classList.toggle('is-selecting', multiSelectMode);
  if (!multiSelectMode) checkedIds.clear();
  syncBatchBar();
  renderLectureList();
});

el('batchClearBtn').addEventListener('click', () => {
  checkedIds.clear();
  syncBatchBar();
  renderLectureList();
});

el('batchDownloadBtn').addEventListener('click', () =>
  downloadLecturesSequentially([...checkedIds], 'video')
);
el('batchZipBtn').addEventListener('click', () =>
  downloadLecturesSequentially([...checkedIds], 'notion-zip')
);
el('batchGroupBtn').addEventListener('click', () => openGroupModal([...checkedIds]));

el('batchUngroupBtn').addEventListener('click', async () => {
  if (!checkedIds.size) return;
  await updateLectures([...checkedIds], (l) => ({ lessonId: `${STANDALONE_PREFIX}${l.id}`, lessonTitle: '' }));
  await renderLectureList();
});

el('batchFreeBtn').addEventListener('click', async () => {
  if (!checkedIds.size) return;
  for (const id of checkedIds) {
    const lec = await getLecture(id);
    if (lec && lec.status !== 'recording') await freeLectureMedia(id);
  }
  await renderLectureList();
  if (selectedId && checkedIds.has(selectedId)) {
    if (activeViewMode === 'lesson' && activeLessonId) await selectLesson(activeLessonId, focusedPartId);
    else await selectLecture(selectedId);
  }
});

el('batchDeleteBtn').addEventListener('click', async () => {
  const ids = [...checkedIds];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} selected recording(s)?`)) return;
  const affectedLessons = new Set();
  for (const id of ids) {
    const meta = libraryTree.partMetaById.get(id);
    if (meta?.lessonId) affectedLessons.add(meta.lessonId);
    await deleteLectureDir(id);
    await deleteLectureMeta(id);
    checkedIds.delete(id);
  }
  await renderLectureList();
  for (const lid of affectedLessons) {
    if (!libraryTree.lessonsById.has(lid)) await deleteLessonDir(lid);
  }
  if (selectedId && ids.includes(selectedId)) {
    selectedId = null;
    focusedPartId = null;
    activeLessonId = null;
    el('emptyState').hidden = false;
    el('lectureView').hidden = true;
  }
  syncBatchBar();
});

el('copyNotionBtn').addEventListener('click', async () => {
  if (!selectedId || !currentNotes) return;
  try {
    const lesson = activeViewMode === 'lesson' && activeLessonId ? libraryTree.lessonsById.get(activeLessonId) : null;
    if (lesson && lesson.parts.length > 1) {
      const slideEntriesMeta = [];
      for (let i = 0; i < lesson.parts.length; i++) {
        const files = await listDirFiles(lesson.parts[i].id, 'slides');
        for (const f of files) {
          slideEntriesMeta.push({ partIndex: i + 1, filename: f, zipPath: `slides/pt${i + 1}_${f}` });
        }
      }
      const lessonMeta = {
        title: lesson.title,
        subject: lesson.subject,
        createdAt: lesson.parts[0].createdAt,
        courseHint: el('lecCourseHint').value.trim(),
      };
      await navigator.clipboard.writeText(notesToNotionMarkdown(lessonMeta, currentNotes, slideEntriesMeta));
    } else {
      const [lec, slides] = await Promise.all([getLecture(selectedId), listDirFiles(selectedId, 'slides')]);
      await navigator.clipboard.writeText(notesToNotionMarkdown(lec, currentNotes, slides));
    }
    setBanner('Copied Notion-ready Markdown to clipboard.');
  } catch (err) {
    setBanner(err?.message || String(err), true);
  }
});

el('zipNotionBtn').addEventListener('click', async () => {
  try {
    await exportNotionZipForCurrent();
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
  'jevEnabled',
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

function syncRoutingCards(route) {
  const select = form.elements.providerRouting;
  if (select && route) select.value = route;
  const current = select?.value || 'auto';
  for (const card of form.querySelectorAll('.route-card')) {
    card.classList.toggle('active', card.dataset.route === current);
  }
}

async function openSettingsModal() {
  const s = await getSettings();
  for (const name of SETTING_FIELDS) {
    const field = form.elements[name];
    if (field.type === 'checkbox') field.checked = Boolean(s[name]);
    else field.value = s[name] || '';
  }
  syncModeUI(s.providerMode);
  syncRoutingCards(s.providerRouting || 'auto');
  if (!modal.open) modal.showModal();
}

for (const card of form.querySelectorAll('.route-card')) {
  card.addEventListener('click', () => syncRoutingCards(card.dataset.route));
}

for (const btn of form.querySelectorAll('.seg-btn')) {
  btn.addEventListener('click', () => syncModeUI(btn.dataset.mode));
}
el('openSettingsBtn').addEventListener('click', openSettingsModal);
el('openSettingsTopBtn')?.addEventListener('click', openSettingsModal);
el('closeSettingsBtn').addEventListener('click', () => modal.close());
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const patch = { providerMode: modalMode };
  for (const name of SETTING_FIELDS) {
    const field = form.elements[name];
    patch[name] = field.type === 'checkbox' ? field.checked : field.value.trim();
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

for (const btn of document.querySelectorAll('.dock-btn[data-store-view]')) {
  btn.addEventListener('click', () => switchStoreView(btn.dataset.storeView));
}

for (const pill of document.querySelectorAll('.filter-pill[data-catalog-filter]')) {
  pill.addEventListener('click', () => {
    catalogStatusFilter = pill.dataset.catalogFilter;
    for (const p of document.querySelectorAll('.filter-pill[data-catalog-filter]')) {
      p.classList.toggle('active', p === pill);
    }
    renderCatalogGrid();
  });
}

el('catalogSearch')?.addEventListener('input', () => renderCatalogGrid());

el('toggleRailBtn')?.addEventListener('click', (e) => {
  const hidden = el('workbenchView').classList.toggle('rail-hidden');
  e.currentTarget.textContent = hidden ? 'Show Library' : 'Hide Library';
});

el('themeToggleBtn')?.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const next = current ? (current === 'dark' ? 'light' : 'dark') : (systemDark ? 'light' : 'dark');
  try {
    localStorage.setItem('mytems_theme', next);
  } catch {
    // ignore storage restriction
  }
  applyTheme(next);
});

try {
  applyTheme(localStorage.getItem('mytems_theme'));
} catch {
  applyTheme(null);
}

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
  const firstLesson = libraryTree.subjects[0]?.lessons[0];
  if (firstLesson) {
    if (firstLesson.isGroup) await selectLesson(firstLesson.lessonId);
    else await selectLecture(firstLesson.parts[0].id);
  }
  switchStoreView('catalog');
  if (location.hash === '#settings') await openSettingsModal();
}

if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  init().catch((err) => setBanner(err?.message || String(err), true));
}
