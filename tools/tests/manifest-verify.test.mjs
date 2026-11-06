import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequirement, validateManifestVerify } from "../requirements.mjs";
import { validateManifestRows } from "../workflow-core.mjs";

test("parseRequirement: exposes verify when manifest header names a verify column", () => {
  const header = "| ID | Requirement | Verbatim quote | verify | Status |";
  const row = "| R01 | Манифест связывает требование | «quote» | `node --test tools/tests/manifest-verify.test.mjs` | in-spec |";
  const parsed = parseRequirement(row, header);

  assert.ok(parsed);
  assert.equal(parsed.id, "R01");
  assert.equal(parsed.type, "R");
  assert.equal(parsed.status, "in-spec");
  assert.equal(parsed.verify, "node --test tools/tests/manifest-verify.test.mjs");
});

test("parseRequirement: strips outer backticks from verify but preserves raw command", () => {
  const header = "| ID | Requirement | verify | Status |";
  const rowNoTicks = "| R02 | Direct command | node --test foo.mjs | in-spec |";
  const parsedNoTicks = parseRequirement(rowNoTicks, header);
  assert.equal(parsedNoTicks?.verify, "node --test foo.mjs");

  const rowWithTicks = "| R03 | Ticked command | `npm test` | in-spec |";
  const parsedWithTicks = parseRequirement(rowWithTicks, header);
  assert.equal(parsedWithTicks?.verify, "npm test");
});

test("parseRequirement: does not expose verify when header lacks verify column (legacy)", () => {
  const legacyHeader = "| ID | Requirement | Verbatim quote | Status |";
  const row = "| R01 | User requirement | «quote» | in-spec |";
  const parsed = parseRequirement(row, legacyHeader);

  assert.ok(parsed);
  assert.equal(parsed.id, "R01");
  assert.equal(parsed.type, "R");
  assert.equal(parsed.status, "in-spec");
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "verify"), false);
});

test("parseRequirement: calling without header maintains legacy 3-property return", () => {
  const row = "| R01 | User requirement | «quote» | in-spec |";
  const parsed = parseRequirement(row);

  assert.deepEqual(parsed, {
    id: "R01",
    type: "R",
    status: "in-spec",
  });
});

test("validateManifestVerify: returns error when verify column present and a row has empty verify", () => {
  const header = "| ID | Requirement | Verbatim quote | verify | Status |";
  const rows = [
    "| R01 | First req | «valid quote 1» | `node --test ok.mjs` | in-spec |",
    "| R02 | Second req | «valid quote 2» | | in-spec |",
  ];

  const err = validateManifestVerify(header, rows);
  assert.ok(err, "Should return an error for empty verify");
  assert.match(err, /R02/);
  assert.match(err, /verify/i);
});

test("validateManifestVerify: returns error when verify cell is shorter than 4 chars", () => {
  const header = "| ID | Requirement | Verbatim quote | verify | Status |";
  const shortRows = [
    "| R01 | First req | «valid quote 1» | - | in-spec |",
  ];
  const err1 = validateManifestVerify(header, shortRows);
  assert.ok(err1);
  assert.match(err1, /R01/);

  const naRows = [
    "| R02 | Second req | «valid quote 2» | n/a | in-spec |",
  ];
  const err2 = validateManifestVerify(header, naRows);
  assert.ok(err2);
  assert.match(err2, /R02/);

  const emptyTicks = [
    "| R03 | Third req | «valid quote 3» | `` | in-spec |",
  ];
  const err3 = validateManifestVerify(header, emptyTicks);
  assert.ok(err3);
  assert.match(err3, /R03/);
});

test("validateManifestVerify: returns null when all rows have non-empty verify (>= 4 chars)", () => {
  const header = "| ID | Requirement | Verbatim quote | verify | Status |";
  const rows = [
    "| R01 | First req | «valid quote 1» | `node --test ok.mjs` | in-spec |",
    "| R02 | Second req | «valid quote 2» | npm test | done |",
  ];

  const res = validateManifestVerify(header, rows);
  assert.equal(res, null);
});

test("validateManifestVerify: returns null when header has no verify column (legacy)", () => {
  const header = "| ID | Requirement | Verbatim quote | Status |";
  const rows = [
    "| R01 | First req | «valid quote 1» | in-spec |",
    "| R02 | Second req | «valid quote 2» | done |",
  ];

  const res = validateManifestVerify(header, rows);
  assert.equal(res, null);
});

test("validateManifestRows: manifest with verify column and empty verify returns error", () => {
  const body = [
    "| ID | Requirement | Verbatim quote | verify | Status |",
    "|----|-------------|----------------|--------|--------|",
    "| R01 | First req | «quote 1» | `node --test a.mjs` | in-spec |",
    "| R02 | Second req | «quote 2» | | in-spec |",
  ].join("\n");

  const res = validateManifestRows(body);
  assert.ok(res, "Should return an error string");
  assert.match(res, /R02/);
  assert.match(res, /verify/i);
});

test("validateManifestRows: manifest with verify column and filled verify returns null", () => {
  const body = [
    "| ID | Requirement | Verbatim quote | verify | Status |",
    "|----|-------------|----------------|--------|--------|",
    "| R01 | First req | «quote 1» | `node --test a.mjs` | in-spec |",
    "| R02 | Second req | «quote 2» | `node --test b.mjs` | in-spec |",
  ].join("\n");

  const res = validateManifestRows(body);
  assert.equal(res, null);
});

test("validateManifestRows: manifest without verify column returns null (legacy)", () => {
  const legacyBody = [
    "| ID | Requirement | Verbatim quote | Status |",
    "|----|-------------|----------------|--------|",
    "| R01 | First req | «quote 1» | in-spec |",
    "| R02 | Second req | «quote 2» | done |",
  ].join("\n");

  const res = validateManifestRows(legacyBody);
  assert.equal(res, null);
});

test("validateManifestRows: duplicate IDs still caught with verify column present", () => {
  const duplicateBody = [
    "| ID | Requirement | Verbatim quote | verify | Status |",
    "|----|-------------|----------------|--------|--------|",
    "| R01 | First req | «quote 1» | `node --test a.mjs` | in-spec |",
    "| R01 | Duplicate req | «quote 2» | `node --test b.mjs` | in-spec |",
  ].join("\n");

  const res = validateManifestRows(duplicateBody);
  assert.equal(res, "duplicate requirement IDs");
});
