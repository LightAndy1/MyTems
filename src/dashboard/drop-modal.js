import { DROP_LAYERS } from '../shared/constants.js';
import {
  buildDropManifest,
  exportDropBundleBlob,
  importDropFromEntries,
  inspectPartsForDrop,
  parseDropBundle,
  planDuplicateResolution,
} from '../shared/drop-bundle.js';
import {
  createDropReceiver,
  createDropSender,
  formatBytes,
} from '../shared/p2p-drop.js';

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Controller for the Share Drop (`.mytems` + P2P Drop Code) and Receive Drop modals.
 */
export function createDropModalController({
  el,
  getSettings,
  listLectures,
  upsertLecture,
  readLectureFile,
  listDirFiles,
  openLectureWritable,
  writeLectureFile,
  onImported,
}) {
  const shareModal = el('shareDropModal');
  const receiveModal = el('receiveDropModal');

  let inspectedParts = [];
  let selectedPartIds = new Set();
  let selectedLayers = new Set(DROP_LAYERS.map((l) => l.id));
  let activeSender = null;

  let activeReceiver = null;
  let pendingFileBundle = null;
  let pendingManifest = null;
  let pendingMode = null; // 'p2p' | 'file'

  function stopActiveSender() {
    if (!activeSender) return;
    activeSender.close();
    activeSender = null;
    el('shareCodeBox').hidden = true;
    el('generateDropCodeBtn').disabled = false;
  }

  function stopActiveReceiver() {
    if (!activeReceiver) return;
    activeReceiver.close();
    activeReceiver = null;
  }

  function setShareError(msg = '') {
    const errEl = el('shareDropError');
    errEl.textContent = msg;
    errEl.hidden = !msg;
  }

  function setReceiveError(msg = '') {
    const errEl = el('receiveDropError');
    errEl.textContent = msg;
    errEl.hidden = !msg;
  }

  function renderShareChecklist() {
    const partsBox = el('sharePartsList');
    const layersBox = el('shareLayersList');
    partsBox.innerHTML = '';
    layersBox.innerHTML = '';

    const layerTotals = Object.fromEntries(DROP_LAYERS.map((l) => [l.id, 0]));
    for (const item of inspectedParts) {
      const partTotal = DROP_LAYERS.reduce((sum, l) => sum + (item.layers[l.id]?.bytes || 0), 0);
      if (selectedPartIds.has(item.part.id)) {
        for (const l of DROP_LAYERS) layerTotals[l.id] += item.layers[l.id]?.bytes || 0;
      }

      const row = document.createElement('label');
      row.className = 'drop-check-row';
      const left = document.createElement('span');
      left.className = 'drop-check-left';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selectedPartIds.has(item.part.id);
      cb.addEventListener('change', () => {
        if (cb.checked) selectedPartIds.add(item.part.id);
        else selectedPartIds.delete(item.part.id);
        stopActiveSender();
        renderShareChecklist();
      });
      const title = document.createElement('span');
      title.textContent = item.part.title || item.part.id;
      left.append(cb, title);

      const sizeEl = document.createElement('span');
      sizeEl.className = 'mono';
      sizeEl.style.fontSize = '12px';
      sizeEl.style.color = 'var(--muted)';
      sizeEl.textContent = formatBytes(partTotal);
      row.append(left, sizeEl);
      partsBox.appendChild(row);
    }

    for (const layer of DROP_LAYERS) {
      const bytes = layerTotals[layer.id] || 0;
      const row = document.createElement('label');
      row.className = `drop-check-row${bytes === 0 ? ' disabled' : ''}`;
      const left = document.createElement('span');
      left.className = 'drop-check-left';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.disabled = bytes === 0;
      cb.checked = bytes > 0 && selectedLayers.has(layer.id);
      cb.addEventListener('change', () => {
        if (cb.checked) selectedLayers.add(layer.id);
        else selectedLayers.delete(layer.id);
        stopActiveSender();
        renderShareChecklist();
      });
      const label = document.createElement('span');
      label.textContent = layer.label;
      left.append(cb, label);

      const sizeEl = document.createElement('span');
      sizeEl.className = 'mono';
      sizeEl.style.fontSize = '12px';
      sizeEl.style.color = 'var(--muted)';
      sizeEl.textContent = formatBytes(bytes);
      row.append(left, sizeEl);
      layersBox.appendChild(row);
    }

    const manifest = buildDropManifest(inspectedParts, [...selectedPartIds], [...selectedLayers]);
    el('shareTotalSize').textContent = `Payload: ${formatBytes(manifest.totalBytes)} · ${manifest.lectures.length} part(s)`;
    const canDispatch = manifest.lectures.length > 0;
    el('exportMytemsBtn').disabled = !canDispatch;
    el('generateDropCodeBtn').disabled = !canDispatch || Boolean(activeSender);
  }

  async function openShareModal(parts) {
    stopActiveSender();
    setShareError('');
    if (!parts || parts.length === 0) return;
    inspectedParts = await inspectPartsForDrop(parts, { readLectureFile, listDirFiles });
    selectedPartIds = new Set(inspectedParts.map((i) => i.part.id));
    selectedLayers = new Set(DROP_LAYERS.map((l) => l.id));
    renderShareChecklist();
    if (!shareModal.open) shareModal.showModal();
  }

  el('closeShareDropBtn').addEventListener('click', () => {
    stopActiveSender();
    shareModal.close();
  });
  shareModal.addEventListener('close', () => stopActiveSender());

  el('shareSelectAllBtn').addEventListener('click', () => {
    selectedPartIds = new Set(inspectedParts.map((i) => i.part.id));
    stopActiveSender();
    renderShareChecklist();
  });

  el('shareSelectNoneBtn').addEventListener('click', () => {
    selectedPartIds.clear();
    stopActiveSender();
    renderShareChecklist();
  });

  el('exportMytemsBtn').addEventListener('click', async () => {
    setShareError('');
    const btn = el('exportMytemsBtn');
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Packaging .mytems...';
    try {
      const res = await exportDropBundleBlob(
        inspectedParts,
        [...selectedPartIds],
        [...selectedLayers],
        { readLectureFile }
      );
      if (!res) throw new Error('Select at least one non-empty layer.');
      triggerBlobDownload(res.blob, res.filename);
    } catch (err) {
      setShareError(err?.message || String(err));
    } finally {
      btn.textContent = prev;
      renderShareChecklist();
    }
  });

  el('generateDropCodeBtn').addEventListener('click', async () => {
    setShareError('');
    const manifest = buildDropManifest(inspectedParts, [...selectedPartIds], [...selectedLayers]);
    if (manifest.lectures.length === 0) {
      setShareError('Select at least one non-empty layer.');
      return;
    }
    const genBtn = el('generateDropCodeBtn');
    genBtn.disabled = true;
    try {
      const settings = await getSettings();
      activeSender = await createDropSender({
        manifest,
        readPartFile: readLectureFile,
        relayUrl: settings.dropRelayUrl || 'https://ntfy.sh',
        onPeerUpdate: (peers) => {
          const statusEl = el('sharePeerStatus');
          if (!peers.length) {
            statusEl.textContent = 'Waiting for colleagues on Basement Relay...';
            return;
          }
          statusEl.textContent = peers
            .map((p) => `Peer ${p.peerId.slice(0, 4)}: ${p.state} (${formatBytes(p.sentBytes)} / ${formatBytes(manifest.totalBytes)})`)
            .join(' · ');
        },
      });
      el('shareCodeValue').textContent = activeSender.code;
      el('shareCodeBox').hidden = false;
      el('sharePeerStatus').textContent = 'Waiting for colleagues on Basement Relay...';
    } catch (err) {
      setShareError(err?.message || String(err));
      genBtn.disabled = false;
    }
  });

  el('copyDropCodeBtn').addEventListener('click', async () => {
    const code = el('shareCodeValue').textContent;
    if (!code) return;
    await navigator.clipboard.writeText(code);
    const btn = el('copyDropCodeBtn');
    btn.textContent = 'Copied';
    setTimeout(() => {
      btn.textContent = 'Copy Code';
    }, 1400);
  });

  el('stopDropDispatchBtn').addEventListener('click', () => {
    stopActiveSender();
    renderShareChecklist();
  });

  // --- Receive Modal ---

  async function showManifestPreview(manifest, mode) {
    pendingManifest = manifest;
    pendingMode = mode;

    const existing = await listLectures();
    const existingIds = new Set(existing.map((l) => l.id));
    const hasDups = manifest.lectures.some((l) => existingIds.has(l.meta?.id));

    const first = manifest.lectures[0]?.meta;
    const title = first?.lessonTitle || first?.title || 'Colleague Drop';
    el('receivePreviewTitle').textContent =
      manifest.lectures.length > 1 ? `${title} (+${manifest.lectures.length - 1} more)` : title;
    el('receivePreviewSize').textContent = formatBytes(manifest.totalBytes);
    const layersText = (manifest.includedLayers || []).join(' · ') || 'files';
    el('receivePreviewMeta').textContent = `${manifest.lectures.length} part(s) · Layers: ${layersText}`;

    const listEl = el('receivePreviewList');
    listEl.innerHTML = '';
    for (const lec of manifest.lectures) {
      const li = document.createElement('li');
      const lecBytes = (lec.files || []).reduce((s, f) => s + (f.size || 0), 0);
      li.textContent = `${lec.meta?.title || lec.meta?.id} (${formatBytes(lecBytes)})`;
      listEl.appendChild(li);
    }

    el('receiveDupRow').hidden = !hasDups;
    el('receivePreviewBox').hidden = false;
    const confirmBtn = el('confirmReceiveBtn');
    confirmBtn.disabled = false;
    confirmBtn.textContent = mode === 'p2p' ? `Pull Drop (${formatBytes(manifest.totalBytes)})` : `Import .mytems (${formatBytes(manifest.totalBytes)})`;
  }

  function openReceiveModal() {
    stopActiveReceiver();
    pendingFileBundle = null;
    pendingManifest = null;
    pendingMode = null;
    setReceiveError('');
    el('receiveCodeInput').value = '';
    el('receiveFileInput').value = '';
    el('receivePreviewBox').hidden = true;
    el('receiveProgressWrap').hidden = true;
    el('receiveProgressFill').style.width = '0%';
    el('confirmReceiveBtn').disabled = true;
    el('confirmReceiveBtn').textContent = 'Pull Drop';
    if (!receiveModal.open) receiveModal.showModal();
  }

  el('closeReceiveDropBtn').addEventListener('click', () => {
    stopActiveReceiver();
    receiveModal.close();
  });
  receiveModal.addEventListener('close', () => stopActiveReceiver());

  el('lookupDropCodeBtn').addEventListener('click', async () => {
    setReceiveError('');
    stopActiveReceiver();
    pendingFileBundle = null;
    const btn = el('lookupDropCodeBtn');
    btn.disabled = true;
    btn.textContent = 'Checking...';
    try {
      const settings = await getSettings();
      activeReceiver = createDropReceiver({
        code: el('receiveCodeInput').value,
        relayUrl: settings.dropRelayUrl || 'https://ntfy.sh',
      });
      const { manifest } = await activeReceiver.waitForManifest();
      await showManifestPreview(manifest, 'p2p');
    } catch (err) {
      stopActiveReceiver();
      el('receivePreviewBox').hidden = true;
      el('confirmReceiveBtn').disabled = true;
      setReceiveError(err?.message || String(err));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check Drop';
    }
  });

  el('pickDropFileBtn').addEventListener('click', () => el('receiveFileInput').click());
  el('receiveFileInput').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    setReceiveError('');
    stopActiveReceiver();
    try {
      pendingFileBundle = await parseDropBundle(file);
      await showManifestPreview(pendingFileBundle.manifest, 'file');
    } catch (err) {
      pendingFileBundle = null;
      el('receivePreviewBox').hidden = true;
      el('confirmReceiveBtn').disabled = true;
      setReceiveError(err?.message || String(err));
    }
  });

  el('confirmReceiveBtn').addEventListener('click', async () => {
    if (!pendingManifest) return;
    setReceiveError('');
    const btn = el('confirmReceiveBtn');
    btn.disabled = true;
    el('receiveProgressWrap').hidden = false;

    try {
      const existing = await listLectures();
      const strategy = el('receiveDupSelect').value || 'copy';

      if (pendingMode === 'file' && pendingFileBundle) {
        const res = await importDropFromEntries(
          pendingFileBundle.manifest,
          pendingFileBundle.entryByName,
          existing,
          strategy,
          {
            writeLectureFile,
            upsertLecture,
            onProgress: ({ doneFiles, totalFiles, currentFile }) => {
              const pct = totalFiles ? Math.round((doneFiles / totalFiles) * 100) : 100;
              el('receiveProgressFill').style.width = `${pct}%`;
              el('receiveProgressText').textContent = `${doneFiles}/${totalFiles} files · ${currentFile}`;
            },
          }
        );
        receiveModal.close();
        await onImported?.(res.imported, res.skipped);
        return;
      }

      if (pendingMode === 'p2p' && activeReceiver) {
        const plan = planDuplicateResolution(pendingManifest.lectures, existing, strategy);
        const planBySource = new Map(plan.map((p) => [p.sourceId, p]));
        let activeWritable = null;

        await activeReceiver.pull({
          onFileStart: async ({ lectureId, relPath }) => {
            const p = planBySource.get(lectureId);
            if (!p || p.action === 'skip' || !p.targetMeta) {
              activeWritable = null;
              return;
            }
            activeWritable = await openLectureWritable(p.targetMeta.id, relPath);
          },
          onFileChunk: async (_file, chunk) => {
            if (activeWritable) await activeWritable.write(chunk);
          },
          onFileEnd: async () => {
            if (activeWritable) {
              await activeWritable.close();
              activeWritable = null;
            }
          },
          onProgress: ({ receivedBytes, totalBytes, currentFile }) => {
            const pct = totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 100;
            el('receiveProgressFill').style.width = `${pct}%`;
            el('receiveProgressText').textContent = `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)} (${pct}%) · ${currentFile}`;
          },
        });

        const imported = [];
        const skipped = [];
        for (const item of plan) {
          if (item.action === 'skip' || !item.targetMeta) {
            skipped.push(item.sourceId);
          } else {
            await upsertLecture(item.targetMeta);
            imported.push(item.targetMeta);
          }
        }
        stopActiveReceiver();
        receiveModal.close();
        await onImported?.(imported, skipped);
      }
    } catch (err) {
      setReceiveError(err?.message || String(err));
      btn.disabled = false;
    }
  });

  return {
    openShareModal,
    openReceiveModal,
  };
}
