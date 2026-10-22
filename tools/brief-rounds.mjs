/**
 * tools/brief-rounds.mjs
 * Interactive briefing rounds and manifest addenda for Wave 0 and workflow brief.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import readline from 'node:readline';
import { depthChecklist, adversarialPass } from './checklists.mjs';

const ADVERSARIAL_DEFAULTS = {
  failure: 'Fail-fast with descriptive error and safe fallback or rollback.',
  collision: 'Isolated worktrees and atomic resource locks prevent collisions.',
  unverified: 'Verify via automated tests and explicit assertions before execution.',
  cost: 'Bounded resource usage with strict budgets and usage monitoring.',
  dependency: 'Graceful degradation with descriptive warning and fallback mode.',
  'second-week': 'Keep interfaces narrow, zero unnecessary dependencies, and clear tests.',
  'second-actor': 'Detect foreign modifications and prevent concurrent overwrites.',
};

const DEPTH_PROMPTS = {
  'first-run': 'first-run: How does the system behave on initial or first run?',
  empty: 'empty: How does the system handle empty input or empty state?',
  'wrong-input': 'wrong-input: How does the system validate and handle invalid input?',
  failure: 'failure: How does the system recover from unexpected runtime failure?',
  interruption: 'interruption: How are interrupted operations or partial executions handled?',
  growth: 'growth: How does the system handle scale and data growth over time?',
  boundaries: 'boundaries: What are the strict interface and trust boundaries?',
  aftermath: 'aftermath: How are resources and temporary artifacts cleaned up after execution?',
};

const DEPTH_DEFAULTS = {
  'first-run': 'Ensure clean bootstrap, verify default configurations and directories.',
  empty: 'Handle empty inputs gracefully without throwing unexpected errors.',
  'wrong-input': 'Validate inputs at boundaries and report actionable error messages.',
  failure: 'Catch errors, preserve system invariants, and log diagnostic context.',
  interruption: 'Support safe clean exit or resumption without data corruption.',
  growth: 'Ensure linear scalability and bounded memory or storage growth.',
  boundaries: 'Enforce strict schema validation and scope isolation at boundaries.',
  aftermath: 'Clean up temporary files and restore modified environment state.',
};

/**
 * Interactive readline prompt for CLI use when no ask stub is injected.
 */
export async function defaultCliAsk(question, defaultAnswer) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    const prompt = defaultAnswer
      ? `\n${question}\n[default: ${defaultAnswer}]\n> `
      : `\n${question}\n> `;
    rl.question(prompt, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed.length > 0 ? trimmed : defaultAnswer);
    });
  });
}

/**
 * Conducts rounds of interactive briefing questions.
 *
 * @param {string} [briefText] - Initial brief text.
 * @param {object} [opts]
 * @param {number} [opts.rounds=2] - Number of question rounds (max 5).
 * @param {Function} [opts.ask] - Injected question prompt fn: async (q, defaultAnswer) => answer.
 * @returns {Promise<Array<{ id: string, question: string, answer: string, defaultAnswer: string, status: string, row: string }>>}
 */
export async function runBriefRounds(briefText = '', { rounds = 2, ask } = {}) {
  let numRounds = typeof rounds === 'number' && !isNaN(rounds) ? rounds : parseInt(rounds, 10);
  if (isNaN(numRounds) || numRounds < 1) numRounds = 2;
  if (numRounds > 5) numRounds = 5;

  const askFn = ask || defaultCliAsk;

  const advPrompts = adversarialPass(briefText || '');
  const missingDims = depthChecklist(briefText || '');

  // Interleave adversarial questions and missing depth dimensions to cover both checklist sources
  const candidates = [];
  const maxPool = Math.max(advPrompts.length, missingDims.length);
  for (let i = 0; i < maxPool; i++) {
    if (i < advPrompts.length) {
      const prompt = advPrompts[i];
      const key = prompt.split(':')[0].trim();
      const defaultAnswer = ADVERSARIAL_DEFAULTS[key] || 'Handle according to safety and test specifications.';
      candidates.push({ question: prompt, defaultAnswer, key, source: 'adversarial' });
    }
    if (i < missingDims.length) {
      const dim = missingDims[i];
      const prompt = DEPTH_PROMPTS[dim] || `${dim}: How does the system address ${dim}?`;
      const defaultAnswer = DEPTH_DEFAULTS[dim] || 'Handle according to safety and test specifications.';
      candidates.push({ question: prompt, defaultAnswer, key: dim, source: 'depth' });
    }
  }

  const addenda = [];
  for (let r = 0; r < numRounds && r < candidates.length; r++) {
    const q = candidates[r];
    const id = `G${String(r + 1).padStart(2, '0')}`;
    let answer = await askFn(q.question, q.defaultAnswer);
    if (answer === undefined || answer === null || String(answer).trim() === '') {
      answer = q.defaultAnswer;
    } else {
      answer = String(answer).trim();
    }
    const row = `| ${id} | «${q.question}» | ${answer} | open |`;
    addenda.push({
      id,
      question: q.question,
      answer,
      defaultAnswer: q.defaultAnswer,
      status: 'open',
      row,
      toString() {
        return row;
      },
    });
  }

  return addenda;
}

