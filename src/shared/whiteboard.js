import { WHITEBOARD_CONFIG } from './constants.js';
import { deriveLectureTitle } from './sanitize.js';

export function parseMeetingFilters(filterCsv) {
  return String(filterCsv || '')
    .split(/[,\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function matchesWhiteboardMeeting(tabTitle, filterCsv) {
  const tokens = parseMeetingFilters(filterCsv);
  if (!tokens.length) return false;
  const raw = String(tabTitle || '').toLowerCase();
  const clean = deriveLectureTitle(tabTitle).toLowerCase();
  return tokens.some((tok) => raw.includes(tok) || clean.includes(tok));
}

export function shouldEnableWhiteboard({ mode, tabTitle, filterCsv, override = null }) {
  if (override === true) return true;
  if (override === false) return false;
  if (mode === 'always') return true;
  if (mode === 'match') return matchesWhiteboardMeeting(tabTitle, filterCsv);
  return false;
}

export function formatWhiteboardFilename(seq, timestampSec) {
  const idx = String(Math.max(1, Math.floor(seq))).padStart(3, '0');
  const sec = Math.max(0, Math.floor(timestampSec || 0));
  return `${idx}_${sec}_wb.png`;
}

export function computeFnv1aHash(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function shouldSaveWhiteboardFrame({
  hash,
  prevHash,
  elapsedSinceLastSec,
  savedCount,
  minIntervalSec = WHITEBOARD_CONFIG.MIN_COOLDOWN_SEC,
  maxCaptures = WHITEBOARD_CONFIG.MAX_CAPTURES,
}) {
  if (savedCount >= maxCaptures) return false;
  if (prevHash === null || prevHash === undefined) return true;
  if (hash === prevHash) return false;
  return elapsedSinceLastSec >= minIntervalSec;
}

export function pickWhiteboardSurface(candidates) {
  let best = null;
  let bestScore = 0;
  for (const c of candidates || []) {
    if (!c || c.width < 250 || c.height < 250) continue;
    if (c.kind === 'svg' && (c.elementCount || 0) === 0) continue;
    const area = c.width * c.height;
    const vectorBonus = c.kind === 'svg' ? 1.2 : 1;
    const score = area * vectorBonus;
    if (score > bestScore) {
      bestScore = score;
      best = { kind: c.kind, index: c.index };
    }
  }
  return best;
}

export function computeStrokeBounds(rects, viewport, pad = 24) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const vw = Math.max(1, viewport?.width || 0);
  const vh = Math.max(1, viewport?.height || 0);

  for (const r of rects || []) {
    if (!r || r.width <= 0 || r.height <= 0) continue;
    // Ignore completely offscreen strokes so zoomed-out history outside the view does not crush resolution.
    if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
    minX = Math.min(minX, r.left);
    minY = Math.min(minY, r.top);
    maxX = Math.max(maxX, r.right);
    maxY = Math.max(maxY, r.bottom);
  }

  if (!Number.isFinite(minX)) return null;
  const x = Math.max(0, Math.floor(minX - pad));
  const y = Math.max(0, Math.floor(minY - pad));
  const right = Math.min(vw, Math.ceil(maxX + pad));
  const bottom = Math.min(vh, Math.ceil(maxY + pad));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

export function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToUint8(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export async function saveWhiteboardSlide({ lectureId, filename, base64 }, writeFileFn) {
  if (!lectureId || !filename || !base64) throw new Error('Invalid whiteboard frame payload');
  const bytes = base64ToUint8(base64);
  await writeFileFn(lectureId, `slides/${filename}`, bytes);
}
