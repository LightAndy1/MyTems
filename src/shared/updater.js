export const GITHUB_REPO = 'LightAndy1/MyTems';
export const GITHUB_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
export const LATEST_DOWNLOAD_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/mytems.zip`;
export const UPDATE_CACHE_KEY = 'mytems_update_cache';
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Parse a semver string (e.g. "v0.2.0" or "0.2.0-beta.1") into numeric parts.
 */
export function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const cleaned = version.trim().replace(/^v/i, '').split('-')[0];
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

/**
 * Compare two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal or invalid.
 */
export function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] > pb[key]) return 1;
    if (pa[key] < pb[key]) return -1;
  }
  return 0;
}

/**
 * Pick the best .zip download URL from a GitHub Release payload.
 */
export function pickReleaseAssetUrl(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const preferred = assets.find((a) => a?.name === 'mytems.zip' && a?.browser_download_url);
  if (preferred) return preferred.browser_download_url;
  const anyZip = assets.find(
    (a) => typeof a?.name === 'string' && a.name.endsWith('.zip') && a?.browser_download_url,
  );
  if (anyZip) return anyZip.browser_download_url;
  return release?.html_url || LATEST_DOWNLOAD_URL;
}

export function isCacheFresh(cache, nowMs = Date.now(), ttlMs = UPDATE_CHECK_TTL_MS) {
  return Boolean(cache && typeof cache.checkedAtMs === 'number' && nowMs - cache.checkedAtMs < ttlMs);
}

export async function getCachedUpdateState(storage = globalThis.chrome?.storage?.local) {
  if (!storage?.get) return null;
  try {
    const res = await storage.get(UPDATE_CACHE_KEY);
    return res?.[UPDATE_CACHE_KEY] || null;
  } catch {
    return null;
  }
}

export function getInstalledVersion() {
  return globalThis.chrome?.runtime?.getManifest?.()?.version || '0.0.0';
}

/**
 * Check GitHub Releases for a newer version of MyTems, with 24h local caching.
 */
export async function checkForUpdates({
  force = false,
  currentVersion = getInstalledVersion(),
  fetchImpl = globalThis.fetch,
  storage = globalThis.chrome?.storage?.local,
  nowMs = Date.now(),
} = {}) {
  if (!force) {
    const cached = await getCachedUpdateState(storage);
    if (cached && cached.currentVersion === currentVersion && isCacheFresh(cached, nowMs)) {
      return { ...cached, fromCache: true };
    }
  }

  try {
    const resp = await fetchImpl(GITHUB_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (!resp.ok) {
      const error =
        resp.status === 404
          ? 'No releases published yet.'
          : `GitHub API returned ${resp.status}`;
      return {
        ok: false,
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        downloadUrl: LATEST_DOWNLOAD_URL,
        releaseUrl: null,
        checkedAtMs: nowMs,
        fromCache: false,
        error,
      };
    }

    const release = await resp.json();
    const rawTag = String(release?.tag_name || '').trim();
    const latestVersion = rawTag.replace(/^v/i, '') || null;
    const hasUpdate = Boolean(latestVersion && compareVersions(latestVersion, currentVersion) > 0);
    const result = {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate,
      downloadUrl: pickReleaseAssetUrl(release),
      releaseUrl: release?.html_url || null,
      releaseNotes: typeof release?.body === 'string' ? release.body.trim().slice(0, 400) : '',
      checkedAtMs: nowMs,
      fromCache: false,
      error: null,
    };

    if (storage?.set) {
      await storage.set({ [UPDATE_CACHE_KEY]: result }).catch(() => {});
    }
    return result;
  } catch (err) {
    return {
      ok: false,
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      downloadUrl: LATEST_DOWNLOAD_URL,
      releaseUrl: null,
      checkedAtMs: nowMs,
      fromCache: false,
      error: err?.message || 'Update check failed',
    };
  }
}
