import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { notesToNotionMarkdown } from '../src/shared/notion.js';

describe('notesToNotionMarkdown', () => {
  it('rejects export when final AI notes are missing', () => {
    assert.throws(() => notesToNotionMarkdown({ title: 'OS' }, null), /AI-processed notes/);
  });

  it('formats Exam Radar, chapters, timestamps, definitions, and slide links', () => {
    const md = notesToNotionMarkdown(
      { title: 'OS Lecture 3', createdAt: '2026-11-17T10:00:00.000Z', courseHint: 'Operating Systems' },
      {
        summary: 'Covered page tables and TLB.',
        examRadar: [{ type: 'deadline', text: 'Lab 2 due Friday', timestampSec: 75, dueDate: '2026-11-20' }],
        chapters: [
          {
            title: 'Virtual Memory',
            startSec: 120,
            endSec: 600,
            bullets: ['Page size is 4KB'],
            formulas: ['VA = VPN + offset', '`$x^2 + y^2 = r^2$`'],
            slideRefs: [0],
          },
        ],
        definitions: [{ term: 'TLB', definition: 'Translation Lookaside Buffer', timestampSec: 310 }],
        totalCostUsd: 0.064,
      },
      ['001_125.jpg']
    );
    assert.match(md, /# OS Lecture 3/);
    assert.match(md, /> \[!IMPORTANT\] Exam & Deadline Radar/);
    assert.match(md, /Lab 2 due Friday \(Due: 2026-11-20\) — `01:15`/);
    assert.match(md, /## Virtual Memory \(`02:00` - `10:00`\)/);
    assert.match(md, /\$\$VA = VPN \+ offset\$\$/);
    assert.match(md, /\$\$x\^2 \+ y\^2 = r\^2\$\$/);
    assert.ok(!md.includes('- Formula: `'));
    assert.match(md, /!\[\]\(slides\/001_125\.jpg\)/);
    assert.match(md, /\*\*TLB\*\* \(`05:10`\): Translation Lookaside Buffer/);
  });

  it('formats multi-part Lesson cues with Pt prefix and nested slide zip paths', () => {
    const lesson = { title: 'Mathematical Logic (2026-11-17)', createdAt: '2026-11-17T10:00:00Z', subject: 'Mathematical Logic' };
    const notes = {
      isMultiPart: true,
      summary: 'Connected Part 1 and Part 2.',
      totalCostUsd: 0.0123,
      examRadar: [{ type: 'exam_hint', text: 'Proof on Friday', partIndex: 2, timestampSec: 125 }],
      chapters: [{ title: 'Completeness', partIndex: 2, startSec: 60, endSec: 300, bullets: ['Theorem'], formulas: [], slideRefs: [0] }],
      definitions: [{ term: 'Tautology', definition: 'Always true', partIndex: 1, timestampSec: 45 }],
    };
    const md = notesToNotionMarkdown(lesson, notes, [{ partIndex: 2, filename: '001_120.jpg', zipPath: 'slides/pt2_001_120.jpg' }]);
    assert.match(md, /Subject: Mathematical Logic/);
    assert.match(md, /`Pt 2 · 02:05`/);
    assert.match(md, /## Completeness \(`Pt 2 · 01:00` - `Pt 2 · 05:00`\)/);
    assert.match(md, /!\[\]\(slides\/pt2_001_120\.jpg\)/);
    assert.match(md, /\*\*Tautology\*\* \(`Pt 1 · 00:45`\)/);
  });
});
