import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadReviewEvidence, saveReviewEvidence, runReviewRecord } from "./evidence.mjs";
import { createHttpExecutor, resolveNodeRuntime, validatePolicy } from "./http-runtime.mjs";
import { load, save } from "../workflow-core.mjs";

export function initReviewExecution(root, flags, dryRun) {
  if (dryRun || flags["resume-session"] || flags.ompRunner) return { policy: null, httpExecutor: null };
  if (!flags["admission-policy"]) throw new Error("No model spending authority: supply --admission-policy PROJECT_RELATIVE_JSON");
  let rawJson;
  try {
    rawJson = JSON.parse(readFileSync(resolve(root, flags["admission-policy"]), "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse admission policy: ${e.message}`);
  }
  const policy = validatePolicy(rawJson);
  resolveNodeRuntime({});
  return { policy, httpExecutor: createHttpExecutor({ root, policy }) };
}
export function checkProviderAdmitted(provider, policy = null, env = process.env) {
  if (!provider || typeof provider !== "string") return false;
  const p = provider.trim();
  if (p === "nullform-gateway") {
    return Boolean(env.NULLFORM_GATEWAY_API_KEY || (policy && policy.provider === "nullform-gateway"));
  }
  if (p === "openai") {
    return Boolean(env.OPENAI_API_KEY || (policy && policy.provider === "openai"));
  }
  if (policy && policy.provider === p) {
    const credKey = policy.credentialEnv || "OPENAI_API_KEY";
    return Boolean(env[credKey]);
  }
  return false;
}

export function resolveReviewMode(rawMode, role) {
  const mode = rawMode === undefined || rawMode === null ? "default" : String(rawMode).trim() || "default";
  if (!["default", "adversarial"].includes(mode)) {
    throw new Error(`review-run: unknown --mode '${mode}'; allowed: default adversarial`);
  }
  if (mode === "adversarial" && role !== "reviewer") {
    throw new Error("review-run: --mode adversarial is only supported for --role reviewer");
  }
  return mode;
}

export function parseCrossModelFlag(flags) {
  const rawCrossModel = flags?.["cross-model"] ?? flags?.crossModel ?? null;
  if (rawCrossModel === true) {
    throw new Error("review-run: '--cross-model' requires a '<provider/model>' argument");
  }
  const crossModel = rawCrossModel ? String(rawCrossModel).trim() : null;
  if (crossModel && flags?.role !== "oracle") {
    throw new Error("review-run: --cross-model is only supported for --role oracle");
  }
  if (crossModel && !/^[^/\s]+\/\S+$/.test(crossModel)) {
    throw new Error("review-run: --cross-model requires '<provider/model>' format");
  }
  return crossModel;
}

export function cleanReviewRunFlags(flags) {
  const clean = { ...flags };
  delete clean["cross-model"];
  delete clean.crossModel;
  delete clean.ompRunner;
  delete clean.crossModelRunner;
  delete clean.env;
  delete clean.mockMissingProvider;
  delete clean.returnResult;
  delete clean.mode;
  return clean;
}

function handleUnadmittedProvider(changeDir, evidence, crossModel, crossProvider, flags, res) {
  if (evidence) {
    evidence.crossModel = {
      status: "unverified",
      model: crossModel,
      provider: crossProvider,
      verdict: "UNVERIFIED",
      reason: "provider unavailable or credential absent",
    };
    evidence.unverified = true;
    evidence.verdict = "UNVERIFIED";
    saveReviewEvidence(changeDir, evidence);
  }
  console.log(`workflow review-run: cross-model UNVERIFIED for '${flags.change}': provider unavailable or credential absent.`);
  return flags.returnResult ? { ok: false, unverified: true, verdict: "UNVERIFIED", record: res.record } : 1;
}

function recordMatchedVerdict(changeDir, updatedEvidence, crossModel, verdict1, verdict2) {
  if (updatedEvidence) {
    updatedEvidence.verdict = verdict1;
    updatedEvidence.crossModel = { model: crossModel, verdict: verdict2, matches: true };
    saveReviewEvidence(changeDir, updatedEvidence);
  }
}

function recordEscalatedVerdict(root, changeDir, updatedEvidence, crossModel, verdict1, verdict2) {
  if (updatedEvidence) {
    const at = new Date().toISOString();
    updatedEvidence.escalated = true;
    updatedEvidence.escalation = { reason: "cross-model verdict disagreement", verdicts: [verdict1, verdict2], at };
    updatedEvidence.verdicts = [verdict1, verdict2];
    updatedEvidence.crossModel = { model: crossModel, verdict: verdict2, matches: false, escalated: true };
    updatedEvidence.verdict = "ESCALATED";
    saveReviewEvidence(changeDir, updatedEvidence);
  }
  try {
    const st = load(root);
    if (st && st.status === "open") {
      st.escalated = true;
      st.escalatedAt = new Date().toISOString();
      st.escalations = [
        ...(st.escalations || []),
        { reason: "cross-model verdict disagreement", verdicts: [verdict1, verdict2], at: st.escalatedAt },
      ];
      save(root, st);
    }
  } catch {}
}

export function runCrossModelReview({
  root,
  flags,
  res,
  crossModel,
  policy,
  gate,
  httpExecutor,
  productCommand,
}) {
  const [crossProvider] = crossModel.split("/");
  const env = flags.env || process.env;
  const isAdmitted = checkProviderAdmitted(crossProvider, policy, env) && !flags.mockMissingProvider;

  const changeDir = join(root, "openspec", "changes", flags.change);
  const evidence = loadReviewEvidence(changeDir);

  if (!isAdmitted) {
    return handleUnadmittedProvider(changeDir, evidence, crossModel, crossProvider, flags, res);
  }

  const crossRunner = flags.crossModelRunner || flags.ompRunner || null;
  const res2 = runReviewRecord({
    root,
    changeId: flags.change,
    role: flags.role,
    model: crossModel,
    baseRef: flags["base-ref"] || flags.baseRef,
    prompt: flags.prompt,
    redo: false,
    productCommand,
    admissionPolicy: flags["admission-policy"] || flags.admissionPolicy,
    resumeSessionDir: null,
    dryRun: false,
    harness: gate.harness,
    httpExecutor,
    policy,
    ompRunner: crossRunner,
  });

  if (!res2.ok) {
    console.error(`workflow review-run: cross-model execution failed for '${flags.change}'.`);
    return flags.returnResult ? { ok: false, error: "cross-model pass failed" } : 1;
  }

  const verdict1 = res.record?.verdict;
  const verdict2 = res2.record?.verdict;
  const updatedEvidence = loadReviewEvidence(changeDir);

  if (verdict1 === verdict2) {
    recordMatchedVerdict(changeDir, updatedEvidence, crossModel, verdict1, verdict2);
    const ok = verdict1 === "ACCEPT";
    console.log(`workflow review-run: recorded ${flags.role} execution for '${flags.change}'. Cross-model agreed: ${verdict1}.`);
    if (flags.returnResult) {
      return { ok, verdict: verdict1, record: res.record, crossRecord: res2.record };
    }
    return ok ? 0 : 1;
  }

  recordEscalatedVerdict(root, changeDir, updatedEvidence, crossModel, verdict1, verdict2);
  console.log(`workflow review-run: cross-model verdict divergence (${verdict1} vs ${verdict2}) -> escalated (no ACCEPT).`);
  return flags.returnResult ? { ok: false, escalated: true, verdicts: [verdict1, verdict2], record: res.record, crossRecord: res2.record } : 1;
}

export function parseProductCommand(flags) {
  const raw = flags["product-command"] ?? flags.productCommand ?? null;
  if (!raw) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function handleDryRunResult(res, crossModel, mode, returnResult) {
  if (crossModel) res.crossModel = crossModel;
  if (mode !== "default") res.mode = mode;
  console.log(JSON.stringify(res, null, 2));
  return returnResult ? res : 0;
}

export function handleSinglePassResult(res, mode, flags) {
  const out = { ...res, mode };
  if (flags.returnResult) return out;
  console.log(`workflow review-run: recorded ${flags.role} execution for '${flags.change}'${mode === "adversarial" ? " (adversarial mode)" : ""}.`);
  return res.ok ? 0 : 1;
}
