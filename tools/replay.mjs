#!/usr/bin/env node
/**
 * replay.mjs — record/replay a live network interaction as a deterministic cassette.
 *
 * The gap this closes: an Oracle can start a smoke run, but it cannot REFUTE a
 * claim about a network path without the live service. Exchange-dependent code
 * (broker APIs, Telegram, OAuth) was therefore only ever verified by hand, and
 * the defects it hid — burst requests, missing depth coverage, an unlabelled
 * venue — surfaced in production instead of in review.
 *
 * A cassette is the recorded request/response pairs for one scenario. Replay
 * serves them from a local proxy, so the product under test talks to the same
 * bytes every run.
 *
 * Commands:
 *   record  --cassette <file> --port <n> [--target <url>] [--filter <regex>]
 *   replay  --cassette <file> --port <n> [--strict]
 *   verify  --cassette <file>              check structural integrity + coverage
 *   show    --cassette <file>              list recorded interactions
 *
 * Cassette format (JSON):
 *   { version, recordedAt, target, interactions: [ { key, request, response } ] }
 *
 * Matching is by METHOD + PATH + normalised query. Volatile headers and bodies
 * are redacted at record time so a cassette is safe to commit.
 *
 * Zero dependencies. Node 18+ / Bun.
 */
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* --------------------------------------------------------------- normalising */

// Headers that differ every run and would make matching/commit-review noisy.
const VOLATILE_HEADERS = new Set([
  "date", "connection", "keep-alive", "transfer-encoding", "content-length",
  "content-encoding",
  "x-request-id", "x-amzn-trace-id", "cf-ray", "set-cookie", "expires",
  "etag", "last-modified", "age", "via", "server-timing",
]);

// Header names whose VALUES are secrets; the name is kept, the value redacted,
// so a cassette still shows that authentication happened.
const SECRET_HEADERS = /^(authorization|cookie|x-api-key|api-key|x-auth-token|proxy-authorization)$/i;
const SECRET_BODY_KEYS = /("(?:api_?key|token|secret|password|access_?token|refresh_?token|signature|apiKey|apiSecret)"\s*:\s*")(?:\\.|[^"\\])*"/gi;
const SECRET_QUERY = /([?&](?:api_?key|token|secret|password|signature|access_?token)=)[^&]*/gi;

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (VOLATILE_HEADERS.has(lk)) continue;
    out[lk] = SECRET_HEADERS.test(lk) ? "[REDACTED]" : v;
  }
  return out;
}

function redactBody(text) {
  if (!text) return text;
  return text.replace(SECRET_BODY_KEYS, '$1[REDACTED]"');
}

function redactUrl(url) {
  return (url || "").replace(SECRET_QUERY, "$1[REDACTED]");
}
function decodeResponseBody(buffer, encoding) {
  if (!buffer || !buffer.length) return "";
  const enc = (encoding || "").toLowerCase().trim();
  try {
    if (enc === "gzip") return gunzipSync(buffer).toString("utf8");
    if (enc === "br") return brotliDecompressSync(buffer).toString("utf8");
    if (enc === "deflate") return inflateSync(buffer).toString("utf8");
  } catch {}
  return buffer.toString("utf8");
}


/** Stable identity of a request, ignoring volatile and secret material. */
function requestKey(method, url, body) {
  const u = new URL(url, "http://placeholder");
  const params = [...u.searchParams.entries()]
    .map(([k, v]) => [k, k.match(/key|token|secret|password|signature/i) ? "[REDACTED]" : v])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const q = params.map(([k, v]) => `${k}=${v}`).join("&");
  const payload = body ? createHash("sha256").update(redactBody(body), "utf8").digest("hex").slice(0, 12) : "-";
  return `${method.toUpperCase()} ${u.pathname}${q ? "?" + q : ""} [${payload}]`;
}

/* ------------------------------------------------------------------ cassettes */

