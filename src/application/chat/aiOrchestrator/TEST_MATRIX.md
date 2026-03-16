# AI Orchestrator + Query Plan Test Matrix

Scenarios to validate Phase 4 guardrails and queryPlan consumption.

## Prerequisites

- `AI_ORCHESTRATOR_ENABLED=true` (or default)
- `AI_QUERY_PLANNER_ENABLED=true` for planner-related scenarios
- `LOG_QUERYPLAN=true` optional, for tracing guardrail decisions

---

## 1. Simple KPI with Explicit Person

| Step | User Input | Expected | Guardrail |
|------|------------|----------|-----------|
| 1 | "How many confirmed cases did Maria have this month?" | KPI answer for Maria | No queryPlan used; explicit entity wins |

**Pass:** Entity from message; filters.person set; no suggested_entity applied.

---

## 2. Follow-up with Implied Prior Entity

| Step | User Input | Expected | Guardrail |
|------|------------|----------|-----------|
| 1 | "How many confirmed cases did Maria have this month?" | KPI for Maria | — |
| 2 | "And last month?" | KPI for Maria, last month | Follow-up expansion; suggested_entity from context; **must align with lastPerson** |

**Pass:** suggested_entity = Maria; lastPerson = Maria; canUseSuggestedEntity ok.

---

## 3. Entity Switch

| Step | User Input | Expected | Guardrail |
|------|------------|----------|-----------|
| 1 | "How many cases did Maria confirm this month?" | KPI for Maria | — |
| 2 | "How many cases did Juan confirm this month?" | KPI for Juan, NOT Maria | explicit_entity_switch: don't use suggested_entity |

**Pass:** suggested_entity rejected; Juan from message wins.  
Note: "What about Juan?" may not trigger if personDetect doesn't extract "Juan"; use explicit "How many cases did Juan confirm?" for validation.

---

## 4. Mixed Greeting + KPI

| Step | User Input | Expected | Guardrail |
|------|------------|----------|-----------|
| 1 | "Hello, how many cases did Tony confirm this week?" | Conversational reply OR KPI (depending on classification) | If routed to KPI: Tony from message; no suggested_entity carryover |

**Pass:** Entity from message; no prior context.

---

## 5. Analysis Request

| Step | User Input | Expected | Guardrail |
|------|------------|----------|-----------|
| 1 | "Why did conversions drop this month?" | Analytical answer | needs_analysis → expert mode (if passes guard) |
| 2 | "Compare this month vs last month and explain" | Analytical comparison | Same |

**Pass:** shouldUseNeedsAnalysis ok; expert mode enabled.

---

## 6. Ambiguous Request Requiring Clarification

| Step | User Input | Expected | Guardrail |
|------|------------|----------|-----------|
| 1 | "Analyze" or "Show me" (very short) | Clarification: "Which person or team would you like me to analyze?" | needs_disambiguation + shouldTriggerDisambiguation |

**Pass:** Disambiguation triggered; message short; no strong entity keywords.

---

## 7. New Unrelated Request After Context-Heavy Question

| Step | User Input | Expected | Guardrail |
|------|------------|----------|-----------|
| 1 | "Maria performance this month" | Logs review for Maria | — |
| 2 | "Top reps by office" | Leaderboard by office, NOT filtered by Maria | new_topic: don't use suggested_entity (Maria) |

**Pass:** looksLikeNewTopic; suggested_entity rejected.

---

## 8. Simple Count – Don't Force Analysis

| Step | User Input | Expected | Guardrail |
|------|------------|----------|-----------|
| 1 | "How many cases this month?" | Concise count, not verbose analysis | needs_analysis rejected: simple_count |

**Pass:** shouldUseNeedsAnalysis returns false; no forced expert mode.

---

## 9. Stale Context – No lastPerson

| Step | User Input | Expected | Guardrail |
|------|------------|----------|-----------|
| 1 | (New session, no prior context) | — | — |
| 2 | "And last month?" (before any entity established) | Expansion may fail; no suggested_entity | no_context_lastPerson: can't use suggested_entity |

**Pass:** suggested_entity rejected when lastPerson missing.

---

## 10. Entity Comparison with suggested_entity Fallback

| Step | User Input | Expected | Guardrail |
|------|------------|----------|-----------|
| 1 | "Maria confirmed rate this month" | — | — |
| 2 | "Compare with average" (parser may miss entity) | Entity comparison Maria vs average | suggested_entity = Maria; aligns with lastPerson |

**Pass:** canUseSuggestedEntity ok; entityComparison uses suggested_entity.

---

## Debug Tracing

With `LOG_QUERYPLAN=true`, look for:

- `[queryPlan:logsReview] canUseSuggestedEntity ok/reject`
- `[queryPlan:kpiOnly] canUseSuggestedEntity ok/reject`
- `[queryPlan:entityComparison] canUseSuggestedEntity ok/reject`
- `[queryPlan] shouldTriggerDisambiguation=true`
- `[queryPlan] shouldUseNeedsAnalysis ok/reject`
- `[reqId] [queryPlan] logsReview applied suggested_entity=...`
