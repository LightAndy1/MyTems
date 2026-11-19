import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STANDALONE_PREFIX,
  resolveLectureSubject,
  buildLibraryTree,
  findPreviousSubjectLesson,
  planLibraryDrop,
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

describe('planLibraryDrop drag-and-drop organization', () => {
  const t1 = new Date(2026, 10, 17, 10, 0, 0).getTime();
  const t2 = new Date(2026, 10, 17, 11, 0, 0).getTime();
  const t3 = new Date(2026, 10, 18, 9, 0, 0).getTime();
  const t4 = new Date(2026, 10, 18, 12, 0, 0).getTime();

  const applyPlan = (lectures, plan) => {
    const byId = new Map(plan.changes.map((c) => [c.id, c.patch]));
    return lectures.map((l) => (byId.has(l.id) ? { ...l, ...byId.get(l.id) } : l));
  };

  it('groups two solo lectures and ignores self-drop', () => {
    const lectures = [
      { id: 's1', title: 'Meeting', subject: 'Other', createdAt: new Date(t1).toISOString(), startedAtMs: t1 },
      { id: 's2', title: 'Databases', subject: 'Databases', createdAt: new Date(t3).toISOString(), startedAtMs: t3 },
    ];
    const tree = buildLibraryTree(lectures);

    assert.equal(planLibraryDrop(tree, { kind: 'lecture', ids: ['s1'] }, { kind: 'lecture', lectureId: 's1' }), null);

    const plan = planLibraryDrop(tree, { kind: 'lecture', ids: ['s1'] }, { kind: 'lecture', lectureId: 's2' }, 999);
    assert.equal(plan.action, 'group-lessons');
    assert.equal(plan.lessonId, 'manual:999');

    const nextTree = buildLibraryTree(applyPlan(lectures, plan));
    assert.equal(nextTree.subjects.length, 1);
    assert.equal(nextTree.subjects[0].name, 'Databases');
    assert.equal(nextTree.subjects[0].lessons.length, 1);
    assert.deepEqual(nextTree.subjects[0].lessons[0].parts.map((p) => p.id), ['s1', 's2']);
  });

  it('adds a lecture to an existing lesson, ungroups onto same subject, and moves whole lesson across subjects', () => {
    const lectures = [
      { id: 'a', title: 'Math', subject: 'Math', createdAt: new Date(t1).toISOString(), startedAtMs: t1 },
      { id: 'b', title: 'Math', subject: 'Math', createdAt: new Date(t2).toISOString(), startedAtMs: t2 },
      { id: 'c', title: 'Extra', subject: 'Misc', createdAt: new Date(t3).toISOString(), startedAtMs: t3 },
      { id: 'd', title: 'Databases', subject: 'Databases', createdAt: new Date(t4).toISOString(), startedAtMs: t4 },
    ];
    let tree = buildLibraryTree(lectures);
    const mathLessonId = tree.partMetaById.get('a').lessonId;

    // Add solo 'c' into Math auto-grouped lesson
    const addPlan = planLibraryDrop(tree, { kind: 'lecture', ids: ['c'] }, { kind: 'lesson', lessonId: mathLessonId });
    assert.equal(addPlan.action, 'add-to-lesson');
    assert.equal(planLibraryDrop(tree, { kind: 'lecture', ids: ['a'] }, { kind: 'lesson', lessonId: mathLessonId }), null);

    let nextLectures = applyPlan(lectures, addPlan);
    tree = buildLibraryTree(nextLectures);
    assert.deepEqual(tree.lessonsById.get(mathLessonId).parts.map((p) => p.id), ['a', 'b', 'c']);

    // Ungroup 'c' by dropping onto its own subject
    const ungroupPlan = planLibraryDrop(tree, { kind: 'lecture', ids: ['c'] }, { kind: 'subject', subject: 'Math' });
    assert.equal(ungroupPlan.action, 'ungroup');
    nextLectures = applyPlan(nextLectures, ungroupPlan);
    tree = buildLibraryTree(nextLectures);
    assert.equal(tree.subjects.find((s) => s.name === 'Math').lessons.length, 2);
    assert.equal(planLibraryDrop(tree, { kind: 'lecture', ids: ['c'] }, { kind: 'subject', subject: 'Math' }), null);

    // Move remaining Math lesson ('a', 'b') into Databases without colliding with 'd'
    assert.equal(planLibraryDrop(tree, { kind: 'lesson', ids: ['a', 'b'] }, { kind: 'subject', subject: 'Math' }), null);
    const moveLessonPlan = planLibraryDrop(tree, { kind: 'lesson', ids: ['a', 'b'] }, { kind: 'subject', subject: 'Databases' });
    assert.equal(moveLessonPlan.action, 'move-lesson');
    nextLectures = applyPlan(nextLectures, moveLessonPlan);
    tree = buildLibraryTree(nextLectures);
    const dbLessons = tree.subjects.find((s) => s.name === 'Databases').lessons;
    assert.equal(dbLessons.length, 2);
    assert.deepEqual(tree.lessonsById.get(mathLessonId).parts.map((p) => p.id), ['a', 'b']);
  });
});
