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
function filterOuterEmpty(cells) {
  return cells.filter((c, idx) => (idx !== 0 || c !== "") && (idx !== cells.length - 1 || c !== ""));
}

function findStatus(cols) {
  for (let i = cols.length - 1; i >= 0; i--) {
    const s = cols[i].replace(/[*_`]/g, "").trim().toLowerCase();
    if (ALLOWED_STATUSES.includes(s)) return s;
  }
  return null;
}

function extractVerify(cols, header) {
  if (header === undefined || header === null) return undefined;
  const vIdx = getHeaderVerifyIndex(header);
  if (vIdx < 0) return undefined;
  const raw = cols[vIdx] !== undefined ? cols[vIdx].trim() : "";
  return raw.replace(/^`+|`+$/g, "").trim();
}

function toRowList(rows) {
  if (Array.isArray(rows)) return rows;
  if (typeof rows === "string") return rows.split(/\r?\n/);
  return [];
}

function toRequirement(item, vIdx) {
  if (typeof item === "string") return parseRequirement(item, vIdx);
  if (item && typeof item === "object" && item.id) return item;
  return null;
}

/**
 * Find the zero-based index of the 'verify' column in the header row cells.
 * Returns -1 if no verify column is present.
 */
export function getHeaderVerifyIndex(header) {
  if (header === null || header === undefined) return -1;
  if (typeof header === "number") return header;
  const rawCols = typeof header === "string" ? splitRow(header) : Array.isArray(header) ? header : [];
  const cols = filterOuterEmpty(rawCols);
  return cols.findIndex((c) => {
    const clean = String(c || "").replace(/[*_`: ]/g, "").trim().toLowerCase();
    return clean === "verify";
  });
}

/**
 * Extract { id, type, status } from a manifest table row.
 * Returns null if the row is not a valid requirement row.
 * If header names a verify column, also exposes `verify`.
 */
export function parseRequirement(row, header) {
  if (typeof row !== "string" || !row.trim()) return null;
  const cols = filterOuterEmpty(splitRow(row));
  if (cols.length < 2) return null;

  const status = findStatus(cols);
  if (!status) return null;

  const idCol = cols[0].replace(/[*_`]/g, "").trim();
  if (!idCol) return null;

  const explicitType = cols.length > 2 && ALLOWED_TYPES.includes(cols[1].trim()) ? cols[1].trim() : null;
  const type = extractType(idCol, explicitType);
  if (!type) return null;

  const res = { id: idCol, type, status };
  const verify = extractVerify(cols, header);
  if (verify !== undefined) {
    res.verify = verify;
  }
  return res;
}

/**
 * Validate that every requirement row carries a non-empty verify criterion (min length 4)
 * when the manifest header declares a verify column.
 * Returns null if valid, or an error string describing the failing row.
 */
export function validateManifestVerify(headerRow, rows) {
  const vIdx = getHeaderVerifyIndex(headerRow);
  if (vIdx < 0) return null;

  for (const item of toRowList(rows)) {
    if (!item) continue;
    const req = toRequirement(item, vIdx);
    if (!req) continue;

    const clean = String(req.verify || "").replace(/^`+|`+$/g, "").trim();
    if (clean.length < 4) {
      return `row '${req.id}' missing verify criterion`;
    }
  }

  return null;
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
