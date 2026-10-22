/**
 * requirements.mjs — requirement types, statuses, manifest parsing, and recount.
 */

export const ALLOWED_TYPES = ["R", "Ri", "G", "A", "D"];
export const ALLOWED_STATUSES = [
  "open",
  "in-spec",
  "in-ticket",
  "done",
  "placeholder",
  "deferred",
  "dropped",
];

function splitRow(row) {
  const cells = [];
  let curr = "";
  let insideGuillemet = 0;
  let insideBacktick = false;
  let insideDouble = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === "«") {
      insideGuillemet++;
      curr += ch;
    } else if (ch === "»") {
      if (insideGuillemet > 0) insideGuillemet--;
      curr += ch;
    } else if (ch === "`") {
      insideBacktick = !insideBacktick;
      curr += ch;
    } else if (ch === '"' && insideGuillemet === 0 && !insideBacktick) {
      insideDouble = !insideDouble;
      curr += ch;
    } else if (ch === "|" && insideGuillemet === 0 && !insideBacktick && !insideDouble) {
      cells.push(curr.trim());
      curr = "";
    } else {
      curr += ch;
    }
  }
  cells.push(curr.trim());
  return cells;
}

function extractType(id, candidateType) {
  if (candidateType && ALLOWED_TYPES.includes(candidateType)) {
    return candidateType;
  }
  const str = String(id || "").trim();
  const match = str.match(/^(Ri|[RGAD])/i);
  if (match) {
    const raw = match[1];
    if (raw.toLowerCase() === "ri") return "Ri";
    return raw.toUpperCase();
  }
  return null;
}

/**
 * Extract { id, type, status } from a manifest table row.
 * Returns null if the row is not a valid requirement row.
 */
export function parseRequirement(row) {
  if (typeof row !== "string" || !row.trim()) return null;
  const rawCols = splitRow(row);
  const cols = rawCols.filter((c, idx) => {
    // Drop outer empty cells from leading/trailing pipe
    if (idx === 0 && c === "") return false;
    if (idx === rawCols.length - 1 && c === "") return false;
    return true;
  });

  if (cols.length < 2) return null;

  // Status is located from right to left
  let status = null;
  for (let i = cols.length - 1; i >= 0; i--) {
    const s = cols[i].replace(/[*_`]/g, "").trim().toLowerCase();
    if (ALLOWED_STATUSES.includes(s)) {
      status = s;
      break;
    }
  }
  if (!status) return null;

  const idCol = cols[0].replace(/[*_`]/g, "").trim();
  if (!idCol) return null;

  const explicitType = cols.length > 2 && ALLOWED_TYPES.includes(cols[1].trim()) ? cols[1].trim() : null;
  const type = extractType(idCol, explicitType);
  if (!type) return null;

  return { id: idCol, type, status };
}

/**
 * Mechanically recount requirements per status and type.
 */
export function recount(rows) {
  const byStatus = Object.fromEntries(ALLOWED_STATUSES.map((s) => [s, 0]));
  const byType = Object.fromEntries(ALLOWED_TYPES.map((t) => [t, 0]));
  const byStatusAndType = {};
  for (const s of ALLOWED_STATUSES) {
    byStatusAndType[s] = Object.fromEntries(ALLOWED_TYPES.map((t) => [t, 0]));
  }
  let total = 0;

  const items = Array.isArray(rows)
    ? rows
    : typeof rows === "string"
      ? rows.split("\n")
      : [];

  for (const item of items) {
    const req = typeof item === "string" ? parseRequirement(item) : item;
    if (req && req.id && req.type && req.status) {
      if (ALLOWED_STATUSES.includes(req.status) && ALLOWED_TYPES.includes(req.type)) {
        byStatus[req.status] = (byStatus[req.status] || 0) + 1;
        byType[req.type] = (byType[req.type] || 0) + 1;
        if (!byStatusAndType[req.status]) {
          byStatusAndType[req.status] = {};
        }
        byStatusAndType[req.status][req.type] = (byStatusAndType[req.status][req.type] || 0) + 1;
        total++;
      }
    }
  }

  return {
    total,
    byStatus,
    byType,
    byStatusAndType,
    ...byStatus,
    ...byType,
  };
}
