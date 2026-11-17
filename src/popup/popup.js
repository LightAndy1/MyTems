import { deriveLectureTitle, formatTimestamp } from '../shared/sanitize.js';
import { getActiveSession, getSettings } from '../shared/storage.js';

const tabTitleEl = document.getElementById('tabTitle');
const courseHintEl = document.getElementById('courseHint');
const timerEl = document.getElementById('timer');
const toggleBtn = document.getElementById('toggleBtn');
const errorEl = document.getElementById('errorMsg');
const dashboardBtn = document.getElementById('dashboardBtn');
const settingsBtn = document.getElementById('settingsBtn');

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
  renderSession(session);
}

toggleBtn.addEventListener('click', async () => {
  setError('');
  toggleBtn.disabled = true;
  try {
    const active = await getActiveSession();
    if (active) {
      const resp = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
      if (!resp?.ok) throw new Error(resp?.error || 'Failed to stop');
      renderSession(null);
    } else {
      if (!currentTab?.id) throw new Error('Select a Teams tab first.');
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: currentTab.id });
      const resp = await chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        tabId: currentTab.id,
        tabTitle: currentTab.title || '',
        streamId,
        courseHint: courseHintEl.value,
      });
      if (!resp?.ok) throw new Error(resp?.error || 'Failed to start');
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

init().catch((err) => setError(err?.message || String(err)));
