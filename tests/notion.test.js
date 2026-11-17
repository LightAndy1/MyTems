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
            formulas: ['VA = VPN + offset'],
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
    assert.match(md, /!\[\]\(slides\/001_125\.jpg\)/);
    assert.match(md, /\*\*TLB\*\* \(`05:10`\): Translation Lookaside Buffer/);
  });
});
