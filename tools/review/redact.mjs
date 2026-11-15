// Credential redaction, isolated so the budget ledger module stays under its size ceiling
// and every caller shares one implementation.
//
// The two shapes that actually reach a retained run file are not the literal key:
// provider errors echo `Authorization: Basic <base64(:key)>`, and pretty-printed bodies
// wrap a key across a newline. A plain substring replace misses both.

const MARKER = '[REDACTED_PROVIDER_CREDENTIAL]';

/**
 * Remove one credential and every form an upstream error body is likely to carry it in.
 * Never throws; a secret shorter than 8 characters is not treated as a credential.
 */
export function redactSecret(text, secret) {
  const value = typeof text === 'string' ? text : '';
  if (typeof secret !== 'string' || secret.length < 8) return value;
  let out = value.split(secret).join(MARKER);
  // Base64 of `:key` and of `key`, as used by Authorization: Basic and some SDKs.
  for (const form of [Buffer.from(`:${secret}`).toString('base64'), Buffer.from(secret).toString('base64')]) {
    if (form.length >= 8) out = out.split(form).join(MARKER);
  }
  // A key split by hard wrapping: if the unbroken text carries the secret, redact the
  // pieces that survived the newline.
  if (out.replace(/[\r\n]+/g, '').includes(secret)) {
    for (let cut = 1; cut < secret.length; cut++) {
      const head = secret.slice(0, cut), tail = secret.slice(cut);
      if (head.length >= 4 && tail.length >= 4 && out.includes(head) && out.includes(tail)) {
        out = out.split(head).join(MARKER).split(tail).join(MARKER);
      }
    }
  }
  return out;
}

/**
 * Redact every known provider credential: the policy-named one plus the two historical
 * pinned names (defense in depth — the env may carry several keys). Never throws and never
 * requires any key to exist.
 */
export function redactPolicySecrets(text, policy = null, env = process.env) {
  let value = typeof text === 'string' ? text : '';
  const names = new Set(['OPENAI_API_KEY', 'NULLFORM_GATEWAY_API_KEY']);
  const named = policy && typeof policy.credentialEnv === 'string' ? policy.credentialEnv : '';
  if (/^[A-Z][A-Z0-9_]{2,63}$/.test(named)) names.add(named);
  for (const name of names) {
    const secret = env ? env[name] : undefined;
    if (typeof secret === 'string' && secret.length >= 8) value = redactSecret(value, secret);
  }
  return value;
}
