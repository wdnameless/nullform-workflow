import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  layoutSketch, sketchBoxPath, buildSketch, toExcalidraw, seedOf, seededRandom,
} from "../dashboard-sketch.mjs";
import { collectSymbolInventory, collectArchDrill } from "../arch-drill.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "archdrill-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.mjs"), [
    "export function alpha() {",
    "  beta();",
    "  beta();",
    "}",
    "function beta() {",
    "  return 1;",
    "}",
  ].join("\n"), "utf8");
  writeFileSync(join(root, "src", "b.py"), "def handle(x):\n    return x\n", "utf8");
  writeFileSync(join(root, "src", "c.mjs"), "\u0000\u0001 not parseable", "utf8");
  return root;
}

test("collectSymbolInventory: JS symbols carry real line ranges", () => {
  const root = fixture();
  try {
    const inv = collectSymbolInventory(root, "src/a.mjs");
    assert.equal(inv.path, "src/a.mjs");
    assert.equal(inv.lines, 7);
    const names = inv.symbols.map((s) => s.name).sort();
    assert.deepEqual(names, ["alpha", "beta"]);
    const alpha = inv.symbols.find((s) => s.name === "alpha");
    assert.equal(alpha.startLine, 1);
    assert.equal(alpha.endLine, 4);
    assert.equal(alpha.internalCalls, 2, "beta() called twice inside alpha");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectSymbolInventory: python uses the same scanner, not a second one", () => {
  const root = fixture();
  try {
    const inv = collectSymbolInventory(root, "src/b.py");
    assert.equal(inv.symbols.length, 1);
    assert.equal(inv.symbols[0].name, "handle");
    assert.equal(inv.symbols[0].startLine, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectSymbolInventory: an unparseable file yields no symbols instead of throwing", () => {
  const root = fixture();
  try {
    const inv = collectSymbolInventory(root, "src/c.mjs");
    assert.deepEqual(inv.symbols, []);
    assert.equal(inv.lines, 1, "the file still reports its size");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectSymbolInventory: a missing file is empty, never an exception", () => {
  const root = fixture();
  try {
    const inv = collectSymbolInventory(root, "src/nope.mjs");
    assert.deepEqual(inv.symbols, []);
    assert.equal(inv.lines, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectArchDrill: module file counts match the module input, and the cap is reported", () => {
  const root = fixture();
  try {
    const modules = [{
      name: "src",
      fileCount: 3,
      totalLines: 9,
      files: [
        { name: "src/a.mjs", lines: 7 },
        { name: "src/b.py", lines: 2 },
      ],
    }];
    const drill = collectArchDrill(root, modules);
    assert.equal(drill.files, 3);
    assert.equal(drill.modules.length, 1);
    const src = drill.modules[0];
    assert.equal(src.files, 3);
    assert.equal(src.truncated, true, "fileCount exceeds the files actually listed");
    assert.equal(src.children.length, 2);
    assert.ok(src.children[0].symbols.length >= 1, "symbols travel with the file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("layoutSketch: levels follow edges and the root sits alone on level 0", () => {
  const s = layoutSketch({
    nodes: [
      { id: "p", label: "project" },
      { id: "a", label: "a" },
      { id: "b", label: "b" },
    ],
    edges: [{ from: "p", to: "a" }, { from: "p", to: "b" }],
  });
  const byId = Object.fromEntries(s.nodes.map((n) => [n.id, n]));
  assert.equal(byId.p.level, 0);
  assert.equal(byId.a.level, 1);
  assert.equal(byId.b.level, 1);
  assert.ok(byId.a.x > byId.p.x, "children are to the right of the root");
});

test("layoutSketch: a wide level is packed into several columns instead of one 2.6k-pixel strip", () => {
  const nodes = [{ id: "root", label: "root" }];
  for (let i = 0; i < 40; i++) nodes.push({ id: `n${i}`, label: `n${i}` });
  const edges = nodes.slice(1).map((n) => ({ from: "root", to: n.id }));
  const s = layoutSketch({ nodes, edges });
  assert.ok(s.h <= 900, `height stayed bounded, got ${s.h}`);
  assert.ok(s.w > 600, `width grew with the extra columns, got ${s.w}`);
});

test("deterministic geometry: the same node renders byte-identically across calls", () => {
  const a = sketchBoxPath(10, 20, 200, 50, seedOf("x"));
  const b = sketchBoxPath(10, 20, 200, 50, seedOf("x"));
  assert.equal(a, b);
  const c = sketchBoxPath(10, 20, 200, 50, seedOf("y"));
  assert.notEqual(a, c, "a different id must draw a different wobble");
});

test("seededRandom stays in [0,1) and repeats for the same seed", () => {
  const r1 = seededRandom(42);
  const r2 = seededRandom(42);
  for (let i = 0; i < 20; i++) {
    const v = r1();
    assert.ok(v >= 0 && v < 1);
    assert.equal(v, r2());
  }
});

test("buildSketch: project level shows only modules, module level only files, file level only symbols", () => {
  const drill = {
    name: "proj",
    files: 4,
    lines: 20,
    modules: [{
      name: "src",
      files: 2,
      lines: 9,
      truncated: false,
      children: [{
        path: "src/a.mjs",
        lines: 7,
        truncated: false,
        symbols: [{ name: "alpha", kind: "function", startLine: 1, endLine: 4, lines: 4, internalCalls: 2 }],
      }],
    }],
  };
  const project = buildSketch(drill, { edges: [] }, {});
  assert.equal(project.level, "project");
  assert.ok(project.nodes.every((n) => n.kind === "root" || n.module), "no file or symbol at the top level");

  const mod = buildSketch(drill, { edges: [] }, { module: "src" });
  assert.equal(mod.level, "module");
  assert.deepEqual(mod.nodes.map((n) => n.kind).sort(), ["code", "file"]);

  const file = buildSketch(drill, { edges: [] }, { module: "src", file: "src/a.mjs" });
  assert.equal(file.level, "file");
  assert.deepEqual(file.nodes.map((n) => n.kind).sort(), ["file", "symbol"]);
  assert.equal(file.crumbs.length, 3, "project › module › file");
});

test("buildSketch: an unknown module or file falls back to the project level, never to an error", () => {
  const drill = { name: "p", files: 0, lines: 0, modules: [] };
  assert.equal(buildSketch(drill, null, { module: "nope" }).level, "project");
  assert.equal(buildSketch(drill, null, { module: "nope", file: "x" }).level, "project");
});

test("toExcalidraw: envelope is loadable and every element is complete", () => {
  const drill = {
    name: "p", files: 1, lines: 2,
    modules: [{ name: "src", files: 1, lines: 2, truncated: false, children: [] }],
  };
  const sketch = buildSketch(drill, { edges: [] }, {});
  const doc = toExcalidraw(sketch, "demo");
  assert.equal(doc.type, "excalidraw");
  assert.equal(doc.version, 2);
  assert.ok(doc.elements.length >= 2);
  for (const el of doc.elements) {
    assert.ok(el.id, "every element has an id");
    assert.ok(["rectangle", "text", "arrow"].includes(el.type));
    for (const k of ["x", "y", "width", "height"]) assert.equal(typeof el[k], "number", `${el.type}.${k}`);
  }
  const texts = doc.elements.filter((e) => e.type === "text");
  assert.ok(texts.length > 0);
  for (const t of texts) {
    assert.ok(t.containerId, "text is container-bound, never the ignored label: shorthand");
    assert.equal(t.originalText, t.text);
    assert.equal(t.fontFamily, 1);
  }
  assert.ok(!JSON.stringify(doc).includes('"label":{'), "the label shorthand is silently ignored by Excalidraw");
});

test("toExcalidraw: arrows bind to existing shapes, so a moved box keeps its edge", () => {
  const drill = {
    name: "p", files: 2, lines: 3,
    modules: [
      { name: "a", files: 1, lines: 1, truncated: false, children: [] },
      { name: "b", files: 1, lines: 2, truncated: false, children: [] },
    ],
  };
  const sketch = buildSketch(drill, { edges: [{ from: "a", to: "b", weight: 2 }] }, {});
  const doc = toExcalidraw(sketch, "demo");
  const arrows = doc.elements.filter((e) => e.type === "arrow");
  assert.ok(arrows.length >= 1);
  const ids = new Set(doc.elements.map((e) => e.id));
  for (const a of arrows) {
    assert.ok(ids.has(a.startBinding.elementId), "start binding resolves");
    assert.ok(ids.has(a.endBinding.elementId), "end binding resolves");
  }
});