function loadCassette(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  let cassette;
  try {
    cassette = JSON.parse(raw);
  } catch {
    const repaired = raw.replace(/(\"\[REDACTED\])(?=[\s,}\]])/g, '$1"');
    cassette = JSON.parse(repaired);
  }
  if (Array.isArray(cassette?.interactions)) {
    const fixUnclosed = (t) => (typeof t === "string"
      ? t.replace(/("(?:api_?key|token|secret|password|access_?token|refresh_?token|signature|apiKey|apiSecret)"\s*:\s*")\[REDACTED\](?=[\s,}\]])/gi, '$1[REDACTED]"')
      : t);
    for (const item of cassette.interactions) {
      if (item.request?.body) item.request.body = fixUnclosed(item.request.body);
      if (item.response?.body) item.response.body = fixUnclosed(item.response.body);
    }
  }
  return cassette;
}

function saveCassette(path, cassette) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cassette, null, 2), "utf8");
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/* -------------------------------------------------------------------- record */

async function cmdRecord(cassettePath, port, target, filter) {
  if (!target) { console.error("replay: --target is required for record"); return 2; }
  const base = new URL(target);
  const isHttps = base.protocol === "https:";
  const upstreamPort = base.port ? Number(base.port) : (isHttps ? 443 : 80);
  const upstreamRequest = isHttps ? httpsRequest : httpRequest;
  const upstreamHost = base.host;
  const filterRe = filter ? new RegExp(filter) : null;
  const existing = loadCassette(cassettePath);
  const interactions = existing?.interactions ?? [];
  const seen = new Set(interactions.map((i) => i.key));

  const recorded = [];
  const flush = () => {
    saveCassette(cassettePath, {
      version: 1,
      recordedAt: new Date().toISOString().slice(0, 10),
      target: base.origin,
      interactions,
    });
  };
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const u = new URL(req.url || "/", "http://localhost");
    const pathAndQuery = u.pathname + u.search;

    const isRecorded = !filterRe || filterRe.test(pathAndQuery) || filterRe.test(u.pathname);
    // Pass-through for anything the operator excluded (auth, telemetry).
    if (!isRecorded) {
      const headers = { ...req.headers, host: upstreamHost };
      const upstream = upstreamRequest(
        { hostname: base.hostname, port: upstreamPort, path: pathAndQuery, method: req.method, headers },
        (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); },
      );
      upstream.on("error", () => { res.writeHead(502); res.end(); });
      if (body) upstream.write(body);
      upstream.end();
      return;
    }

    const headers = { ...req.headers, host: upstreamHost };
    const upstream = upstreamRequest(
      { hostname: base.hostname, port: upstreamPort, path: pathAndQuery, method: req.method, headers },
      async (up) => {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          const rawBuffer = Buffer.concat(chunks);
          const respBody = decodeResponseBody(rawBuffer, up.headers["content-encoding"]);
          const key = requestKey(req.method, pathAndQuery, body);
          if (!seen.has(key)) {
            seen.add(key);
            const entry = {
              key,
              request: { method: req.method, url: redactUrl(pathAndQuery), headers: redactHeaders(headers), body: redactBody(body) || null },
              response: { status: up.statusCode, headers: redactHeaders(up.headers), body: redactBody(respBody) },
            };
            interactions.push(entry);
            recorded.push(entry);
            flush();   // incremental: a crash or a hard kill must not lose the recording
            console.log(`  + ${key}`);
          }
          res.writeHead(up.statusCode || 200, up.headers);
          res.end(rawBuffer);
        });
      },
    );
    upstream.on("error", (e) => { res.writeHead(502); res.end(String(e.message)); });
    if (body) upstream.write(body);
    upstream.end();
  });

  server.listen(port, () => {
    console.log(`replay: recording http://127.0.0.1:${port} -> ${target}`);
    console.log(`  point the product under test at http://127.0.0.1:${port}`);
    console.log(`  Ctrl-C to finish.\n`);
  });

  const finish = () => {
    flush();
    console.log(`\nreplay: ${recorded.length} new interaction(s); ${interactions.length} total -> ${cassettePath}`);
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", finish);
  process.on("SIGTERM", finish);
  // On Windows a hard kill does not deliver signals, so also flush on exit.
  process.on("exit", () => { try { flush(); } catch { /* best effort */ } });
  return server;
}

