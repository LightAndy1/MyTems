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

  it('exports fenced codeblocks instead of KaTeX for coding notes and uses meeting headings in meeting mode', () => {
    const codeMd = notesToNotionMarkdown(
      { title: 'React Hooks', noteMode: 'code' },
      {
        noteMode: 'code',
        summary: 'Use `useEffect` cleanly.',
        chapters: [
          {
            title: 'Effect Cleanup',
            startSec: 10,
            endSec: 90,
            bullets: ['Return a cleanup callback from `useEffect`.'],
            formulas: [],
            codeBlocks: [
              { language: 'js', code: 'useEffect(() => {\n  return () => sub.unsubscribe();\n}, []);' },
              { language: 'py', code: '```python\nprint(1)\n```' },
              { language: 'md', code: 'Example:\n```\nnested\n```' },
            ],
            slideRefs: [],
          },
        ],
        definitions: [],
        examRadar: [],
      }
    );
    assert.match(codeMd, /```js\nuseEffect\(\(\) => \{\n  return \(\) => sub\.unsubscribe\(\);\n\}, \[\]\);\n```/);
    assert.match(codeMd, /```py\nprint\(1\)\n```/);
    assert.match(codeMd, /````md\nExample:\n```\nnested\n```\n````/);
    assert.ok(!codeMd.includes('$$'));

    const meetingMd = notesToNotionMarkdown(
      { title: 'Sprint Sync' },
      {
        noteMode: 'meeting',
        summary: 'Aligned on API rollout.',
        examRadar: [{ type: 'deadline', text: 'Ship v2 endpoint', timestampSec: 120, dueDate: '2026-11-22' }],
        chapters: [{ title: 'API Contract', startSec: 0, endSec: 300, bullets: ['Keep `/v1` active.'], codeBlocks: [{ language: 'bash', code: 'curl -I /v2/health' }] }],
        definitions: [{ term: 'Cutover', definition: 'Blue-green swap on Monday', timestampSec: 200 }],
      }
    );
    assert.match(meetingMd, /> \[!IMPORTANT\] Action Items & Deadlines/);
    assert.match(meetingMd, /## Key Decisions & Terms/);
    assert.match(meetingMd, /```bash\ncurl -I \/v2\/health\n```/);
  });

  it('exports architecture mode diagram images alongside assembly blocks and formulas', () => {
    const archMd = notesToNotionMarkdown(
      { title: 'CPU Pipeline', noteMode: 'architecture' },
      {
        noteMode: 'architecture',
        summary: '5-stage `IF`/`ID`/`EX`/`MEM`/`WB` pipeline.',
        chapters: [
          {
            title: 'Hazard Unit',
            startSec: 15,
            endSec: 180,
            bullets: ['Forwarding mux selects `ALU` output from `EX/MEM`.'],
            formulas: ['CPI = 1 + stall\\_cycles'],
            codeBlocks: [{ language: 'asm', code: 'ADD R1, R2, R3\nSUB R4, R1, R5' }],
            slideRefs: [0],
          },
        ],
        definitions: [{ term: 'Forwarding', definition: 'Bypass path from EX/MEM to ALU input', timestampSec: 65 }],
        examRadar: [],
      },
      ['001_20_wb.png']
    );
    assert.match(archMd, /\$\$CPI = 1 \+ stall\\_cycles\$\$/);
    assert.match(archMd, /```asm\nADD R1, R2, R3\nSUB R4, R1, R5\n```/);
    assert.match(archMd, /!\[\]\(slides\/001_20_wb\.png\)/);
  });
});
