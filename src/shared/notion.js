import { resolveNoteMode } from './constants.js';
import { formatTimestamp } from './sanitize.js';

function formatCue(sec, partIndex, isMultiPart) {
  const ts = formatTimestamp(sec);
  return isMultiPart ? `Pt ${partIndex || 1} · ${ts}` : ts;
}

function resolveSlidePath(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return `slides/${entry}`;
  return entry.zipPath || `slides/${entry.filename}`;
}

function formatNotionFormula(formula) {
  const clean = String(formula || '').trim().replace(/^`+|`+$/g, '').trim();
  if (!clean) return '';
  if (clean.startsWith('$$') && clean.endsWith('$$')) return clean;
  const inner = clean.startsWith('$') && clean.endsWith('$') ? clean.slice(1, -1).trim() : clean;
  return `$$${inner}$$`;
}

function formatNotionCodeBlock(block) {
  const rawCode = typeof block === 'string' ? block : block?.code;
  const trimmed = String(rawCode || '').replace(/^\n+|\n+$/g, '');
  if (!trimmed.trim()) return '';
  const fenceMatch = trimmed.match(/^`{3,}([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n`{3,}$/);
  const code = fenceMatch ? fenceMatch[2] : trimmed;
  const rawLang = typeof block === 'object' ? block?.language : '';
  const lang = String(rawLang || fenceMatch?.[1] || '')
    .trim()
    .replace(/[^a-zA-Z0-9_+-]/g, '');
  const fence = code.includes('```') ? '````' : '```';
  return `${fence}${lang}\n${code}\n${fence}`;
}

/**
 * Serialize final AI-processed lecture or multi-part lesson notes into Notion-ready Markdown.
 * @param {object} lecture
 * @param {object} notes
 * @param {Array<string|{partIndex?: number, filename: string, zipPath?: string}>} [slideEntries]
 * @returns {string}
 */
export function notesToNotionMarkdown(lecture, notes, slideEntries = []) {
  if (!notes || !Array.isArray(notes.chapters)) {
    throw new Error('Notion export requires final AI-processed notes.');
  }
  const lec = lecture || {};
  const mode = resolveNoteMode(notes.noteMode ?? lec.noteMode);
  const isMeeting = mode === 'meeting';
  const isMultiPart = Boolean(notes.isMultiPart || (Array.isArray(notes.partsMeta) && notes.partsMeta.length > 1));
  const lines = [`# ${lec.title || 'Teams Lecture'}`];
  const meta = [];
  if (lec.createdAt) meta.push(`Date: ${lec.createdAt.slice(0, 10)}`);
  if (lec.subject) meta.push(`Subject: ${lec.subject}`);
  if (lec.courseHint && lec.courseHint !== lec.subject) meta.push(`Course: ${lec.courseHint}`);
  if (typeof notes.totalCostUsd === 'number') meta.push(`AI Cost: $${notes.totalCostUsd.toFixed(4)}`);
  if (meta.length) lines.push('', `_${meta.join(' · ')}_`);

  if (notes.summary) {
    lines.push('', '## Summary', notes.summary.trim());
  }

  if (Array.isArray(notes.examRadar) && notes.examRadar.length > 0) {
    const radarTitle = isMeeting ? 'Action Items & Deadlines' : 'Exam & Deadline Radar';
    lines.push('', `> [!IMPORTANT] ${radarTitle}`);
    for (const item of notes.examRadar) {
      const tag = String(item.type || 'note').toUpperCase();
      const due = item.dueDate ? ` (Due: ${item.dueDate})` : '';
      const cue = formatCue(item.timestampSec, item.partIndex, isMultiPart);
      lines.push(`> - **[${tag}]** ${item.text}${due} — \`${cue}\``);
    }
  }

  for (const ch of notes.chapters) {
    const startCue = formatCue(ch.startSec, ch.partIndex, isMultiPart);
    const endCue = formatCue(ch.endSec, ch.partIndex, isMultiPart);
    lines.push('', `## ${ch.title} (\`${startCue}\` - \`${endCue}\`)`);
    for (const b of ch.bullets || []) lines.push(`- ${b}`);
    for (const f of ch.formulas || []) {
      const eq = formatNotionFormula(f);
      if (eq) lines.push('', eq);
    }
    for (const cb of ch.codeBlocks || []) {
      const block = formatNotionCodeBlock(cb);
      if (block) lines.push('', block);
    }
    for (const refIdx of ch.slideRefs || []) {
      const path = resolveSlidePath(slideEntries[refIdx]);
      if (path) lines.push('', `![](${path})`);
    }
  }

  if (Array.isArray(notes.definitions) && notes.definitions.length > 0) {
    lines.push('', isMeeting ? '## Key Decisions & Terms' : '## Key Definitions');
    for (const d of notes.definitions) {
      const cue = formatCue(d.timestampSec, d.partIndex, isMultiPart);
      lines.push(`- **${d.term}** (\`${cue}\`): ${d.definition}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
