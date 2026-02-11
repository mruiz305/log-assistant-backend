// src/utils/timers.js
function createTimers(reqId) {
  const t0 = Date.now();
  const marks = [];
  return {
    mark(label) {
      marks.push({ label, ms: Date.now() - t0 });
    },
    done() {
      const total = Date.now() - t0;
      return { reqId, totalMs: total, marks };
    },
  };
}

function makeTimers(reqId) {
  const t0 = nowMs();
  const marks = [];
  return {
    mark(label) {
      marks.push({ label, ms: nowMs() - t0 });
    },
    done() {
      const total = nowMs() - t0;
      return { reqId, totalMs: total, marks };
    },
  };
}

function nowMs() {
  return Date.now();
}

module.exports = { createTimers , makeTimers, nowMs};
