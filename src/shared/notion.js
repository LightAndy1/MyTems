import { formatTimestamp } from './sanitize.js';

/**
 * Serialize final AI-processed lecture notes into Notion-ready Markdown.
 * @param {object} lecture
 * @param {object} notes
 * @param {string[]} [slideFilenames]
 * @returns {string}
 */
export function notesToNotionMarkdown(lecture, notes, slideFilenames = []) {
  if (!notes || !Array.isArray(notes.chapters)) {
    throw new Error('Notion export requires final AI-processed notes.');
  }
  const lec = lecture || {};
  const lines = [`# ${lec.title || 'Teams Lecture'}`];
  const meta = [];
  if (lec.createdAt) meta.push(`Date: ${lec.createdAt.slice(0, 10)}`);
  if (lec.courseHint) meta.push(`Course: ${lec.courseHint}`);
  if (typeof notes.totalCostUsd === 'number') meta.push(`AI Cost: $${notes.totalCostUsd.toFixed(4)}`);
  if (meta.length) lines.push('', `_${meta.join(' · ')}_`);

  if (notes.summary) {
    lines.push('', '## Summary', notes.summary.trim());
  }

  if (Array.isArray(notes.examRadar) && notes.examRadar.length > 0) {
    lines.push('', '> [!IMPORTANT] Exam & Deadline Radar');
    for (const item of notes.examRadar) {
      const tag = String(item.type || 'note').toUpperCase();
      const due = item.dueDate ? ` (Due: ${item.dueDate})` : '';
      const ts = formatTimestamp(item.timestampSec);
      lines.push(`> - **[${tag}]** ${item.text}${due} — \`${ts}\``);
    }
  }

  for (const ch of notes.chapters) {
    lines.push('', `## ${ch.title} (\`${formatTimestamp(ch.startSec)}\` - \`${formatTimestamp(ch.endSec)}\`)`);
    for (const b of ch.bullets || []) lines.push(`- ${b}`);
    for (const f of ch.formulas || []) lines.push(`- Formula: \`${f}\``);
    for (const refIdx of ch.slideRefs || []) {
      const file = slideFilenames[refIdx];
      if (file) lines.push('', `![](slides/${file})`);
    }
  }

  if (Array.isArray(notes.definitions) && notes.definitions.length > 0) {
    lines.push('', '## Key Definitions');
    for (const d of notes.definitions) {
      lines.push(`- **${d.term}** (\`${formatTimestamp(d.timestampSec)}\`): ${d.definition}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
