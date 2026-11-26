import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WHITEBOARD_ORIGINS } from '../src/shared/constants.js';

describe('manifest.json integrity', () => {
  it('references existing files and obeys global MV3 constraints', () => {
    const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.options_page, undefined);
    assert.ok(!manifest.permissions.includes('identity'));
    assert.ok(!manifest.permissions.includes('scripting'));
    assert.ok(manifest.optional_permissions?.includes('scripting'));
    for (const origin of WHITEBOARD_ORIGINS) {
      assert.ok(manifest.optional_host_permissions?.includes(origin), `Missing optional origin: ${origin}`);
    }
    assert.ok(manifest.host_permissions?.includes('https://openrouter.ai/*'));
    assert.ok(manifest.host_permissions?.includes('https://generativelanguage.googleapis.com/*'));
    assert.ok(manifest.host_permissions?.includes('https://integrate.api.nvidia.com/*'));
    assert.ok(manifest.host_permissions?.includes('https://api.groq.com/*'));
    assert.ok(fs.existsSync(manifest.background.service_worker));
    assert.ok(fs.existsSync(manifest.action.default_popup));
    for (const p of Object.values(manifest.icons)) {
      assert.ok(fs.existsSync(p), `Missing icon: ${p}`);
    }
    for (const p of Object.values(manifest.action.default_icon)) {
      assert.ok(fs.existsSync(p), `Missing action default_icon: ${p}`);
    }
    assert.ok(fs.existsSync('src/offscreen/offscreen.html'), 'Missing src/offscreen/offscreen.html');
    assert.ok(fs.existsSync('src/dashboard/dashboard.html'), 'Missing src/dashboard/dashboard.html');
  });
});
