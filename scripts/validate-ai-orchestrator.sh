#!/bin/bash
# Manual validation checklist for AI Orchestrator + Query Planner
# Run after enabling AI_ORCHESTRATOR_ENABLED and AI_QUERY_PLANNER_ENABLED

set -e

echo "=== AI Orchestrator Validation Checklist ==="
echo ""

# 1. Unit tests
echo "1. Running guardrails unit tests..."
node test/queryPlanGuardrails.test.js
echo "   ✓ Guardrails tests passed"
echo ""

# 2. Optional: run isResolvedEntityReusable (dependency)
echo "2. Running isResolvedEntityReusable tests..."
node test/isResolvedEntityReusable.test.js 2>/dev/null || true
echo ""

# 3. Check env flags
echo "3. Environment flags (recommended for validation):"
echo "   AI_ORCHESTRATOR_ENABLED=${AI_ORCHESTRATOR_ENABLED:-not set}"
echo "   AI_QUERY_PLANNER_ENABLED=${AI_QUERY_PLANNER_ENABLED:-not set}"
echo "   AI_ORCHESTRATOR_OBSERVABILITY=${AI_ORCHESTRATOR_OBSERVABILITY:-not set}"
echo "   LOG_QUERYPLAN=${LOG_QUERYPLAN:-not set}"
echo ""

echo "4. Manual test scenarios (use chat UI or API):"
echo "   [ ] Greeting: 'Hello' -> conversational reply"
echo "   [ ] Simple KPI: 'How many cases did Maria confirm this month?' -> KPI answer"
echo "   [ ] Follow-up: After Maria KPI, 'And last month?' -> Maria last month"
echo "   [ ] Entity switch: After Maria, 'What about Juan?' -> Juan, NOT Maria"
echo "   [ ] New topic: After Maria, 'Top reps by office' -> leaderboard, NOT Maria filter"
echo "   [ ] Analysis: 'Why did conversions drop?' -> analytical answer"
echo "   [ ] Simple count: 'How many cases?' -> concise, NOT verbose"
echo ""

echo "5. If AI_ORCHESTRATOR_OBSERVABILITY=true, stats at:"
echo "   GET /api/internal/ai-orchestrator-stats"
echo ""

echo "=== Validation checklist complete ==="