/**
 * Appends addenda rows to the manifest file under `## Дополнения` + G-rows table.
 *
 * @param {string} manifestPath
 * @param {Array<string|object>|string|object} rows
 */
export function appendAddenda(manifestPath, rows) {
  if (!manifestPath) throw new Error('manifestPath is required');
  if (!rows || (Array.isArray(rows) && rows.length === 0)) return;

  const rowList = Array.isArray(rows) ? rows : [rows];
  const fileExists = existsSync(manifestPath);
  let content = fileExists ? readFileSync(manifestPath, 'utf8') : '';

  const existingIds = new Set();
  const idMatches = content.matchAll(/\|\s*([A-Za-z0-9_-]+)\s*\|/gi);
  for (const m of idMatches) {
    existingIds.add(m[1].trim());
  }

  let maxG = 0;
  const gMatches = content.matchAll(/\|\s*G(\d+)\s*\|/gi);
  for (const m of gMatches) {
    const num = parseInt(m[1], 10);
    if (!isNaN(num) && num > maxG) maxG = num;
  }

  const formattedRows = [];
  for (const item of rowList) {
    let rowStr = '';
    let itemId = null;
    if (typeof item === 'string' && item.trim().startsWith('|')) {
      rowStr = item.trim();
      const match = rowStr.match(/^\s*\|\s*([^|]+)\s*\|/);
      if (match) itemId = match[1].trim();
    } else if (typeof item === 'object' && item !== null) {
      itemId = item.id || null;
      if (item.row && typeof item.row === 'string') {
        rowStr = item.row.trim();
      } else {
        const question = item.question || item.quote || item.prompt || '';
        const answer = item.answer || item.acceptance || item.text || '';
        const status = item.status || 'open';
        rowStr = `| ${itemId || 'TEMP'} | «${question}» | ${answer} | ${status} |`;
      }
    }

    if (rowStr) {
      if (!itemId || existingIds.has(itemId)) {
        maxG++;
        const newId = `G${String(maxG).padStart(2, '0')}`;
        rowStr = rowStr.replace(/^\s*\|\s*[^|]+\s*\|/, `| ${newId} |`);
        itemId = newId;
      } else {
        const gNum = itemId.match(/^G(\d+)$/i);
        if (gNum) {
          const n = parseInt(gNum[1], 10);
          if (!isNaN(n) && n > maxG) maxG = n;
        }
      }
      existingIds.add(itemId);
      formattedRows.push(rowStr);
    }
  }
  if (formattedRows.length === 0) return;

  const tableHeader = '| ID | Verbatim user quote | Observable acceptance | Status |\n|---|---|---|---|';

  const addendaHeaderRegex = /##\s*Дополнения/i;
  if (addendaHeaderRegex.test(content)) {
    const match = content.match(addendaHeaderRegex);
    const afterHeader = content.slice(match.index);
    if (/\|\s*ID\s*\|/i.test(afterHeader)) {
      content = content.trimEnd() + '\n' + formattedRows.join('\n') + '\n';
    } else {
      content = content.trimEnd() + '\n\n' + tableHeader + '\n' + formattedRows.join('\n') + '\n';
    }
  } else {
    const prefix = content.trim().length > 0 ? content.trimEnd() + '\n\n' : '';
    content = prefix + `## Дополнения\n\n${tableHeader}\n` + formattedRows.join('\n') + '\n';
  }

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, content, 'utf8');
}
