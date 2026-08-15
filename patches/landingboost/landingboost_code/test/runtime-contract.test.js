const test = require("node:test");
const assert = require("node:assert/strict");

const { runWorkflowRequest } = require("../src/api");

function buildMockRequest(extraBody = {}) {
  return {
    body: {
      lp_url: "https://landingboost.app",
      ...extraBody,
    },
    headers: {
      "x-lb-secret": "test-secret",
    },
    query: {},
  };
}

function buildMockFetchPayload() {
  return {
    finalUrl: "https://landingboost.app/",
    canonicalUrl: "https://landingboost.app/",
    meta: {
      ok: true,
      blocked: false,
      thin: false,
    },
    aboveFoldText:
      "Turn your landing page into a conversion machine\nPaste your URL to get a conversion score",
    heroText:
      "Turn your landing page into a conversion machine\nPaste your URL to get a conversion score",
    fullPageText:
      "Turn your landing page into a conversion machine\nPaste your URL to get a conversion score\nTrusted by founders building in public",
    visibleText:
      "Turn your landing page into a conversion machine\nPaste your URL to get a conversion score\nTrusted by founders building in public",
    html: "<html><body><h1>Turn your landing page into a conversion machine</h1></body></html>",
    screenshot: "base64-jpeg",
    screenshot_type: "jpeg",
  };
}

function buildMockLlmPayload() {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            scores: {
              clarity_100: 82,
              relevance_100: 79,
              trust_100: 78,
              action_100: 85,
              conversion_100: 85,
              overall_100: 78,
            },
            ai_insights: {
              biggest_bottleneck: "Trust is decent but still not obvious enough near the CTA.",
              fastest_win: "Add one proof line right under the CTA.",
              estimated_impact: "Should improve signups from first-time visitors.",
            },
            summary_insights: {
              biggest_bottleneck: "Trust is decent but still not obvious enough near the CTA.",
              fastest_win: "Add one proof line right under the CTA.",
              estimated_impact: "Should improve signups from first-time visitors.",
            },
            user_snapshot: {
              target_audience: "Founders shipping SaaS landing pages",
              offer_summary: "LP scoring, fixes, and monitoring for conversion-focused founders",
              user_fit_diagnosis: "Best for founders who want clarity on what to fix next.",
            },
            free_preview_fix: {
              axis: "trust",
              title: "Add social proof under CTA",
              verb: "Add",
              place: "under the CTA",
              quote: "Trusted by founders building in public",
              patch: {
                before: "",
                after: "Trusted by founders building in public",
              },
              instruction:
                "Add “Trusted by founders building in public” directly under the primary CTA.",
            },
            score_breakdown: {
              clarity: "The core promise is fairly clear.",
              relevance: "The buyer is clear enough for founder traffic.",
              trust: "Proof exists, but could be more obvious near the CTA.",
              action: "The CTA is visible and reasonably strong.",
            },
            ab_test_variants: {
              headline: [
                "Turn your landing page into a conversion machine",
                "Find what is blocking signups on your landing page",
                "See what to fix on your landing page in minutes",
              ],
              subheadline: [
                "Paste your URL to get a score and clear next steps.",
                "See your rank, your bottleneck, and the fastest fix.",
                "Get a conversion score and copy changes you can use now.",
              ],
              primary_cta: ["Analyze my landing page", "Get my scorecard", "See my score"],
            },
          }),
        },
      },
    ],
  };
}

function buildGenericSaasFetchPayload() {
  return {
    finalUrl: "https://www.loom.com/",
    canonicalUrl: "https://www.loom.com/",
    meta: {
      ok: true,
      blocked: false,
      thin: false,
    },
    aboveFoldText:
      "Loom screen recorder for work\nRecord quick videos to update your team and explain work faster\nGet Loom for free",
    heroText:
      "Loom screen recorder for work\nRecord quick videos to update your team and explain work faster\nGet Loom for free",
    fullPageText:
      "Loom screen recorder for work. Record quick videos, share product walkthroughs, explain bugs, and keep your team aligned without another meeting. Get Loom for free.",
    visibleText:
      "Loom screen recorder for work. Record quick videos, share product walkthroughs, explain bugs, and keep your team aligned without another meeting. Get Loom for free.",
    html: "<html><body><h1>Loom screen recorder for work</h1><button>Get Loom for free</button></body></html>",
    screenshot: "base64-jpeg",
    screenshot_type: "jpeg",
  };
}

