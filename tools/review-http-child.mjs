/**
 * tools/review-http-child.mjs — stdlib Node child entry for the controlled executor.
 *
 * Reads one JSON invocation from stdin, runs the bounded Chat Completions loop, and
 * writes the JSON result envelope to stdout. Nothing else is accepted from argv.
 */
import { readFileSync } from 'node:fs';
import { runHttpReview } from './review-http-runtime.mjs';

async function main() {
  const input = readFileSync(0, 'utf8');
  if (!input.trim()) throw new Error('Controlled review child requires a JSON invocation on stdin');
  let invocation;
  try { ({ invocation } = JSON.parse(input)); } catch { throw new Error('Controlled review child received unparsable JSON'); }
  if (!invocation || typeof invocation !== 'object') throw new Error('Controlled review child received an invalid invocation');
  const endpoint = invocation.policy?.endpoint;
  const result = await runHttpReview(invocation, { approveEndpoint: url => url === endpoint });
  process.stdout.write(JSON.stringify(result));
}

main().catch(error => {
  process.stdout.write(JSON.stringify({ status: 1, executor: 'nullform-http-v1', reason: String(error?.message || error) }));
});
