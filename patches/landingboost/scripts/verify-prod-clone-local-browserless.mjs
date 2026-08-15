#!/usr/bin/env node
/**
 * Production clone of the scoring capture path:
 *   cloud Browserless /function → 429 (credits exhausted)
 *   → BROWSERLESS_FALLBACK_ENDPOINT local Browserless /function
 *   → real JPEG screenshot from that local Browserless
 *
 * Does not use Playwright, dump-dom, or synthetic 1x1 images.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { runWorkflowRequest } = require("/tmp/landingboost_code/src/api.js");

const CLOUD = process.env.BROWSERLESS_ENDPOINT || "http://127.0.0.1:3999/function";
const LOCAL = process.env.BROWSERLESS_FALLBACK_ENDPOINT || "http://127.0.0.1:3001/function";
const OUT_DIR = process.env.SCAN_OUT_DIR || "/tmp/local-scans/browserless-shots";

const URLS = (process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "https://soloboss.app/",
      "https://webscore.now/",
      "https://mozolist.com/",
      "https://landingboost.app/",
      "https://example.com/",
    ]
);

function jpegMagicOk(b64) {
  if (!b64 || typeof b64 !== "string") return { ok: false, reason: "missing" };
  const raw = Buffer.from(b64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, ""), "base64");
  const jpeg = raw.length >= 3 && raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff;
  const png = raw.length >= 8 && raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47;
  if (!(jpeg || png)) {
    return { ok: false, reason: "not_jpeg_or_png", bytes: raw.length, magic: raw.subarray(0, 4).toString("hex") };
  }
  if (raw.length < 2000) {
    return { ok: false, reason: "too_small", bytes: raw.length, kind: jpeg ? "jpeg" : "png" };
  }
  return { ok: true, bytes: raw.length, kind: jpeg ? "jpeg" : "png" };
}

function slugForUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`
      .replace(/^www\./, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "scan";
  } catch {
    return String(url).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "scan";
  }
}

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

function mockLlmPayload() {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            scores: {
              clarity_100: 72,
              relevance_100: 70,
              trust_100: 68,
              action_100: 74,
              conversion_100: 74,
              overall_100: 71,
            },
            ai_insights: {
              biggest_bottleneck: "Trust near the primary action is still easy to miss.",
              fastest_win: "Put one proof line next to the CTA.",
              estimated_impact: "First-time visitors should understand the offer faster.",
            },
            summary_insights: {
              biggest_bottleneck: "Trust near the primary action is still easy to miss.",
              fastest_win: "Put one proof line next to the CTA.",
              estimated_impact: "First-time visitors should understand the offer faster.",
            },
            user_snapshot: {
              target_audience: "Founders evaluating the product from the landing page",
              offer_summary: "A landing page that should convert first-time visitors",
              user_fit_diagnosis: "Best for visitors who need a clear offer and next step.",
            },
            free_preview_fix: {
              axis: "trust",
              title: "Add proof next to the CTA",
              verb: "Add",
              place: "under the CTA",
              quote: "Trusted by teams shipping in public",
              patch: { before: "", after: "Trusted by teams shipping in public" },
              instruction: "Add a proof line directly under the primary CTA.",
            },
            score_breakdown: {
              clarity: "The offer is readable.",
              relevance: "The buyer is identifiable.",
              trust: "Proof exists but is easy to miss.",
              action: "The CTA is visible.",
            },
            ab_test_variants: {
              headline: ["See what to fix on your landing page", "Score your landing page", "Find the conversion bottleneck"],
              subheadline: ["Paste a URL and get a score.", "Get the bottleneck and the next fix.", "A conversion score with copy you can use."],
              primary_cta: ["Analyze my page", "Get my score", "See my scorecard"],
            },
          }),
        },
      },
    ],
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, "json"), { recursive: true });

const summaries = [];

for (const url of URLS) {
  const startedAt = Date.now();
  process.stderr.write(`scan started: ${url}\n`);
  try {
    const output = await runWorkflowRequest(
      {
        body: { lp_url: url },
        headers: {},
        query: {},
      },
      {
        failClosed: true,
        repairForDelivery: true,
        useFirecrawl: false,
        aiElementSelection: false,
        forceVision: false,
        includeBenchmarkEvidence: false,
        browserlessEndpoint: CLOUD,
        browserlessFallbackEndpoint: LOCAL,
        browserlessTimeoutMs: 20_000,
        browserlessFallbackTimeoutMs: 55_000,
        workflowBudgetMs: 180_000,
        llmResponseOverride: mockLlmPayload(),
      },
    );
    const result = output.result || {};
    const diagnostics = result.meta?.fetch_diagnostics || {};
    const shot = result.screenshot_b64 || result.screenshot || "";
    const shotCheck = jpegMagicOk(shot);
    const slug = slugForUrl(url);
    if (shotCheck.ok) {
      const raw = Buffer.from(String(shot).replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, ""), "base64");
      fs.writeFileSync(path.join(OUT_DIR, `${slug}.${shotCheck.kind === "png" ? "png" : "jpg"}`), raw);
    }
    const jsonPath = path.join(OUT_DIR, "json", `${Date.now()}-${slug}.json`);
    const slim = {
      url,
      ok: result.ok !== false,
      duration_ms: Date.now() - startedAt,
      strategy: diagnostics.strategy,
      browserless_error: diagnostics.browserless_error,
      browserless_fallback_configured: diagnostics.browserless_fallback_configured,
      browserless_fallback_attempted: diagnostics.browserless_fallback_attempted,
      browserless_fallback_used: diagnostics.browserless_fallback_used,
      browserless_fallback_duration_ms: diagnostics.browserless_fallback_duration_ms,
      browserless_fallback_error: diagnostics.browserless_fallback_error,
      scan_quality_status: result.scan_quality_status,
      fail_soft: result.meta?.fail_soft === true,
      delivery_repaired: result.meta?.delivery_repaired === true,
      screenshot: shotCheck,
      headline: result.current_copy?.headline || result.page_facts?.hero?.headline || null,
      primary_cta: result.current_copy?.primary_cta || result.page_facts?.hero?.primary_cta || null,
      overall_100: result.scores?.overall_100 ?? null,
      lp_score_gate: wouldLpScoreAcceptScan(result),
    };
    fs.writeFileSync(jsonPath, `${JSON.stringify({ summary: slim, diagnostics, stage_timings: output.stage_timings }, null, 2)}\n`);
    const pathOk =
      diagnostics.browserless_fallback_used === true &&
      shotCheck.ok === true &&
      slim.lp_score_gate.ok === true;
    summaries.push({ ...slim, file: jsonPath, clone_path_ok: pathOk });
    process.stderr.write(
      `scan finished: ${url} fallback_used=${diagnostics.browserless_fallback_used} shot=${shotCheck.kind || shotCheck.reason} bytes=${shotCheck.bytes || 0} gate=${slim.lp_score_gate.reason}\n`,
    );
  } catch (error) {
    const summary = {
      url,
      ok: false,
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      clone_path_ok: false,
    };
    summaries.push(summary);
    process.stderr.write(`scan failed: ${url}: ${summary.error}\n`);
  }
}

const report = {
  ok: summaries.every((entry) => entry.clone_path_ok),
  capture_engine: "ghcr.io/browserless/chromium /function",
  playwright_used: false,
  cloud_endpoint: CLOUD,
  local_endpoint: LOCAL,
  outDir: OUT_DIR,
  summaries,
};
fs.writeFileSync(path.join(OUT_DIR, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.ok ? 0 : 1);
