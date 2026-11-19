import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveLectureTitle,
  toSafeFilename,
  formatTimestamp,
  createLectureId,
  formatLocalDateTimeParts,
  buildDownloadFilename,
  buildTranscriptTailPrompt,
} from '../src/shared/sanitize.js';

describe('sanitize helpers', () => {
  it('strips Microsoft Teams suffix and trims whitespace', () => {
    assert.equal(
      deriveLectureTitle('Distributed Systems Week 4 | Microsoft Teams'),
      'Distributed Systems Week 4'
    );
    assert.equal(deriveLectureTitle('   | Microsoft Teams  '), 'Teams Lecture');
    assert.equal(deriveLectureTitle(''), 'Teams Lecture');
  });

  it('produces filesystem-safe filenames', () => {
    assert.equal(
      toSafeFilename('CS101: Graphs / Trees? (RO+EN)'),
      'CS101_Graphs_Trees_RO+EN'
    );
    assert.equal(toSafeFilename('   '), 'Teams_Lecture');
  });

  it('formats seconds as MM:SS or HH:MM:SS', () => {
    assert.equal(formatTimestamp(0), '00:00');
    assert.equal(formatTimestamp(65.8), '01:05');
    assert.equal(formatTimestamp(3661), '1:01:01');
  });

  it('creates sortable unique lecture ids', () => {
    const id = createLectureId(new Date('2026-11-17T13:15:00.000Z'));
    assert.match(id, /^20261117-131500-[a-z0-9]{4}$/);
  });

  it('transliterates Romanian diacritics in safe filenames', () => {
    assert.equal(
      toSafeFilename('Logică Matematică — Curs 3 (Ședință)'),
      'Logica_Matematica_Curs_3_Sedinta'
    );
  });

  it('formats local date/time parts and builds collision-free filenames', () => {
    const dt = new Date(2026, 10, 17, 14, 5, 0); // local 2026-11-17 14:05
    const parts = formatLocalDateTimeParts(dt);
    assert.deepEqual(parts, { date: '2026-11-17', time: '14-05', displayTime: '14:05' });

    const lec = { title: 'Mathematical Logic', createdAt: dt.toISOString(), startedAtMs: dt.getTime() };
    assert.equal(
      buildDownloadFilename(lec, { partIndex: 1, totalParts: 1, kind: 'video' }),
      '2026-11-17_14-05_Mathematical_Logic.webm'
    );
    assert.equal(
      buildDownloadFilename(lec, { partIndex: 2, totalParts: 3, kind: 'video' }),
      '2026-11-17_14-05_Mathematical_Logic_pt2.webm'
    );
    assert.equal(
      buildDownloadFilename(lec, { partIndex: 2, totalParts: 3, kind: 'notion-zip' }),
      '2026-11-17_14-05_Mathematical_Logic_pt2_notion.zip'
    );
    assert.equal(
      buildDownloadFilename(lec, { kind: 'lesson-zip', lessonTitle: 'Mathematical Logic' }),
      '2026-11-17_Mathematical_Logic_lesson_notion.zip'
    );
    assert.equal(
      buildDownloadFilename(lec, { kind: 'audio' }),
      '2026-11-17_14-05_Mathematical_Logic_audio.webm'
    );
    assert.equal(
      buildDownloadFilename(lec, { kind: 'audio-zip' }),
      '2026-11-17_14-05_Mathematical_Logic_audio.zip'
    );
    assert.equal(
      buildDownloadFilename(lec, { kind: 'export-zip' }),
      '2026-11-17_14-05_Mathematical_Logic.zip'
    );
    assert.equal(
      buildDownloadFilename(lec, { kind: 'lesson-export-zip', lessonTitle: 'Mathematical Logic' }),
      '2026-11-17_Mathematical_Logic_lesson.zip'
    );
  });

  it('extracts trimmed tail prompt bounded by maxChars at word boundary', () => {
    assert.equal(buildTranscriptTailPrompt('   '), '');
    const longText = 'alpha beta gamma delta epsilon zeta';
    const tail = buildTranscriptTailPrompt(longText, 18);
    assert.ok(tail.length <= 18);
    assert.equal(tail, 'delta epsilon zeta');
  });

  it('strips repeated fragments and keeps last 1-2 clean sentences in tail prompt', () => {
    const noisy = 'Prima propoziție veche. Deci deci deci verificăm cazul de bază. Continuăm cu P(k+1) P(k+1).';
    const tail = buildTranscriptTailPrompt(noisy, 220);
    assert.equal(tail, 'Deci verificăm cazul de bază. Continuăm cu P(k+1).');
  });
});
