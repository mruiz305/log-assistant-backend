/**
 * AI Orchestrator Observability
 * Lightweight structured events and counters for the orchestrator/planner flow.
 * All output is optional; gate: AI_ORCHESTRATOR_OBSERVABILITY=true.
 */

const ENABLED = process.env.AI_ORCHESTRATOR_OBSERVABILITY === "true";

const counters = {
  classification_used: 0,
  classification_failed: 0,
  conversational_handled: 0,
  greeting_fallback: 0,
  followup_expansion_success: 0,
  followup_expansion_skipped: 0,
  followup_expansion_failed: 0,
  planner_invoked: 0,
  planner_skipped: 0,
  planner_failed: 0,
  queryplan_suggested_entity_accepted: 0,
  queryplan_suggested_entity_rejected: 0,
  queryplan_disambiguation_triggered: 0,
  queryplan_needs_analysis_applied: 0,
  queryplan_needs_analysis_suppressed: 0,
  guardrail_rejected: 0,
  legacy_fallback: 0,
};

function emit(event, payload = {}) {
  if (!ENABLED) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event: `aiOrchestrator.${event}`,
    ...payload,
  });
  console.log(`[aiOrchestrator.obs] ${line}`);
}

function inc(key) {
  if (typeof counters[key] === "number") counters[key]++;
}

function track(event, payload = {}) {
  if (!ENABLED) return;
  emit(event, payload);
  const counterMap = {
    classification_used: "classification_used",
    classification_failed: "classification_failed",
    conversational_handled: "conversational_handled",
    greeting_fallback: "greeting_fallback",
    followup_expansion_success: "followup_expansion_success",
    followup_expansion_skipped: "followup_expansion_skipped",
    followup_expansion_failed: "followup_expansion_failed",
    planner_invoked: "planner_invoked",
    planner_skipped: "planner_skipped",
    planner_failed: "planner_failed",
    suggested_entity_accepted: "queryplan_suggested_entity_accepted",
    suggested_entity_rejected: "queryplan_suggested_entity_rejected",
    disambiguation_triggered: "queryplan_disambiguation_triggered",
    needs_analysis_applied: "queryplan_needs_analysis_applied",
    needs_analysis_suppressed: "queryplan_needs_analysis_suppressed",
    guardrail_rejected: "guardrail_rejected",
    legacy_fallback: "legacy_fallback",
  };
  const c = counterMap[event];
  if (c) inc(c);
}

function getCounters() {
  return { ...counters };
}

function resetCounters() {
  for (const k of Object.keys(counters)) counters[k] = 0;
}

module.exports = {
  ENABLED,
  emit,
  track,
  getCounters,
  resetCounters,
};
