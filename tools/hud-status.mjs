export const HUD_SCHEMA = 'hud-status.v1';
export const VALID_STATES = Object.freeze(['working', 'blocked', 'idle']);

export function validateHudStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Payload must be a non-null object, got ${value === null ? 'null' : typeof value}`);
  }
  if (!('schema' in value)) {
    throw new Error("Missing required field 'schema'");
  }
  if (value.schema !== HUD_SCHEMA) {
    throw new Error(`Invalid schema: expected '${HUD_SCHEMA}', got ${JSON.stringify(value.schema)}`);
  }
  if (!('state' in value)) {
    throw new Error("Missing required field 'state'");
  }
  if (!VALID_STATES.includes(value.state)) {
    throw new Error(`Invalid state '${value.state}': expected one of ${VALID_STATES.join('|')}`);
  }
  if (!('waits' in value)) {
    throw new Error("Missing required field 'waits'");
  }
  if (!('costs' in value)) {
    throw new Error("Missing required field 'costs'");
  }
  return true;
}

export function emitHudStatus(session = {}) {
  const state = session?.state;
  if (!VALID_STATES.includes(state)) {
    throw new Error(`Invalid state '${state}': expected one of ${VALID_STATES.join('|')}`);
  }
  const payload = {
    schema: HUD_SCHEMA,
    state,
    waits: session.waits !== undefined ? session.waits : [],
    costs: session.costs !== undefined ? session.costs : { total: 0 },
  };
  validateHudStatus(payload);
  return payload;
}