function buildGenericSaasLlmPayload() {
  const payload = buildMockLlmPayload();
  const content = JSON.parse(payload.choices[0].message.content);
  content.user_snapshot = {
    target_audience: "Teams that need async video updates",
    offer_summary: "Screen recording and video messaging for work",
    user_fit_diagnosis: "Best for teams replacing meetings with short video walkthroughs.",
  };
  content.free_preview_fix = {
    axis: "action",
    title: "Make the free start feel immediate",
    verb: "Add",
    place: "next to the CTA",
    quote: "Record your first video in minutes",
    patch: {
      before: "",
      after: "Record your first video in minutes",
    },
    instruction: "Add “Record your first video in minutes” directly next to the primary CTA.",
  };
  payload.choices[0].message.content = JSON.stringify(content);
  return payload;
}

test("native runtime preserves the webhook response contract without competitors", async () => {
  const output = await runWorkflowRequest(buildMockRequest(), {
    fetchPayloadOverride: buildMockFetchPayload(),
    llmResponseOverride: buildMockLlmPayload(),
  });

  const result = output.result;
  assert.equal(typeof result.ok, "boolean");
  for (const key of [
    "url",
    "lp_url",
    "finalUrlStr",
    "scores",
    "ai_insights",
    "summary_insights",
    "user_snapshot",
    "free_preview_fix",
    "score_breakdown",
    "weakest_axis",
    "primary_bottleneck",
    "pricingContext",
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(result, key), `missing ${key}`);
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "pricingRecommendation"));
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "paywallRewrite"));
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "ab_test_variants"));
  assert.ok(!Object.prototype.hasOwnProperty.call(result, "competitor_intelligence"));
});

