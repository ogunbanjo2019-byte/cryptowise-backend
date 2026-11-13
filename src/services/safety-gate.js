let active = String(process.env.SAFETY_GATE_ACTIVE ?? 'true').toLowerCase() !== 'false';
let reason = active ? 'Safety gate is active by default.' : 'Safety gate was explicitly disabled by deployment configuration.';
let engagedAt = active ? new Date().toISOString() : null;

export function isSafetyGateActive() {
  return active;
}

export function safetyGateStatus() {
  return { active, reason, engagedAt };
}

export function engageSafetyGate(newReason) {
  if (!active) engagedAt = new Date().toISOString();
  active = true;
  reason = String(newReason || 'Safety gate engaged.');
  return safetyGateStatus();
}

export function requireSafetyGateOpen() {
  if (active) {
    const error = new Error('Safety gate is active; money movement is blocked.');
    error.statusCode = 503;
    throw error;
  }
}
