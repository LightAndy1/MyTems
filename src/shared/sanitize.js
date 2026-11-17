export function deriveLectureTitle(tabTitle) {
  const cleaned = String(tabTitle || '')
    .replace(/\s*\|\s*Microsoft Teams\s*$/i, '')
    .replace(/^\(\d+\)\s*/, '')
    .trim();
  return cleaned || 'Teams Lecture';
}

export function toSafeFilename(title) {
  const safe = String(title || '')
    .replace(/[^a-zA-Z0-9+._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return safe || 'Teams_Lecture';
}

export function formatTimestamp(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

export function createLectureId(now = new Date()) {
  const iso = now.toISOString();
  const datePart = iso.slice(0, 10).replace(/-/g, '');
  const timePart = iso.slice(11, 19).replace(/:/g, '');
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${datePart}-${timePart}-${rand}`;
}
