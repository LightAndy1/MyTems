import { WHITEBOARD_ORIGINS } from '../shared/constants.js';
import { deriveLectureTitle, formatTimestamp } from '../shared/sanitize.js';
import { getActiveSession, getSettings, saveSettings } from '../shared/storage.js';
import { checkForUpdates } from '../shared/updater.js';
import { shouldEnableWhiteboard } from '../shared/whiteboard.js';

const tabTitleEl = document.getElementById('tabTitle');
const courseHintEl = document.getElementById('courseHint');
const screenToggleRowEl = document.getElementById('screenToggleRow');
const screenCaptureCheckEl = document.getElementById('screenCaptureCheck');
const wbToggleRowEl = document.getElementById('wbToggleRow');
const wbCaptureCheckEl = document.getElementById('wbCaptureCheck');
const statusDotEl = document.getElementById('statusDot');
const statusLabelEl = document.getElementById('statusLabel');
const timerEl = document.getElementById('timer');
const toggleBtn = document.getElementById('toggleBtn');
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

function renderSession(session) {
  clearInterval(timerInterval);
  if (session) {
    tabTitleEl.textContent = session.title;
    courseHintEl.hidden = true;
    screenToggleRowEl.hidden = true;
    wbToggleRowEl.hidden = true;
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
    courseHintEl.hidden = false;
    screenToggleRowEl.hidden = false;
    wbToggleRowEl.hidden = false;
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
  const [session, settings] = await Promise.all([getActiveSession(), getSettings()]);
  if (settings.defaultCourseHint && !courseHintEl.value) {
    courseHintEl.value = settings.defaultCourseHint;
  }
  screenCaptureCheckEl.checked = settings.recordScreen !== false;
  wbCaptureCheckEl.checked = shouldEnableWhiteboard({
    mode: settings.whiteboardMode,
    tabTitle: currentTab?.title,
    filterCsv: settings.whiteboardMeetings,
  });
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
