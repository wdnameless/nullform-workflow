import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareEvidence } from './fixtures/review-execution.mjs';

// Parent verified primary model/reference docs on 2026-10-17. The installed
// 18.11.3 catalogue independently agrees on the alias's window/output/prices.
// This exact snapshot avoids silently inventing alias-to-response equivalence.
const MODEL = 'gpt-4o-mini-2024-07-18';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const EXECUTOR = 'nullform-http-v1';
const RESERVE_NANO_USD = 3 * (128000 * 150 + 256 * 600);
// One project budget for every worktree of one repository:
// <git-common-dir>/nullform-review-budget.json (non-git: <canonical root>/...).
// No policy field, CLI flag or environment variable relocates or resets it.
const LEDGER_FILE = 'nullform-review-budget.json';
const evidenceModule = new URL('../review-evidence.mjs', import.meta.url).href;
const runtimeModule = new URL('../review-http-runtime.mjs', import.meta.url).href;
// Budget authority is the financial owner; the runtime is the transport owner.
const budgetModule = new URL('../review-budget.mjs', import.meta.url).href;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const POLICY = { schemaVersion: 1, provider: 'openai', model: MODEL, transport: EXECUTOR, endpoint: ENDPOINT,
  ceilingUsd: 0.07, maxRequests: 3, maxContextBytes: 65536, maxResponseBytes: 65536, maxOutputTokens: 256, timeoutMs: 250,
  tariffsUsdPerMillion: { input: 0.15, output: 0.60, cacheRead: 0.075, cacheWrite: 0 } };
const gitEnv = home => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
  HOME: home, USERPROFILE: home, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
