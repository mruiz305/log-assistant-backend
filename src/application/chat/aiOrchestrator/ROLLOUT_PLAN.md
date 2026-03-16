# AI Orchestrator & Query Planner – Rollout Plan

## Overview

This document describes a safe, incremental rollout for the AI orchestrator, query planner, and related features.

## Feature Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `AI_ORCHESTRATOR_ENABLED` | `true` (or unset) | Enable intent classification and conversational handling |
| `AI_QUERY_PLANNER_ENABLED` | `false` | Enable query planner (adds LLM call for follow-up/mixed/analysis) |
| `AI_ORCHESTRATOR_OBSERVABILITY` | `false` | Enable structured events and counters |
| `LOG_QUERYPLAN` | `false` | Verbose guardrail decision logging |

**Old behavior (planner off):** With `AI_QUERY_PLANNER_ENABLED` unset or `false`, the planner never runs. Classification still runs (unless `AI_ORCHESTRATOR_ENABLED=false`). Handlers receive `queryPlan=undefined`; all guardrails skip; behavior matches pre-planner state.

**Explicit user input:** Always wins over `queryPlan` and prior context. Guardrails enforce this.

---

## Rollout Phases

### Phase 1: Local Testing

1. Run unit tests:
   ```bash
   node test/queryPlanGuardrails.test.js
   node test/isResolvedEntityReusable.test.js
   ```

2. Run manual validation script:
   ```bash
   chmod +x scripts/validate-ai-orchestrator.sh
   ./scripts/validate-ai-orchestrator.sh
   ```

3. Enable flags locally:
   ```bash
   export AI_ORCHESTRATOR_ENABLED=true
   export AI_QUERY_PLANNER_ENABLED=true
   export AI_ORCHESTRATOR_OBSERVABILITY=true
   export LOG_QUERYPLAN=true
   ```

4. Execute TEST_MATRIX scenarios manually via chat UI or API.

5. Check `/api/internal/ai-orchestrator-stats` (when observability enabled) for counters.

---

### Phase 2: Staging

1. Deploy with planner **disabled**:
   ```bash
   AI_ORCHESTRATOR_ENABLED=true
   AI_QUERY_PLANNER_ENABLED=false
   AI_ORCHESTRATOR_OBSERVABILITY=true
   ```

2. Confirm:
   - Classification and conversational handling work
   - No regression in KPI, logs, performance flows
   - `planner_invoked` remains 0

3. Enable planner:
   ```bash
   AI_QUERY_PLANNER_ENABLED=true
   ```

4. Validate:
   - Follow-up expansion and query plan usage
   - Guardrail rejections when expected (entity switch, new topic)

---

### Phase 3: Limited Production

1. Enable orchestrator only (no planner):
   ```bash
   AI_ORCHESTRATOR_ENABLED=true
   AI_QUERY_PLANNER_ENABLED=false
   AI_ORCHESTRATOR_OBSERVABILITY=true
   ```

2. Monitor for 24–48 hours:
   - Structured logs: `[aiOrchestrator.obs]`
   - Counters via `/api/internal/ai-orchestrator-stats`
   - No increase in errors or latency

3. Enable planner for a subset (e.g., internal users, percentage) if supported by routing.

4. Enable planner globally:
   ```bash
   AI_QUERY_PLANNER_ENABLED=true
   ```

---

### Phase 4: Logging Review

1. Parse structured events:
   ```bash
   grep '\[aiOrchestrator.obs\]' /var/log/app.log | jq -r '.event'
   ```

2. Review counters:
   - `classification_used` vs `classification_failed`
   - `planner_invoked` vs `planner_skipped` vs `planner_failed`
   - `queryplan_suggested_entity_accepted` vs `queryplan_suggested_entity_rejected`
   - `queryplan_disambiguation_triggered`
   - `queryplan_needs_analysis_suppressed`

3. Use insights to tune planner prompts or guardrails if needed.

---

### Phase 5: Gradual Expansion

1. Keep observability on in production for at least one week.
2. Reduce `LOG_QUERYPLAN` to `false` after validation.
3. Optionally turn off `AI_ORCHESTRATOR_OBSERVABILITY` once stable, or leave on for ongoing metrics.

---

## Rollback

To revert to legacy behavior:

```bash
AI_ORCHESTRATOR_ENABLED=false
AI_QUERY_PLANNER_ENABLED=false
```

- Classification: disabled
- Conversational handler: disabled (falls back to `isGreeting` only)
- Planner: disabled
- Handlers: receive no `queryPlan`; guardrails never apply
- Behavior: matches pre–AI orchestrator state

---

## Observability Output

When `AI_ORCHESTRATOR_OBSERVABILITY=true`:

- **Structured logs:** `[aiOrchestrator.obs] {"ts":"...","event":"aiOrchestrator.classification_used","intent":"kpi"}`
- **Stats endpoint:** `GET /api/internal/ai-orchestrator-stats` returns counters