/* -------------------------------------------------------------------- replay */

function cmdReplay(cassettePath, port, strict) {
  const cassette = loadCassette(cassettePath);
  if (!cassette) { console.error(`replay: no cassette at ${cassettePath}`); return 2; }

  const byKey = new Map();
  for (const i of cassette.interactions) {
    if (!byKey.has(i.key)) byKey.set(i.key, []);
    byKey.get(i.key).push(i);
  }
  const cursors = new Map();   // key -> how many times served

  const unmatched = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const key = requestKey(req.method, req.url, body);
    const matches = byKey.get(key);

    if (!matches || !matches.length) {
      unmatched.push(key);
      console.log(`  MISS  ${key}`);
      // Strict mode is the point: a missing interaction means the product
      // reached a network path this scenario never covered. That is a finding,
      // not a reason to reach for the live service.
      res.writeHead(strict ? 501 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "replay: no recorded interaction", key }));
      return;
    }

    // Serve repeated calls in order; the last one repeats if called again.
    const n = cursors.get(key) ?? 0;
    cursors.set(key, n + 1);
    const hit = matches[Math.min(n, matches.length - 1)];
    const headers = { ...hit.response.headers };
    delete headers["content-length"];
    delete headers["content-encoding"];
    res.writeHead(hit.response.status || 200, headers);
    res.end(hit.response.body ?? "");
    console.log(`  HIT   ${key}`);
  });

  server.listen(port, () => {
    console.log(`replay: serving cassette on http://127.0.0.1:${port}${strict ? "  (strict)" : ""}`);
    console.log(`  ${cassette.interactions.length} interaction(s), target ${cassette.target || "unknown"}`);
    console.log(`  Ctrl-C to stop.\n`);
  });
  process.on("SIGINT", () => {
    console.log(`\nreplay: ${unmatched.length} unmatched request(s).`);
    for (const u of [...new Set(unmatched)]) console.log(`  MISS  ${u}`);
    if (unmatched.length && strict) console.log("\nstrict mode: unmatched requests exit non-zero.");
    server.close();
    process.exit(unmatched.length && strict ? 1 : 0);
  });
  return server;
}

/* -------------------------------------------------------------------- verify */