const gitIn = (cwd, env, ...args) => {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
// Independent statement of the shared-authority contract: the fixture must read the
// budget where the production resolver must put it, not where a reset would be cheap.
const sharedLedgerPath = (cwd, env) => join(realpathSync(resolve(cwd, gitIn(cwd, env, 'rev-parse', '--git-common-dir'))), LEDGER_FILE);

// Every wait in this file is bounded: a stale build that refuses admission
// immediately must fail a test, never hang it.
function withDeadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Fixture timed out after ${milliseconds}ms: ${label}`)), milliseconds); })])
    .finally(() => clearTimeout(timer));
}

// Separate process: the synchronous workflow parent must not block its own HTTP fixture.
const serverScript = String.raw`
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const {root, scenario, model, ledgerPath} = JSON.parse(process.argv[1]);
let ordinal = 0, release = null;
process.on('message', message => { if (message === 'release' && release) { release(); release = null; } });
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const n = ++ordinal;
  fs.appendFileSync(path.join(root, '.tmp', 'requests.jsonl'), JSON.stringify({
    ordinal:n, method:req.method, url:req.url, body:JSON.parse(body), bodyBytes:Buffer.byteLength(body),
    dummyAuth:req.headers.authorization === ['Bearer','fixture-only-credential'].join(' '),
    ledger:fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : null
  }) + '\n');
  if (scenario === 'disconnect') { req.socket.destroy(); return; }
  if (scenario === 'timeout') return;
  if (scenario === 'redirect') { res.writeHead(307, {location:'/redirected'}); res.end(); return; }
  if (scenario === 'http421') { res.writeHead(421, {'content-type':'application/json'}); res.end('{"error":{"message":"fixture misdirected request"}}'); return; }
  if (scenario === 'http429') { res.writeHead(429); res.end('{"error":{"message":"fixture rate limit"}}'); return; }
  if (scenario === 'holdFirst' && n === 1) { process.send({held:1}); await new Promise(done => { release = done; }); }
  const toolTurn = n === 1 || scenario === 'requestLimit';
  const exerciseCalls = scenario === 'exerciseTwice'
    ? [{id:'ex-1', type:'function', function:{name:'exercise_product', arguments:JSON.stringify({offset:0})}},
       {id:'ex-2', type:'function', function:{name:'exercise_product', arguments:JSON.stringify({offset:0})}}]
    : [{id:'exercise-1', type:'function', function:{name:'exercise_product', arguments:JSON.stringify({offset:0})}}];
  const message = toolTurn ? {role:'assistant', content:null, tool_calls:[
    {id:'inspect-1', type:'function', function:{name:'inspect_product', arguments:JSON.stringify({requests:[{path:'product.cjs',kind:'source',offset:0}]})}},
    ...exerciseCalls
  ]} : {role:'assistant',content:JSON.stringify({findings:[],overall_correctness:'correct',overall_explanation:'Synthetic transport fixture, not code-quality evidence',overall_confidence_score:0.9})};
  const response = {id:'chatcmpl-fixture-'+n, object:'chat.completion', created:Math.floor(Date.now()/1000),
    model:scenario === 'modelMismatch' ? 'another-model' : model,
    choices:[{index:0,message,finish_reason:toolTurn ? 'tool_calls' : 'stop'}],
  usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110,prompt_tokens_details:{cached_tokens:20}}};
  if (scenario === 'realUsage') {
    // The standard documented OpenAI shape: known non-billable details at zero.
    response.usage = { prompt_tokens:100, completion_tokens:10, total_tokens:110,
      prompt_tokens_details:{cached_tokens:20, audio_tokens:0},
      completion_tokens_details:{reasoning_tokens:0, audio_tokens:0, accepted_prediction_tokens:0, rejected_prediction_tokens:0} };
  }
  if (scenario === 'overContext') Object.assign(response.usage,{prompt_tokens:200000, total_tokens:200010});
  if (scenario === 'unknownUsage') response.usage.bogus_tokens = 5;
  if (scenario === 'overOutput') Object.assign(response.usage,{completion_tokens:300, total_tokens:400});
  if (scenario === 'trickle') {
    res.writeHead(200, {'content-type':'application/json','x-request-id':'fixture-request-'+n});
    const text = JSON.stringify(response);
    for (let i = 0; i < text.length; i += 8) { res.write(text.slice(i, i + 8)); await new Promise(done => setTimeout(done, 20)); }
    res.end();
    return;
  }
  if (scenario === 'missingUsage') delete response.usage;
  if (scenario === 'publishFailure' && !toolTurn) fs.mkdirSync(path.join(root,'openspec','changes','http','review-evidence.json'));
  if (scenario === 'oversizedResponse') response.choices[0].message.content = 'X'.repeat(65537);
  res.writeHead(200, {'content-type':'application/json','x-request-id':'fixture-request-'+n});
  res.end(JSON.stringify(response));
});
server.listen(0,'127.0.0.1',()=>process.send({endpoint:'http://127.0.0.1:'+server.address().port+'/v1/chat/completions'}));
`;

async function fixture(t, scenario = 'ok') {
  const root = mkdtempSync(join(tmpdir(), 'review-http-'));
  const scratch = join(root, '.tmp'), changeDir = join(root, 'openspec', 'changes', 'http');
  mkdirSync(scratch); mkdirSync(changeDir, { recursive: true });
  writeFileSync(join(changeDir, 'manifest.md'), '| R01 | Consumer returns 42 |\n');
  prepareEvidence(root, 'http');
  writeFileSync(join(root, '.gitignore'), '.tmp/\n.workflow/\n');
  writeFileSync(join(root, 'product.cjs'), "const fs=require('node:fs');fs.appendFileSync('.tmp/product-runs','run\\n');console.log(42);\n");
  const env = gitEnv(scratch);
  const git = (...args) => gitIn(root, env, ...args);
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'HTTP fixture baseline');
  const baseRef = git('rev-parse', 'HEAD');
  const ledgerPath = sharedLedgerPath(root, env);
  const server = spawn(process.execPath, ['-e', serverScript, JSON.stringify({ root, scenario, model: MODEL, ledgerPath })],
    { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) { const ended = once(server, 'exit'); server.kill(); await withDeadline(ended, 10000, 'fixture server exit').catch(() => {}); }
    rmSync(root, { recursive: true, force: true });
  });
  const [{ endpoint }] = await once(server, 'message');
  const policy = { ...POLICY };
  const policyPath = join(scratch, 'admission.json');
  writeFileSync(policyPath, JSON.stringify(policy));
  const childMarker = join(scratch, 'executor-children');
  const childHarness = join(scratch, 'runtime-harness.mjs');
  writeFileSync(childHarness, `import fs from 'node:fs';
import http from 'node:http'; import https from 'node:https'; import { syncBuiltinESMExports } from 'node:module';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
fs.appendFileSync(input.childMarker,'child\\n');
// Guard the CORE transports the production sender actually uses, so an accidental
// provider call fails here instead of silently reaching the network.
const guard=(mod,label)=>{const real=mod.request;mod.request=(...args)=>{const first=args[0];
  const host=typeof first==='string'?new URL(first).host:first?.hostname;
  if(host!=='127.0.0.1')throw new Error('Fixture blocks all non-loopback outbound HTTP ('+label+' '+host+')');
  return real.apply(mod,args);};syncBuiltinESMExports();};
