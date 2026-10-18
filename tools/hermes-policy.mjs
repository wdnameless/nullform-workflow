#!/usr/bin/env node
/**
 * tools/hermes-policy.mjs — Hermes YAML policy updater with strict ownership,
 * YAML 1.1 native field validation, and merge-key rejection.
 */

import { MANAGED_START, MANAGED_END, hashContent, loadYaml, preflightManagedMarkers } from "./harness-config.mjs";

/**
 * Add the native prompt block without reserializing unrelated human YAML.
 *
 * Write authority is the persisted ownership hash (`ownedConfigHash`) plus a
 * proven legacy registration for the one-time blockless migration. A block that
 * is present without ownership is refused, never adopted, and a block removed or
 * edited after ownership is never re-enabled.
 *
 * `validateOnly` is the read-only doctor check: it accepts a freshly written
 * expected block and never inserts, replaces, or requires ownership.
 */
export function updateHermesConfigYaml(existingPath, preflightedContent, policy, { ownedConfigHash = null, legacyRegistration = false, validateOnly = false } = {}) {
  const yaml = loadYaml();
  const source = preflightedContent || "";
  const doc = yaml.parseDocument(source || "{}\n", { keepSourceTokens: true, schema: "yaml-1.1" });
  if (doc.errors.length || !yaml.isMap(doc.contents)) throw new Error(`Preflight failed: malformed Hermes YAML mapping in ${existingPath}`);
  const agent = doc.get("agent", true);
  if (doc.has("agent") && (!yaml.isMap(agent) || agent.anchor)) {
    throw new Error("Hermes agent must be an unaliased mapping; preserve this configuration and resolve manually.");
  }
  if (agent && yaml.isMap(agent)) {
    for (const item of agent.items) {
      if (item.key && (item.key.value === "<<" || item.key.source === "<<")) {
        throw new Error("Hermes agent mapping must not use merge keys (<<); preserve this configuration and resolve manually.");
      }
    }
  }
  const node = agent?.get("system_prompt", true);
  if (agent?.has("system_prompt") && (!yaml.isScalar(node) || typeof node.value !== "string" || node.anchor)) {
    throw new Error("Hermes agent.system_prompt must be an unaliased string (YAML 1.1 off/yes/on are booleans); preserve this configuration and resolve manually.");
  }
  const prompt = node?.value || "";
  const block = `${MANAGED_START}\n${policy.trim()}\n${MANAGED_END}`;
  const hasOwnership = Boolean(ownedConfigHash);
  const unchangedOwned = hasOwnership && ownedConfigHash === hashContent(source);

  let updated;
  if (prompt.includes(MANAGED_START) || prompt.includes(MANAGED_END)) {
    preflightManagedMarkers(existingPath, prompt);
    const start = prompt.indexOf(MANAGED_START), end = prompt.indexOf(MANAGED_END) + MANAGED_END.length;
    const current = prompt.slice(start, end);
    if (current === block) {
      if (validateOnly || hasOwnership) return source;
      throw new Error("Hermes managed prompt block has no prior ownership record; refusing to adopt it. Resolve manually.");
    }
    if (validateOnly) throw new Error("Hermes agent.system_prompt managed policy is missing or modified.");
    if (!unchangedOwned) throw new Error("Hermes managed prompt block is unknown or human-modified; preserve it and resolve manually.");
    updated = prompt.slice(0, start) + block + prompt.slice(end);
  } else {
    if (validateOnly) throw new Error("Hermes agent.system_prompt managed policy is missing; legacy skills.auto_load is not a native loader.");
    if (hasOwnership && !(unchangedOwned && legacyRegistration)) {
      throw new Error("Hermes managed prompt was removed by the operator; refusing to re-enable it. Resolve manually.");
    }
    updated = prompt + (prompt ? "\n\n" : "") + block + "\n";
  }

  const quoted = JSON.stringify(updated);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  if (node) {
    const [start, end] = node.range;
    const raw = source.slice(start, end);
    const headerComment = /^[|>]/.test(raw) ? (raw.split(/\r?\n/, 1)[0].match(/[ \t]*#.*$/)?.[0] || "") : "";
    return source.slice(0, start) + quoted + headerComment + (raw.endsWith("\n") ? eol : "") + source.slice(end);
  }
  const insert = (map, key, value) => {
    if (map.flow) {
      const at = map.range[1] - 1;
      if (source[at] !== "}" || /,\s*(?:#[^\n]*\n\s*)*$/.test(source.slice(map.range[0], at))) {
        throw new Error("Hermes flow mapping needs manual prompt insertion; no configuration was changed.");
      }
      return source.slice(0, at) + (map.items.length ? ", " : "") + `${key}: ${value}` + source.slice(at);
    }
    const at = map.range[1];
    const line = source.lastIndexOf("\n", map.range[0] - 1) + 1;
    const indent = source.slice(line, map.range[0]).match(/^[ \t]*/)[0];
    return source.slice(0, at) + (at && source[at - 1] !== "\n" ? eol : "") + indent + `${key}: ${value}` + eol + source.slice(at);
  };
  if (agent) return insert(agent, "system_prompt", quoted);
  if (source && doc.contents.flow) return insert(doc.contents, "agent", `{ system_prompt: ${quoted} }`);
  const at = source ? doc.contents.range[1] : 0;
  return source.slice(0, at) + (at && source[at - 1] !== "\n" ? eol : "") +
    `agent:${eol}  system_prompt: ${quoted}${eol}` + source.slice(at);
}