test("competitor enrichment is opt-in and does not leak debug payload", async () => {
  const output = await runWorkflowRequest(
    buildMockRequest({ include_competitors: true }),
    {
      fetchPayloadOverride: buildMockFetchPayload(),
      llmResponseOverride: buildMockLlmPayload(),
    },
  );

  const intelligence = output.result.competitor_intelligence;
  assert.ok(intelligence);
  assert.ok(intelligence.bestCategory);
  assert.ok(Array.isArray(intelligence.closestCompetitors));
  assert.ok(intelligence.closestCompetitors.length > 0);
  assert.equal(Object.prototype.hasOwnProperty.call(intelligence, "signalText"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(intelligence, "_debug"), false);
});

test("benchmark profile ignores the internal LLM prompt when classifying the scanned page", async () => {
  const output = await runWorkflowRequest(
    buildMockRequest({ lp_url: "https://www.loom.com/" }),
    {
      fetchPayloadOverride: buildGenericSaasFetchPayload(),
      llmResponseOverride: buildGenericSaasLlmPayload(),
    },
  );

  const profile = output.result.market_profile;
  assert.ok(profile);
  assert.notEqual(profile.market_family, "landing_page_optimization");
  assert.equal(profile.signals.includes("landing_page_audit_language"), false);
});

test("benchmark references use the displayed-copy market profile after realignment", async () => {
  const payload = buildGenericSaasLlmPayload();
  const content = JSON.parse(payload.choices[0].message.content);
  content.current_copy = {
    headline: "Be the next solo-preneur",
    subheadline: "Dream big and build fast on Shopify. The world's best commerce platform.",
    primary_cta: "Start for free",
    trust_line: "Shopify App Store Largest commerce ecosystem",
    trust_social_proof: "Trusted by enterprise brands",
    trust_signals: ["commerce platform", "Shopify App Store", "enterprise brands"],
  };
  content.user_snapshot = {
    target_audience: "Solo entrepreneurs and ecommerce founders",
    offer_summary: "Commerce platform for building online stores and selling products",
    user_fit_diagnosis: "Best for founders who need to launch and grow an online store.",
  };
  payload.choices[0].message.content = JSON.stringify(content);

  const output = await runWorkflowRequest(
    buildMockRequest({ lp_url: "https://www.shopify.com/" }),
    {
      fetchPayloadOverride: buildGenericSaasFetchPayload(),
      llmResponseOverride: payload,
    },
  );

  assert.equal(output.result.market_profile.market_family, "ecommerce");
  assert.equal(output.result.benchmark_evidence.source_profile.market_family, "ecommerce");
  assert.notEqual(output.result.benchmark_evidence.corpus.match_scope, "fallback");
  assert.ok(output.result.benchmark_evidence.references.length > 0);
  assert.ok(
    output.result.benchmark_evidence.references.every((ref) => ref.market_family === "ecommerce"),
  );
});

test("benchmark evidence enrichment never changes the scoring result", async () => {
  const scenarios = [
    {
      name: "landing page audit",
      request: buildMockRequest({ lp_url: "https://landingboost.app/" }),
      fetchPayload: buildMockFetchPayload(),
      llmPayload: buildMockLlmPayload(),
    },
    {
      name: "generic SaaS",
      request: buildMockRequest({ lp_url: "https://www.loom.com/" }),
      fetchPayload: buildGenericSaasFetchPayload(),
      llmPayload: buildGenericSaasLlmPayload(),
    },
    {
      name: "commerce platform",
      request: buildMockRequest({ lp_url: "https://www.shopify.com/" }),
      fetchPayload: buildGenericSaasFetchPayload(),
      llmPayload: (() => {
        const payload = buildGenericSaasLlmPayload();
        const content = JSON.parse(payload.choices[0].message.content);
        content.current_copy = {
          headline: "Be the next solo-preneur",
          subheadline: "Dream big and build fast on Shopify. The world's best commerce platform.",
          primary_cta: "Start for free",
          trust_line: "Shopify App Store Largest commerce ecosystem",
        };
        content.user_snapshot = {
          target_audience: "Solo entrepreneurs and ecommerce founders",
          offer_summary: "Commerce platform for building online stores and selling products",
          user_fit_diagnosis: "Best for founders who need to launch and grow an online store.",
        };
        payload.choices[0].message.content = JSON.stringify(content);
        return payload;
      })(),
    },
  ];

  const scoreFields = [
    "scores",
    "weakest_axis",
    "primary_bottleneck",
    "clarity_100",
    "relevance_100",
    "trust_100",
    "action_100",
    "conversion_100",
    "overall_100",
  ];

  for (const scenario of scenarios) {
    const baseline = await runWorkflowRequest(scenario.request, {
      fetchPayloadOverride: scenario.fetchPayload,
      llmResponseOverride: scenario.llmPayload,
      includeBenchmarkEvidence: false,
    });
    const enriched = await runWorkflowRequest(scenario.request, {
      fetchPayloadOverride: scenario.fetchPayload,
      llmResponseOverride: scenario.llmPayload,
      includeBenchmarkEvidence: true,
    });

    for (const field of scoreFields) {
      assert.deepEqual(
        enriched.result[field],
        baseline.result[field],
        `${scenario.name}: ${field} changed after benchmark enrichment`,
      );
    }
    assert.ok(enriched.result.benchmark_evidence, `${scenario.name}: missing benchmark evidence`);
  }
});

test("native runtime replaces suspicious thin score payloads with a deterministic degraded report", async () => {
  const payload = buildGenericSaasLlmPayload();
  const content = JSON.parse(payload.choices[0].message.content);
  content.scores = {
    clarity_100: 0,
    relevance_100: 0,
    trust_100: 56,
    action_100: 0,
    conversion_100: 0,
    overall_100: 14,
  };
  content.user_snapshot = {
    target_audience: "Teams that need async video updates",
    offer_summary: "Screen recording and video messaging for work",
    user_fit_diagnosis: "Best for teams replacing meetings with short video walkthroughs.",
  };
  payload.choices[0].message.content = JSON.stringify(content);

  const output = await runWorkflowRequest(buildMockRequest({ lp_url: "https://www.loom.com/" }), {
    fetchPayloadOverride: buildGenericSaasFetchPayload(),
    llmResponseOverride: payload,
  });

  assert.equal(output.result.ok, true);
  assert.equal(output.result.scan_quality_status, "degraded");
  assert.equal(output.result.meta.fail_soft, true);
  assert.ok(output.result.scores.overall_100 > 0);
  assert.deepEqual(output.result.meta.rejected_scoring_quality.issues, ["majority_zero_axes"]);
});

test("native runtime replaces all-zero score payloads with a deterministic degraded report", async () => {
  const payload = buildGenericSaasLlmPayload();
  const content = JSON.parse(payload.choices[0].message.content);
  content.scores = {
    clarity_100: 0,
    relevance_100: 0,
    trust_100: 0,
    action_100: 0,
    conversion_100: 0,
    overall_100: 0,
  };
  content.user_snapshot = {
    target_audience: "Developers sending product emails",
    offer_summary: "Email API for transactional and marketing email",
    user_fit_diagnosis: "Best for teams that need reliable email delivery.",
  };
  payload.choices[0].message.content = JSON.stringify(content);

  const output = await runWorkflowRequest(buildMockRequest({ lp_url: "https://resend.com/" }), {
    fetchPayloadOverride: buildGenericSaasFetchPayload(),
    llmResponseOverride: payload,
  });

  assert.equal(output.result.ok, true);
  assert.equal(output.result.scan_quality_status, "degraded");
  assert.equal(output.result.meta.fail_soft, true);
  assert.ok(output.result.scores.overall_100 > 0);
  assert.deepEqual(output.result.meta.rejected_scoring_quality.issues, ["all_zero_scores"]);
});

test("native runtime returns a deterministic report when LLM parsing fails", async () => {
  const output = await runWorkflowRequest(buildMockRequest({ lp_url: "https://www.loom.com/" }), {
    fetchPayloadOverride: buildGenericSaasFetchPayload(),
    llmResponseOverride: {
      choices: [{ message: { content: "not-json" } }],
    },
  });

  assert.equal(output.result.ok, true);
  assert.equal(output.result.scan_quality_status, "degraded");
  assert.equal(output.result.meta.fail_soft, true);
  assert.match(output.result.meta.fail_soft_reason, /scoring|json|parse|object/i);
  assert.ok(output.result.scores.overall_100 > 0);
});

test("production fail-closed mode rejects unreliable output instead of returning a report", async () => {
  await assert.rejects(
    runWorkflowRequest(buildMockRequest({ lp_url: "https://www.loom.com/" }), {
      fetchPayloadOverride: buildGenericSaasFetchPayload(),
      llmResponseOverride: {
        choices: [{ message: { content: "not-json" } }],
      },
      failClosed: true,
    }),
    (error) =>
      error?.statusCode === 422 &&
      ["SCORING_MODEL_FAILED", "FACT_CONTRADICTION", "SCORING_QUALITY_FAILED"].includes(error?.code),
  );
});

test("production delivery repair returns a grounded report when model parsing fails", async () => {
  const output = await runWorkflowRequest(buildMockRequest({ lp_url: "https://www.loom.com/" }), {
    fetchPayloadOverride: buildGenericSaasFetchPayload(),
    llmResponseOverride: {
      choices: [{ message: { content: "not-json" } }],
    },
    failClosed: true,
    repairForDelivery: true,
    includeBenchmarkEvidence: false,
  });

  assert.equal(output.result.ok, true);
  assert.ok(output.result.scores.overall_100 > 0);
  assert.ok(output.result.free_preview_fix?.title);
  assert.equal(output.result.meta.delivery_repaired, true);
  assert.ok([
    "scoring_model_or_postprocess_failed",
    "ai_fact_contradiction",
    "scoring_payload_incomplete",
  ].includes(output.result.meta.delivery_repair_reason));
});

test("workflow deadline returns a deterministic degraded report instead of hanging", async () => {
  const output = await runWorkflowRequest(buildMockRequest({ lp_url: "https://www.loom.com/" }), {
    workflowBudgetMs: 1,
    fetchPayloadOverride: buildGenericSaasFetchPayload(),
    llmResponseOverride: buildGenericSaasLlmPayload(),
    includeBenchmarkEvidence: false,
  });

  assert.equal(output.result.ok, true);
  assert.equal(output.result.scan_quality_status, "degraded");
  assert.equal(output.result.meta.fail_soft, true);
  assert.match(output.result.meta.llm_fail_soft_reason, /deadline/i);
  assert.equal(output.result.meta.workflow_budget_ms, 1);
});

test("degraded capture completes and exposes low-confidence diagnostics", async () => {
  const fetchPayload = {
    finalUrl: "https://www.loom.com/",
    canonicalUrl: "https://www.loom.com/",
    meta: {
      ok: false,
      blocked: false,
      thin: true,
      screenshot_ok: false,
      preview_degraded: true,
      preview_degraded_reasons: ["residual_popup_overlay"],
    },
    heroText: "Loom screen recorder for work",
    aboveFoldText: "Loom screen recorder for work",
    visibleText: "Loom screen recorder for work",
    fullPageText: "Loom screen recorder for work",
    html: "<html><body><h1>Loom screen recorder for work</h1></body></html>",
  };

  const output = await runWorkflowRequest(buildMockRequest({ lp_url: "https://www.loom.com/" }), {
    fetchPayloadOverride: fetchPayload,
    llmResponseOverride: buildGenericSaasLlmPayload(),
  });

  assert.equal(output.result.ok, true);
  assert.equal(output.result.scan_quality_status, "degraded");
  assert.equal(output.result.meta.fail_soft, true);
  assert.ok(output.result.scan_quality_issues.length > 0);
});

test("healthy hybrid capture does not request an unused Firecrawl screenshot", async () => {
  const firecrawlRequestBodies = [];
  const browserlessPayload = {
    ...buildGenericSaasFetchPayload(),
    meta: {
      ...buildGenericSaasFetchPayload().meta,
      screenshot_ok: true,
      hard_fail: false,
      soft_fail: false,
      final_url: "https://www.loom.com/",
      screenshot_viewport: {
        viewport_width: 1365,
        viewport_height: 768,
        coordinate_width: 1365,
        coordinate_height: 768,
      },
    },
    heroBlock: {
      found: true,
      headline: "Loom screen recorder for work",
      subheadline: "Record quick videos to update your team and explain work faster",
      primary_cta: "Get Loom for free",
    },
  };
  const firecrawlFetchFn = async (_url, init) => {
    firecrawlRequestBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      success: true,
      data: {
        markdown: [
          "# Loom screen recorder for work",
          "Record quick videos to update your team and explain work faster",
          "[Get Loom for free](/signup)",
        ].join("\n"),
        html: "<main><h1>Loom screen recorder for work</h1><p>Record quick videos to update your team and explain work faster</p><a href=\"/signup\">Get Loom for free</a></main>",
        rawHtml: "<html><body><main><h1>Loom screen recorder for work</h1><p>Record quick videos to update your team and explain work faster</p><a href=\"/signup\">Get Loom for free</a></main></body></html>",
        links: ["https://www.loom.com/signup"],
        metadata: {
          sourceURL: "https://www.loom.com/",
          url: "https://www.loom.com/",
        },
      },
    }));
  };
  const browserlessFetchFn = async () =>
    new Response(JSON.stringify(browserlessPayload));

  const output = await runWorkflowRequest(buildMockRequest({ lp_url: "https://www.loom.com/" }), {
    useFirecrawl: true,
    firecrawlApiKey: "test-key",
    firecrawlFetchFn,
    browserlessEndpoint: "https://browserless.example/function",
    browserlessFetchFn,
    llmResponseOverride: buildGenericSaasLlmPayload(),
    includeBenchmarkEvidence: false,
    forceVision: false,
  });

  assert.equal(firecrawlRequestBodies[0].formats.includes("screenshot"), false);
  assert.equal(
    firecrawlRequestBodies.length,
    1,
    JSON.stringify(output.result.meta.fetch_diagnostics),
  );
  assert.equal(output.result.meta.fetch_diagnostics.firecrawl_screenshot_requested, false);
  assert.equal(output.result.meta.fetch_diagnostics.firecrawl_screenshot_fallback_used, false);
  assert.equal(output.result.meta.fetch_diagnostics.firecrawl_used, true);
  assert.equal(output.result.meta.fetch_diagnostics.browserless_used, true);
  assert.equal(typeof output.result.meta.fetch_diagnostics.firecrawl_duration_ms, "number");
  assert.equal(typeof output.result.meta.fetch_diagnostics.browserless_duration_ms, "number");
  assert.equal(output.result.screenshot_b64, "base64-jpeg");
});