guard(http,'http');guard(https,'https');
const {runHttpReview}=await import(${JSON.stringify(runtimeModule)});
const result=await runHttpReview(input.invocation,{approveEndpoint:url=>new URL(url).href===input.endpoint});
process.stdout.write(JSON.stringify(result));\n`);
  const driver = join(scratch, 'driver.mjs');
  writeFileSync(driver, `import fs from 'node:fs';import {spawnSync} from 'node:child_process';
import {runReviewRecord,validateReviewEvidence} from ${JSON.stringify(evidenceModule)};
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const httpExecutor={endpoint:input.endpoint,approveEndpoint:url=>new URL(url).href===input.endpoint,
run:invocation=>spawnSync(process.execPath,[input.childHarness],{cwd:input.options.root,encoding:'utf8',timeout:10000,
input:JSON.stringify({invocation,endpoint:input.endpoint,childMarker:input.childMarker}),env:process.env})};
try{const result=runReviewRecord({...input.options,httpExecutor});const gate=validateReviewEvidence({root:input.options.root,changeId:input.options.changeId,tier:'T2'});process.stdout.write(JSON.stringify({ok:true,result,gate}));}
catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}\n`);
  // The budget probe is the production admission decision in its own process, with no
  // model child and no HTTP: it proves competing processes share one durable authority.
  const budgetProbe = join(scratch, 'budget-probe.mjs');
  writeFileSync(budgetProbe, `import fs from 'node:fs';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const {admitSession}=await import(input.budgetModule);
try{const result=admitSession({root:input.root,policy:JSON.parse(fs.readFileSync(input.policyPath,'utf8'))});process.stdout.write(JSON.stringify({ok:true,result}));}
catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}\n`);
  const options = { root, changeId: 'http', role: 'reviewer', model: `openai/${MODEL}`, baseRef,
    admissionPolicy: '.tmp/admission.json', productCommand: [process.execPath, 'product.cjs'] };
  const payload = overrides => JSON.stringify({ options: { ...options, ...overrides }, endpoint, childMarker, childHarness, root, policyPath, runtimeModule, budgetModule });
  const replyOf = result => { try { return JSON.parse(result.stdout); } catch { return { ok: false, error: result.stderr || `driver produced no reply (status ${result.status})` }; } };
  const invoke = (overrides = {}, credential = true) => {
    const result = spawnSync(process.execPath, [driver], { cwd: root, env: { ...env, ...(credential ? { OPENAI_API_KEY: 'fixture-only-credential' } : {}) },
      input: payload(overrides), encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined, result.error?.message);
    return { ...result, reply: replyOf(result) };
  };
  const invokeAsync = (overrides = {}, milliseconds = 20000) => {
    const child = spawn(process.execPath, [driver], { cwd: root, env: { ...env, OPENAI_API_KEY: 'fixture-only-credential' }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(payload(overrides));
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    // Bounded by construction: on timeout the driver is killed, so no resource
    // outlives the test even if it never reaches the fixture.
    const done = withDeadline(new Promise(done => child.on('exit', status => done({ status, stdout, stderr, reply: replyOf({ status, stdout, stderr }) }))), milliseconds, 'async review driver')
      .finally(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    return { child, done };
  };
  const probeBudget = () => {
    const result = spawnSync(process.execPath, [budgetProbe], { cwd: root, env, input: JSON.stringify({ root, policyPath, runtimeModule, budgetModule }), encoding: 'utf8', timeout: 15000 });
    return { ...result, reply: replyOf(result) };
  };
  const gateProbe = join(scratch, 'gate-probe.mjs');
  writeFileSync(gateProbe, `import fs from 'node:fs';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const {validateReviewEvidence}=await import(${JSON.stringify(evidenceModule)});
