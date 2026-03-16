/**
 * AI Orchestrator
 * Capa de orquestación basada en IA: clasificación, planificación, follow-up.
 */

const { classifyIntent } = require("./aiIntentClassification.service");
const { planQuery, shouldUsePlanner } = require("./aiQueryPlanner.service");
const { expandFollowUp } = require("./expandFollowUp.service");
const { handleConversational } = require("./conversational.handler");

module.exports = {
  classifyIntent,
  planQuery,
  shouldUsePlanner,
  expandFollowUp,
  handleConversational,
};
