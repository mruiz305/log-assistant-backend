# queryPlan Consumption (Phase 3) + Guardrails (Phase 4)

This document describes where `queryPlan` is actively consumed and how it influences execution.

## Overview

`queryPlan` is produced by the AI Query Planner (when `AI_QUERY_PLANNER_ENABLED=true`) and passed to all handlers. Handlers use it only when it adds value; if `queryPlan` is absent, behavior is unchanged.

**Rule: explicit user input always wins over queryPlan.**

## Guardrails (Phase 4)

All `suggested_entity` and `needs_disambiguation` / `needs_analysis` usage is gated by `queryPlanGuardrails.js`:

| Guard | Purpose |
|-------|---------|
| `canUseSuggestedEntity` | Requires context alignment (lastPerson), no entity switch, no new topic |
| `shouldTriggerDisambiguation` | Only when message is short/ambiguous and lacks entity/metric keywords |
| `shouldUseNeedsAnalysis` | Rejects simple "how many X" counts; avoids forced analytical mode |

**Debug:** Set `LOG_QUERYPLAN=true` to log guardrail accept/reject reasons.

**Observability:** Set `AI_ORCHESTRATOR_OBSERVABILITY=true` for structured events and counters. Stats at `GET /api/internal/ai-orchestrator-stats`.

---

## Handler Usage

### 1. logsReview.handler.js

| Field | Usage | Behavior Change |
|-------|-------|-----------------|
| `suggested_entity` | When no entity from filters/ctx/NL extraction | Uses `suggested_entity` as entity value (submitter) instead of returning null. Resolves follow-up "how is she doing?" when context had person but extraction failed. |
| `needs_disambiguation` | When no entity and no `suggested_entity` | Returns a friendly clarification prompt instead of null: "Which person or team would you like me to analyze?" |

**Location**: After `extractEntityFromLogsPhrase` / `extractEntityFromWeaknessPhrase` fail, before returning null.

---

### 2. entityComparison.handler.js

| Field | Usage | Behavior Change |
|-------|-------|-----------------|
| `suggested_entity` | When `parsedAnalytics.entity?.name` is missing | Uses `suggested_entity` as fallback entity name. Enables comparison when parser missed entity but planner inferred it from context. |

**Location**: Entity resolution; `parsedAnalytics.period` must still be present (from message/ensureDefaultMonth).

---

### 3. kpiOnly.handler.js

| Field | Usage | Behavior Change |
|-------|-------|-----------------|
| `suggested_entity` | In forced KPI path (`hasAnyPersonSignal` + `isHowManyCasesQuestion`) when `filters.person` is not set | Sets `filtersForKpi.person` and `personValueFinal` from `suggested_entity`. Resolves follow-up "and last month?" when expansion didn't inject person but planner inferred it. |

**Location**: Before `buildKpiPackSql` in the forced KPI block. Only used when `!filters?.person?.locked` (no explicit override).

---

### 4. normalAi.handler.js

| Field | Usage | Behavior Change |
|-------|-------|-----------------|
| `needs_analysis` | Passed to `buildOwnerAnswer` as `meta.needsAnalysis` | When true, `ownerAnswer.service` enables expert/analytical mode (longer responses, interpretation focus). Improves answers for "why did X drop?" or "analyze this month". |

**Location**: In the `buildOwnerAnswer` call; `ownerAnswer.service` uses `meta.needsAnalysis || wantsExpertAnalysis(question)`.

---

### 5. performance.handler.js

| Field | Usage | Behavior Change |
|-------|-------|-----------------|
| — | `queryPlan` accepted for future use | No active consumption. Performance delegates entity-specific requests to logsReview/kpiOnly, which now consume `suggested_entity`. |

---

## Orchestrator (Pre-handler)

Before handlers run, the orchestrator uses `queryPlan`:

- **`suggested_period`**: Injected into `ensureDefaultMonth` when the message has no explicit period (Phase 2).

---

## Backward Compatibility

- All handlers accept `queryPlan` as an optional argument.
- When `queryPlan` is `undefined` or `null`, handlers preserve existing behavior.
- When `AI_QUERY_PLANNER_ENABLED` is not `"true"`, `queryPlan` is never set.
