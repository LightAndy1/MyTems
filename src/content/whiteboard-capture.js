(() => {
  if (window.__mytemsWhiteboardInstalled) return;
  window.__mytemsWhiteboardInstalled = true;

  let timerId = null;
  let activeLectureId = null;
  let activeStartedAtMs = 0;
  let inFlight = false;

  const STROKE_STYLE_PROPS = [
    ['fill', 'fill'],
    ['fill-opacity', 'fillOpacity'],
    ['fill-rule', 'fillRule'],
    ['stroke', 'stroke'],
    ['stroke-width', 'strokeWidth'],
    ['stroke-opacity', 'strokeOpacity'],
    ['stroke-linecap', 'strokeLinecap'],
    ['stroke-linejoin', 'strokeLinejoin'],
    ['opacity', 'opacity'],
  ];

  function copyComputedSvgStyles(srcRoot, cloneRoot) {
    const selector = 'path, polyline, line, rect, circle, ellipse, polygon, text';
    const srcNodes = srcRoot.querySelectorAll(selector);
    const cloneNodes = cloneRoot.querySelectorAll(selector);
    const len = Math.min(srcNodes.length, cloneNodes.length);
    for (let i = 0; i < len; i += 1) {
      const cs = getComputedStyle(srcNodes[i]);
      const dst = cloneNodes[i];
      for (const [attr, prop] of STROKE_STYLE_PROPS) {
        if (!dst.hasAttribute(attr) && cs[prop]) {
          dst.setAttribute(attr, cs[prop]);
        }
      }
    }
  }

  function computeVisibleBounds(rects, vw, vh, pad = 24) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of rects) {
      if (r.width <= 0 || r.height <= 0) continue;
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

  function svgElementToImage(svgEl, targetW, targetH) {
    const rect = svgEl.getBoundingClientRect();
    const cs = getComputedStyle(svgEl);
    const baseW = svgEl.width?.baseVal?.value || parseFloat(cs.width) || rect.width || 1;
    const baseH = svgEl.height?.baseVal?.value || parseFloat(cs.height) || rect.height || 1;

    const clone = svgEl.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clone.getAttribute('viewBox') && baseW > 0 && baseH > 0) {
      clone.setAttribute('viewBox', `0 0 ${baseW} ${baseH}`);
    }
    clone.removeAttribute('style');
    clone.setAttribute('width', String(Math.max(1, Math.round(targetW))));
    clone.setAttribute('height', String(Math.max(1, Math.round(targetH))));
    copyComputedSvgStyles(svgEl, clone);

    const xml = new XMLSerializer().serializeToString(clone);
    const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('SVG rasterization failed'));
      };
      img.src = url;
    });
  }

  function pickFallbackSurface() {
    const svgs = [...document.querySelectorAll('svg')];
    const canvases = [...document.querySelectorAll('canvas')];
    const candidates = [];

    svgs.forEach((el, idx) => {
      if (el.classList.contains('canvasBackground') || el.classList.contains('inkRuler')) return;
      const rect = el.getBoundingClientRect();
      candidates.push({
        kind: 'svg',
        index: idx,
        width: rect.width,
        height: rect.height,
        elementCount: el.querySelectorAll('path, polyline, line, rect, circle, text, g').length,
      });
    });

    canvases.forEach((el, idx) => {
      const rect = el.getBoundingClientRect();
      candidates.push({
        kind: 'canvas',
        index: idx,
        width: Math.max(el.width || 0, rect.width),
        height: Math.max(el.height || 0, rect.height),
      });
    });

    let best = null;
    let bestScore = 0;
    for (const c of candidates) {
      if (c.width < 250 || c.height < 250) continue;
      if (c.kind === 'svg' && c.elementCount === 0) continue;
      const score = c.width * c.height * (c.kind === 'svg' ? 1.2 : 1);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) return null;
    return best.kind === 'svg'
      ? { kind: 'svg', el: svgs[best.index] }
      : { kind: 'canvas', el: canvases[best.index] };
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : '');
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
  }

  async function canvasBlobToBase64(canvas) {
    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!pngBlob) return null;
    return blobToBase64(pngBlob);
  }

  async function rasterizeCanvasContentToPngBase64() {
    const root = document.querySelector('#canvasContent');
    if (!root) return null;

    const strokeSvgs = [...root.querySelectorAll('.canvasChildElement svg')].filter((el) => {
      if (el.classList.contains('canvasBackground') || el.classList.contains('inkRuler')) return false;
      return el.querySelector('path, polyline, line, rect, circle, ellipse, polygon, text');
    });
    if (!strokeSvgs.length) return null;

    const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
    const vh = window.innerHeight || document.documentElement.clientHeight || 720;
    const items = strokeSvgs.map((el) => ({ el, rect: el.getBoundingClientRect() }));
    const box = computeVisibleBounds(
      items.map((item) => item.rect),
      vw,
      vh,
      24
    );
    if (!box) return null;

    const scale = Math.min(2, 1920 / Math.max(1, box.width), 1080 / Math.max(1, box.height));
    const outW = Math.max(1, Math.round(box.width * scale));
    const outH = Math.max(1, Math.round(box.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);

    const visibleItems = items.filter(
      ({ rect }) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right >= 0 &&
        rect.bottom >= 0 &&
        rect.left <= vw &&
        rect.top <= vh
    );
    if (!visibleItems.length) return null;

    const rendered = await Promise.allSettled(
      visibleItems.map(async ({ el, rect }) => {
        const dw = Math.max(1, rect.width * scale);
        const dh = Math.max(1, rect.height * scale);
        const img = await svgElementToImage(el, dw, dh);
        return {
          img,
          dx: (rect.left - box.x) * scale,
          dy: (rect.top - box.y) * scale,
          dw,
          dh,
        };
      })
    );

    let drawn = 0;
    for (const res of rendered) {
      if (res.status !== 'fulfilled') continue;
      const { img, dx, dy, dw, dh } = res.value;
      ctx.drawImage(img, dx, dy, dw, dh);
      drawn += 1;
    }
    if (drawn === 0) return null;
    return canvasBlobToBase64(canvas);
  }

  async function rasterizeSvgToPngBase64(svgEl) {
    const rect = svgEl.getBoundingClientRect();
    const width = Math.min(1920, Math.max(800, Math.round(rect.width)));
    const height = Math.min(1080, Math.max(450, Math.round(rect.height)));

    const img = await svgElementToImage(svgEl, width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvasBlobToBase64(canvas);
  }

  async function canvasToPngBase64(srcCanvas) {
    const out = document.createElement('canvas');
    const scale = Math.min(1, 1920 / Math.max(1, srcCanvas.width));
    out.width = Math.max(1, Math.round(srcCanvas.width * scale));
    out.height = Math.max(1, Math.round(srcCanvas.height * scale));
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(srcCanvas, 0, 0, out.width, out.height);
    return canvasBlobToBase64(out);
  }

  async function captureOnce() {
    if (!activeLectureId || inFlight) return;
    inFlight = true;
    try {
      let base64 = await rasterizeCanvasContentToPngBase64();
      if (!base64) {
        const surface = pickFallbackSurface();
        if (!surface) return;
        base64 =
          surface.kind === 'svg'
            ? await rasterizeSvgToPngBase64(surface.el)
            : await canvasToPngBase64(surface.el);
      }
      if (!base64) return;
      const elapsedSec = Math.max(0, Math.floor((Date.now() - activeStartedAtMs) / 1000));
      chrome.runtime
        .sendMessage({
          type: 'WHITEBOARD_FRAME',
          lectureId: activeLectureId,
          elapsedSec,
          base64,
        })
        .catch(() => {});
    } catch {
      // Never disturb the host Teams/Whiteboard page on transient DOM/taint errors.
    } finally {
      inFlight = false;
    }
  }

  function stopMonitor() {
    clearInterval(timerId);
    timerId = null;
    activeLectureId = null;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'MYTEMS_WB_START') {
      stopMonitor();
      activeLectureId = msg.lectureId;
      activeStartedAtMs = msg.startedAtMs || Date.now();
      const intervalMs = Math.max(5000, Number(msg.intervalMs) || 25000);
      setTimeout(captureOnce, 2500);
      timerId = setInterval(captureOnce, intervalMs);
    } else if (msg?.type === 'MYTEMS_WB_STOP') {
      stopMonitor();
    }
  });

  window.addEventListener('pagehide', stopMonitor);
})();
