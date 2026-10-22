/**
 * Validates plan coverage, topology, and zone disjointness.
 *
 * @param {Array<{ id: string, status: string }>} manifestRows
 * @param {Array<{ id: string, requirements: string[], wave: number, zone: string[] | string, blockedBy: string[] }>} tickets
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkPlan(manifestRows = [], tickets = []) {
  const problems = [];
  const rows = Array.isArray(manifestRows) ? manifestRows : [];
  const tList = Array.isArray(tickets) ? tickets : [];

  const LIVE_STATUSES = new Set(["in-spec", "in-ticket", "placeholder"]);
  const manifestMap = new Map(rows.map((r) => [r.id, r]));
  const ticketMap = new Map(tList.map((t) => [t.id, t]));

  // 1. Every live requirement must be covered in >= 1 ticket
  const coveredReqs = new Set();
  for (const t of tList) {
    if (Array.isArray(t.requirements)) {
      for (const req of t.requirements) {
        coveredReqs.add(req);
      }
    }
  }

  for (const r of rows) {
    if (LIVE_STATUSES.has(r.status) && !coveredReqs.has(r.id)) {
      problems.push(`Requirement ${r.id} (${r.status}) is not covered by any ticket`);
    }
  }

  // 2. Every ticket requirement must exist in manifest
  for (const t of tList) {
    if (Array.isArray(t.requirements)) {
      for (const req of t.requirements) {
        if (!manifestMap.has(req)) {
          problems.push(`Ticket ${t.id} references non-existent requirement: ${req}`);
        }
      }
    }
  }

  // 3. Every ticket must have zone and wave
  for (const t of tList) {
    const hasWave = typeof t.wave === "number" && Number.isInteger(t.wave) && t.wave >= 1;
    if (!hasWave) {
      problems.push(`Ticket ${t.id} missing or invalid wave: ${t.wave}`);
    }

    const zones = Array.isArray(t.zone) ? t.zone : typeof t.zone === "string" && t.zone.trim() ? [t.zone] : [];
    if (zones.length === 0) {
      problems.push(`Ticket ${t.id} missing zone`);
    }
  }

  // 4. blockedBy dependencies must exist, and wave == 1 + max(dep waves)
  for (const t of tList) {
    const deps = Array.isArray(t.blockedBy) ? t.blockedBy : [];
    let depsValid = true;
    const depWaves = [];

    for (const depId of deps) {
      const depTicket = ticketMap.get(depId);
      if (!depTicket) {
        problems.push(`Ticket ${t.id} references non-existent blockedBy dependency: ${depId}`);
        depsValid = false;
      } else if (typeof depTicket.wave === "number" && Number.isInteger(depTicket.wave) && depTicket.wave >= 1) {
        depWaves.push(depTicket.wave);
      }
    }

    if (depsValid && typeof t.wave === "number" && Number.isInteger(t.wave) && t.wave >= 1) {
      const expectedWave = depWaves.length === 0 ? 1 : 1 + Math.max(...depWaves);
      if (t.wave !== expectedWave) {
        problems.push(
          `Ticket ${t.id} wave ${t.wave} does not match expected wave ${expectedWave} (1 + max(dep waves))`
        );
      }
    }
  }

  // 5. Disjoint zones per wave via path-prefix check
  function normalizePath(p) {
    return p.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
  }

  function pathsCollide(p1, p2) {
    const n1 = normalizePath(p1);
    const n2 = normalizePath(p2);
    if (!n1 || !n2) return false;
    return n1 === n2 || n2.startsWith(n1 + "/") || n1.startsWith(n2 + "/");
  }

  const waveMap = new Map();
  for (const t of tList) {
    if (typeof t.wave === "number" && Number.isInteger(t.wave) && t.wave >= 1) {
      if (!waveMap.has(t.wave)) {
        waveMap.set(t.wave, []);
      }
      waveMap.get(t.wave).push(t);
    }
  }

  for (const [wave, ticketsInWave] of waveMap.entries()) {
    for (let i = 0; i < ticketsInWave.length; i++) {
      for (let j = i + 1; j < ticketsInWave.length; j++) {
        const tA = ticketsInWave[i];
        const tB = ticketsInWave[j];
        const zonesA = Array.isArray(tA.zone) ? tA.zone : typeof tA.zone === "string" && tA.zone.trim() ? [tA.zone] : [];
        const zonesB = Array.isArray(tB.zone) ? tB.zone : typeof tB.zone === "string" && tB.zone.trim() ? [tB.zone] : [];

        let collided = false;
        for (const pA of zonesA) {
          for (const pB of zonesB) {
            if (pathsCollide(pA, pB)) {
              problems.push(
                `Zone collision in wave ${wave} between ticket ${tA.id} (${pA}) and ticket ${tB.id} (${pB})`
              );
              collided = true;
              break;
            }
          }
          if (collided) break;
        }
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
  };
}
