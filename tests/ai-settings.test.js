import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS } from '../src/shared/constants.js';
import {
  calibrateExamRadarWithJev,
  generateStructuredNotes,
  transcribeAudioSegment,
} from '../src/dashboard/ai-client.js';

describe('AI toggle & Expert Mode defaults', () => {
  test('DEFAULT_SETTINGS enables AI by default and keeps Expert Mode off', () => {
    expect(DEFAULT_SETTINGS.aiEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.expertMode).toBe(false);
  });

  test('AI client functions block network calls when aiEnabled is false', async () => {
    let fetchCalled = false;
    const mockFetch = async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called');
    };
    const settings = { ...DEFAULT_SETTINGS, aiEnabled: false, openrouterApiKey: 'sk-or-test' };

    await expect(
      transcribeAudioSegment({
        settings,
        blob: new Blob(['audio'], { type: 'audio/webm' }),
        filename: 'seg-0.webm',
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow('AI is disabled in Settings.');

    await expect(
      generateStructuredNotes({
        settings,
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: mockFetch,
      })
    ).rejects.toThrow('AI is disabled in Settings.');

    const items = [{ type: 'exam_hint', text: 'Midterm Friday', timestampSec: 10, dueDate: null }];
    const jevRes = await calibrateExamRadarWithJev(items, 'Summary', settings, { fetchImpl: mockFetch });
    expect(jevRes).toEqual({ items, costUsd: 0 });
    expect(fetchCalled).toBe(false);
  });
});
