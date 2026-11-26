import { AI_VENDORS, WHITEBOARD_ORIGINS } from '../shared/constants.js';
import { resolveLectureSubject } from '../shared/grouping.js';
import { deriveLectureTitle, formatTimestamp } from '../shared/sanitize.js';
import { getActiveSession, getSettings, listLectures, saveSettings } from '../shared/storage.js';
import { checkForUpdates } from '../shared/updater.js';
import { shouldEnableWhiteboard } from '../shared/whiteboard.js';

const tabTitleEl = document.getElementById('tabTitle');
const preRecordFieldsEl = document.getElementById('preRecordFields');
const subjectInputEl = document.getElementById('subjectInput');
const subjectOptionsEl = document.getElementById('subjectOptions');
const courseHintEl = document.getElementById('courseHint');
const screenCaptureCheckEl = document.getElementById('screenCaptureCheck');
const wbCaptureCheckEl = document.getElementById('wbCaptureCheck');
const statusDotEl = document.getElementById('statusDot');
const statusLabelEl = document.getElementById('statusLabel');
const timerEl = document.getElementById('timer');
const toggleBtn = document.getElementById('toggleBtn');
const dispatchStatusEl = document.getElementById('dispatchStatus');
const errorEl = document.getElementById('errorMsg');
const dashboardBtn = document.getElementById('dashboardBtn');
const settingsBtn = document.getElementById('settingsBtn');
const updateBannerEl = document.getElementById('updateBanner');
const updateBannerTextEl = document.getElementById('updateBannerText');
const updateBannerBtn = document.getElementById('updateBannerBtn');

let currentTab = null;
let timerInterval = null;

function setError(msg) {
  errorEl.textContent = msg || '';
  errorEl.hidden = !msg;
}

function renderDispatchStatus(settings) {
  if (!dispatchStatusEl) return;
  if (settings.aiEnabled === false) {
    dispatchStatusEl.textContent = 'AI Off · Capture Only ($0)';
    dispatchStatusEl.classList.remove('is-warn');
    dispatchStatusEl.hidden = false;
    return;
  }
  const sttVendor = AI_VENDORS[settings.sttVendor] || AI_VENDORS.openrouter;
  const llmVendor = AI_VENDORS[settings.llmVendor] || AI_VENDORS.openrouter;
  const sttOk = sttVendor.id === 'custom' ? Boolean(settings.localSttUrl) : Boolean(settings.vendorKeys?.[sttVendor.id]);
  const llmOk = llmVendor.id === 'custom' ? Boolean(settings.localLlmUrl) : Boolean(settings.vendorKeys?.[llmVendor.id]);
  if (!sttOk || !llmOk) {
    dispatchStatusEl.textContent = `Arm keys in Settings (${sttVendor.label} / ${llmVendor.label})`;
    dispatchStatusEl.classList.add('is-warn');
  } else {
    const route = sttVendor.id === llmVendor.id ? sttVendor.label : `${sttVendor.label} → ${llmVendor.label}`;
    dispatchStatusEl.textContent = `Dispatch armed · ${route}`;
    dispatchStatusEl.classList.remove('is-warn');
  }
  dispatchStatusEl.hidden = false;
}

function renderSession(session) {
  clearInterval(timerInterval);
  if (session) {
    tabTitleEl.textContent = session.title;
    preRecordFieldsEl.hidden = true;
    statusDotEl.classList.add('live');
    statusLabelEl.textContent =
      session.recordScreen === false ? 'Recording audio ($0)' : 'Recording locally ($0)';
    timerEl.hidden = false;
    toggleBtn.textContent = 'Stop Recording';
    toggleBtn.classList.add('recording');
    const tick = () => {
      timerEl.textContent = formatTimestamp((Date.now() - session.startedAtMs) / 1000);
    };
    tick();
    timerInterval = setInterval(tick, 1000);
  } else {
    tabTitleEl.textContent = currentTab ? deriveLectureTitle(currentTab.title) : 'No active tab';
    preRecordFieldsEl.hidden = false;
    statusDotEl.classList.remove('live');
    statusLabelEl.textContent = 'Ready to capture tab';
    timerEl.hidden = true;
    toggleBtn.textContent = 'Start Recording';
    toggleBtn.classList.remove('recording');
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  const [session, settings, lectures] = await Promise.all([
    getActiveSession(),
    getSettings(),
    listLectures().catch(() => []),
  ]);
  if (subjectOptionsEl) {
    const subjects = [...new Set(lectures.map((l) => resolveLectureSubject(l)).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    );
    subjectOptionsEl.innerHTML = '';
    for (const subj of subjects) {
      const opt = document.createElement('option');
      opt.value = subj;
      subjectOptionsEl.appendChild(opt);
    }
  }
  if (settings.defaultCourseHint && !courseHintEl.value) {
    courseHintEl.value = settings.defaultCourseHint;
  }
  screenCaptureCheckEl.checked = settings.recordScreen !== false;
  wbCaptureCheckEl.checked = shouldEnableWhiteboard({
    mode: settings.whiteboardMode,
    tabTitle: currentTab?.title,
    filterCsv: settings.whiteboardMeetings,
  });
  renderDispatchStatus(settings);
  renderSession(session);
  checkForUpdates({ force: false })
    .then((res) => {
      if (res?.hasUpdate && res.latestVersion) {
        updateBannerTextEl.textContent = `Update v${res.latestVersion} ready`;
        updateBannerEl.hidden = false;
      }
    })
    .catch(() => {});
}

screenCaptureCheckEl.addEventListener('change', () => {
  saveSettings({ recordScreen: screenCaptureCheckEl.checked }).catch(() => {});
});

toggleBtn.addEventListener('click', async () => {
  setError('');
  toggleBtn.disabled = true;
  try {
    const active = await getActiveSession();
    if (active) {
      const resp = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
      if (!resp?.ok) throw new Error(resp?.error || 'Failed to stop recording');
      renderSession(null);
    } else {
      if (!currentTab?.id) throw new Error('Open a Teams tab before recording.');
      let whiteboardOverride = wbCaptureCheckEl.checked;
      if (whiteboardOverride && chrome.permissions?.request) {
        const ok = await chrome.permissions
          .request({ permissions: ['scripting'], origins: WHITEBOARD_ORIGINS })
          .catch(() => false);
        if (!ok) whiteboardOverride = false;
      }
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: currentTab.id });
      const resp = await chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        tabId: currentTab.id,
        tabTitle: currentTab.title || '',
        streamId,
        subject: subjectInputEl?.value || '',
        courseHint: courseHintEl.value,
        whiteboardOverride,
        recordScreen: screenCaptureCheckEl.checked,
      });
      if (!resp?.ok) throw new Error(resp?.error || 'Failed to start recording');
      renderSession(resp.data);
    }
  } catch (err) {
    setError(err?.message || String(err));
  } finally {
    toggleBtn.disabled = false;
  }
});

function openDashboard(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/dashboard/dashboard.html${hash}`) });
}

dashboardBtn.addEventListener('click', () => openDashboard(''));
settingsBtn.addEventListener('click', () => openDashboard('#settings'));
updateBannerBtn?.addEventListener('click', () => openDashboard('#settings'));

init().catch((err) => setError(err?.message || String(err)));
