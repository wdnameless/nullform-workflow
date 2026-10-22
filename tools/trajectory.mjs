/**
 * tools/trajectory.mjs — trajectory evaluation for subagent loop and step limit detection.
 *
 * observeTrajectory(events, { maxSteps, loopWindow }) flags repeated identical tool calls
 * within loopWindow as loops, and throws when events.length > maxSteps.
 */

function canonicalize(val) {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalize);
  }
  const sorted = {};
  for (const key of Object.keys(val).sort()) {
    sorted[key] = canonicalize(val[key]);
  }
  return sorted;
}

function canonicalJson(val) {
  return JSON.stringify(canonicalize(val));
}

function callKey(event) {
  if (!event || typeof event !== 'object') return '';
  const tool = event.tool ?? '';
  const args = canonicalJson(event.args !== undefined ? event.args : {});
  return `${tool}::${args}`;
}

/**
 * Observes a tool call trajectory to detect loops and enforce step ceilings.
 *
 * @param {Array<{ tool: string, args: unknown }>} events - Sequence of tool calls.
 * @param {{ maxSteps?: number, loopWindow?: number }} [options] - Trajectory bounds.
 * @returns {{ loops: string[] }} Detected looping tool names.
 */
export function observeTrajectory(events, { maxSteps = 200, loopWindow = 5 } = {}) {
  if (!Array.isArray(events)) {
    throw new TypeError('events must be an array');
  }
  if (events.length > maxSteps) {
    throw new Error(`Trajectory step limit exceeded: ${events.length} steps > maxSteps ${maxSteps}`);
  }

  const loops = [];
  const keys = events.map(callKey);

  for (let i = 0; i < events.length; i++) {
    const key = keys[i];
    if (!key) continue;
    const start = Math.max(0, i - loopWindow);
    for (let j = start; j < i; j++) {
      if (keys[j] === key) {
        const toolName = events[i]?.tool ?? 'unknown';
        if (!loops.includes(toolName)) {
          loops.push(toolName);
        }
        break;
      }
    }
  }

  return { loops };
}