function cmdVerify(cassettePath) {
  const cassette = loadCassette(cassettePath);
  if (!cassette) { console.error(`replay: no cassette at ${cassettePath}`); return 2; }

  const problems = [];
  if (cassette.version !== 1) problems.push(`unexpected version ${cassette.version}`);
  if (!Array.isArray(cassette.interactions)) problems.push("interactions is not an array");
  if (!cassette.recordedAt) problems.push("missing recordedAt");

  const seen = new Set();
  const methods = new Map();
  for (const [n, i] of (cassette.interactions || []).entries()) {
    if (!i.key) problems.push(`interaction ${n}: missing key`);
    if (!i.request?.method) problems.push(`interaction ${n}: missing request.method`);
    if (!i.response || typeof i.response.status !== "number") problems.push(`interaction ${n}: missing response.status`);
    if (seen.has(i.key)) problems.push(`interaction ${n}: duplicate key ${i.key}`);
    seen.add(i.key);
    const m = i.request?.method || "?";
    methods.set(m, (methods.get(m) || 0) + 1);
    const ct = (i.response?.headers?.["content-type"] || "").toLowerCase();
    if (ct.includes("application/json") && typeof i.response?.body === "string" && i.response.body.trim()) {
      try {
        JSON.parse(i.response.body);
      } catch (err) {
        problems.push(`interaction ${n}: malformed JSON body (${err.message})`);
      }
    }
  }

  // Scan the actual body STRINGS, not a re-serialized document: inside
  // JSON.stringify the quotes are escaped, so a naive regex on the whole
  // document never matches and a leaked secret passes verification.
  const liveSecret = (() => {
    const re = /"(?:api_?key|token|secret|password|access_?token|refresh_?token|signature|apiSecret)"\s*:\s*"(?!\[REDACTED\])[^"]{12,}"/i;
    for (const i of cassette.interactions || []) {
      for (const [where, text] of [["request.body", i.request?.body], ["response.body", i.response?.body]]) {
        if (typeof text !== "string") continue;
        const m = re.exec(text);
        if (m) return `${where}: ${m[0].slice(0, 48)}`;
      }
      // Header values are a separate leak surface.
      for (const [where, hdrs] of [["request.headers", i.request?.headers], ["response.headers", i.response?.headers]]) {
        for (const [k, v] of Object.entries(hdrs || {})) {
          if (/authorization|cookie|api-key|x-api-key|token/i.test(k) && typeof v === "string" && v !== "[REDACTED]" && v.length > 12) {
            return `${where}.${k}: ${String(v).slice(0, 32)}`;
          }
        }
      }
    }
    return null;
  })();
  if (liveSecret) problems.push(`UNREDACTED SECRET -> ${liveSecret}`);

  const errors = (cassette.interactions || []).filter((i) => (i.response?.status ?? 0) >= 500).length;
  const ok = (cassette.interactions || []).filter((i) => {
    const s = i.response?.status ?? 0;
    return s >= 200 && s < 300;
  }).length;

  console.log(`replay: cassette ${cassettePath}`);
  console.log(`  recordedAt  ${cassette.recordedAt || "(none)"}`);
  console.log(`  target      ${cassette.target || "(none)"}`);
  console.log(`  interactions ${(cassette.interactions || []).length}  (2xx ${ok}, 5xx ${errors})`);
  console.log(`  methods     ${[...methods].map(([k, v]) => `${k}:${v}`).join(" ")}`);

  if (errors) console.log(`\n  warning: ${errors} recorded 5xx response(s) — replay will faithfully reproduce the failure.`);
  if (!(cassette.interactions || []).length) problems.push("cassette has no interactions — it proves nothing");

  if (!problems.length) { console.log("\n  cassette is structurally valid and redacted."); return 0; }
  console.log(`\n  ${problems.length} problem(s):`);
  for (const p of problems) console.log(`    ${p}`);
  return 1;
}

/* ---------------------------------------------------------------------- show */

function cmdShow(cassettePath) {
  const cassette = loadCassette(cassettePath);
  if (!cassette) { console.error(`replay: no cassette at ${cassettePath}`); return 2; }
  for (const i of cassette.interactions) {
    console.log(`  ${String(i.response?.status ?? "?").padStart(3)}  ${i.key}`);
  }
  return 0;
}
export {
  cmdRecord,
  cmdReplay,
  cmdVerify,
  cmdShow,
  loadCassette,
  saveCassette,
  requestKey,
  redactUrl,
  redactHeaders,
  redactBody,
  decodeResponseBody,
};


/* ---------------------------------------------------------------------- main */

const isMain = process.argv[1] && (() => {
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  const argv = process.argv.slice(2);
const opts = { _: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--cassette") opts.cassette = argv[++i];
  else if (a === "--port") opts.port = Number(argv[++i]);
  else if (a === "--target") opts.target = argv[++i];
  else if (a === "--filter") opts.filter = argv[++i];
  else if (a === "--strict") opts.strict = true;
  else opts._.push(a);
}

const cmd = opts._[0];
let code;
switch (cmd) {
  case "record": code = await cmdRecord(opts.cassette, opts.port || 8899, opts.target, opts.filter); break;
  case "replay": code = cmdReplay(opts.cassette, opts.port || 8899, opts.strict); break;
  case "verify": code = cmdVerify(opts.cassette); break;
  case "show":   code = cmdShow(opts.cassette); break;
  default:
    console.log("replay.mjs — deterministic record/replay for network paths\n");
    console.log("  node replay.mjs record --cassette c.json --port 8899 --target https://api.example.com");
    console.log("  node replay.mjs replay --cassette c.json --port 8899 --strict");
    console.log("  node replay.mjs verify --cassette c.json     # integrity + redaction");
    console.log("  node replay.mjs show   --cassette c.json     # list interactions");
    code = 0;
}
if (cmd === "record" || cmd === "replay") { /* servers keep the loop alive */ }
else process.exit(code);
}
