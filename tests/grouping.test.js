import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STANDALONE_PREFIX,
  resolveLectureSubject,
  buildLibraryTree,
  findPreviousSubjectLesson,
} from '../src/shared/grouping.js';

describe('Subject -> Lesson -> Parts grouping', () => {
  it('auto-groups same-day same-subject recordings chronologically and keeps singletons flat', () => {
    const t1 = new Date(2026, 10, 17, 10, 0, 0).getTime();
    const t2 = new Date(2026, 10, 17, 10, 40, 0).getTime();
    const t3 = new Date(2026, 10, 17, 11, 15, 0).getTime();
    const tOther = new Date(2026, 10, 16, 12, 0, 0).getTime();

    const lectures = [
      { id: 'p3', title: 'Mathematical Logic', createdAt: new Date(t3).toISOString(), startedAtMs: t3, durationSec: 600, status: 'recorded' },
      { id: 'p1', title: 'Mathematical Logic', createdAt: new Date(t1).toISOString(), startedAtMs: t1, durationSec: 1200, status: 'ready' },
      { id: 'p2', title: 'Mathematical Logic', createdAt: new Date(t2).toISOString(), startedAtMs: t2, durationSec: 900, status: 'transcribed' },
      { id: 'd1', title: 'Databases', createdAt: new Date(tOther).toISOString(), startedAtMs: tOther, durationSec: 1800, status: 'ready' },
    ];

    const tree = buildLibraryTree(lectures);
    assert.equal(tree.subjects.length, 2);
    assert.equal(tree.subjects[0].name, 'Mathematical Logic');
    assert.equal(tree.subjects[0].lessons.length, 1);

    const mathLesson = tree.subjects[0].lessons[0];
    assert.equal(mathLesson.isGroup, true);
    assert.deepEqual(mathLesson.parts.map((p) => p.id), ['p1', 'p2', 'p3']);
    assert.equal(mathLesson.totalDurationSec, 2700);

    assert.deepEqual(tree.partMetaById.get('p2'), {
      lessonId: mathLesson.lessonId,
      subject: 'Mathematical Logic',
      partIndex: 2,
      totalParts: 3,
      isGroup: true,
    });

    const dbLesson = tree.subjects[1].lessons[0];
    assert.equal(dbLesson.isGroup, false);
    assert.equal(tree.partMetaById.get('d1').totalParts, 1);
  });

  it('respects explicit standalone override, manual lessonId, and subject override', () => {
    const t1 = new Date(2026, 10, 17, 10, 0, 0).getTime();
    const t2 = new Date(2026, 10, 17, 11, 0, 0).getTime();
    const t3 = new Date(2026, 10, 18, 9, 0, 0).getTime();

    const lectures = [
      { id: 'a', title: 'Meeting', subject: 'Mathematical Logic', lessonId: 'manual-1', lessonTitle: 'Week 7 Logic', createdAt: new Date(t1).toISOString(), startedAtMs: t1 },
      { id: 'b', title: 'Meeting', subject: 'Mathematical Logic', lessonId: 'manual-1', createdAt: new Date(t3).toISOString(), startedAtMs: t3 },
      { id: 'c', title: 'Meeting', subject: 'Mathematical Logic', lessonId: `${STANDALONE_PREFIX}c`, createdAt: new Date(t2).toISOString(), startedAtMs: t2 },
    ];

    const tree = buildLibraryTree(lectures);
    assert.equal(tree.subjects.length, 1);
    assert.equal(tree.subjects[0].lessons.length, 2);
    const manual = tree.lessonsById.get('manual-1');
    assert.equal(manual.title, 'Week 7 Logic');
    assert.deepEqual(manual.parts.map((p) => p.id), ['a', 'b']);
    const standalone = tree.lessonsById.get(`${STANDALONE_PREFIX}c`);
    assert.equal(standalone.isGroup, false);
  });

  it('finds the most recent earlier lesson in the same subject', () => {
    const d1 = new Date(2026, 10, 10, 10, 0, 0).getTime();
    const d2 = new Date(2026, 10, 17, 10, 0, 0).getTime();
    const tree = buildLibraryTree([
      { id: 'old', title: 'Math Logic', subject: 'Math Logic', createdAt: new Date(d1).toISOString(), startedAtMs: d1 },
      { id: 'new1', title: 'Math Logic', subject: 'Math Logic', createdAt: new Date(d2).toISOString(), startedAtMs: d2 },
      { id: 'new2', title: 'Math Logic', subject: 'Math Logic', createdAt: new Date(d2 + 60000).toISOString(), startedAtMs: d2 + 60000 },
    ]);
    const todayId = tree.partMetaById.get('new1').lessonId;
    const prev = findPreviousSubjectLesson(tree, 'Math Logic', todayId);
    assert.equal(prev?.parts[0].id, 'old');
    assert.equal(findPreviousSubjectLesson(tree, 'Math Logic', prev.lessonId), null);
  });

  it('resolves subject from subject, then courseHint, then title', () => {
    assert.equal(resolveLectureSubject({ subject: 'Logic', courseHint: 'CS', title: 'Meet' }), 'Logic');
    assert.equal(resolveLectureSubject({ courseHint: 'CS', title: 'Meet' }), 'CS');
    assert.equal(resolveLectureSubject({ title: 'Meet' }), 'Meet');
    assert.equal(resolveLectureSubject({}), 'Teams Lecture');
  });
});
