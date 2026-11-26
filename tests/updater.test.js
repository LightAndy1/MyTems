import { describe, expect, test } from 'bun:test';
import {
  UPDATE_CACHE_KEY,
  UPDATE_CHECK_TTL_MS,
  checkForUpdates,
  compareVersions,
  parseSemver,
  pickReleaseAssetUrl,
} from '../src/shared/updater.js';

function createMemoryStorage(initial = {}) {
  const store = { ...initial };
  return {
    async get(key) {
      return { [key]: store[key] };
    },
    async set(obj) {
      Object.assign(store, obj);
    },
  };
}

describe('updater semver and asset helpers', () => {
  test('parses and compares semver strings', () => {
    expect(parseSemver('v0.2.1')).toEqual({ major: 0, minor: 2, patch: 1 });
    expect(parseSemver('1.4.0-beta.1')).toEqual({ major: 1, minor: 4, patch: 0 });
    expect(parseSemver('invalid')).toBeNull();

    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('v0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.0', 'v0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
  });

  test('picks mytems.zip asset over other assets and falls back cleanly', () => {
    const url = pickReleaseAssetUrl({
      html_url: 'https://github.com/LightAndy1/MyTems/releases/tag/v0.2.0',
      assets: [
        { name: 'mytems-v0.2.0.zip', browser_download_url: 'https://example.com/versioned.zip' },
        { name: 'mytems.zip', browser_download_url: 'https://example.com/mytems.zip' },
      ],
    });
    expect(url).toBe('https://example.com/mytems.zip');
  });
});

describe('checkForUpdates', () => {
  test('detects newer release, caches result, and respects 24h TTL unless forced', async () => {
    const storage = createMemoryStorage();
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            tag_name: 'v0.2.0',
            html_url: 'https://github.com/LightAndy1/MyTems/releases/tag/v0.2.0',
            body: 'Added update checker.',
            assets: [{ name: 'mytems.zip', browser_download_url: 'https://example.com/mytems.zip' }],
          };
        },
      };
    };

    const first = await checkForUpdates({
      currentVersion: '0.1.0',
      fetchImpl,
      storage,
      nowMs: 1_000_000,
    });
    expect(first.ok).toBe(true);
    expect(first.hasUpdate).toBe(true);
    expect(first.latestVersion).toBe('0.2.0');
    expect(first.downloadUrl).toBe('https://example.com/mytems.zip');
    expect(first.fromCache).toBe(false);
    expect(fetchCount).toBe(1);

    const cached = await checkForUpdates({
      currentVersion: '0.1.0',
      fetchImpl,
      storage,
      nowMs: 1_000_000 + 60_000,
    });
    expect(cached.fromCache).toBe(true);
    expect(fetchCount).toBe(1);

    const forced = await checkForUpdates({
      force: true,
      currentVersion: '0.1.0',
      fetchImpl,
      storage,
      nowMs: 1_000_000 + 60_000,
    });
    expect(forced.fromCache).toBe(false);
    expect(fetchCount).toBe(2);

    const stale = await checkForUpdates({
      currentVersion: '0.1.0',
      fetchImpl,
      storage,
      nowMs: 1_060_000 + UPDATE_CHECK_TTL_MS + 1,
    });
    expect(stale.fromCache).toBe(false);
    expect(fetchCount).toBe(3);
  });

  test('invalidates cache when installed version changes', async () => {
    const storage = createMemoryStorage({
      [UPDATE_CACHE_KEY]: {
        ok: true,
        currentVersion: '0.1.0',
        latestVersion: '0.2.0',
        hasUpdate: true,
        checkedAtMs: 1_000_000,
      },
    });
    const res = await checkForUpdates({
      currentVersion: '0.2.0',
      storage,
      nowMs: 1_001_000,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { tag_name: 'v0.2.0', assets: [] };
        },
      }),
    });
    expect(res.fromCache).toBe(false);
    expect(res.hasUpdate).toBe(false);
  });

  test('handles 404 when no releases exist yet', async () => {
    const res = await checkForUpdates({
      force: true,
      currentVersion: '0.1.0',
      storage: createMemoryStorage(),
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    expect(res.ok).toBe(false);
    expect(res.hasUpdate).toBe(false);
    expect(res.error).toBe('No releases published yet.');
  });
});
