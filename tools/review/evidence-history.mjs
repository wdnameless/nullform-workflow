/**
 * tools/review/evidence-history.mjs — историческая валидация evidence.
 *
 * Вынесено из evidence.mjs, чтобы оба файла оставались в пределах code-size.
 *
 * Зачем: `validateReviewEvidence` сравнивает записанные хеши с ТЕКУЩИМ деревом
 * (`sourceDigest` покрывает весь worktree). Поэтому пере-валидация архивного
 * change на HEAD падает от любого более позднего несвязанного коммита — история
 * становится навсегда красной. Push-диапазон обязан судить каждый change по тому
 * дереву, против которого его принимали: ревизии, последней тронувшей его.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { validateReviewEvidence } from './evidence.mjs';

/**
 * Валидировать evidence change против дерева НА исторической ревизии.
 * Дерево материализуется во временном `git worktree` в OS temp; живое дерево
 * не мутируется. Fail-closed: нечитаемая ревизия — не доказательство валидности.
 */
export function validateReviewEvidenceAtRevision({ root = '.', changeId, tier, baseRef = null, revision = null }) {
  if (!Array.isArray(tier) && !['T2', 'T3'].includes(tier)) return { ok: true, errors: [] };
  if (!revision) return { ok: false, errors: ['missing revision for historical evidence validation'] };
  const absRoot = resolve(root);
  let tmpRoot = null;
  try {
    tmpRoot = join(mkdtempSync(join(tmpdir(), 'nf-evidence-')), 'tree');
    execFileSync('git', ['worktree', 'add', '--detach', '--quiet', tmpRoot, String(revision)], {
      cwd: absRoot, encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return validateReviewEvidence({ root: tmpRoot, changeId, tier, baseRef });
  } catch (error) {
    return { ok: false, errors: [`historical worktree unavailable at ${String(revision).slice(0, 8)}: ${error.message}`] };
  } finally {
    if (tmpRoot) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', tmpRoot], {
          cwd: absRoot, encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { /* best-effort cleanup; a leaked temp worktree is not evidence of anything */ }
      try { rmSync(dirname(tmpRoot), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