process.stdout.write(JSON.stringify({gate:validateReviewEvidence({root:input.root,changeId:input.changeId,tier:'T2'})}));\n`);
  // Release-gate view of the CURRENT on-disk evidence, without running a review.
  const gate = () => { try { const out = spawnSync(process.execPath, [gateProbe], { cwd: root, env, input: JSON.stringify({ root, changeId: 'http' }), encoding: 'utf8', timeout: 15000 }).stdout; return JSON.parse(out).gate; } catch { return { ok: false, errors: ['gate probe failed'] }; } };
  return { root, changeDir, policy, server, invoke, invokeAsync, probeBudget, gate, writePolicy: changes => writeFileSync(policyPath, JSON.stringify({ ...policy, ...changes })),
    requests: () => lines(join(scratch, 'requests.jsonl')),
    children: () => existsSync(childMarker) ? readFileSync(childMarker, 'utf8').trim().split('\n').length : 0,
    ledgerPath, ledger: () => json(ledgerPath) };
}

function success(result) {
  assert.equal(result.status, 0, result.reply.error || result.stderr);
  assert.equal(result.reply.ok, true);
  return result.reply.result;
}

test('controlled HTTP: exact direct route reserves full-window session before real requests and settles exact usage', async t => {
  const f = await fixture(t);
  const response = f.invoke(), { record } = success(response);
  assert.equal(response.reply.gate.ok, false);
  assert.ok(response.reply.gate.errors.some(error => /transport-fixture|fixture.*(?:acceptance|release)/i.test(error)));
  const requests = f.requests();
  assert.equal(f.children(), 1); assert.equal(requests.length, 2);
  for (const request of requests) {
    const reservation = request.ledger.reservations.find(row => row.status === 'reserved');
    assert.equal(reservation.reservedNanoUsd, RESERVE_NANO_USD);
    assert.equal(reservation.requests.length, request.ordinal, 'Each physical call must consume durable authority before HTTP');
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.dummyAuth, true); assert.ok(request.bodyBytes <= 65536);
    assert.equal(request.body.model, MODEL); assert.equal(request.body.n, 1);
    assert.equal(request.body.max_completion_tokens, 256);
    assert.equal(request.body.stream, false); assert.equal(request.body.store, false);
    assert.equal(request.body.service_tier, 'default');
    assert.ok(request.body.tools.every(tool => tool.type === 'function'));
    for (const forbidden of ['audio', 'modalities', 'web_search_options', 'plugins']) assert.equal(request.body[forbidden], undefined);
  }
  const toolOutputs = requests[1].body.messages.filter(message => message.role === 'tool');
  assert.ok(toolOutputs.some(message => message.content.includes('console.log(42)')));
  assert.ok(toolOutputs.some(message => message.content.includes('42') && message.content.includes('exitCode')));
  assert.equal(readFileSync(join(f.root, '.tmp', 'product-runs'), 'utf8'), 'run\n');
  assert.equal(existsSync(join(f.root, '.workflow', LEDGER_FILE)), false, 'Budget must never be per-worktree state');
  const ledger = f.ledger(), settled = ledger.reservations.at(-1);
  assert.equal(settled.status, 'settled'); assert.equal(settled.settledNanoUsd, 39000);
  assert.equal(ledger.settledNanoUsd, 39000);
  assert.equal(record.executor, EXECUTOR); assert.equal(record.context.executor, EXECUTOR);
  assert.equal(record.context.evidenceClass, 'transport-fixture');
  assert.equal(typeof record.executionId, 'string'); assert.equal(record.sessionId, undefined);
  assert.equal(record.nativeEvents, undefined); assert.equal(record.nativeProjection, undefined);
  assert.equal(record.model, MODEL); assert.equal(record.usage.totalTokens, 220); assert.equal(record.usage.costUsd, 0.000039);
  assert.equal(record.providerResponses.length, 2);
  for (const [index, response] of record.providerResponses.entries()) {
    const bytes = readFileSync(join(f.root, response.path)), raw = JSON.parse(bytes);
    assert.equal(response.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(response.requestId, `fixture-request-${index + 1}`);
    assert.equal(raw.id, `chatcmpl-fixture-${index + 1}`); assert.equal(raw.model, MODEL);
  }
  success(f.invoke({ redo: true })); // Would exceed $0.07 if unused session reservation were not released.
});

test('controlled HTTP: missing authority credential wrong route and insufficient full-window ceiling refuse before child', async t => {
  const f = await fixture(t);
  const cases = [
    { label: 'missing policy', options: { admissionPolicy: null } },
    { label: 'unapproved model', options: { model: 'openai/unapproved-model' } },
    { label: 'opaque route', policy: { endpoint: 'https://opaque.example.invalid/v1/chat/completions' } },
    { label: 'underpriced tariff', policy: { tariffsUsdPerMillion: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
    { label: 'full-window ceiling', policy: { ceilingUsd: 0.001 } },
    { label: 'caller context override', policy: { maxInputTokens: 1 } },
    { label: 'output beyond descriptor', policy: { maxOutputTokens: 16385 } },
    { label: 'missing credential', credential: false },
  ];
  for (const row of cases) await t.test(row.label, () => {
    f.writePolicy(row.policy || {});
    const result = f.invoke(row.options || {}, row.credential !== false);
    assert.notEqual(result.status, 0); assert.equal(f.children(), 0); assert.equal(f.requests().length, 0);
    if (row.label === 'full-window ceiling') assert.match(result.reply.error, /budget|ceiling|reserv/i);
    if (row.label === 'missing credential') assert.match(result.reply.error, /OPENAI_API_KEY|credential/i);
  });
});

test('controlled HTTP: serialized context limit prevents every physical request', async t => {
  const f = await fixture(t);
  f.writePolicy({ maxContextBytes: 16 });
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.equal(f.requests().length, 0);
});

test('controlled HTTP: unknown failed cancelled redirected and out-of-bounds usage holds authority without retries', async t => {
  for (const scenario of ['missingUsage', 'unknownUsage', 'overOutput', 'overContext', 'modelMismatch', 'oversizedResponse', 'redirect', 'disconnect', 'http429', 'http421', 'timeout']) {
    await t.test(scenario, async t => {
      const f = await fixture(t, scenario);
      const first = f.invoke();
      assert.notEqual(first.status, 0); assert.equal(f.requests().length, 1); assert.equal(f.children(), 1);
      const held = f.ledger().reservations.at(-1);
      assert.equal(held.status, 'held'); assert.equal(held.reservedNanoUsd, RESERVE_NANO_USD);
      const second = f.invoke();
      assert.notEqual(second.status, 0); assert.match(second.reply.error, /held|unknown|unsettled|account/i);
      assert.equal(f.requests().length, 1); assert.equal(f.children(), 1);
      assert.equal(existsSync(join(f.changeDir, 'review-evidence.json')), false);
    });
  }
});

test('controlled HTTP: request limit forbids a second physical call after nonterminal tool output', async t => {
  const f = await fixture(t, 'requestLimit'); f.writePolicy({ maxRequests: 1 });
  const result = f.invoke();
  assert.notEqual(result.status, 0); assert.equal(f.requests().length, 1);
  assert.equal(f.ledger().reservations.at(-1).status, 'held');
  assert.match(result.reply.error, /request|attempt|limit/i);
});

test('controlled HTTP: publication recovery preserves execution and budget without another child or HTTP request', async t => {
  const f = await fixture(t, 'publishFailure');
  const first = f.invoke();
  assert.notEqual(first.status, 0); assert.equal(f.requests().length, 2); assert.equal(f.children(), 1);
  const runs = join(f.root, '.workflow', 'review-runs');
  const names = readdirSync(runs).filter(name => name.startsWith('run-'));
  assert.equal(names.length, 1);
  const runDir = join(runs, names[0]), before = json(join(runDir, 'run.json'));
  assert.equal(before.status, 'completed'); assert.equal(f.ledger().reservations.at(-1).status, 'settled');
  // Operator repair only: the fixture's own EISDIR blocker is removed by hand. The
  // production code must never delete an unexpected path to recover.
  rmSync(join(f.changeDir, 'review-evidence.json'), { recursive: true, force: true });
  assert.equal(existsSync(join(f.changeDir, 'review-evidence.json')), false);
  const unblocked = f.invoke(); // Ordinary invocation once publication could now succeed.
  assert.notEqual(unblocked.status, 0);
  assert.match(unblocked.reply.error, /resume-session/i);
  assert.equal(f.requests().length, 2, 'A completed identical run must never be silently repurchased');
  assert.equal(f.children(), 1);
  assert.equal(existsSync(join(f.changeDir, 'review-evidence.json')), false);
  const resumed = success(f.invoke({ resumeSessionDir: runDir }, false)); // Import needs no new provider request.
  assert.equal(resumed.record.executionId, before.executionId);
  assert.equal(resumed.record.context.executor, EXECUTOR);
  assert.equal(f.requests().length, 2); assert.equal(f.children(), 1);
  const published = readFileSync(join(f.changeDir, 'review-evidence.json'), 'utf8');
  assert.notEqual(f.invoke({ resumeSessionDir: runDir }).status, 0);
  assert.equal(readFileSync(join(f.changeDir, 'review-evidence.json'), 'utf8'), published);
  assert.equal(f.requests().length, 2); assert.equal(f.children(), 1);
});

test('controlled HTTP: a competing process cannot admit while the first response is held', async t => {
  const f = await fixture(t, 'holdFirst');
  f.writePolicy({ timeoutMs: 5000 });
  const held = once(f.server, 'message');
  const { child, done } = f.invokeAsync();
  // Bounded even if the race itself rejects: the driver is killed before the test returns.
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  // The startup IPC message was already consumed, so this waits for the held first
  // request. A stale build refuses admission and exits without HTTP: take whichever
  // settles first, so the suite fails immediately instead of hanging on a message
  // that will never come. `once()` resolves an ARG ARRAY, hence the destructure.
  const outcome = await withDeadline(Promise.race([held.then(([value]) => ({ held: value })), done.then(value => ({ exited: value }))]), 20000, 'held first response');
  assert.ok(outcome.held, `First request never reached the fixture; driver exited first: ${outcome.exited?.reply?.error ?? outcome.exited?.stderr ?? 'no reply'}`);
  assert.equal(outcome.held.held, 1);
  const inflight = f.requests();
  assert.equal(inflight.length, 1);
  const consumed = inflight[0].ledger.reservations.find(row => row.status === 'reserved');
  assert.equal(consumed.requests.length, 1, 'The in-flight process must consume durable authority before its held request');
  const probe = f.probeBudget();
  assert.notEqual(probe.status, 0);
  assert.match(probe.reply.error, /budget|ceiling|reserv|held|authority/i);
  const cli = f.invoke();
  assert.notEqual(cli.status, 0);
  assert.equal(f.children(), 1, 'No competing process may launch a model child while the reservation stands');
  assert.equal(f.requests().length, 1, 'No competing process may send a second physical request');
  f.server.send('release');
  const { record } = success(await done);
  const settledLedger = f.ledger(), settledRow = settledLedger.reservations.at(-1);
  assert.equal(settledRow.status, 'settled');
  assert.equal(settledRow.settledNanoUsd, 39000);
  assert.equal(settledLedger.settledNanoUsd, 39000);
  assert.equal(settledLedger.reservations.length, 1);
  assert.equal(f.requests().length, 2);
  assert.equal(f.children(), 1);
  assert.equal(typeof record.executionId, 'string');
  // A later admission adds its own reservation and leaves the settled one untouched.
  const afterRelease = f.probeBudget();
  assert.equal(afterRelease.status, 0, afterRelease.reply.error);
  assert.equal(afterRelease.reply.result.reservedNanoUsd, RESERVE_NANO_USD);
  const laterLedger = f.ledger();
  assert.equal(laterLedger.settledNanoUsd, 39000);
  assert.deepEqual(laterLedger.reservations.slice(0, 1), [settledRow], 'An existing settlement must never be rewritten');
  assert.equal(laterLedger.reservations.length, 2);
  assert.equal(laterLedger.reservations.at(-1).status, 'reserved');
  assert.equal(f.requests().length, 2, 'Admission alone must never send HTTP');
  assert.equal(f.children(), 1, 'Admission alone must never spawn a model child');
});

test('controlled HTTP: one project budget is shared across real Git worktrees and never reset by policy edits', async t => {
  const runtime = await import(budgetModule);
  const root = mkdtempSync(join(tmpdir(), 'review-budget-'));
  const env = gitEnv(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.gitignore'), '.tmp/\n');
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n');
  gitIn(root, env, 'init', '-q');
  gitIn(root, env, 'add', '.');
  gitIn(root, env, 'commit', '-qm', 'budget fixture baseline');
  const scratchRoot = join(root, '.tmp');
  mkdirSync(scratchRoot);
  const worktree = join(root, '.tmp', 'wt');
  gitIn(root, env, 'worktree', 'add', '--detach', '--', worktree, 'HEAD');
  const policy = { ...POLICY };
  const primary = runtime.resolveBudgetAuthority(root), secondary = runtime.resolveBudgetAuthority(worktree);
  assert.equal(primary.kind, 'git-common'); assert.equal(secondary.kind, 'git-common');
  assert.equal(primary.authority, realpathSync(resolve(root, gitIn(root, env, 'rev-parse', '--git-common-dir'))));
  assert.equal(secondary.authority, primary.authority);
  assert.equal(secondary.ledgerPath, primary.ledgerPath);
  assert.equal(primary.ledgerPath, join(primary.authority, LEDGER_FILE));
  const first = runtime.admitSession({ root, policy });
  assert.equal(first.reservedNanoUsd, RESERVE_NANO_USD);
  assert.equal(typeof first.reservationId, 'string');
  assert.equal(json(primary.ledgerPath).reservations.at(-1).reservationId, first.reservationId);
  assert.equal(existsSync(primary.ledgerPath), true);
  assert.equal(existsSync(join(root, '.workflow', LEDGER_FILE)), false);
  assert.equal(existsSync(join(worktree, '.workflow', LEDGER_FILE)), false);
  assert.throws(() => runtime.admitSession({ root: worktree, policy }), /budget|ceiling|reserv/i);
  runtime.settleReservation({ root, reservationId: first.reservationId, usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 0 } });
  const before = json(primary.ledgerPath);
  assert.ok(before.settledNanoUsd > 0);
  assert.equal(before.reservations.at(-1).status, 'settled');
  const raisedPolicyPath = join(worktree, 'raised-admission.json');
  writeFileSync(raisedPolicyPath, JSON.stringify({ ...policy, ceilingUsd: 0.5 }));
  const raised = runtime.admitSession({ root: worktree, policy: json(raisedPolicyPath) });
  const after = json(primary.ledgerPath);
  assert.equal(after.settledNanoUsd, before.settledNanoUsd, 'A policy edit must not reset recorded spending');
  assert.deepEqual(after.reservations.slice(0, before.reservations.length), before.reservations);
  assert.equal(after.reservations.length, before.reservations.length + 1);
  assert.equal(after.reservations[0].reservationId, first.reservationId);
  assert.equal(after.reservations.at(-1).reservationId, raised.reservationId);
  assert.equal(existsSync(join(worktree, '.workflow', LEDGER_FILE)), false);
  // Ambient Git overrides must not redirect discovery to a second ceiling.
  const authorityProbe = join(scratchRoot, 'authority-probe.mjs');
  writeFileSync(authorityProbe, `const {resolveBudgetAuthority}=await import(${JSON.stringify(budgetModule)});process.stdout.write(JSON.stringify(resolveBudgetAuthority(process.argv[2])));\n`);
  const probe = (cwd, extraEnv = {}) => {
    const result = spawnSync(process.execPath, [authorityProbe, cwd], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000 });
    return { ...result, value: result.status === 0 ? JSON.parse(result.stdout) : null };
  };
  const foreign = mkdtempSync(join(tmpdir(), 'review-budget-foreign-'));
  t.after(() => rmSync(foreign, { recursive: true, force: true }));
  gitIn(foreign, env, 'init', '-q');
  // A *valid* foreign repository in the ambient environment must not become the
  // ceiling: ambient GIT_* is stripped before discovery, exactly as elsewhere.
  const redirected = probe(root, { GIT_DIR: join(foreign, '.git'), GIT_COMMON_DIR: join(foreign, '.git'), GIT_WORK_TREE: root });
  assert.equal(redirected.status, 0, redirected.stderr);
  assert.equal(redirected.value.authority, primary.authority);
  assert.equal(redirected.value.ledgerPath, primary.ledgerPath);
  // A worktree whose Git pointer is corrupt must fail closed: no fallback ledger,
  // no mutation of the shared ledger, and no eviction of shared state to recover.
  const corrupt = join(root, '.tmp', 'wt-corrupt');
  gitIn(root, env, 'worktree', 'add', '--detach', '--', corrupt, 'HEAD');
  // Git marks a linked worktree's .git with Windows attributes (A H I) that block
  // in-place writes even after `attrib -r`; unlink then recreate is the portable way.
  rmSync(join(corrupt, '.git'), { force: true });
  writeFileSync(join(corrupt, '.git'), 'gitdir: /nonexistent/pointer\n');
  const frozen = json(primary.ledgerPath);
  assert.throws(() => runtime.resolveBudgetAuthority(corrupt), /git|worktree|pointer|authority|discover|fail|refus/i);
  assert.throws(() => runtime.admitSession({ root: corrupt, policy: { ...policy, ceilingUsd: 0.5 } }), /git|worktree|pointer|authority|discover|fail|refus/i);
  assert.deepEqual(json(primary.ledgerPath), frozen, 'Failed Git discovery must never mutate or evict the shared ledger');
  assert.equal(existsSync(join(corrupt, LEDGER_FILE)), false, 'Failed Git discovery must not create a second root-level ceiling');
  assert.equal(existsSync(join(corrupt, '.workflow', LEDGER_FILE)), false);
  assert.equal(existsSync(join(root, LEDGER_FILE)), false);
  const plain = mkdtempSync(join(tmpdir(), 'review-budget-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  const plainAuthority = runtime.resolveBudgetAuthority(plain);
  assert.equal(plainAuthority.kind, 'root');
  assert.equal(plainAuthority.authority, realpathSync(plain));
  // Non-Git operational state lives under .workflow/, which the source snapshot excludes.
  assert.equal(plainAuthority.ledgerPath, join(realpathSync(plain), '.workflow', LEDGER_FILE));
  assert.equal(runtime.admitSession({ root: plain, policy }).reservedNanoUsd, RESERVE_NANO_USD);
  assert.equal(existsSync(plainAuthority.ledgerPath), true);
});

test('controlled HTTP: documented non-billable usage details do not break a real API response', async t => {
  const f = await fixture(t, 'realUsage');
  const { record } = success(f.invoke());
  // prompt_tokens_details.audio_tokens:0 and completion_tokens_details all-zero are standard.
  assert.equal(record.usage.input, 200);
  assert.equal(record.usage.cacheRead, 40);
  assert.equal(record.usage.output, 20);
  assert.equal(f.requests().length, 2);
  assert.equal(f.ledger().reservations.at(-1).status, 'settled');
});

test('controlled HTTP: the wire bound is a total deadline, not an idle socket timeout', async t => {
  const f = await fixture(t, 'trickle');
  f.writePolicy({ timeoutMs: 50 });
  const started = Date.now();
  const result = f.invoke();
  const elapsed = Date.now() - started;
  assert.notEqual(result.status, 0);
  assert.match(result.reply.error, /deadline|timeout|exceeded/i);
  // A body trickling every 20ms would never trip an idle timeout; the total bound must.
  assert.ok(elapsed < 5000, `trickle must be cut off by the total deadline, took ${elapsed}ms`);
  assert.equal(f.ledger().reservations.at(-1).status, 'held');
});

test('controlled HTTP: repeated product reads never re-execute and latch one execution event', async t => {
  const f = await fixture(t, 'exerciseTwice');
  const { record } = success(f.invoke());
  // The command ran once, and both offset=0 reads were served from the same buffer.
  assert.equal(readFileSync(join(f.root, '.tmp', 'product-runs'), 'utf8'), 'run\n');
  const products = record.events.filter(event => event.type === 'product_execution');
  assert.equal(products.length, 1, 'exactly one latched product execution event');
  assert.equal(record.providerResponses.length, 2);
});

test('controlled HTTP: a forged executor object cannot claim direct-provider eligibility', async t => {
  const f = await fixture(t, 'ok');
  const response = f.invoke();
  success(response);
  const { gate } = response.reply;
  // The fixture seam is not privately branded, so the record is fixture-class even
  // though it reports the official endpoint, and the gate rejects it.
  assert.equal(gate.ok, false);
  assert.ok(gate.errors.some(error => /transport-fixture|fixture.*(?:acceptance|release)/i.test(error)));
});

test('controlled HTTP: tampered retained evidence adds an integrity error instead of passing', async t => {
  const f = await fixture(t, 'ok');
  const first = success(f.invoke());
  const runs = join(f.root, '.workflow', 'review-runs');
  const runDir = join(runs, readdirSync(runs).find(name => name.startsWith('run-')));
  const record = json(join(runDir, 'run.json'));
  assert.equal(typeof record.executionId, 'string');
  // Flipping the outer verdict without touching the retained bytes must be detected.
  const published = json(join(f.changeDir, 'review-evidence.json'));
  published.reviewer.verdict = 'REJECT';
  writeFileSync(join(f.changeDir, 'review-evidence.json'), JSON.stringify(published));
  const gate = f.gate();
  assert.equal(gate.ok, false);
  assert.ok(gate.errors.length > 0, 'a tampered verdict must produce an integrity error');
  assert.equal(first.record.executionId, record.executionId);
});
