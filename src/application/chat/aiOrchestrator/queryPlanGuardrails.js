/**
 * Query Plan Guardrails
 * Validation and safety checks before applying queryPlan in handlers.
 * Ensures: explicit user input wins, no stale carryover, no over-triggering.
 *
 * Debug: set LOG_QUERYPLAN=true to log guardrail decisions.
 */

const { getExplicitPersonFromMessage } = require("../../../utils/personDetect");
const { isResolvedEntityReusable } = require("../../../utils/chatRoute.helpers");
const { looksLikeNewTopic } = require("../../../utils/topic");
const obs = require("./aiOrchestratorObservability");

/**
 * Check if suggested_entity is safe to apply.
 * Requires: context alignment, no entity switch, no new-topic.
 * @param {object} opts - { queryPlan, lastPerson, effectiveMessage, uiLang, logTag }
 * @returns {{ ok: boolean, reason?: string }}
 */
const DEBUG = process.env.LOG_QUERYPLAN === "true";

function canUseSuggestedEntity({ queryPlan, lastPerson, effectiveMessage, uiLang = "en", logTag = "" }) {
  const suggested = queryPlan?.suggested_entity ? String(queryPlan.suggested_entity).trim() : null;
  if (!suggested || suggested.length < 2) {
    if (DEBUG) console.log(`[queryPlan:${logTag}] canUseSuggestedEntity reject: no_valid_suggested_entity`);
    obs.track("suggested_entity_rejected", { handler: logTag, reason: "no_valid_suggested_entity" });
    obs.track("guardrail_rejected");
    return { ok: false, reason: "no_valid_suggested_entity" };
  }

  // Guard: new topic first (don't carry over old entity)
  if (looksLikeNewTopic(effectiveMessage || "", uiLang)) {
    if (DEBUG) console.log(`[queryPlan:${logTag}] canUseSuggestedEntity reject: new_topic`);
    obs.track("suggested_entity_rejected", { handler: logTag, reason: "new_topic" });
    obs.track("guardrail_rejected");
    return { ok: false, reason: "new_topic" };
  }

  // Guard: suggested_entity must align with context (avoid stale cross-request carryover)
  const ctxPerson = lastPerson ? String(lastPerson).trim() : "";
  if (!ctxPerson) {
    if (DEBUG) console.log(`[queryPlan:${logTag}] canUseSuggestedEntity reject: no_context_lastPerson`);
    obs.track("suggested_entity_rejected", { handler: logTag, reason: "no_context_lastPerson" });
    obs.track("guardrail_rejected");
    return { ok: false, reason: "no_context_lastPerson" };
  }
  if (!isResolvedEntityReusable(suggested, ctxPerson) && suggested.toLowerCase() !== ctxPerson.toLowerCase()) {
    if (DEBUG) console.log(`[queryPlan:${logTag}] canUseSuggestedEntity reject: suggested_entity_mismatch_context suggested="${suggested}" ctxPerson="${ctxPerson}"`);
    obs.track("suggested_entity_rejected", { handler: logTag, reason: "suggested_entity_mismatch_context" });
    obs.track("guardrail_rejected");
    return { ok: false, reason: "suggested_entity_mismatch_context" };
  }

  // Guard: explicit different person in message = entity switch, don't use suggested
  const explicitPerson = getExplicitPersonFromMessage(effectiveMessage || "", uiLang);
  if (explicitPerson) {
    const explicit = String(explicitPerson).trim();
    if (!isResolvedEntityReusable(explicit, suggested) && explicit.toLowerCase() !== suggested.toLowerCase()) {
      if (DEBUG) console.log(`[queryPlan:${logTag}] canUseSuggestedEntity reject: explicit_entity_switch explicit="${explicit}" suggested="${suggested}"`);
      obs.track("suggested_entity_rejected", { handler: logTag, reason: "explicit_entity_switch" });
      obs.track("guardrail_rejected");
      return { ok: false, reason: "explicit_entity_switch" };
    }
  }

  if (DEBUG) console.log(`[queryPlan:${logTag}] canUseSuggestedEntity ok suggested="${suggested}"`);
  obs.track("suggested_entity_accepted", { handler: logTag, suggested });
  return { ok: true };
}

/**
 * Check if needs_disambiguation should trigger clarification.
 * Avoid over-triggering: only when message is short/ambiguous and no entity path.
 * @param {object} opts - { queryPlan, effectiveMessage, uiLang }
 * @returns {boolean}
 */
function shouldTriggerDisambiguation({ queryPlan, effectiveMessage, uiLang = "en" }) {
  if (!queryPlan?.needs_disambiguation) return false;
  const msg = String(effectiveMessage || "").trim();
  // Don't clarify if message has substantial content (likely resolvable downstream)
  if (msg.length > 60) return false;
  const wordCount = msg.split(/\s+/).filter(Boolean).length;
  if (wordCount > 8) return false;
  // Don't clarify if message has strong entity/metric keywords
  if (/\b(maria|juan|tony|performance|casos|cases|top\s+reps|ranking)\b/i.test(msg)) return false;
  if (DEBUG) console.log(`[queryPlan] shouldTriggerDisambiguation=true msg="${msg.slice(0, 50)}..."`);
  obs.track("disambiguation_triggered");
  return true;
}

/**
 * Check if needs_analysis should force analytical mode in ownerAnswer.
 * Avoid forcing on simple "how many X" counts.
 * @param {boolean} metaNeedsAnalysis - from queryPlan.needs_analysis
 * @param {string} question - user question
 * @returns {boolean}
 */
function shouldUseNeedsAnalysis(metaNeedsAnalysis, question = "") {
  if (metaNeedsAnalysis !== true) return false;
  const q = String(question || "").toLowerCase();
  // Simple count without analysis signal: don't force
  const isSimpleCount = /\b(how\s+many|cu[aá]ntos?)\b/i.test(q) && !/\b(why|compare|trend|analyz|por\s+qu[eé]|explain|interpret)\b/i.test(q);
  if (isSimpleCount && q.split(/\s+/).length < 12) {
    if (DEBUG) console.log(`[queryPlan] shouldUseNeedsAnalysis reject: simple_count`);
    obs.track("needs_analysis_suppressed");
    return false;
  }
  if (DEBUG) console.log(`[queryPlan] shouldUseNeedsAnalysis ok (from planner)`);
  obs.track("needs_analysis_applied");
  return true;
}

module.exports = {
  canUseSuggestedEntity,
  shouldTriggerDisambiguation,
  shouldUseNeedsAnalysis,
};
