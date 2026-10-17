#!/usr/bin/env node
/**
 * tools/contrast-check.mjs — WCAG 2.x contrast checker (normal 4.5:1, large 3.0:1).
 *
 * Ported from anti-slop's contrast-check.py (MIT, miqdadbadjuber/anti-slop, pinned 439a2ef5).
 * Rule: compare the UNROUNDED ratio, round only for display. A pairing at 4.4983:1
 * prints 4.50 and still FAILS 4.5:1.
 *
 * Usage:
 *   node tools/contrast-check.mjs "#FFFFFF" "#777777"
 *   node tools/contrast-check.mjs --selftest   # recompute reference table, exit nonzero on drift
 */

const NAMED = { black: [0, 0, 0], white: [255, 255, 255] };

// Reference table: [pairing label, ratio display, normal verdict, large verdict].
// Ratios shown rounded; verdicts computed from the unrounded value.
export const REFERENCE_TABLE = [
  ["Black on white", 21.0, "Pass", "Pass"],
  ["White on black", 21.0, "Pass", "Pass"],
  ["White on #333333", 12.63, "Pass", "Pass"],
  ["White on #666666", 5.74, "Pass", "Pass"],
  ["#777777 on white", 4.48, "Fail", "Pass"],
  ["#777777 on #070707", 4.5, "Fail", "Pass"], // 4.4983:1 — the near-threshold case
  ["White on #888888", 3.54, "Fail", "Pass"],
  ["White on #999999", 2.85, "Fail", "Fail"],
  ["#555555 on black", 2.82, "Fail", "Fail"],
];

export function parseHex(value) {
  let v = String(value).trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(v)) v = [...v].map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(v)) throw new Error(`expected a hex color like #FFFFFF, got ${JSON.stringify(value)}`);
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
}

export function luminance([r, g, b]) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function checkPair(hexA, hexB) {
  const ratio = contrastRatio(parseHex(hexA), parseHex(hexB));
  return { ratio, normal: ratio >= 4.5, large: ratio >= 3.0 };
}

function parsePairing(label) {
  const parts = label.split(/\s+on\s+/i).map((t) => t.trim());
  if (parts.length !== 2) throw new Error(`cannot parse pairing ${JSON.stringify(label)}`);
  return parts.map((token) => {
    const hex = token.match(/#[0-9a-fA-F]{3,6}/)?.[0];
    if (hex) return parseHex(hex);
    const named = NAMED[token.toLowerCase()];
    if (!named) throw new Error(`cannot parse ${JSON.stringify(token)}`);
    return named;
  });
}

export function selftest() {
  const failures = [];
  for (const [label, displayRatio, normal, large] of REFERENCE_TABLE) {
    const [a, b] = parsePairing(label);
    const raw = contrastRatio(a, b);
    const shown = Math.round(raw * 100) / 100;
    if (shown.toFixed(2) !== displayRatio.toFixed(2)) {
      failures.push(`${label}: table says ${displayRatio.toFixed(2)}, formula says ${shown.toFixed(2)}`);
    }
    if ((raw >= 4.5 ? "Pass" : "Fail") !== normal) failures.push(`${label}: normal verdict drift`);
    if ((raw >= 3.0 ? "Pass" : "Fail") !== large) failures.push(`${label}: large verdict drift`);
  }
  return failures;
}

function main(argv) {
  if (argv.length === 1 && argv[0] === "--selftest") {
    const failures = selftest();
    if (failures.length) {
      for (const f of failures) console.error(`selftest: ${f}`);
      return 1;
    }
    console.log(`selftest: ${REFERENCE_TABLE.length} reference pairs OK`);
    return 0;
  }
  if (argv.length !== 2) {
    console.error("usage: node tools/contrast-check.mjs <hex1> <hex2> | --selftest");
    return 2;
  }
  let result;
  try {
    result = checkPair(argv[0], argv[1]);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 2;
  }
  console.log(`ratio: ${result.ratio.toFixed(2)}:1`);
  console.log(`normal text (4.5:1): ${result.normal ? "PASS" : "FAIL"}`);
  console.log(`large text  (3.0:1): ${result.large ? "PASS" : "FAIL"}`);
  return result.normal && result.large ? 0 : 1;
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
