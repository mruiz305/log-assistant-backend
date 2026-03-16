function parseAnalyticsQuestion(message = "", uiLang = "en", activeScope = null) {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();
  const res = {
    entity: null,
    metric: null,
    period: null,
    intent: null,
    comparisonTarget: null,
  };

  if (!text) return res;

  // 1) "How does X's confirmed case rate compare to the average submitter in 2025?"
  let m = text.match(
    /\bhow\s+does\s+(.+?)['’]s\s+confirmed\s+case\s+rate\s+compare\s+to\s+the\s+average\s+submitter\s+in\s+(\d{4})\b/i
  );
  if (m) {
    const name = m[1].trim();
    const year = parseInt(m[2], 10);
    if (name && year) {
      res.entity = { type: "submitter", name };
      res.metric = "confirmed_rate";
      res.period = { kind: "year", value: year };
      res.intent = "comparison_vs_average";
      res.comparisonTarget = "average_submitter";
    }
  }

  // 1b) "How does Karla compare to the average submitter in 2025?" (sin posesivo)
  if (!res.intent) {
    m = text.match(
      /\bhow\s+does\s+([A-Za-z][A-Za-z0-9\-']*(?:\s+[A-Za-z][A-Za-z0-9\-']*)?)\s+compare\s+to\s+(?:the\s+)?(?:average\s+submitter|peers?)\s+in\s+(\d{4})\b/i
    );
    if (m) {
      const name = m[1].trim();
      const year = parseInt(m[2], 10);
      if (name && year) {
        res.entity = { type: "submitter", name };
        res.metric = "confirmed_rate";
        res.period = { kind: "year", value: year };
        res.intent = "comparison_vs_average";
        res.comparisonTarget = "average_submitter";
      }
    }
  }

  // 2) "What was X's confirmed case rate in 2025?"
  if (!res.intent) {
    m = text.match(
      /\bwhat\s+was\s+(.+?)['’]s\s+confirmed\s+case\s+rate\s+in\s+(\d{4})\b/i
    );
    if (m) {
      const name = m[1].trim();
      const year = parseInt(m[2], 10);
      if (name && year) {
        res.entity = { type: "submitter", name };
        res.metric = "confirmed_rate";
        res.period = { kind: "year", value: year };
        res.intent = "kpi_value";
      }
    }
  }

  // 6) Attorney scope: "How many cases Kanner & Pintaluga has confirmed in this month?"
  //    + "How many cases did Kanner & Pintaluga handle this month?"
  if (!res.intent && activeScope === "attorney") {
    let name = null;
    let period = { kind: "this_month" };
    let metric = "confirmed_cases";

    // "How many confirmed cases does X have this month?" / "how many cases does X have in January 2026?"
    const doesHave = text.match(
      /\bhow\s+many\s+(?:confirmed\s+)?cases\s+does\s+(.+?)\s+have\s+(?:this\s+month|in\s+(\w+)\s+(\d{4}))\b/i
    );
    if (doesHave) {
      name = String(doesHave[1] || "").trim();
      if (doesHave[2] && doesHave[3]) {
        period = { kind: "month_year", month: doesHave[2], year: parseInt(doesHave[3], 10) };
      }
      metric = text.toLowerCase().includes("confirmed") ? "confirmed_cases" : "gross_cases";
    }

    // "How many cases were confirmed by X this month?" (antes que hasConfirmed para no capturar "were")
    if (!name) {
      const wereConfirmedBy = text.match(
        /\bhow\s+many\s+cases\s+were\s+confirmed\s+by\s+(.+?)\s+(?:this\s+month|in\s+(\w+)\s+(\d{4}))\b/i
      );
      if (wereConfirmedBy) {
        name = String(wereConfirmedBy[1] || "").trim();
        if (wereConfirmedBy[2] && wereConfirmedBy[3]) {
          period = { kind: "month_year", month: wereConfirmedBy[2], year: parseInt(wereConfirmedBy[3], 10) };
        }
        metric = "confirmed_cases";
      }
    }

    const hasConfirmed =
      !name &&
      (text.match(/\bhow\s+many\s+cases\s+(.+?)\s+has\s+confirmed\b/i) ||
        text.match(/\bhow\s+many\s+cases\s+(.+?)\s+confirmed\b/i));
    if (hasConfirmed) {
      name = String(hasConfirmed[1] || "").trim();
      name = name.replace(/\s+(in\s+this\s+month|this\s+month|in\s+\d{4}|in\s+\w+\s+\d{4})\b.*$/i, "").trim();
      metric = "confirmed_cases";
    }

    // "How many cases did X confirm this month?" / "did X confirm in January 2026?"
    if (!name) {
      const didConfirm = text.match(
        /\bhow\s+many\s+cases\s+did\s+(.+?)\s+confirm\s+(?:this\s+month|in\s+(\w+)\s+(\d{4}))\b/i
      );
      if (didConfirm) {
        name = String(didConfirm[1] || "").trim();
        if (didConfirm[2] && didConfirm[3]) {
          period = { kind: "month_year", month: didConfirm[2], year: parseInt(didConfirm[3], 10) };
        }
        metric = "confirmed_cases";
      }
    }

    // "What is the confirmed case count for X this month?" / "confirmed case count for X in January 2026?"
    if (!name) {
      const whatsCountFor = text.match(
        /\bwhat\s+is\s+the\s+confirmed\s+case\s+count\s+for\s+(.+?)\s+(?:this\s+month|in\s+(\w+)\s+(\d{4}))\b/i
      );
      if (whatsCountFor) {
        name = String(whatsCountFor[1] || "").trim();
        if (whatsCountFor[2] && whatsCountFor[3]) {
          period = { kind: "month_year", month: whatsCountFor[2], year: parseInt(whatsCountFor[3], 10) };
        }
        metric = "confirmed_cases";
      }
    }

    // "What is X's confirmed volume this month?" / "What is X's confirmed volume in January 2026?"
    if (!name) {
      const whatsVolume = text.match(
        /\bwhat\s+is\s+(.+?)[''’]s\s+confirmed\s+volume\s+(?:this\s+month|in\s+(\w+)\s+(\d{4}))\b/i
      );
      if (whatsVolume) {
        name = String(whatsVolume[1] || "").trim();
        if (whatsVolume[2] && whatsVolume[3]) {
          period = { kind: "month_year", month: whatsVolume[2], year: parseInt(whatsVolume[3], 10) };
        }
        metric = "confirmed_cases";
      }
    }

    // "How many cases did X handle this month?" / "did X handle in January 2026?"
    if (!name) {
      const didHandle = text.match(
        /\bhow\s+many\s+cases\s+did\s+(.+?)\s+handle\s+(?:this\s+month|in\s+(\w+)\s+(\d{4}))\b/i
      );
      if (didHandle) {
        name = String(didHandle[1] || "").trim();
        if (didHandle[2] && didHandle[3]) {
          period = { kind: "month_year", month: didHandle[2], year: parseInt(didHandle[3], 10) };
        }
        metric = "gross_cases";
      }
    }

    if (name) {
      res.entity = { type: "attorney", name };
      res.metric = metric;
      res.period = period;
      res.intent = "metric_lookup";
    }
  }

  // 3) "How is X doing this month?"
  if (!res.intent) {
    m = text.match(/\bhow\s+is\s+(.+?)\s+doing\s+this\s+month\b/i);
    if (m) {
      const name = m[1].trim();
      if (name) {
        res.entity = { type: "submitter", name };
        res.metric = "kpi_pack";
        res.period = { kind: "this_month" };
        res.intent = "performance_summary";
      }
    }
  }

  // 4) "Based on X's 2025 logs..."
  if (!res.intent) {
    m = text.match(
      /\bbased\s+on\s+(.+?)['’]s\s+(\d{4})\s+logs\b/i
    );
    if (m) {
      const name = m[1].trim();
      const year = parseInt(m[2], 10);
      if (name && year) {
        res.entity = { type: "submitter", name };
        res.metric = "kpi_pack";
        res.period = { kind: "year", value: year };
        res.intent = "logs_based_review";
      }
    }
  }

  // 5a) "Which KPI affects X the most in 2025?" / "What KPI affects X the most in 2025?"
  if (!res.intent) {
    m = text.match(
      /\b(?:which|what)\s+kpi\s+affects\s+([A-Za-z][A-Za-z0-9\-\s&']+?)\s+(?:the\s+most\s+)?in\s+(\d{4})\b/i
    );
    if (m) {
      const name = m[1].trim();
      const year = parseInt(m[2], 10);
      if (name && year) {
        res.entity = { type: "submitter", name };
        res.metric = "kpi_pack";
        res.period = { kind: "year", value: year };
        res.intent = "kpi_diagnosis";
      }
    }
  }

  // 5b) "Which KPI in X's 2025 logs..."
  if (!res.intent) {
    m = text.match(
      /\bwhich\s+kpi\s+in\s+(.+?)['’]s\s+(\d{4})\s+logs\b/i
    );
    if (m) {
      const name = m[1].trim();
      const year = parseInt(m[2], 10);
      if (name && year) {
        res.entity = { type: "submitter", name };
        res.metric = "kpi_pack";
        res.period = { kind: "year", value: year };
        res.intent = "kpi_diagnosis";
      }
    }
  }

  if (process.env.DEBUG_PARSE || process.env.LOG_SQL) {
    console.log(
      `[parse] entity="${res.entity?.name || ""}" metric="${res.metric || ""}" period="${
        res.period?.kind === "year" ? res.period.value : res.period?.kind || ""
      }" intent="${res.intent || ""}" comparisonTarget="${res.comparisonTarget || ""}"`
    );
  }

  return res;
}

module.exports = { parseAnalyticsQuestion };