test("self-hosted Browserless fallback replaces an unavailable cloud capture", async () => {
  const browserlessEndpoints = [];
  const firecrawlRequestBodies = [];
  const healthyBrowserlessPayload = {
    ...buildGenericSaasFetchPayload(),
    meta: {
      ...buildGenericSaasFetchPayload().meta,
      screenshot_ok: true,
      hard_fail: false,
      soft_fail: false,
      final_url: "https://www.loom.com/",
      screenshot_viewport: {
        viewport_width: 1365,
        viewport_height: 768,
        coordinate_width: 1365,
        coordinate_height: 768,
      },
    },
    heroBlock: {
      found: true,
      headline: "Loom screen recorder for work",
      subheadline: "Record quick videos to update your team and explain work faster",
      primary_cta: "Get Loom for free",
    },
  };
  const browserlessFetchFn = async (endpoint) => {
    browserlessEndpoints.push(String(endpoint));
    if (String(endpoint).includes("cloud.browserless.example")) {
      return new Response(JSON.stringify({ error: "monthly unit allowance exhausted" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(healthyBrowserlessPayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const firecrawlFetchFn = async (_url, init) => {
    firecrawlRequestBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      success: true,
      data: {
        markdown: [
          "# Loom screen recorder for work",
          "Record quick videos to update your team and explain work faster",
          "[Get Loom for free](/signup)",
        ].join("\n"),
        html: "<main><h1>Loom screen recorder for work</h1><p>Record quick videos to update your team and explain work faster</p><a href=\"/signup\">Get Loom for free</a></main>",
        rawHtml: "<html><body><main><h1>Loom screen recorder for work</h1><p>Record quick videos to update your team and explain work faster</p><a href=\"/signup\">Get Loom for free</a></main></body></html>",
        metadata: {
          sourceURL: "https://www.loom.com/",
          url: "https://www.loom.com/",
        },
      },
    }));
  };

  const output = await runWorkflowRequest(buildMockRequest({ lp_url: "https://www.loom.com/" }), {
    useFirecrawl: true,
    firecrawlApiKey: "test-key",
    firecrawlFetchFn,
    browserlessEndpoint: "https://cloud.browserless.example/function",
    browserlessFallbackEndpoint: "http://selfhosted-browserless.example/function",
    browserlessFetchFn,
    llmResponseOverride: buildGenericSaasLlmPayload(),
    includeBenchmarkEvidence: false,
    forceVision: false,
  });

  const diagnostics = output.result.meta.fetch_diagnostics;
  assert.deepEqual(browserlessEndpoints, [
    "https://cloud.browserless.example/function",
    "http://selfhosted-browserless.example/function",
  ]);
  assert.equal(diagnostics.browserless_fallback_configured, true);
  assert.equal(diagnostics.browserless_fallback_attempted, true);
  assert.equal(diagnostics.browserless_fallback_used, true);
  assert.equal(diagnostics.browserless_fallback_error, "");
  assert.equal(diagnostics.firecrawl_screenshot_fallback_used, false);
  assert.equal(firecrawlRequestBodies.length, 1);
  assert.equal(output.result.screenshot_b64, "base64-jpeg");
});

function wouldLpScoreAcceptScan(scoreData) {
  const meta = scoreData && typeof scoreData.meta === "object" ? scoreData.meta : {};
  const degraded =
    scoreData?.scan_quality_status === "degraded" ||
    scoreData?.scan_quality?.degraded === true ||
    meta.degraded === true ||
    meta.fail_soft === true;
  if (degraded && meta.delivery_repaired !== true) {
    return { ok: false, reason: "UNVERIFIED_REPAIR_PAYLOAD" };
  }
  if (Array.isArray(scoreData?.fact_contradictions) && scoreData.fact_contradictions.length > 0) {
    return { ok: false, reason: "FACT_CONTRADICTION" };
  }
  const scores = scoreData?.scores && typeof scoreData.scores === "object" ? scoreData.scores : {};
  const axes = [
    scores.clarity_100,
    scores.relevance_100,
    scores.trust_100,
    scores.action_100 ?? scores.conversion_100,
  ];
  if (!(Number(scores.overall_100) > 0) || axes.filter((value) => Number(value) > 0).length < 4) {
    return { ok: false, reason: "THIN_PAYLOAD" };
  }
  if (!scoreData?.free_preview_fix?.title) {
    return { ok: false, reason: "THIN_PAYLOAD" };
  }
  return { ok: true, reason: "accepted" };
}

function buildFirecrawlLandingPageResponse(extraData = {}) {
  return {
    success: true,
    data: {
      markdown: [
        "# Loom screen recorder for work",
        "Record quick videos to update your team and explain work faster",
        "[Get Loom for free](/signup)",
      ].join("\n"),
      html: "<main><h1>Loom screen recorder for work</h1><p>Record quick videos to update your team and explain work faster</p><a href=\"/signup\">Get Loom for free</a></main>",
      rawHtml: "<html><body><main><h1>Loom screen recorder for work</h1><p>Record quick videos to update your team and explain work faster</p><a href=\"/signup\">Get Loom for free</a></main></body></html>",
      links: ["https://www.loom.com/signup"],
      metadata: {
        sourceURL: "https://www.loom.com/",
        url: "https://www.loom.com/",
      },
      ...extraData,
    },
  };
}

test("cloud Browserless 429 does not retry the exhausted endpoint", async () => {
  const browserlessEndpoints = [];
  const browserlessFetchFn = async (endpoint) => {
    browserlessEndpoints.push(String(endpoint));
    return new Response(JSON.stringify({ error: "monthly unit allowance exhausted" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  };
  const firecrawlFetchFn = async () =>
    new Response(JSON.stringify(buildFirecrawlLandingPageResponse()));

  const output = await runWorkflowRequest(buildMockRequest({ lp_url: "https://www.loom.com/" }), {
    useFirecrawl: true,
    firecrawlApiKey: "test-key",
    firecrawlFetchFn,
    browserlessEndpoint: "https://cloud.browserless.example/function",
    browserlessFetchFn,
    llmResponseOverride: buildGenericSaasLlmPayload(),
    includeBenchmarkEvidence: false,
    forceVision: false,
  });

  const diagnostics = output.result.meta.fetch_diagnostics;
  assert.deepEqual(browserlessEndpoints, ["https://cloud.browserless.example/function"]);
  assert.equal(diagnostics.browserless_fallback_attempted, false);
  assert.equal(diagnostics.browserless_retry_attempted, false);
  assert.equal(diagnostics.browserless_retry_error, "cloud_quota_exhausted");
  assert.equal(diagnostics.fail_soft, true);
  assert.equal(output.result.ok, true);
  assert.equal(output.result.scan_quality_status, "degraded");
});

test("fail-soft capture with a screenshot is delivery-repaired for lp-score", async () => {
  // soloboss.app 2026-08-14: scoring returned HTTP 200 with scores and a ~704KB
  // payload, scan_quality_status=degraded, fail_soft=true, delivery_repaired=false.
  // lp-score then discarded it as UNVERIFIED_DEGRADED_SCORING_PAYLOAD.
  // Browserless 429 was never logged; reproduce the observed shape only:
  // visual capture fails, Firecrawl still supplies a screenshot, production
  // failClosed + repairForDelivery must stamp delivery_repaired.
  const firecrawlScreenshot =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const firecrawlRequestBodies = [];
  const browserlessFetchFn = async () => {
    throw new Error("The operation was aborted due to timeout");
  };
  const firecrawlFetchFn = async (_url, init) => {
    const body = JSON.parse(init.body);
    firecrawlRequestBodies.push(body);
    const wantsScreenshot = Array.isArray(body.formats) && body.formats.includes("screenshot");
    return new Response(JSON.stringify(buildFirecrawlLandingPageResponse(
      wantsScreenshot ? { screenshot: firecrawlScreenshot } : {},
    )));
  };

  const output = await runWorkflowRequest(buildMockRequest({ lp_url: "https://soloboss.app/" }), {
    useFirecrawl: true,
    firecrawlApiKey: "test-key",
    firecrawlFetchFn,
    browserlessEndpoint: "https://cloud.browserless.example/function",
    browserlessFetchFn,
    llmResponseOverride: buildGenericSaasLlmPayload(),
    includeBenchmarkEvidence: false,
    forceVision: false,
    failClosed: true,
    repairForDelivery: true,
  });

  const diagnostics = output.result.meta.fetch_diagnostics;
  assert.equal(diagnostics.fail_soft, true);
  assert.equal(diagnostics.firecrawl_screenshot_fallback_used, true);
  assert.equal(output.result.ok, true);
  assert.equal(output.result.scan_quality_status, "degraded");
  assert.equal(output.result.meta.fail_soft, true);
  assert.equal(output.result.meta.delivery_repaired, true);
  assert.equal(output.result.meta.delivery_repair_reason, "capture_fail_soft");
  assert.ok(output.result.screenshot_b64);
  assert.deepEqual(wouldLpScoreAcceptScan(output.result), { ok: true, reason: "accepted" });
  assert.ok(firecrawlRequestBodies.some((body) => body.formats.includes("screenshot")));
});

test("all capture providers failing still returns a URL-only degraded report", async () => {
  const rejectFetch = async () => {
    throw new Error("provider unavailable");
  };
  const output = await runWorkflowRequest(buildMockRequest({ lp_url: "https://outage.example/" }), {
    useFirecrawl: true,
    firecrawlApiKey: "test-key",
    firecrawlFetchFn: rejectFetch,
    browserlessFetchFn: rejectFetch,
    directFetchFn: rejectFetch,
    llmResponseOverride: buildGenericSaasLlmPayload(),
    includeBenchmarkEvidence: false,
  });

  assert.equal(output.result.ok, true);
  assert.equal(output.result.url, "https://outage.example/");
  assert.equal(output.result.scan_quality_status, "degraded");
  assert.equal(output.result.meta.fetch_source, "url_only_fail_soft");
  assert.equal(output.result.meta.fetch_diagnostics.fail_soft, true);
  assert.ok(output.result.scan_quality_issues.length > 0);
});

test("direct HTML becomes the third capture path when both managed providers fail", async () => {
  const rejectFetch = async () => {
    throw new Error("provider unavailable");
  };
  const output = await runWorkflowRequest(buildMockRequest({ lp_url: "https://fallback.example/" }), {
    useFirecrawl: true,
    firecrawlApiKey: "test-key",
    firecrawlFetchFn: rejectFetch,
    browserlessFetchFn: rejectFetch,
    directFetchFn: async () =>
      new Response(
        "<html><body><main><h1>Ship clearer landing pages</h1><p>Find the next conversion fix for your SaaS.</p><a class=\"cta\" href=\"/start\">Start free</a></main></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
    llmResponseOverride: buildGenericSaasLlmPayload(),
    includeBenchmarkEvidence: false,
  });

  assert.equal(output.result.ok, true);
  assert.equal(output.result.meta.fetch_source, "direct_html_after_capture_providers_failed");
  assert.equal(output.result.current_copy.headline, "Ship clearer landing pages");
  assert.equal(output.result.current_copy.primary_cta, "Start free");
});

test("strict scoring mode still rejects suspicious payloads for diagnostics", async () => {
  const payload = buildGenericSaasLlmPayload();
  const content = JSON.parse(payload.choices[0].message.content);
  content.scores = {
    clarity_100: 0,
    relevance_100: 0,
    trust_100: 0,
    action_100: 0,
    conversion_100: 0,
    overall_100: 0,
  };
  payload.choices[0].message.content = JSON.stringify(content);

  await assert.rejects(
    () =>
      runWorkflowRequest(buildMockRequest({ lp_url: "https://resend.com/" }), {
        fetchPayloadOverride: buildGenericSaasFetchPayload(),
        llmResponseOverride: payload,
        strictScoringQuality: true,
      }),
    /Scoring response failed quality checks/,
  );
});

// landingboost.app, 2026-07-29. Browserless timed out after 38s and the scan continued on
// Firecrawl's plain text, still labelled "firecrawl_text_browserless_visual" so nothing
// downstream could tell. The page has one <h1>; with no tags and no rects the pipeline had
// nothing to prefer it by and reported the headline as "Building the scanner in public." —
// a line from the founder note near the footer. Every string in that report exists on the
// page and none of them describe it, and the reader was told their headline fails to say
// what the tool does, about a headline the scan never read.
//
// Geometry comes only from Browserless. Delivery mode can suppress positioning only
// when a valid screenshot survives; without one it still refuses to guess.
test("delivery repair still rejects a capture with no usable screenshot", async () => {
  let browserlessAttempts = 0;
  const firecrawlFetchFn = async () =>
    new Response(JSON.stringify({
      success: true,
      data: {
        markdown: "# Real headline here\nSome body copy\n[Start free](/signup)",
        html: "<main><h1>Real headline here</h1><p>Some body copy</p><a href=\"/signup\">Start free</a></main>",
        metadata: { sourceURL: "https://example.com/", url: "https://example.com/" },
      },
    }));
  const browserlessFetchFn = async () => {
    browserlessAttempts += 1;
    throw new Error("The operation was aborted due to timeout");
  };

  await assert.rejects(
    () => runWorkflowRequest(buildMockRequest({ lp_url: "https://example.com/" }), {
      useFirecrawl: true,
      firecrawlApiKey: "test-key",
      firecrawlFetchFn,
      browserlessEndpoint: "https://browserless.example/function",
      browserlessFetchFn,
      llmResponseOverride: buildGenericSaasLlmPayload(),
      includeBenchmarkEvidence: false,
      forceVision: false,
      failClosed: true,
      repairForDelivery: true,
    }),
    (error) => {
      assert.equal(error.statusCode, 422);
      assert.equal(error.code, "CAPTURE_UNUSABLE");
      return true;
    },
  );

  // Retried once before giving up: the original failure was a timeout, and most are transient.
  assert.equal(browserlessAttempts, 2, `expected one retry, saw ${browserlessAttempts} attempts`);
});
