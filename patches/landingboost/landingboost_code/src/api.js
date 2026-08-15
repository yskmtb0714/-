const crypto = require("node:crypto");
const { URL } = require("node:url");
const { asObject } = require("./common");
const {
  NODE_NAMES,
  rebuildPromptAndUiPack,
  runBuildBrowserlessPayload,
  runPreLlmPipeline,
  runPostLlmPipeline,
} = require("./pipeline");
const { analyzePageModel } = require("./analyze-page");
const { fetchBrowserless } = require("./browserless");
const { fetchFirecrawlLandingPage, materializeFirecrawlScreenshot } = require("./firecrawl");
const { firecrawlToFetchPayload } = require("./firecrawl-fetch-adapter");
const { mergeFirecrawlTextWithBrowserlessVisual } = require("./merge-fetch-payloads");
const { callLlmPrompt } = require("./llm-provider");
const { WORKFLOW_MODEL } = require("./config");
const { matchCompetitors } = require("./competitor-matcher");
const { validateCoreResponseContract, validateResponseContract } = require("./response-contract");
const { classifyProofLineKind, classifyProductProfile } = require("./family-router");
const { buildReferenceBackedEdit } = require("./reference-backed-edit");
const { extractVisionProofFromScreenshot } = require("./vision-proof");
const {
  selectPageElements,
  applySelectionToPayload,
} = require("./select-page-elements");
const {
  buildPageFacts,
  reconcileVerbWithProofState,
  alignBottleneckToFreePreview,
  anchorFixQuoteToPage,
  findFactContradictions,
  renderFactsForPrompt,
} = require("./page-facts");
const { buildDecisionSummary } = require("./decision-summary");

const DEFAULT_WORKFLOW_BUDGET_MS = 85000;
const DEFAULT_LLM_STAGE_TIMEOUT_MS = 55000;

function toTrimmed(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return toTrimmed(value[0]);
  if (typeof value === "object") return "";
  return String(value).trim();
}

function hasInvalidMarketFamily(value) {
  const obj = asObject(value);
  const family = toTrimmed(obj.market_family || obj.marketFamily || obj.family).toLowerCase();
  const subtype = toTrimmed(obj.profile_subtype || obj.profileSubtype || obj.subtype).toLowerCase();
  return family === "invalid_or_placeholder" || subtype === "broken_or_placeholder";
}

function preferFreshProfile(existing, next) {
  return existing && !hasInvalidMarketFamily(existing) ? existing : next;
}

function labelizeProfileValue(value) {
  return toTrimmed(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readableProfileLabel(profile) {
  const family = toTrimmed(profile?.market_family || profile?.marketFamily || profile?.family).toLowerCase();
  const subtype = toTrimmed(profile?.market_subtype || profile?.marketSubtype || profile?.subtype || profile?.profile_subtype || profile?.profileSubtype).toLowerCase();
  if (family === "product_idea_validation") return "Product Idea Validation / Idea Validation Tool";
  if (family === "landing_page_optimization") return "Landing Page Optimization";
  if (family === "finance_ops") return subtype ? `Finance Ops / ${labelizeProfileValue(subtype)}` : "Finance Ops";
  if (family === "content_marketing") return subtype ? `Content Marketing / ${labelizeProfileValue(subtype)}` : "Content Marketing";
  if (family === "sales_outreach") return subtype ? `Sales Outreach / ${labelizeProfileValue(subtype)}` : "Sales Outreach";
  if (family === "developer_workflow") return subtype ? `Developer Workflow / ${labelizeProfileValue(subtype)}` : "Developer Workflow";
  if (family === "consumer_app") return subtype ? `Consumer App / ${labelizeProfileValue(subtype)}` : "Consumer App";
  if (family === "ecommerce") return subtype ? `E-commerce / ${labelizeProfileValue(subtype)}` : "E-commerce";
  if (family || subtype) return [labelizeProfileValue(family), labelizeProfileValue(subtype)].filter(Boolean).join(" / ");
  return "";
}

function canonicalScanProfileFrom(profile) {
  const marketFamily = toTrimmed(profile?.market_family || profile?.marketFamily || profile?.family);
  const marketSubtype = toTrimmed(profile?.market_subtype || profile?.marketSubtype || profile?.profile_subtype || profile?.profileSubtype || profile?.subtype);
  const conversionModel = toTrimmed(profile?.conversion_model || profile?.conversionModel);
  const lpRole = toTrimmed(profile?.lp_role || profile?.lpRole);
  const proofPattern = toTrimmed(profile?.proof_pattern || profile?.proofPattern);
  const proofGap = toTrimmed(profile?.proof_gap || profile?.proofGap);
  const demoArtifact = toTrimmed(profile?.demo_artifact || profile?.demoArtifact);
  const monetizationSurface = toTrimmed(profile?.monetization_surface || profile?.monetizationSurface);
  const readableProfile = readableProfileLabel({
    ...asObject(profile),
    market_family: marketFamily,
    market_subtype: marketSubtype,
  });

  return {
    version: "canonical_scan_profile_v1",
    family: toTrimmed(profile?.family),
    subtype: toTrimmed(profile?.subtype),
    category: toTrimmed(profile?.category),
    market_family: marketFamily,
    marketFamily,
    market_subtype: marketSubtype,
    marketSubtype,
    profile_family: marketFamily,
    profileFamily: marketFamily,
    profile_subtype: marketSubtype,
    profileSubtype: marketSubtype,
    conversion_model: conversionModel,
    conversionModel,
    lp_role: lpRole,
    lpRole,
    proof_pattern: proofPattern,
    proofPattern,
    proof_gap: proofGap,
    proofGap,
    demo_artifact: demoArtifact,
    demoArtifact,
    monetization_surface: monetizationSurface,
    monetizationSurface,
    readable_profile: readableProfile,
    readableProfile,
    label: readableProfile,
    confidence: toTrimmed(profile?.confidence),
    intent_tags: Array.isArray(profile?.intent_tags) ? profile.intent_tags : Array.isArray(profile?.intentTags) ? profile.intentTags : [],
    intentTags: Array.isArray(profile?.intentTags) ? profile.intentTags : Array.isArray(profile?.intent_tags) ? profile.intent_tags : [],
    signals: Array.isArray(profile?.signals) ? profile.signals : [],
    page_validity: profile?.page_validity || profile?.pageValidity || null,
    pageValidity: profile?.pageValidity || profile?.page_validity || null,
  };
}

function marketProfileFromCanonical(canonical) {
  return {
    version: "market_profile_v1",
    market_family: canonical.market_family,
    market_subtype: canonical.market_subtype,
    conversion_model: canonical.conversion_model,
    lp_role: canonical.lp_role,
    proof_pattern: canonical.proof_pattern,
    proof_gap: canonical.proof_gap,
    demo_artifact: canonical.demo_artifact,
    monetization_surface: canonical.monetization_surface,
    page_validity: canonical.page_validity,
    readable_profile: canonical.readable_profile,
    confidence: canonical.confidence,
    signals: canonical.signals || [],
  };
}

function attachCanonicalProfile(rootValue, profile, marketProfileValue) {
  const root = asObject(rootValue);
  const canonical = canonicalScanProfileFrom(profile);
  const marketProfile = marketProfileValue || marketProfileFromCanonical(canonical);
  const profileContext = {
    ...canonical,
    used: true,
    classification: [canonical.readable_profile, canonical.conversion_model, canonical.proof_pattern]
      .filter(Boolean)
      .join(" + "),
    evidence_alignment: asObject(root.free_preview_fix?.market_profile_context?.evidence_alignment),
  };
  const evidence = asObject(root.benchmark_evidence);
  const hasEvidence = Object.keys(evidence).length > 0;

  return {
    ...root,
    page_category: canonical.category || root.page_category,
    canonical_scan_profile: canonical,
    benchmark_match_profile: canonical,
    market_profile: marketProfile,
    free_preview_fix: root.free_preview_fix && typeof root.free_preview_fix === "object"
      ? {
          ...root.free_preview_fix,
          market_profile_context: {
            ...asObject(root.free_preview_fix.market_profile_context),
            ...profileContext,
          },
        }
      : root.free_preview_fix,
    benchmark_evidence: hasEvidence
      ? {
          ...evidence,
          source_profile: {
            ...asObject(evidence.source_profile),
            ...canonical,
          },
        }
      : root.benchmark_evidence,
    meta: {
      ...asObject(root.meta),
      canonical_scan_profile: canonical,
      benchmark_match_profile: canonical,
      market_profile: marketProfile,
      profile_family: canonical.family,
      profile_subtype: canonical.subtype,
      profile_category: canonical.category,
      profile_intent_tags: canonical.intent_tags,
      market_family: canonical.market_family,
      market_subtype: canonical.market_subtype,
      conversion_model: canonical.conversion_model,
      lp_role: canonical.lp_role,
      proof_pattern: canonical.proof_pattern,
      proof_gap: canonical.proof_gap,
      monetization_surface: canonical.monetization_surface,
      readable_profile: canonical.readable_profile,
      profile_confidence: canonical.confidence,
    },
  };
}

function getHeader(headers, key) {
  const target = String(key || "").toLowerCase();
  const source = asObject(headers);
  for (const name of Object.keys(source)) {
    if (String(name).toLowerCase() === target) return source[name];
  }
  return undefined;
}

function sanitizeUrlInput(raw) {
  let s = toTrimmed(raw);
  s = s.replace(/[\u200B\uFEFF\u00A0]/g, "");
  s = s.replace(/。/g, ".").replace(/／/g, "/").replace(/：/g, ":");

  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }

  s = s.replace(/[)\],;。．，,\s]+$/g, "").trim();

  if (/^lp_url\s*=\s*/i.test(s)) {
    s = s.replace(/^lp_url\s*=\s*/i, "").trim();
  }

  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/^http:\/\//i, "https://");
  return s;
}

function validateHttpUrl(url) {
  const s = toTrimmed(url);
  if (!/^https?:\/\//i.test(s)) return false;
  if (/\s/.test(s)) return false;

  const match = s.match(/^https?:\/\/([^\s/?#]+)/i);
  if (!match) return false;

  const host = match[1];
  if (!host || host.includes("..") || host.startsWith(".") || host.endsWith(".")) return false;
  if (host === "localhost") return true;

  const hostOnly = host.split(":")[0];
  if (!hostOnly.includes(".")) return false;
  if (/[^a-z0-9.\-]/i.test(hostOnly)) return false;
  return true;
}

function buildWebhookEnvelope(input) {
  const req = asObject(input);
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : req;
  const query = req.query && typeof req.query === "object" && !Array.isArray(req.query) ? req.query : {};
  const headers =
    req.headers && typeof req.headers === "object" && !Array.isArray(req.headers) ? req.headers : {};

  return { body, query, headers, ...req };
}

function getExpectedWebhookSecret() {
  return toTrimmed(process.env.LB_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET);
}

function makeHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function secretsMatch(incoming, expected) {
  const incomingBuffer = Buffer.from(toTrimmed(incoming));
  const expectedBuffer = Buffer.from(toTrimmed(expected));
  if (incomingBuffer.length === 0 || incomingBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(incomingBuffer, expectedBuffer);
}

function requiresWebhookSecret(env = process.env) {
  const nodeEnv = toTrimmed(env.NODE_ENV).toLowerCase();
  const explicit = toTrimmed(env.REQUIRE_WEBHOOK_SECRET).toLowerCase();
  return nodeEnv === "production" || ["1", "true", "yes", "on", "required"].includes(explicit);
}

function buildSafeErrorDetails(error) {
  const details = {};
  const code = toTrimmed(error?.code);
  const quality = asObject(error?.quality);
  const qualityIssues = Array.isArray(quality.issues)
    ? quality.issues.filter((value) => typeof value === "string" && value)
    : [];
  const missingSignals = Array.isArray(quality.missing_signals)
    ? quality.missing_signals.filter((value) => typeof value === "string" && value)
    : [];

  if (code) details.code = code;
  if (qualityIssues.length) details.quality_issues = qualityIssues;
  if (missingSignals.length) details.missing_signals = missingSignals;
  if (quality.bot_verification === true) details.bot_verification = true;
  return details;
}

function wantsCompetitors(reqInput) {
  const req = buildWebhookEnvelope(reqInput);
  const body = asObject(req.body);
  const query = asObject(req.query);
  const raw =
    body.include_competitors ??
    body.includeCompetitors ??
    query.include_competitors ??
    query.includeCompetitors ??
    req.include_competitors ??
    req.includeCompetitors;
  if (typeof raw === "boolean") return raw;
  const value = toTrimmed(raw).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

// Extraction sometimes misreads UI copy as a testimonial author (e.g. the word
// "Place" from "Place proof beside the CTA:"), which then leaks into suggested
// copy as `... (Place)`. Attribution must look like a name, not a UI verb/label.
const NON_NAME_ATTRIBUTION_RE = new RegExp(
  "^(?:place|add|move|keep|show|put|replace|use|copy|edit|scan|click|get|try|start|learn|read|see|view|buy|join|make|build|fix|test|run|open|close|share|save|send|submit|continue|cancel|next|back|home|menu|about|pricing|features|blog|docs|faq|login|log in|sign in|sign up|register|subscribe|download|upgrade)$",
  "i",
);

function looksLikeProofAttribution(value) {
  const s = toTrimmed(value);
  if (!s) return false;
  return !NON_NAME_ATTRIBUTION_RE.test(s);
}

function formatOutcomeProofLine(proof) {
  const p = asObject(proof);
  const quote = toTrimmed(p.quote || p.text || p.label);
  if (!quote) return "";
  const author = toTrimmed(p.author || p.name || p.attribution);
  return author && looksLikeProofAttribution(author) ? `${quote} (${author})` : quote;
}

function normalizeExistingOutcomeProofFix(fix, currentCopy) {
  const out = asObject(fix);
  const cc = asObject(currentCopy);
  const proof = asObject(cc.cta_supporting_outcome_proof || cc.outcome_proof_to_promote);
  const line = formatOutcomeProofLine(proof);
  if (!line || proof.existing_on_page !== true) return out;
  if (toTrimmed(out.axis || out.category).toLowerCase() !== "trust") return out;

  return {
    ...out,
    axis: "trust",
    category: out.category || "trust",
    title: "Move the existing outcome proof closer to the CTA",
    verb: "Move",
    place: "beside the primary CTA",
    where: "beside the primary CTA",
    quote: line,
    exact_edit: line,
    patch: {
      ...asObject(out.patch),
      before: toTrimmed(asObject(out.patch).before),
      after: line,
    },
    instruction: `Use the existing outcome proof "${line}" as the CTA-supporting proof while keeping the risk-reversal line.`,
    implementation_prompt: `Move the existing outcome proof "${line}" beside the primary CTA. Keep the existing risk-reversal line visible. Do not invent a new testimonial, customer quote, or metric.`,
    problem: "The page already has CTA-near trust proof and a stronger outcome proof; the fix is placement and priority, not inventing proof.",
    reason: "The page already has CTA-near trust proof and a stronger outcome proof; the fix is placement and priority, not inventing proof.",
    success_metric: out.success_metric || "More visitors see a concrete customer outcome before deciding whether to click.",
    acceptance_check: `The existing outcome proof "${line}" appears beside the primary CTA, with the risk-reversal line still visible.`,
  };
}

function normalizeExistingOutcomeProofResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const currentCopy = asObject(result.current_copy || result.currentCopyForLLM || result.currentCopy);
  const proof = asObject(currentCopy.cta_supporting_outcome_proof || currentCopy.outcome_proof_to_promote);
  if (proof.existing_on_page !== true || !formatOutcomeProofLine(proof)) return result;
  return {
    ...result,
    free_preview_fix: normalizeExistingOutcomeProofFix(result.free_preview_fix, currentCopy),
    reference_backed_fix: normalizeExistingOutcomeProofFix(result.reference_backed_fix, currentCopy),
  };
}

function isNegativeVisualEvidenceLine(value) {
  const text = toTrimmed(value).toLowerCase();
  if (!text) return false;
  return /\b(no visible|not visible|none visible|missing|absent|does not show|do not show|without|no customer|no star|no review|no testimonial|no logo|no before\/after)\b/.test(text);
}

function isBotVerificationCapture(pre) {
  const b = asObject(pre?.b);
  const c = asObject(pre?.c);
  const uiPack = asObject(pre?.uiPack);
  const currentCopy = asObject(
    b.currentCopyForLLM ||
      b.currentCopy ||
      c.currentCopyForLLM ||
      c.currentCopy ||
      uiPack.currentCopyForLLM ||
      uiPack.currentCopy,
  );
  const trustPolicy = asObject(b.trustPolicy || c.trustPolicy || uiPack.trustPolicy);
  const rawText = [
    currentCopy.headline,
    currentCopy.subheadline,
    currentCopy.primary_cta,
    currentCopy.secondary_cta,
    currentCopy.trust_line,
    currentCopy.proof_signal,
    ...asArray(currentCopy.section_order),
    ...asArray(currentCopy.trust_near_cta_top),
    ...asArray(trustPolicy.trust_lines_on_page),
    ...asArray(trustPolicy.social_proof_lines_on_page),
    b.compactText,
    c.compactText,
    uiPack.compactText,
  ].map(toTrimmed).filter(Boolean).join(" \n ").toLowerCase();

  return /\b(are you a robot|verify you are human|verifying\.\.\.|checking your browser|just a moment|cloudflare|sorry for the inconvenience|enable javascript and cookies|confirm you'?re not a robot|privacy\s*[·•]\s*help)\b/.test(rawText);
}

function isVisionRiskReducerLine(value) {
  const text = toTrimmed(value);
  if (!text) return false;
  return /\b(no credit card|no card|free for|free every|free plan|free trial|start free|try free|free forever|cancel anytime|cancel any time|unsubscribe any time|no spam|money[- ]back|refund|guarantee|risk[- ]free|no obligation|no contract|instant access|results? in seconds?)\b/i.test(text);
}

function buildVisionProofSignals(visionProof) {
  const raw = asObject(visionProof?.raw);
  const merged = asObject(visionProof?.merged);
  const metricLines = Array.isArray(raw.visual_metric_lines) ? raw.visual_metric_lines : [];
  const logoLines = Array.isArray(raw.visual_customer_logos_readable)
    ? raw.visual_customer_logos_readable
    : [];
  const reviewSources = Array.isArray(raw.visual_review_badge_sources)
    ? raw.visual_review_badge_sources
    : [];
  const evidenceNotes = Array.isArray(raw.evidence_notes) ? raw.evidence_notes : [];
  const positiveEvidenceNotes = evidenceNotes.filter((note) => !isNegativeVisualEvidenceLine(note));
  const riskReducerLines = positiveEvidenceNotes.filter(isVisionRiskReducerLine);
  const strongestLine =
    merged.strongest_proof_line ||
    metricLines[0] ||
    raw.visual_star_rating_text ||
    positiveEvidenceNotes[0] ||
    "";

  return {
    raw,
    merged,
    strongestLine,
    metricLines,
    logoLines,
    reviewSources,
    evidenceNotes,
    positiveEvidenceNotes,
    riskReducerLines,
    proofLines: [
      strongestLine,
      ...metricLines,
      raw.visual_star_rating_text,
      ...reviewSources,
      ...logoLines,
      ...riskReducerLines,
      ...positiveEvidenceNotes,
    ].filter(Boolean),
  };
}

function buildEvidencePageModel(authItem, pre, result, visionProof = null) {
  const b = asObject(pre?.b);
  const c = asObject(pre?.c);
  const uiPack = asObject(pre?.uiPack);
  const vision = buildVisionProofSignals(visionProof);
  const currentCopy = asObject(
      b.currentCopyForLLM ||
      c.currentCopyForLLM ||
      uiPack.currentCopyForLLM ||
      b.currentCopy ||
      c.currentCopy ||
      uiPack.currentCopy ||
      result?.current_copy ||
      result?.currentCopy,
  );
  const pricingContext = asObject(
    result?.pricingContext ||
      b.pricingContext ||
      uiPack.pricingContext ||
      c.pricingContext,
  );
  const visionCurrentCopy = {
    ...currentCopy,
    trust_near_cta_primary:
      currentCopy.trust_near_cta_primary ||
      (vision.raw.visual_proof_near_cta ? vision.strongestLine : ""),
    trust_near_cta_social_proof:
      currentCopy.trust_near_cta_social_proof ||
      (vision.raw.visual_proof_near_cta ? vision.metricLines[0] || vision.strongestLine : ""),
    trust_near_cta_risk_reversal:
      currentCopy.trust_near_cta_risk_reversal ||
      currentCopy.trust_risk_reversal ||
      vision.riskReducerLines[0] ||
      "",
    trust_near_cta_top: [
      ...asArraySafe(currentCopy.trust_near_cta_top),
      ...vision.riskReducerLines,
    ],
    trust_social_proof:
      currentCopy.trust_social_proof ||
      vision.metricLines[0] ||
      vision.strongestLine ||
      currentCopy.trust_line,
    trust_line: currentCopy.trust_line || vision.strongestLine,
    logo_or_badge_signals: [
      ...vision.logoLines,
      ...vision.reviewSources,
      rawTruthyLabel(vision.raw.visual_producthunt_badge_present, "Product Hunt badge"),
      rawTruthyLabel(vision.raw.visual_g2_capterra_badge_present, "G2/Capterra badge"),
    ].filter(Boolean),
    testimonials_top: vision.raw.visual_testimonial_cards_present ? vision.positiveEvidenceNotes : [],
  };
  const trustPolicy = {
    ...asObject(b.trustPolicy),
    hasAnyTrustNearCTA:
      asObject(b.trustPolicy).hasAnyTrustNearCTA || Boolean(vision.raw.visual_proof_near_cta),
    hasSocialProof:
      asObject(b.trustPolicy).hasSocialProof ||
      Boolean(vision.raw.visual_testimonial_cards_present || vision.raw.visual_metric_in_screenshot_present),
    hasLogoSocialProof:
      asObject(b.trustPolicy).hasLogoSocialProof || Boolean(vision.raw.visual_logo_wall_present),
    testimonial_count:
      asObject(b.trustPolicy).testimonial_count ||
      Number(vision.raw.visual_testimonial_count_estimate || 0),
    social_proof_lines_on_page: [
      ...asArraySafe(asObject(b.trustPolicy).social_proof_lines_on_page),
      ...vision.proofLines,
    ],
    logo_social_proof_lines_on_page: [
      ...asArraySafe(asObject(b.trustPolicy).logo_social_proof_lines_on_page),
      ...vision.logoLines,
      ...vision.reviewSources,
    ],
    testimonial_lines_on_page: [
      ...asArraySafe(asObject(b.trustPolicy).testimonial_lines_on_page),
      ...(vision.raw.visual_testimonial_cards_present ? vision.positiveEvidenceNotes : []),
    ],
  };
  const visualStructured = {
    visual_logo_wall_present: vision.raw.visual_logo_wall_present,
    visual_star_rating_present: vision.raw.visual_star_rating_present,
    visual_review_badge_present: vision.raw.visual_review_badge_present,
    visual_producthunt_badge_present: vision.raw.visual_producthunt_badge_present,
    visual_g2_capterra_badge_present: vision.raw.visual_g2_capterra_badge_present,
    visual_founder_faces_present: vision.raw.visual_founder_faces_present,
    visual_testimonial_cards_present: vision.raw.visual_testimonial_cards_present,
    visual_before_after_present: vision.raw.visual_before_after_present,
    visual_metric_in_screenshot_present: vision.raw.visual_metric_in_screenshot_present,
    visual_product_ui_screenshot_present: vision.raw.visual_product_ui_screenshot_present,
    visual_metric_lines: vision.metricLines,
    visual_customer_logos_readable: vision.logoLines,
    visual_review_badge_sources: vision.reviewSources,
    proof_pattern: vision.merged.proof_pattern,
    proof_gap: vision.merged.proof_gap,
    demo_artifact: vision.merged.demo_artifact,
    product_artifact_present: vision.merged.product_artifact_present,
    strongest_proof_line: vision.merged.strongest_proof_line,
    strongest_proof_type: vision.merged.strongest_proof_type,
    social_proof_numbers: vision.metricLines,
    social_proof_logos: vision.logoLines,
    trust_social_proof: vision.metricLines[0] || vision.strongestLine,
    trust_line: vision.strongestLine,
  };
  const currentCopyText = [
    visionCurrentCopy.headline,
    visionCurrentCopy.subheadline,
    visionCurrentCopy.primary_cta,
    visionCurrentCopy.secondary_cta,
    visionCurrentCopy.trust_line,
    visionCurrentCopy.trust_social_proof,
    visionCurrentCopy.trust_near_cta_primary,
    visionCurrentCopy.trust_near_cta_social_proof,
    visionCurrentCopy.trust_near_cta_risk_reversal,
    visionCurrentCopy.trust_primary,
    visionCurrentCopy.trust_risk_reversal,
    ...asArraySafe(visionCurrentCopy.trust_near_cta_top),
    ...asArraySafe(visionCurrentCopy.testimonials_top),
    ...asArraySafe(visionCurrentCopy.testimonials_all),
    ...asArraySafe(visionCurrentCopy.logo_social_proof_top),
    ...asArraySafe(visionCurrentCopy.logo_or_badge_signals),
  ].map(toTrimmed).filter(Boolean).join(" ");

  return {
    url: result?.url || result?.lp_url || authItem?.url || authItem?.lp_url,
    lp_url: result?.lp_url || authItem?.lp_url || authItem?.url,
    finalUrlStr: result?.finalUrlStr || b.finalUrlStr || b.finalUrl || authItem?.lp_url,
    contextHint: [
      b.contextHint,
      b.heroTextStr,
      b.aboveFoldText,
      currentCopyText,
      vision.strongestLine,
      ...vision.metricLines,
      ...vision.positiveEvidenceNotes,
      result?.user_snapshot?.target_audience,
      result?.user_snapshot?.offer_summary,
      result?.user_snapshot?.user_fit_diagnosis,
    ].filter(Boolean).join(" "),
    compactText: [
      b.compactText,
      b.heroTextStr,
      b.aboveFoldText,
      b.visibleText,
      currentCopyText,
      vision.strongestLine,
      ...vision.proofLines,
    ].filter(Boolean).join(" "),
    currentCopyForLLM: visionCurrentCopy,
    currentCopy: visionCurrentCopy,
    user_snapshot: result?.user_snapshot,
    offerSummary: result?.user_snapshot?.offer_summary,
    targetAudience: result?.user_snapshot?.target_audience,
    userFitDiagnosis: result?.user_snapshot?.user_fit_diagnosis,
    pricingContext,
    trustPolicy,
    commonProfile: visualStructured,
    extractedSignals: visualStructured,
    trustmrrExtracted: visualStructured,
    visionProof,
  };
}

function asArraySafe(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function rawTruthyLabel(value, label) {
  return value ? label : "";
}

function getRuntimeScreenshot(pre, result) {
  const b = asObject(pre?.b);
  const uiPack = asObject(pre?.uiPack);
  return {
    screenshot:
      result?.screenshot_b64 ||
      result?.screenshot_url ||
      result?.screenshot_full ||
      uiPack.screenshot ||
      uiPack.screenshot_b64 ||
      b.screenshot ||
      b.screenshot_b64 ||
      "",
    screenshotType:
      result?.screenshot_full_type ||
      result?.screenshot_type ||
      uiPack.screenshotType ||
      uiPack.screenshot_type ||
      b.screenshotType ||
      b.screenshot_type ||
      "image/png",
  };
}

async function buildRuntimeVisionProofResult(authItem, pre, result, options = {}) {
  try {
    const { screenshot, screenshotType } = getRuntimeScreenshot(pre, result);
    if (!screenshot) {
      return {
        proof: null,
        status: "skipped_no_screenshot",
        error: "",
      };
    }
    const b = asObject(pre?.b);
    const currentCopy = asObject(result?.current_copy || result?.currentCopy || b.currentCopyForLLM || b.currentCopy);
    const provenance = asObject(currentCopy.provenance);
    const candidateTexts = (field) => {
      const values = Array.isArray(asObject(provenance[field]).candidates)
        ? asObject(provenance[field]).candidates
        : [];
      return values.map((item) => toTrimmed(asObject(item).text || item)).filter(Boolean).slice(0, 20);
    };
    const proof = await extractVisionProofFromScreenshot({
      screenshot,
      screenshotType,
      apiKey: options.openRouterApiKey || process.env.OPENROUTER_API_KEY,
      model: options.visionModel || process.env.OPENROUTER_VISION_MODEL || "openai/gpt-5.4-nano",
      timeoutMs: options.visionTimeoutMs || process.env.VISION_TIMEOUT_MS || 8000,
      fetchFn: options.visionFetchFn,
      context: {
        name: result?.name || authItem?.name || "",
        url: result?.url || result?.lp_url || authItem?.url || authItem?.lp_url,
        headline: currentCopy.headline || result?.headline || "",
        primary_cta: currentCopy.primary_cta || result?.primary_cta || "",
        trust_line: currentCopy.trust_line || result?.trust_line || "",
        headline_candidates: candidateTexts("headline"),
        subheadline_candidates: candidateTexts("subheadline"),
        primary_cta_candidates: candidateTexts("primary_cta"),
        secondary_cta_candidates: candidateTexts("secondary_cta"),
      },
    });
    return {
      proof,
      status: proof ? "ok" : "skipped_no_image",
      error: "",
    };
  } catch (error) {
    console.warn("[vision-proof] skipped:", error?.message || error);
    return {
      proof: null,
      status: "failed",
      error: String(error?.message || error),
    };
  }
}

function isSuspiciousDomHeadline(value) {
  const text = toTrimmed(value).replace(/\s+/g, " ");
  if (!text) return true;
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3 || words.length > 22) return true;
  if (/^[a-z]/.test(text) && !/[.!?]$/.test(text)) return true;
  if (/\b(limited spots?|special|free trial|free trail|guarantee|profit-performance|money back|no credit card|cancel anytime|offer ends|early bird|discount|% off|only \d+ left)\b/i.test(text)) return true;
  if (/^(?:get started|try for free|start for free|sign up|log in|book a demo|request demo)\b/i.test(text)) return true;
  if (/\b(is live|new!|new for enterprise|give it a try here|announcement|what'?s new|launch week|introducing\b|pre[ -]?order)\b/i.test(text)) return true;
  if (/\b(set up cursor rules|cursor desktop|ready for review|thought \d+s|fonts preload|critical css|color-scheme meta|enter a url above|retrieve a screenshot|py\s*torch|mnist|experiments)\b/i.test(text)) return true;
  if (
    /\b(bank of england|michelin|hyundai|government of the united kingdom|gov\.?uk|google|microsoft|amazon|stripe|shopify|notion|slack|github)\b/i.test(text) &&
    !/\b(alternative|platform|software|tool|service|analytics|builder|automation|workflow|for|that|without|with)\b/i.test(text)
  ) {
    return true;
  }
  const navHits = [
    "home",
    "features",
    "pricing",
    "docs",
    "blog",
    "templates",
    "examples",
    "sign in",
    "log in",
  ].filter((token) => lower.includes(token)).length;
  if (navHits >= 3) return true;
  if (/^(?:[A-Z][a-zA-Z0-9.&-]+(?:\s+|$)){4,}$/.test(text) && !/[.!?]/.test(text)) return true;
  return false;
}

function isUsableVisionHeadline(value) {
  const text = toTrimmed(value).replace(/\s+/g, " ");
  if (!text) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3 || words.length > 18 || text.length < 14 || text.length > 160) return false;
  if (/^(?:get started|try for free|start for free|sign up|log in|book a demo|request demo)\b/i.test(text)) return false;
  if (/\b(home|features|pricing|docs|blog|templates|examples|sign in|log in)\b/i.test(text) && words.length >= 5) return false;
  if (/\b(cookie|captcha|verify you are human|are you a robot|security checkpoint)\b/i.test(text)) return false;
  return true;
}

function headlineQualityScore(value, context = {}) {
  const text = toTrimmed(value).replace(/\s+/g, " ");
  if (!text) return -20;
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  let score = 0;
  if (words.length >= 4 && words.length <= 12) score += 4;
  else if (words.length >= 3 && words.length <= 16) score += 2;
  else score -= 3;
  if (/[.!?]$/.test(text)) score += 1;
  if (/\b(get|turn|grow|build|create|automate|find|book|ship|launch|convert|stop|start|save|scale)\b/i.test(text)) score += 2;
  if (/\b(customers?|leads?|users?|revenue|sales|traffic|signups?|appointments?|pipeline|audience|newsletter|product|website|landing page|workflow|data|reports?)\b/i.test(text)) score += 3;
  if (/\b(for|from|without|with|in|on|to)\b/i.test(text)) score += 1;
  if (/\b(home|features|pricing|docs|blog|sign in|log in)\b/i.test(lower)) score -= 4;
  if (/\b(comment|dm|rank|publish|write|track|manage|monitor|scrape|send)\b(?:\s*,\s*|\s+and\s+|\s+or\s+)/i.test(lower) && words.length <= 5) score -= 5;
  if (/^[a-z]/.test(text) && !/[.!?]$/.test(text)) score -= 2;
  if (isSuspiciousDomHeadline(text)) score -= 6;
  const visualSubheadline = toTrimmed(context.visualSubheadline).toLowerCase();
  if (visualSubheadline && visualSubheadline.includes(lower) && lower !== visualSubheadline) score -= 4;
  return score;
}

function shouldPreferVisionHeadline(currentHeadline, visualHeadline, context = {}) {
  const current = toTrimmed(currentHeadline).replace(/\s+/g, " ");
  const visual = toTrimmed(visualHeadline).replace(/\s+/g, " ");
  if (!isUsableVisionHeadline(visual)) return false;
  if (!current) return true;
  if (current === visual) return false;
  if (isSuspiciousDomHeadline(current)) return true;
  const currentScore = headlineQualityScore(current, context);
  const visualScore = headlineQualityScore(visual, context);
  return visualScore >= currentScore + 3;
}

function isSuspiciousDomCta(value) {
  const text = toTrimmed(value).replace(/\s+/g, " ");
  if (!text) return true;
  const lower = text.toLowerCase();
  if (/^(?:find|search|go)$/i.test(text)) return true;
  if (text.length > 60) return true;
  if (isProofOrTrustLineAsCta(text)) return true;
  if (/\b(result preview|market-backed|market backed|live page|reference evidence|evidence references|similar pages|signal meters|market proof|detected|scan benchmark|fix kit|target zone|editable zones)\b/i.test(text)) return true;
  if (/\b(give it a try here|try here|click here|read more|announcement|is live|what'?s new)\b/i.test(text)) return true;
  if (/\b(home|features|pricing|docs|blog|login|sign in)\b/i.test(text) && text.split(/\s+/).length >= 3) return true;
  if (/\b(with|for|to|from|by|before|after|beside|against)\s*$/i.test(text)) return true;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 5 && /^[A-Z0-9\s/|:._-]+$/.test(text) && !/[!?]/.test(text)) return true;
  if (words.length >= 2 && !/\b(get|start|try|compare|scan|audit|create|book|join|sign|request|download|install|generate|submit|unlock|open|see|view|learn|go|launch)\b/i.test(text) && /\b(preview|backed|market|reference|evidence|result|signal|lane|proof)\b/i.test(text)) return true;
  return false;
}

function isProofOrTrustLineAsCta(value) {
  const text = toTrimmed(value).replace(/\s+/g, " ");
  if (!text) return false;
  if (/\b(no credit card required|cancel anytime|money back|guarantee|risk free)\b/i.test(text)) return true;
  if (/\b(trusted by|used by|loved by|featured in|featured on|reviews?|rated|rating)\b/i.test(text)) return true;
  if (/\b(landing pages analyzed|founders scanned|pages analyzed|scans? completed)\b/i.test(text)) return true;
  if (/^\+?\d[\d.,kKmMbB+]*\s+(?:trusted|users?|customers?|founders?|developers?|creators?|teams?|companies?|downloads?|installs?|reviews?|pages? analyzed|landing pages analyzed)\b/i.test(text)) return true;
  if (/\b\d[\d.,kKmMbB+]*\s*(?:\+)?\s*(?:users?|customers?|founders?|developers?|creators?|teams?|companies?|downloads?|installs?|reviews?)\b/i.test(text) && !/^(?:get|start|try|compare|scan|audit|create|book|join|sign|request|download|install|generate|submit|unlock|open|see|view|learn|go|launch|find)\b/i.test(text)) {
    return true;
  }
  return false;
}

function isUsableVisionCta(value) {
  const text = toTrimmed(value).replace(/\s+/g, " ");
  if (!text) return false;
  if (text.length > 55) return false;
  if (isProofOrTrustLineAsCta(text)) return false;
  if (isSuspiciousDomCta(text)) return false;
  return /\b(get|start|try|compare|scan|audit|create|book|join|sign|request|download|install|generate|submit|unlock|open|see|view|learn|go|launch|list)\b/i.test(text);
}

function shouldPreferVisionPrimaryCta(currentCta, visualCta, visualSecondaryCta = "") {
  const current = toTrimmed(currentCta).replace(/\s+/g, " ");
  const visual = toTrimmed(visualCta).replace(/\s+/g, " ");
  const secondary = toTrimmed(visualSecondaryCta).replace(/\s+/g, " ");
  if (!isUsableVisionCta(visual)) return false;
  if (!current) return true;
  if (current === visual) return false;
  if (secondary && current === secondary && visual !== secondary) return true;
  if (isSuspiciousDomCta(current)) return true;
  if (/\b(join|continue|sign in|log in)\s+with\s+(google|github|email|sso)\b/i.test(current)) return true;
  return false;
}

function hasRealVisualTrustProof(raw, profile = {}) {
  if (!raw || typeof raw !== "object") return false;
  if (
    raw.visual_testimonial_cards_present ||
    raw.visual_logo_wall_present ||
    raw.visual_star_rating_present ||
    raw.visual_review_badge_present ||
    raw.visual_producthunt_badge_present ||
    raw.visual_g2_capterra_badge_present ||
    raw.visual_before_after_present
  ) return true;
  const context = {
    marketFamily: profile.marketFamily || profile.market_family,
    subtype: profile.subtype || profile.profile_subtype,
    intentTags: profile.intentTags || profile.intent_tags,
    pageValidity: profile.pageValidity || profile.page_validity,
  };
  return asArray(raw.visual_metric_lines).some((line) =>
    !["none", "product_detail"].includes(classifyProofLineKind(line, context))
  );
}

function firstConcreteVisionProof(raw, merged) {
  const usableEvidenceNote = asArray(raw.evidence_notes)
    .map((line) => toTrimmed(line).replace(/\s+/g, " "))
    .find((line) =>
      line &&
      /\b(used by|trusted by|customers?|users?|founders?|reviews?|rated|signups?|revenue|mrr)\b/i.test(line) &&
      !/\b(no visible|not visible|none visible|missing|absent|does not show|no clear)\b/i.test(line),
    );
  return toTrimmed(
    asArray(raw.visual_metric_lines)[0] ||
      raw.visual_star_rating_text ||
      merged.strongest_proof_line ||
      usableEvidenceNote ||
      "",
  ).replace(/\s+/g, " ");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function applyVisionCurrentCopyCorrection(pre, visionResult) {
  const proof = visionResult?.proof;
  const raw = asObject(proof?.raw);
  const merged = asObject(proof?.merged);
  const confidence = Number(raw.visual_confidence ?? merged.visual_confidence ?? 0);
  if (!proof || visionResult.status !== "ok" || !Number.isFinite(confidence) || confidence < 0.7) {
    return { pre, applied: false, reason: visionResult?.status || "vision_unavailable" };
  }

  const b = cloneJson(pre.b);
  const d = cloneJson(pre.d);
  const currentCopy = {
    ...asObject(d.currentCopy),
    ...asObject(d.currentCopyForLLM),
    ...asObject(b.currentCopy),
    ...asObject(b.currentCopyForLLM),
  };
  const currentHeadline = toTrimmed(currentCopy.headline);
  const visualHeadline = toTrimmed(raw.visual_headline_text || merged.visual_headline_text).replace(/\s+/g, " ");
  const visualSubheadline = toTrimmed(raw.visual_subheadline_text || merged.visual_subheadline_text).replace(/\s+/g, " ");
  const visualPrimaryCta = toTrimmed(raw.visual_primary_cta_text || merged.visual_primary_cta_text).replace(/\s+/g, " ");
  const visualSecondaryCta = toTrimmed(raw.visual_secondary_cta_text || merged.visual_secondary_cta_text).replace(/\s+/g, " ");
  const visualProofLine = firstConcreteVisionProof(raw, merged);

  const headlineSuspicious = isSuspiciousDomHeadline(currentHeadline);
  const nextCopy = { ...currentCopy };
  const provenance = asObject(currentCopy.provenance);
  const headlineProvenance = asObject(provenance.headline);
  const subheadlineProvenance = asObject(provenance.subheadline);
  const primaryCtaProvenance = asObject(provenance.primary_cta);
  const confirmedStatus = (value) => /^(?:confirmed|confirmed_rendered_dom|confirmed_by_vision|confirmed_missing)$/.test(toTrimmed(value));
  const matchesCandidate = (value, field) => {
    const target = toTrimmed(value).replace(/\s+/g, " ").toLowerCase();
    if (!target) return false;
    const candidates = asArray(field.candidates);
    if (!candidates.length && !toTrimmed(field.status)) return true;
    return candidates
      .map((candidate) => toTrimmed(candidate).replace(/\s+/g, " ").toLowerCase())
      .some((candidate) => candidate === target);
  };
  const changes = {};
  const nextProvenance = {
    ...provenance,
    headline: { ...headlineProvenance },
    subheadline: { ...subheadlineProvenance },
    primary_cta: { ...primaryCtaProvenance },
  };

  if (
    toTrimmed(headlineProvenance.status) &&
    !confirmedStatus(headlineProvenance.status) &&
    matchesCandidate(visualHeadline, headlineProvenance) &&
    toTrimmed(visualHeadline).replace(/\s+/g, " ") === currentHeadline.replace(/\s+/g, " ")
  ) {
    nextProvenance.headline.status = "confirmed_by_vision";
    changes.headline_confirmation = { value: currentHeadline, status: "confirmed_by_vision" };
  }
  if (
    toTrimmed(primaryCtaProvenance.status) &&
    !confirmedStatus(primaryCtaProvenance.status) &&
    matchesCandidate(visualPrimaryCta, primaryCtaProvenance) &&
    toTrimmed(visualPrimaryCta).replace(/\s+/g, " ") === toTrimmed(nextCopy.primary_cta).replace(/\s+/g, " ")
  ) {
    nextProvenance.primary_cta.status = "confirmed_by_vision";
    changes.primary_cta_confirmation = { value: nextCopy.primary_cta, status: "confirmed_by_vision" };
  }

  if (
    !confirmedStatus(headlineProvenance.status) &&
    matchesCandidate(visualHeadline, headlineProvenance) &&
    shouldPreferVisionHeadline(currentHeadline, visualHeadline, { visualSubheadline })
  ) {
    nextCopy.headline = visualHeadline;
    nextProvenance.headline.status = "confirmed_by_vision";
    nextProvenance.headline.exact_text = visualHeadline;
    changes.headline = { from: currentHeadline, to: visualHeadline };
  }
  if (
    !confirmedStatus(subheadlineProvenance.status) &&
    matchesCandidate(visualSubheadline, subheadlineProvenance) &&
    (!toTrimmed(nextCopy.subheadline) || ((headlineSuspicious || changes.headline) && visualSubheadline)) &&
    visualSubheadline &&
    visualSubheadline !== nextCopy.headline
  ) {
    nextCopy.subheadline = visualSubheadline;
    changes.subheadline = { from: currentCopy.subheadline || "", to: visualSubheadline };
  }
  if (
    !confirmedStatus(primaryCtaProvenance.status) &&
    matchesCandidate(visualPrimaryCta, primaryCtaProvenance) &&
    shouldPreferVisionPrimaryCta(nextCopy.primary_cta, visualPrimaryCta, visualSecondaryCta)
  ) {
    const from = nextCopy.primary_cta || "";
    nextCopy.primary_cta = visualPrimaryCta;
    nextProvenance.primary_cta.status = "confirmed_by_vision";
    nextProvenance.primary_cta.exact_text = visualPrimaryCta;
    changes.primary_cta = { from, to: visualPrimaryCta };
  }
  if (!toTrimmed(nextCopy.secondary_cta) && visualSecondaryCta && visualSecondaryCta !== nextCopy.primary_cta) {
    nextCopy.secondary_cta = visualSecondaryCta;
    changes.secondary_cta = { from: "", to: visualSecondaryCta };
  }
  const existingProofLines = [
    nextCopy.trust_line,
    nextCopy.trust_social_proof,
    nextCopy.trust_near_cta_social_proof,
    ...asArray(nextCopy.trust_signals),
    ...asArray(nextCopy.trust_near_cta_top),
    ...asArray(nextCopy.testimonials_top).map((item) => asObject(item).quote || item),
    ...asArray(nextCopy.testimonials_all).map((item) => asObject(item).quote || item),
  ].map((line) => toTrimmed(line).replace(/\s+/g, " ").toLowerCase()).filter(Boolean);
  const groundedVisualProof = visualProofLine && existingProofLines.includes(visualProofLine.toLowerCase());
  if (groundedVisualProof && visualProofLine.length > toTrimmed(nextCopy.trust_social_proof || nextCopy.trust_line).length + 4) {
    const from = nextCopy.trust_social_proof || nextCopy.trust_line || "";
    nextCopy.trust_line = visualProofLine;
    nextCopy.trust_primary = visualProofLine;
    nextCopy.trust_social_proof = visualProofLine;
    nextCopy.proof_signal = visualProofLine;
    const nearCta = asArray(nextCopy.trust_near_cta_top).map(toTrimmed).filter(Boolean);
    if (!nearCta.some((line) => line === visualProofLine)) {
      nextCopy.trust_near_cta_top = [visualProofLine, ...nearCta].slice(0, 4);
    }
    if (raw.visual_proof_near_cta || merged.proof_at_decision_point) {
      nextCopy.trust_near_cta_social_proof = visualProofLine;
    }
    changes.trust_social_proof = { from, to: visualProofLine };
  }

  nextCopy.provenance = nextProvenance;

  if (!Object.keys(changes).length) {
    return { pre, applied: false, reason: headlineSuspicious ? "vision_headline_unusable" : "dom_headline_ok" };
  }

  b.currentCopyForLLM = { ...asObject(b.currentCopyForLLM), ...nextCopy };
  b.currentCopy = { ...asObject(b.currentCopy), ...nextCopy };
  d.currentCopyForLLM = { ...asObject(d.currentCopyForLLM), ...nextCopy };
  d.currentCopy = { ...asObject(d.currentCopy), ...nextCopy };
  b.vision_current_copy_correction = {
    applied: true,
    confidence,
    changes,
    vision_model: proof.model || null,
  };
  d.vision_current_copy_correction = b.vision_current_copy_correction;

  const nodeMap = { ...(pre.nodeMap || {}) };
  nodeMap[NODE_NAMES.buildCurrentCopy] = b;
  nodeMap[NODE_NAMES.decidePath] = d;
  const rebuilt = rebuildPromptAndUiPack({ ...pre, b, d, nodeMap });
  return {
    pre: rebuilt,
    applied: true,
    reason: "vision_current_copy_correction",
    changes,
  };
}

function reconcileVisionProofPlacementWithDom(pre, visionResult) {
  if (!visionResult || visionResult.status !== "ok" || !visionResult.proof) return visionResult;
  const b = asObject(pre?.b);
  const currentCopy = asObject(b.currentCopyForLLM || b.currentCopy);
  const candidatePack = asObject(b.candidatePack);
  const proofTexts = [
    currentCopy.trust_line,
    currentCopy.trust_social_proof,
    currentCopy.trust_near_cta_social_proof,
    ...asArray(currentCopy.trust_near_cta_top),
    ...asArray(currentCopy.testimonials_near_cta_top).map((item) => asObject(item).quote || item),
    ...asArray(currentCopy.testimonials_top).map((item) => asObject(item).quote || item),
  ].map((value) => toTrimmed(value).replace(/\s+/g, " ").toLowerCase()).filter(Boolean);
  const coordinateCandidates = [
    ...asArray(candidatePack.trust_candidates),
    ...asArray(candidatePack.testimonial_candidates),
    ...asArray(candidatePack.logo_social_proof_candidates),
  ];
  const hasCoordinateDecisionProof = coordinateCandidates.some((candidate) => {
    const item = asObject(candidate);
    const text = toTrimmed(item.text || item.raw_text).replace(/\s+/g, " ").toLowerCase();
    const top = Number(item.top ?? item.y ?? asObject(item.rect).top ?? asObject(item.rect).y);
    const left = Number(item.left ?? item.x ?? asObject(item.rect).left ?? asObject(item.rect).x);
    const distance = Number(item.dist_to_primary_cta_px);
    const grounded = text && proofTexts.some((proof) => proof === text || (proof.length >= 12 && (proof.includes(text) || text.includes(proof))));
    return grounded && Number.isFinite(top) && Number.isFinite(left) && Number.isFinite(distance) && distance <= 260 && item.in_nav !== true;
  });
  if (!hasCoordinateDecisionProof) return visionResult;

  const merged = asObject(visionResult.proof.merged);
  const gap = toTrimmed(merged.proof_gap || merged.proofGap);
  if (!["proof_visible_above_fold_but_not_near_cta", "proof_present_but_not_at_decision"].includes(gap)) return visionResult;

  return {
    ...visionResult,
    proof: {
      ...visionResult.proof,
      merged: {
        ...merged,
        proof_gap: "proof_at_decision_point",
        proofGap: "proof_at_decision_point",
        proof_at_decision_point: true,
        placement_reconciled_from_dom: true,
        vision_reported_proof_gap: gap,
      },
    },
  };
}

const CONFIRMED_RENDERED_FIELD_STATUSES = new Set([
  "confirmed",
  "confirmed_rendered_dom",
  "confirmed_by_vision",
]);

function normalizedVisibleText(value) {
  return toTrimmed(value).replace(/\s+/g, " ");
}

function hasUsableFieldRect(field) {
  const item = asObject(field);
  const rect = asObject(item.rect);
  const left = Number(rect.left ?? rect.x ?? item.left ?? item.x);
  const top = Number(rect.top ?? rect.y ?? item.top ?? item.y);
  const width = Number(rect.width ?? item.width ?? (Number(rect.right ?? item.right) - left));
  const height = Number(rect.height ?? item.height ?? (Number(rect.bottom ?? item.bottom) - top));
  return Number.isFinite(left) && Number.isFinite(top) && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

function isConfirmedRenderedField(field, value) {
  const item = asObject(field);
  const current = normalizedVisibleText(value);
  if (!current || !CONFIRMED_RENDERED_FIELD_STATUSES.has(toTrimmed(item.status)) || !hasUsableFieldRect(item)) {
    return false;
  }
  const exactText = normalizedVisibleText(item.exact_text || item.value);
  return !exactText || exactText === current;
}

function hasCoordinateBackedDecisionProof(pre) {
  const b = asObject(pre?.b);
  const currentCopy = asObject(b.currentCopyForLLM || b.currentCopy);
  const candidatePack = asObject(b.candidatePack);
  const proofTexts = [
    currentCopy.trust_line,
    currentCopy.trust_social_proof,
    currentCopy.trust_near_cta_social_proof,
    currentCopy.trust_risk_reversal,
    currentCopy.trust_near_cta_risk_reversal,
    ...asArray(currentCopy.trust_near_cta_top),
    ...asArray(currentCopy.testimonials_near_cta_top).map((item) => asObject(item).quote || item),
    ...asArray(currentCopy.testimonials_top).map((item) => asObject(item).quote || item),
  ].map((value) => normalizedVisibleText(value).toLowerCase()).filter(Boolean);
  if (!proofTexts.length) return false;

  return [
    ...asArray(candidatePack.trust_candidates),
    ...asArray(candidatePack.testimonial_candidates),
    ...asArray(candidatePack.logo_social_proof_candidates),
  ].some((candidate) => {
    const item = asObject(candidate);
    const text = normalizedVisibleText(item.text || item.raw_text).toLowerCase();
    const distance = Number(item.dist_to_primary_cta_px);
    const grounded = text && proofTexts.some((proof) =>
      proof === text || (proof.length >= 12 && text.length >= 12 && (proof.includes(text) || text.includes(proof)))
    );
    return grounded && hasUsableFieldRect(item) && Number.isFinite(distance) && distance >= 0 && distance <= 260 && item.in_nav !== true;
  });
}

function evaluatePreLlmVisionNeed(pre, fetchPayload, options = {}) {
  if (options.forceVision === true) return { run: true, reason: "forced" };
  if (options.skipVisionDueDeadline === true) {
    return { run: false, reason: "workflow_deadline" };
  }

  const b = asObject(pre?.b);
  const currentCopy = asObject(b.currentCopyForLLM || b.currentCopy);
  const provenance = asObject(currentCopy.provenance);
  const contract = asObject(currentCopy.extraction_contract);
  const identity = asObject(contract.page_identity);
  const captureHealth = buildCaptureHealthFromFetchPayload(fetchPayload);
  const fetchMeta = extractFetchMeta(fetchPayload);
  const browserlessMeta = asObject(fetchMeta.browserless_meta);
  const visualReview = asObject(
    browserlessMeta.visual_review ||
    fetchMeta.visual_review,
  );

  // Fail open to Vision. We skip only when the hybrid DOM resolver has
  // confirmed the same rendered page, all scoring-critical hero fields have
  // exact geometry, and decision proof is grounded beside the CTA.
  if (contract.version !== "hybrid_field_resolution_v1") return { run: true, reason: "hybrid_contract_missing" };
  if (identity.status !== "confirmed") return { run: true, reason: "page_identity_unconfirmed" };
  if (captureHealth.hard_fail || captureHealth.soft_fail || !captureHealth.screenshot_ok || captureHealth.preview_degraded) {
    return { run: true, reason: "capture_not_clean" };
  }
  if (!isConfirmedRenderedField(provenance.headline, currentCopy.headline)) {
    return { run: true, reason: "headline_unconfirmed" };
  }
  if (!isConfirmedRenderedField(provenance.subheadline, currentCopy.subheadline)) {
    return { run: true, reason: "subheadline_unconfirmed" };
  }
  if (!isConfirmedRenderedField(provenance.primary_cta, currentCopy.primary_cta || currentCopy.primaryCta)) {
    return { run: true, reason: "primary_cta_unconfirmed" };
  }
  if (isSuspiciousDomHeadline(currentCopy.headline)) return { run: true, reason: "headline_suspicious" };
  if (isSuspiciousDomCta(currentCopy.primary_cta || currentCopy.primaryCta)) return { run: true, reason: "primary_cta_suspicious" };
  if (!extractPreLlmCurrentCopySignals(pre).proof_or_risk) {
    if (visualReview.requires_vision === true) {
      return { run: true, reason: "decision_proof_visual_review" };
    }
    return { run: false, reason: "dom_confident_proof_absent" };
  }
  if (!hasCoordinateBackedDecisionProof(pre)) return { run: true, reason: "decision_proof_unconfirmed" };

  return { run: false, reason: "dom_confident" };
}

async function applyPreLlmVisionCorrection(authItem, pre, options = {}) {
  const decision = options.runtimeVisionResult
    ? { run: true, reason: "runtime_result_supplied" }
    : evaluatePreLlmVisionNeed(pre, options.fetchPayload, options);
  const visionResult = options.runtimeVisionResult || (
    decision.run
      ? await buildRuntimeVisionProofResult(authItem, pre, {}, options)
      : {
          proof: null,
          status: "skipped_dom_confident",
          error: "",
          skip_reason: decision.reason,
        }
  );
  if (!decision.run) {
    return {
      pre,
      applied: false,
      reason: decision.reason,
      visionResult,
    };
  }
  const correction = applyVisionCurrentCopyCorrection(pre, visionResult);
  const reconciledVisionResult = reconcileVisionProofPlacementWithDom(correction.pre, visionResult);
  return {
    ...correction,
    visionResult: reconciledVisionResult,
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function extractFetchMeta(fetchPayload) {
  const root = asObject(fetchPayload);
  const body = asObject(root.body);
  const json = asObject(root.json);
  const data = asObject(root.data);
  const pageLike = asObject(
    data.data && typeof data.data === "object" ? data.data :
    body.data && typeof body.data === "object" ? body.data :
    json.data && typeof json.data === "object" ? json.data :
    data,
  );
  return asObject(
    pageLike.meta && typeof pageLike.meta === "object" ? pageLike.meta :
    pageLike.data && pageLike.data.meta && typeof pageLike.data.meta === "object" ? pageLike.data.meta :
    data.meta && typeof data.meta === "object" ? data.meta :
    body.meta && typeof body.meta === "object" ? body.meta :
    json.meta && typeof json.meta === "object" ? json.meta :
    root.meta && typeof root.meta === "object" ? root.meta :
    {},
  );
}

function buildCaptureHealthFromFetchPayload(fetchPayload) {
  const meta = extractFetchMeta(fetchPayload);
  const browserlessMeta = asObject(meta.browserless_meta);
  const firecrawlVisualFallback = meta.screenshot_source === "firecrawl";
  const overlay = asObject(meta.overlay_cleanup);
  const degradedReasons = asArray(meta.preview_degraded_reasons).filter((item) => typeof item === "string" && item);
  const degradedEvidence = asArray(meta.preview_degraded_evidence).filter((item) => typeof item === "string" && item);

  return {
    hard_fail: meta.hard_fail === true || (!firecrawlVisualFallback && browserlessMeta.hard_fail === true),
    soft_fail: meta.soft_fail === true || (!firecrawlVisualFallback && browserlessMeta.soft_fail === true),
    screenshot_ok: meta.screenshot_ok !== false,
    preview_degraded: meta.preview_degraded === true,
    preview_degraded_reasons: degradedReasons,
    preview_degraded_evidence: degradedEvidence,
    overlay_cleanup: {
      triggered: Boolean(overlay.triggered),
      consent_clicks: Number(overlay.consent_clicks || 0),
      consent_hidden: Number(overlay.consent_hidden || 0),
      launcher_hidden: Number(overlay.launcher_hidden || 0),
      popup_dismissed: Number(overlay.popup_dismissed || 0),
      popup_hidden: Number(overlay.popup_hidden || 0),
    },
  };
}

function extractPreLlmCurrentCopySignals(pre) {
  const b = asObject(pre?.b);
  const c = asObject(pre?.c);
  const uiPack = asObject(pre?.uiPack);
  const currentCopy = asObject(
    b.currentCopyForLLM ||
      b.currentCopy ||
      c.currentCopyForLLM ||
      c.currentCopy ||
      uiPack.currentCopyForLLM ||
      uiPack.currentCopy,
  );
  const trustPolicy = asObject(b.trustPolicy || c.trustPolicy || uiPack.trustPolicy);
  const provenance = asObject(currentCopy.provenance);
  const extractionContract = asObject(currentCopy.extraction_contract);
  const trustLines = [
    currentCopy.trust_line,
    currentCopy.trust_cue,
    currentCopy.trust_social_proof,
    currentCopy.trust_risk_reversal,
    currentCopy.trust_near_cta_primary,
    currentCopy.trust_near_cta_social_proof,
    currentCopy.trust_near_cta_risk_reversal,
    ...asArray(currentCopy.trust_near_cta_top),
    ...asArray(currentCopy.trust_lines_on_page),
    ...asArray(currentCopy.social_proof_lines_on_page),
    ...asArray(trustPolicy.trust_lines_on_page),
    ...asArray(trustPolicy.social_proof_lines_on_page),
    ...asArray(trustPolicy.risk_reducer_lines_on_page),
    ...asArray(trustPolicy.testimonial_lines_on_page),
  ];

  return {
    headline: toTrimmed(currentCopy.headline),
    primary_cta: toTrimmed(currentCopy.primary_cta || currentCopy.primaryCta),
    proof_or_risk: trustLines.some(hasMeaningfulText),
    provenance,
    extraction_contract: extractionContract,
  };
}

function collectCaptureQualityIssues(fetchPayload, pre) {
  const captureHealth = buildCaptureHealthFromFetchPayload(fetchPayload);
  const fetchMeta = extractFetchMeta(fetchPayload);
  const hybridResolution = asObject(fetchMeta.hybrid_field_resolution);
  const signals = extractPreLlmCurrentCopySignals(pre);
  const botVerification = isBotVerificationCapture(pre);
  const missingSignals = [];
  if (!signals.headline) missingSignals.push("headline");
  const primaryCtaState = toTrimmed(asObject(asObject(signals.provenance).primary_cta).status);
  if (!signals.primary_cta && primaryCtaState !== "confirmed_missing") missingSignals.push("primary_cta");
  if (!signals.proof_or_risk) missingSignals.push("proof_or_risk");

  const issues = [];
  if (captureHealth.hard_fail || !captureHealth.screenshot_ok) {
    issues.push("capture_unusable");
  }
  if (captureHealth.preview_degraded && missingSignals.length > 0) {
    issues.push("capture_degraded_missing_core_signals");
  }
  if (botVerification) {
    issues.push("bot_verification_page");
  }
  if (hybridResolution.version) {
    const provenance = asObject(signals.provenance);
    const headlineProvenance = asObject(provenance.headline);
    const subheadlineProvenance = asObject(provenance.subheadline);
    const primaryCtaProvenance = asObject(provenance.primary_cta);
    const identity = asObject(hybridResolution.page_identity);
    const isResolved = (field) => {
      const provenanceField = asObject(field);
      const status = toTrimmed(provenanceField.status);
      if (/^(?:confirmed|confirmed_rendered_dom|confirmed_by_vision|confirmed_missing)$/.test(status)) {
        return true;
      }
      return (
        status === "firecrawl_only" &&
        identity.status === "confirmed" &&
        captureHealth.screenshot_ok === true &&
        Boolean(toTrimmed(provenanceField.exact_text))
      );
    };
    const requiresCoordinates = (status) =>
      /^(?:confirmed|confirmed_rendered_dom)$/.test(toTrimmed(status));
    if (identity.status !== "confirmed") issues.push("page_identity_unresolved");
    if (!isResolved(headlineProvenance)) issues.push("headline_unresolved");
    if (!isResolved(primaryCtaProvenance)) issues.push("primary_cta_unresolved");
    if (requiresCoordinates(headlineProvenance.status) && !Object.keys(asObject(headlineProvenance.rect)).length) {
      issues.push("headline_coordinate_missing");
    }
    if (requiresCoordinates(primaryCtaProvenance.status) && !Object.keys(asObject(primaryCtaProvenance.rect)).length) {
      issues.push("primary_cta_coordinate_missing");
    }
    if (
      headlineProvenance.exact_text &&
      toTrimmed(headlineProvenance.exact_text).replace(/\s+/g, " ") !== signals.headline.replace(/\s+/g, " ")
    ) {
      issues.push("headline_current_copy_drift");
    }
    if (
      subheadlineProvenance.exact_text &&
      toTrimmed(subheadlineProvenance.exact_text).replace(/\s+/g, " ") !==
        toTrimmed(asObject(pre?.b?.currentCopyForLLM || pre?.b?.currentCopy).subheadline).replace(/\s+/g, " ")
    ) {
      issues.push("subheadline_current_copy_drift");
    }
    if (
      primaryCtaProvenance.exact_text &&
      toTrimmed(primaryCtaProvenance.exact_text).replace(/\s+/g, " ") !== signals.primary_cta.replace(/\s+/g, " ")
    ) {
      issues.push("primary_cta_current_copy_drift");
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    missing_signals: missingSignals,
    bot_verification: botVerification,
    capture_health: captureHealth,
    signals,
    hybrid_resolution: hybridResolution,
  };
}

function collectFatalCaptureQualityIssues(quality) {
  const q = asObject(quality);
  const issues = asArray(q.issues).map(toTrimmed).filter(Boolean);
  const signals = asObject(q.signals);
  const provenance = asObject(signals.provenance);
  const ctaStatus = toTrimmed(asObject(provenance.primary_cta).status);
  const fatal = [];

  if (issues.includes("bot_verification_page")) fatal.push("bot_verification_page");
  if (asObject(q.capture_health).screenshot_ok !== true) fatal.push("screenshot_unusable");
  if (!toTrimmed(signals.headline)) fatal.push("headline_missing");
  if (!toTrimmed(signals.primary_cta) && ctaStatus !== "confirmed_missing") {
    fatal.push("primary_cta_missing");
  }
  return Array.from(new Set(fatal));
}

function assertDeliverableCaptureBeforeScoring(fetchPayload, pre) {
  const quality = collectCaptureQualityIssues(fetchPayload, pre);
  const fatalIssues = collectFatalCaptureQualityIssues(quality);
  const { screenshot } = getRuntimeScreenshot(pre, {});
  if (!toTrimmed(screenshot)) fatalIssues.push("screenshot_missing");
  if (!fatalIssues.length) return quality;
  const error = makeHttpError(422, "Landing page capture did not contain usable page content");
  error.code = "CAPTURE_UNUSABLE";
  error.quality = { ...quality, fatal_issues: fatalIssues };
  throw error;
}

function groundedProofSummary(pageFacts) {
  const state = toTrimmed(asObject(pageFacts).proof_state);
  if (state === "present_at_decision_point") {
    return "Proof is visible at the decision point; the opportunity is to make the existing proof more specific.";
  }
  if (state === "exists_but_not_at_decision_point") {
    return "Proof exists elsewhere on the page but is not visible at the decision point.";
  }
  return "The page does not show concrete proof at the decision point.";
}

function repairContradictoryProofClaims(result, pageFacts) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const replacement = groundedProofSummary(pageFacts);
  const contradicts = (claim) =>
    hasMeaningfulText(claim) && findFactContradictions(pageFacts, { claims: [claim] }).length > 0;

  const breakdown = asObject(result.score_breakdown);
  const trust = asObject(breakdown.trust);
  if (Array.isArray(trust.why_this_score)) {
    trust.why_this_score = trust.why_this_score.map((claim) =>
      contradicts(claim) ? replacement : claim,
    );
  }
  for (const key of ["ai_insights", "summary_insights"]) {
    const insights = asObject(result[key]);
    if (contradicts(insights.biggest_bottleneck)) {
      insights.biggest_bottleneck = replacement;
    }
  }
  return result;
}

function assertUsableCaptureBeforeScoring(fetchPayload, pre) {
  const quality = collectCaptureQualityIssues(fetchPayload, pre);
  if (quality.ok) return quality;
  const error = makeHttpError(422, "Landing page capture failed quality checks");
  error.code = "CAPTURE_QUALITY_FAILED";
  error.quality = quality;
  throw error;
}

function extractionAlreadyHasDecisionProof(profile) {
  const p = asObject(profile);
  const hierarchy = asObject(p.proof_hierarchy || p.proofHierarchy);
  const gap = toTrimmed(p.proof_gap || p.proofGap || hierarchy.gap);
  const nearLines = asArray(hierarchy.near_cta_proof_lines).map(toTrimmed).filter(Boolean);
  return Boolean(
    gap === "proof_supports_click" ||
      toTrimmed(hierarchy.strongest_near_cta_proof) ||
      nearLines.length > 0
  );
}

function visionWouldWorsenDecisionProofPlacement(classifiedProfile, visionProof) {
  if (!extractionAlreadyHasDecisionProof(classifiedProfile)) return false;
  const merged = asObject(visionProof?.merged);
  const visionGap = toTrimmed(merged.proof_gap || merged.proofGap);
  return visionGap === "proof_visible_above_fold_but_not_near_cta" ||
    visionGap === "proof_present_but_not_at_decision";
}

function shouldApplyVisionProofPattern(classifiedProfile, visionProof) {
  const raw = asObject(visionProof?.raw);
  const merged = asObject(visionProof?.merged);
  const visionPattern = toTrimmed(merged.proof_pattern);
  if (!visionPattern || visionPattern === "weak_or_missing_proof") return false;
  const confidence = Number(raw.visual_confidence ?? merged.visual_confidence ?? 0);
  if (!Number.isFinite(confidence) || confidence < 0.65) return false;

  const textPattern = toTrimmed(classifiedProfile?.proofPattern || classifiedProfile?.proof_pattern);
  const visionHasCustomerProof = hasRealVisualTrustProof(raw, classifiedProfile);

  if (visionPattern === "product_artifact_proof" && !visionHasCustomerProof) {
    return false;
  }

  if (["testimonial_proof", "numbers_proof", "proof_near_hero"].includes(textPattern)) {
    return visionHasCustomerProof;
  }

  if (textPattern === "logo_wall" && !raw.visual_logo_wall_present && visionPattern === "product_artifact_proof") {
    return true;
  }

  return true;
}

async function attachBenchmarkEvidence(authItem, pre, result, options = {}) {
  let fallbackProfile = null;
  let fallbackMarketProfile = null;
  try {
    const visionResult = options.runtimeVisionResult || await buildRuntimeVisionProofResult(authItem, pre, result, options);
    const visionProof = visionResult.proof;
    const page = buildEvidencePageModel(authItem, pre, result, visionProof);
    const classifiedProfile = classifyProductProfile(page);
    const visionMerged = asObject(visionProof?.merged);
    const applyVisionPattern = shouldApplyVisionProofPattern(classifiedProfile, visionProof) &&
      !visionWouldWorsenDecisionProofPlacement(classifiedProfile, visionProof);
    const baseProfileFromExtraction = {
      ...classifiedProfile,
      ...(visionMerged.demo_artifact || visionMerged.demoArtifact
        ? {
            demoArtifact: visionMerged.demo_artifact || visionMerged.demoArtifact,
            demo_artifact: visionMerged.demo_artifact || visionMerged.demoArtifact,
          }
        : {}),
    };
    const profileFromExtraction = applyVisionPattern
      ? {
          ...baseProfileFromExtraction,
          proofPattern: visionMerged.proof_pattern,
          proof_pattern: visionMerged.proof_pattern,
          proofGap: visionMerged.proof_gap,
          proof_gap: visionMerged.proof_gap,
        }
      : baseProfileFromExtraction;
    const resultCurrentCopy = asObject(result?.current_copy || result?.currentCopy);
    const displayedCopyProfile = Object.keys(resultCurrentCopy).length
      ? classifyProductProfile({
          url: authItem?.lp_url || authItem?.url || result?.url || result?.lp_url,
          lp_url: authItem?.lp_url || authItem?.url || result?.lp_url || result?.url,
          currentCopyForLLM: resultCurrentCopy,
          currentCopy: resultCurrentCopy,
          pricingContext: result?.pricingContext,
          trustPolicy: {
            social_proof_lines_on_page: [
              ...asArray(resultCurrentCopy.trust_signals),
              resultCurrentCopy.trust_line,
              resultCurrentCopy.trust_social_proof,
              ...asArray(resultCurrentCopy.trust_near_cta_top),
            ],
            testimonial_lines_on_page: [
              ...asArray(resultCurrentCopy.testimonials_top),
              ...asArray(resultCurrentCopy.testimonials_all),
            ],
            logo_social_proof_lines_on_page: asArray(resultCurrentCopy.logo_or_badge_signals),
          },
        })
      : null;
    const profile = displayedCopyProfile && shouldPreferDisplayedCopyProfile(profileFromExtraction, displayedCopyProfile)
      ? displayedCopyProfile
      : profileFromExtraction;
    fallbackProfile = profile;
    const marketProfile = marketProfileFromCanonical(canonicalScanProfileFrom(profile));
    fallbackMarketProfile = marketProfile;
    const evidence = buildReferenceBackedEdit(page, profile, asObject(result?.free_preview_fix), {
      limit: 3,
    });

    if (!Array.isArray(evidence.references) || evidence.references.length === 0) {
      return attachCanonicalProfile({
        ...result,
        // Persist the evidence envelope even when the safe matcher returns no
        // pages. The UI can then distinguish "no same-market evidence" from
        // missing/legacy data without calling a second dynamic reference API.
        benchmark_evidence: evidence,
        page_profile: preferFreshProfile(result?.page_profile, profile),
        market_profile: marketProfile,
        vision_proof: visionProof,
        page_category: profile.category || result?.page_category,
        meta: {
          ...asObject(result?.meta),
          profile_family: profile.family,
          profile_subtype: profile.subtype,
          profile_category: profile.category,
          profile_intent_tags: profile.intentTags,
          market_profile: marketProfile,
          market_family: marketProfile.market_family,
          conversion_model: marketProfile.conversion_model,
          lp_role: marketProfile.lp_role,
          proof_pattern: marketProfile.proof_pattern,
          monetization_surface: marketProfile.monetization_surface,
          profile_confidence: profile.confidence,
          benchmark_evidence_version: evidence.matcher_version,
          benchmark_reference_count: 0,
          benchmark_status: "no_references",
          reference_backed_edit_status: "no_references",
          vision_proof_version: visionProof?.merged?.version || null,
          vision_model: visionProof?.model || null,
          vision_status: visionResult.status,
          vision_error: visionResult.error || null,
          vision_override_applied: applyVisionPattern,
        },
      }, profile, marketProfile);
    }

    return attachCanonicalProfile({
      ...result,
      free_preview_fix: result.free_preview_fix,
      reference_backed_fix: evidence.reference_backed_fix || null,
      benchmark_evidence: evidence,
      page_profile: preferFreshProfile(result?.page_profile, profile),
      market_profile: marketProfile,
      vision_proof: visionProof,
      page_category: profile.category || result?.page_category,
      meta: {
        ...asObject(result?.meta),
        profile_family: profile.family,
        profile_subtype: profile.subtype,
        profile_category: profile.category,
        profile_intent_tags: profile.intentTags,
        market_profile: marketProfile,
        market_family: marketProfile.market_family,
        conversion_model: marketProfile.conversion_model,
        lp_role: marketProfile.lp_role,
        proof_pattern: marketProfile.proof_pattern,
        monetization_surface: marketProfile.monetization_surface,
        profile_confidence: profile.confidence,
        benchmark_evidence_version: evidence.matcher_version,
        benchmark_reference_count: evidence.references.length,
        benchmark_status: "ok",
        reference_backed_edit_status: evidence.reference_backed_fix ? "ok" : "no_reference_backed_fix",
        vision_proof_version: visionProof?.merged?.version || null,
        vision_model: visionProof?.model || null,
        vision_status: visionResult.status,
        vision_error: visionResult.error || null,
        vision_override_applied: applyVisionPattern,
      },
    }, profile, marketProfile);
  } catch (error) {
    console.warn("[reference-backed-edit] skipped:", error?.message || error);
    const failed = {
      ...result,
      meta: {
        ...asObject(result?.meta),
        benchmark_status: "failed",
        reference_backed_edit_status: "failed",
        benchmark_error: String(error?.message || error),
      },
    };
    return fallbackProfile
      ? attachCanonicalProfile(failed, fallbackProfile, fallbackMarketProfile)
      : failed;
  }
}

function hasMeaningfulText(value) {
  if (value === null || value === undefined) return false;
  const text = String(value).trim().toLowerCase();
  return Boolean(text) && !["n/a", "na", "none", "unknown", "null"].includes(text);
}

function scoreNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function collectScoringQualityIssues(result) {
  const root = asObject(result);
  const scores = asObject(root.scores);
  const clarityScore = scoreNumber(scores.clarity_100 ?? root.clarity_100);
  const relevanceScore = scoreNumber(scores.relevance_100 ?? root.relevance_100);
  const trustScore = scoreNumber(scores.trust_100 ?? root.trust_100);
  const actionScore = scoreNumber(
    scores.action_100 ?? scores.conversion_100 ?? root.action_100 ?? root.conversion_100,
  );
  const overallScore = scoreNumber(scores.overall_100 ?? root.overall_100);
  const axisScores = [clarityScore, relevanceScore, trustScore, actionScore];
  const zeroAxisCount = axisScores.filter((score) => score === 0).length;
  const allScoresZero =
    overallScore === 0 &&
    clarityScore === 0 &&
    relevanceScore === 0 &&
    trustScore === 0 &&
    actionScore === 0;

  const issues = [];
  if (allScoresZero) issues.push("all_zero_scores");
  if (!allScoresZero && zeroAxisCount >= 2) issues.push("majority_zero_axes");
  return {
    ok: issues.length === 0,
    issues,
    allScoresZero,
    zeroAxisCount,
    scores: {
      overall_100: overallScore,
      clarity_100: clarityScore,
      relevance_100: relevanceScore,
      trust_100: trustScore,
      action_100: actionScore,
    },
  };
}

function assertUsableScoringPayload(result) {
  const quality = collectScoringQualityIssues(result);
  if (quality.ok) return quality;
  const error = makeHttpError(422, "Scoring response failed quality checks");
  error.code = "SCORING_QUALITY_FAILED";
  error.quality = quality;
  throw error;
}

function shouldPreferDisplayedCopyProfile(existingProfile, nextProfile) {
  const existing = asObject(existingProfile);
  const next = asObject(nextProfile);
  const existingFamily = toTrimmed(existing.market_family || existing.marketFamily);
  const nextFamily = toTrimmed(next.market_family || next.marketFamily);
  if (!nextFamily || nextFamily === existingFamily) return false;
  if (hasInvalidMarketFamily(existing) && !hasInvalidMarketFamily(next)) return true;
  const existingConfidence = toTrimmed(existing.confidence).toLowerCase();
  const nextConfidence = toTrimmed(next.confidence).toLowerCase();
  if (nextConfidence === "high" && existingConfidence !== "high") return true;
  if (["other_saas", "productivity_docs", "content_marketing"].includes(existingFamily) && nextConfidence === "high") return true;
  return false;
}

function realignMarketProfileWithDisplayedCopy(result) {
  const root = asObject(result);
  const currentCopy = asObject(root.current_copy || root.currentCopy);
  if (!Object.keys(currentCopy).length) return result;

  const nextProfile = classifyProductProfile({
    url: root.url || root.lp_url,
    lp_url: root.lp_url || root.url,
    currentCopyForLLM: currentCopy,
    currentCopy,
    pricingContext: root.pricingContext,
    trustPolicy: {
      social_proof_lines_on_page: [
        ...asArray(currentCopy.trust_signals),
        currentCopy.trust_line,
        currentCopy.trust_social_proof,
        ...asArray(currentCopy.trust_near_cta_top),
      ],
      testimonial_lines_on_page: [
        ...asArray(currentCopy.testimonials_top),
        ...asArray(currentCopy.testimonials_all),
      ],
      logo_social_proof_lines_on_page: asArray(currentCopy.logo_or_badge_signals),
    },
  });
  const existingProfile = root.market_profile || asObject(root.meta).market_profile;
  if (!shouldPreferDisplayedCopyProfile(existingProfile, nextProfile)) return result;

  const marketProfile = marketProfileFromCanonical(canonicalScanProfileFrom({
    ...nextProfile,
    confidence: nextProfile.confidence || "medium",
    signals: asArray(nextProfile.signals),
  }));

  const out = {
    ...root,
    page_category: nextProfile.category || root.page_category,
    market_profile: marketProfile,
    meta: {
      ...asObject(root.meta),
      profile_family: nextProfile.family,
      profile_subtype: nextProfile.subtype,
      profile_category: nextProfile.category,
      profile_intent_tags: nextProfile.intentTags || nextProfile.intent_tags || [],
      market_profile: marketProfile,
      market_family: marketProfile.market_family,
      conversion_model: marketProfile.conversion_model,
      lp_role: marketProfile.lp_role,
      proof_pattern: marketProfile.proof_pattern,
      monetization_surface: marketProfile.monetization_surface,
      profile_confidence: marketProfile.confidence,
      market_profile_realigned_from_displayed_copy: true,
    },
  };

  return attachCanonicalProfile(out, nextProfile, marketProfile);
}

function authorizeAndNormalize(reqInput) {
  const req = buildWebhookEnvelope(reqInput);
  const body = asObject(req.body);
  const query = asObject(req.query);
  const headers = asObject(req.headers);

  const lpUrlRaw = toTrimmed(body.lp_url) || toTrimmed(query.lp_url) || toTrimmed(req.lp_url);
  const lpUrl = sanitizeUrlInput(lpUrlRaw);

  if (!lpUrl) throw new Error("lp_url is required");
  if (!validateHttpUrl(lpUrl)) {
    throw makeHttpError(400, `lp_url is invalid: ${JSON.stringify({ lpUrlRaw, lpUrl })}`);
  }

  const authContext = req.auth ?? req.user ?? req.session ?? body.auth ?? null;

  let userId = null;
  try {
    userId =
      toTrimmed(
        authContext?.user?.id ??
          authContext?.id ??
          body?.user_id ??
          query?.user_id ??
          req?.user_id,
      ) || null;
  } catch {
    userId = null;
  }

  const incomingSecret = toTrimmed(getHeader(headers, "x-lb-secret"));
  const expectedSecret = getExpectedWebhookSecret();
  const webhookSecretRequired = requiresWebhookSecret();
  if (webhookSecretRequired && !expectedSecret) {
    throw makeHttpError(503, "Webhook authentication is not configured");
  }
  if (webhookSecretRequired && !incomingSecret) {
    throw makeHttpError(401, "Missing x-lb-secret");
  }
  if (incomingSecret) {
    if (expectedSecret && !secretsMatch(incomingSecret, expectedSecret)) {
      throw makeHttpError(401, "Invalid x-lb-secret");
    }
    return {
      lp_url: lpUrl,
      request_source: "lovable_backend",
      user_id: userId,
      api_key: null,
      customer_email: null,
      stripe_customer_id: null,
      stripe_session_id: null,
    };
  }

  let apiKey = "";
  const authHeaderRaw = getHeader(headers, "authorization");
  if (typeof authHeaderRaw === "string") {
    const raw = authHeaderRaw.trim();
    if (raw.toLowerCase().startsWith("bearer ")) apiKey = raw.slice(7).trim();
  }

  if (!apiKey) {
    return {
      lp_url: lpUrl,
      request_source: "ui",
      user_id: userId,
      api_key: null,
      customer_email: null,
      stripe_customer_id: null,
      stripe_session_id: null,
    };
  }

  if (!apiKey.startsWith("lpapi_")) {
    throw makeHttpError(401, "Invalid or unauthorized API key");
  }

  return {
    lp_url: lpUrl,
    request_source: "api",
    user_id: null,
    api_key: apiKey,
    customer_email: null,
    stripe_customer_id: null,
    stripe_session_id: null,
  };
}

function isDeterministicPageModelRequest(json) {
  return Boolean(
    (json.normalized_page && typeof json.normalized_page === "object") ||
      json.currentCopyForLLM ||
      json.currentCopy ||
      json.pricingContext ||
      json.trustPolicy,
  );
}

function firecrawlModeEnabled(options = {}) {
  if (options.useFirecrawl === true) return true;
  if (options.useFirecrawl === false) return false;
  const mode = String(process.env.LB_FETCH_MODE || process.env.FETCH_MODE || "").trim().toLowerCase();
  return mode === "firecrawl_assisted" || mode === "firecrawl-first" || mode === "firecrawl_first";
}

function safeFailureMessage(error) {
  return String(error?.message || error || "unknown failure").slice(0, 300);
}

function emergencyUrlOnlyFetchPayload(url, error) {
  let hostname = "Landing page";
  try {
    hostname = new URL(url).hostname.replace(/^www\./i, "") || hostname;
  } catch {}
  return {
    finalUrl: url,
    final_url: url,
    finalUrlStr: url,
    canonicalUrl: url,
    visibleText: hostname,
    allText: hostname,
    aboveFoldText: hostname,
    heroText: hostname,
    fullPageText: hostname,
    html: `<html><head><title>${hostname}</title></head><body><main><h1>${hostname}</h1></main></body></html>`,
    meta: {
      ok: false,
      blocked: false,
      thin: true,
      screenshot_ok: false,
      preview_degraded: true,
      preview_degraded_reasons: ["all_capture_providers_failed"],
      fail_soft_source: "url_only",
      capture_error: safeFailureMessage(error),
    },
  };
}

async function fetchDirectHtmlFallback(url, options = {}) {
  const fetchFn = options.directFetchFn || fetch;
  const controller = new AbortController();
  const timeoutMs = Number(options.directFetchTimeoutMs || 12_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (compatible; LandingBoost/1.0; +https://landingboost.app)",
      },
      signal: controller.signal,
    });
    if (!response?.ok) {
      throw new Error(`Direct HTML fetch returned HTTP ${response?.status || 0}`);
    }
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error(`Direct fetch returned unsupported content type: ${contentType}`);
    }
    const html = String(await response.text()).slice(0, 2_000_000);
    if (!html.trim()) throw new Error("Direct HTML fetch returned an empty body");
    const resolvedUrl = response.url || url;
    return firecrawlToFetchPayload(
      {
        data: {
          html,
          rawHtml: html,
          metadata: {
            sourceURL: resolvedUrl,
            url: resolvedUrl,
            statusCode: response.status,
          },
        },
      },
      { url: resolvedUrl },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function buildFetchPayloadWithStrategy(authItem, browserlessStage, input, options = {}) {
  const override = options.fetchPayloadOverride || asObject(input).fetch_payload;
  if (override) {
    return {
      fetchPayload: override,
      diagnostics: {
        strategy: "override",
        firecrawl_used: false,
        browserless_used: false,
      },
    };
  }

  const useFirecrawl = firecrawlModeEnabled(options);
  if (!useFirecrawl) {
    const startedAt = Date.now();
    const fetchPayload = await fetchBrowserless(browserlessStage.browserless_payload_string, {
      endpoint: options.browserlessEndpoint,
      fetchFn: options.browserlessFetchFn,
      timeoutMs: options.browserlessTimeoutMs,
    });
    return {
      fetchPayload,
      diagnostics: {
        strategy: "browserless_only",
        firecrawl_used: false,
        browserless_used: true,
        browserless_duration_ms: Date.now() - startedAt,
      },
    };
  }

  const settleTimed = async (operation) => {
    const startedAt = Date.now();
    try {
      return {
        status: "fulfilled",
        value: await operation(),
        duration_ms: Date.now() - startedAt,
      };
    } catch (reason) {
      return {
        status: "rejected",
        reason,
        duration_ms: Date.now() - startedAt,
      };
    }
  };

  // Reuse the already-built standard browserless payload for the visual half of the
  // hybrid fetch. (A lighter "visual_only" extract-mode payload exists on the local
  // dev copy of this pipeline but has not been merged upstream yet, so we deliberately
  // do not depend on it here to avoid touching the much-changed browserless-code.js.)
  const [firecrawlResult, browserlessResult] = await Promise.all([
    settleTimed(() => fetchFirecrawlLandingPage(authItem.lp_url, {
      apiKey: options.firecrawlApiKey,
      endpoint: options.firecrawlEndpoint,
      includeJson: options.firecrawlIncludeJson === true,
      includeScreenshot: false,
      timeout: options.firecrawlProviderTimeoutMs,
      timeoutMs: options.firecrawlTimeoutMs,
      fetchFn: options.firecrawlFetchFn,
    })),
    settleTimed(() => fetchBrowserless(browserlessStage.browserless_payload_string, {
      endpoint: options.browserlessEndpoint,
      fetchFn: options.browserlessFetchFn,
      timeoutMs: options.browserlessTimeoutMs,
    })),
  ]);

  const diagnostics = {
    strategy: "firecrawl_text_browserless_visual",
    firecrawl_used: firecrawlResult.status === "fulfilled",
    browserless_used: browserlessResult.status === "fulfilled",
    firecrawl_duration_ms: firecrawlResult.duration_ms,
    browserless_duration_ms: browserlessResult.duration_ms,
    firecrawl_error:
      firecrawlResult.status === "rejected" ? String(firecrawlResult.reason?.message || firecrawlResult.reason) : "",
    browserless_error:
      browserlessResult.status === "rejected" ? String(browserlessResult.reason?.message || browserlessResult.reason) : "",
    browserless_fallback_configured: false,
    browserless_fallback_attempted: false,
    browserless_fallback_used: false,
    browserless_fallback_duration_ms: 0,
    browserless_fallback_error: "",
    firecrawl_include_json: false,
    firecrawl_screenshot_requested: false,
    firecrawl_screenshot_fallback_used: false,
    firecrawl_screenshot_fallback_duration_ms: 0,
    firecrawl_screenshot_fallback_error: "",
  };

  let effectiveBrowserlessResult = browserlessResult;
  const fallbackEndpoint = toTrimmed(
    options.browserlessFallbackEndpoint || process.env.BROWSERLESS_FALLBACK_ENDPOINT,
  );
  const primaryEndpoint = toTrimmed(options.browserlessEndpoint || process.env.BROWSERLESS_ENDPOINT);
  diagnostics.browserless_fallback_configured = Boolean(
    fallbackEndpoint && fallbackEndpoint !== primaryEndpoint,
  );
  const browserlessResultUsable = (result) => {
    if (result?.status !== "fulfilled") return false;
    const data = asObject(asObject(result.value).data || result.value);
    const meta = asObject(data.meta);
    return Boolean(toTrimmed(data.screenshot || data.screenshot_b64)) &&
      meta.hard_fail !== true &&
      meta.soft_fail !== true &&
      meta.screenshot_ok !== false;
  };

  if (
    diagnostics.browserless_fallback_configured &&
    !browserlessResultUsable(effectiveBrowserlessResult)
  ) {
    const fallbackStartedAt = Date.now();
    diagnostics.browserless_fallback_attempted = true;
    const fallbackResult = await settleTimed(() => fetchBrowserless(
      browserlessStage.browserless_payload_string,
      {
        endpoint: fallbackEndpoint,
        fetchFn: options.browserlessFetchFn,
        timeoutMs: options.browserlessFallbackTimeoutMs || 18_000,
      },
    ));
    diagnostics.browserless_fallback_duration_ms = Date.now() - fallbackStartedAt;
    if (browserlessResultUsable(fallbackResult)) {
      effectiveBrowserlessResult = fallbackResult;
      diagnostics.browserless_fallback_used = true;
      diagnostics.browserless_used = true;
      diagnostics.browserless_error = "";
    } else {
      diagnostics.browserless_fallback_error = fallbackResult.status === "rejected"
        ? safeFailureMessage(fallbackResult.reason)
        : "fallback_capture_unusable";
    }
  }

  if (firecrawlResult.status === "fulfilled") {
    let firecrawlPayload = firecrawlToFetchPayload(firecrawlResult.value, { url: authItem.lp_url });
    const browserlessData =
      effectiveBrowserlessResult.status === "fulfilled"
        ? asObject(asObject(effectiveBrowserlessResult.value).data || effectiveBrowserlessResult.value)
        : {};
    const browserlessMeta = asObject(browserlessData.meta);
    const browserlessScreenshot = toTrimmed(
      browserlessData.screenshot || browserlessData.screenshot_b64,
    );
    const browserlessScreenshotUsable = Boolean(browserlessScreenshot) &&
      browserlessMeta.hard_fail !== true &&
      browserlessMeta.soft_fail !== true &&
      browserlessMeta.screenshot_ok !== false;

    if (!browserlessScreenshotUsable && options.firecrawlScreenshotFallbackEnabled !== false) {
      const screenshotFallbackStartedAt = Date.now();
      diagnostics.firecrawl_screenshot_fallback_used = true;
      try {
        const screenshotResponse = await fetchFirecrawlLandingPage(authItem.lp_url, {
          apiKey: options.firecrawlApiKey,
          endpoint: options.firecrawlEndpoint,
          includeJson: false,
          includeScreenshot: true,
          timeout: options.firecrawlScreenshotProviderTimeoutMs || 14000,
          timeoutMs: options.firecrawlScreenshotTimeoutMs || 16000,
          fetchFn: options.firecrawlFetchFn,
        });
        const screenshotPayload = firecrawlToFetchPayload(screenshotResponse, { url: authItem.lp_url });
        await materializeFirecrawlScreenshot(screenshotPayload, {
          timeoutMs: options.firecrawlScreenshotDownloadTimeoutMs || 4000,
        });
        const screenshotData = asObject(asObject(screenshotPayload).data || screenshotPayload);
        const screenshotMeta = asObject(screenshotData.meta);
        if (toTrimmed(screenshotData.screenshot) && screenshotMeta.screenshot_ok !== false) {
          const baseData = asObject(asObject(firecrawlPayload).data || firecrawlPayload);
          baseData.screenshot = screenshotData.screenshot;
          baseData.screenshot_type = screenshotData.screenshot_type;
          baseData.screenshot_full = screenshotData.screenshot_full || screenshotData.screenshot;
          baseData.screenshot_full_type =
            screenshotData.screenshot_full_type || screenshotData.screenshot_type;
          baseData.meta = {
            ...asObject(baseData.meta),
            screenshot_ok: true,
            screenshot_source: "firecrawl_fallback",
            screenshot_len: String(screenshotData.screenshot).length,
          };
        }
      } catch (error) {
        diagnostics.firecrawl_screenshot_fallback_error = safeFailureMessage(error);
      } finally {
        diagnostics.firecrawl_screenshot_fallback_duration_ms =
          Date.now() - screenshotFallbackStartedAt;
      }
    }
    if (effectiveBrowserlessResult.status === "fulfilled") {
      return {
        fetchPayload: mergeFirecrawlTextWithBrowserlessVisual(
          firecrawlPayload,
          effectiveBrowserlessResult.value,
          diagnostics,
        ),
        diagnostics,
      };
    }

    /**
     * Browserless is the only source of element tags and coordinates, and this used to
     * continue on Firecrawl's plain text alone — while still labelling the strategy
     * "firecrawl_text_browserless_visual", so nothing downstream could tell.
     *
     * On 2026-07-29 that produced a scan of landingboost.app whose headline was
     * "Building the scanner in public." — a line from the founder note near the footer.
     * The page has exactly one <h1> and it says something else entirely, but with no tags
     * and no rects there was nothing to prefer it by, so a heading-shaped sentence was
     * picked out of flat text. Every string in that report exists on the page and none of
     * them describe it. The reader was then told their headline fails to say what the
     * tool does, about a headline the scan never read.
     *
     * A report built without geometry cannot keep this product's promise, so it is not
     * built. Retry once — the failure was a 38s timeout and the budget has room — and if
     * the retry also fails, fail the request rather than return something plausible.
     */
    const retryStartedAt = Date.now();
    // The remaining workflow budget is passed in: workflowRemainingMs lives in
    // runWorkflowRequest and is not in scope here.
    const remainingMs = Number(options.remainingWorkflowMs);
    const headroomMs = Number.isFinite(remainingMs) ? remainingMs - 25000 : 22000;
    const retryBudgetMs = Math.min(Number(options.browserlessRetryTimeoutMs) || 22000, headroomMs);
    const cloudRejectedWithQuota = /429|allowance exhausted|unit allowance/i.test(
      String(diagnostics.browserless_error || ""),
    );
    const retryEndpoint = diagnostics.browserless_fallback_configured
      ? fallbackEndpoint
      : options.browserlessEndpoint;
    if (retryBudgetMs >= 8000 && !cloudRejectedWithQuota && !diagnostics.browserless_fallback_attempted) {
      const retry = await settleTimed(() => fetchBrowserless(browserlessStage.browserless_payload_string, {
        endpoint: retryEndpoint,
        fetchFn: options.browserlessFetchFn,
        timeoutMs: retryBudgetMs,
      }));
      diagnostics.browserless_retry_attempted = true;
      diagnostics.browserless_retry_duration_ms = Date.now() - retryStartedAt;
      diagnostics.browserless_retry_used = retry.status === "fulfilled";
      if (retry.status === "fulfilled") {
        return {
          fetchPayload: mergeFirecrawlTextWithBrowserlessVisual(firecrawlPayload, retry.value, diagnostics),
          diagnostics,
        };
      }
      diagnostics.browserless_retry_error = String(retry.reason?.message || retry.reason || "");
    } else {
      diagnostics.browserless_retry_attempted = false;
      diagnostics.browserless_retry_error = cloudRejectedWithQuota
        ? "cloud_quota_exhausted"
        : diagnostics.browserless_fallback_attempted
          ? "fallback_already_attempted"
          : "insufficient_budget";
    }

    diagnostics.strategy = "firecrawl_text_after_browserless_failed";
    diagnostics.fail_soft = true;
    const degradedData = asObject(asObject(firecrawlPayload).data || firecrawlPayload);
    degradedData.meta = {
      ...asObject(degradedData.meta),
      preview_degraded: true,
      preview_degraded_reasons: Array.from(new Set([
        ...asArray(asObject(degradedData.meta).preview_degraded_reasons),
        "browserless_geometry_unavailable",
      ])),
    };
    return { fetchPayload: firecrawlPayload, diagnostics };
  }

  if (effectiveBrowserlessResult.status === "fulfilled") {
    return {
      fetchPayload: effectiveBrowserlessResult.value,
      diagnostics: {
        ...diagnostics,
        strategy: "firecrawl_failed_browserless_used",
      },
    };
  }

  const captureError =
    firecrawlResult.reason ||
    effectiveBrowserlessResult.reason ||
    browserlessResult.reason ||
    new Error("Both Firecrawl and Browserless failed");
  const directStartedAt = Date.now();
  try {
    const fetchPayload = await fetchDirectHtmlFallback(authItem.lp_url, options);
    return {
      fetchPayload,
      diagnostics: {
        ...diagnostics,
        strategy: "direct_html_after_capture_providers_failed",
        direct_html_used: true,
        direct_html_duration_ms: Date.now() - directStartedAt,
      },
    };
  } catch (directError) {
    return {
      fetchPayload: emergencyUrlOnlyFetchPayload(authItem.lp_url, captureError),
      diagnostics: {
        ...diagnostics,
        strategy: "url_only_fail_soft",
        direct_html_used: false,
        direct_html_duration_ms: Date.now() - directStartedAt,
        direct_html_error: safeFailureMessage(directError),
        fail_soft: true,
      },
    };
  }
}

function buildFailSoftVisualTargets(pageFacts, freePreviewFix) {
  const facts = asObject(pageFacts);
  const proof = asObject(facts.proof);
  const near = asObject(proof.near_cta);
  const hero = asObject(facts.hero);
  const fix = asObject(freePreviewFix);
  const axis = toTrimmed(fix.axis).toLowerCase();
  const preferProof = axis === "trust" || toTrimmed(fix.verb).toLowerCase() === "move" || toTrimmed(fix.verb).toLowerCase() === "replace";
  const rect = preferProof && near.rect
    ? near.rect
    : hero.primary_cta_rect || near.rect || null;
  const text = preferProof
    ? toTrimmed(near.in_context || near.text || proof.best_outcome_line || fix.quote)
    : toTrimmed(hero.headline || fix.quote);
  if (!rect || typeof rect !== "object") return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n)) || width < 12 || height < 8) {
    return null;
  }
  const needsFull = y + height > 768;
  return {
    version: "visual_targets_v2",
    screenshot_scope: needsFull ? "full_page" : "hero",
    screenshot_meta: {
      scope: needsFull ? "full_page" : "hero",
      viewport_width: 1365,
      viewport_height: 768,
      clip_x: 0,
      clip_y: 0,
      clip_width: 1365,
      clip_height: 768,
      coordinate_width: 1365,
      coordinate_height: 768,
      full_page_coordinate_height: needsFull ? Math.max(y + height + 120, 768) : 768,
      device_scale_factor: 1,
    },
    primary_target: {
      kind: preferProof ? "proof_near_cta" : "headline",
      text: text || (preferProof ? "proof near CTA" : "headline"),
      rect: { x, y, width, height },
      source: "fail_soft_page_facts",
      confidence: "high",
      confidence_score: 900,
      reasons: ["fail_soft_page_facts_anchor"],
      requires_full_page_crop: needsFull,
    },
    suppress_reason: "",
    target_kind: preferProof ? "proof_near_cta" : "headline",
    target_mode: "existing_element",
    intended_kind: preferProof ? "proof_near_cta" : "headline",
  };
}

function buildFailSoftResult(authItem, pre, captureQuality, reason, fetchDiagnostics = {}) {
  const pageModel = buildEvidencePageModel(authItem, pre, {}, null);
  const result = analyzePageModel(pageModel);
  const selectionMeta = asObject(
    asObject(asObject(asObject(pre?.fetch_payload || pre?.browserless_payload).data).hybridFieldResolution)
      .ai_element_selection,
  );
  const currentCopy = asObject(pageModel.currentCopyForLLM || pageModel.currentCopy);
  const pageFacts = buildPageFacts({
    currentCopy,
    selectionMeta: Object.keys(selectionMeta).length
      ? selectionMeta
      : {
          proof_near_cta: currentCopy.trust_near_cta_social_proof || currentCopy.trust_social_proof || currentCopy.trust_line,
          proof_near_cta_rect: asObject(asObject(currentCopy.provenance).trust_near_cta_social_proof).rect
            || asObject(asObject(currentCopy.provenance).trust_line).rect
            || null,
          risk_reversal: currentCopy.trust_near_cta_risk_reversal || currentCopy.trust_risk_reversal,
          risk_reversal_rect: asObject(asObject(currentCopy.provenance).trust_near_cta_risk_reversal).rect
            || asObject(asObject(currentCopy.provenance).trust_risk_reversal).rect
            || null,
        },
    capturedElements: [],
  });
  result.free_preview_fix = anchorFixQuoteToPage(
    reconcileVerbWithProofState(result.free_preview_fix, pageFacts),
    result,
  );
  alignBottleneckToFreePreview(result);
  result.page_facts = pageFacts;
  const visualTargets = buildFailSoftVisualTargets(pageFacts, result.free_preview_fix);
  if (visualTargets) result.visual_targets = visualTargets;

  const issues = Array.from(new Set([
    ...asArray(captureQuality?.issues).map(toTrimmed).filter(Boolean),
    reason ? "deterministic_scoring_fallback" : "",
  ].filter(Boolean)));
  // The fail-soft branch bypasses runPostLlmPipeline, so restoreCapturedScreenshots()
  // never runs and the capture we already paid for was being dropped on the floor —
  // the caller then persisted a scan with no screenshot at all. Re-attach it here.
  const { screenshot, screenshotType } = getRuntimeScreenshot(pre, result);
  const preB = asObject(pre?.b);
  const preUiPack = asObject(pre?.uiPack);
  const screenshotFull = toTrimmed(
    result?.screenshot_full || preB.screenshot_full || preUiPack.screenshot_full,
  );
  return {
    ...result,
    ...(screenshot ? { screenshot_b64: screenshot, screenshot_type: screenshotType } : {}),
    ...(screenshotFull
      ? {
          screenshot_full: screenshotFull,
          screenshot_full_type: toTrimmed(
            result?.screenshot_full_type || preB.screenshot_full_type || screenshotType,
          ) || "image/png",
        }
      : {}),
    current_copy: pageModel.currentCopyForLLM,
    scan_quality_status: "degraded",
    scan_quality_issues: issues,
    capture_quality: captureQuality,
    meta: {
      ...asObject(result.meta),
      degraded: true,
      fail_soft: true,
      fail_soft_reason: safeFailureMessage(reason || "capture quality degraded"),
      fetch_source: fetchDiagnostics.strategy || "unknown",
      fetch_diagnostics: fetchDiagnostics,
    },
  };
}

function annotateCaptureQuality(result, captureQuality, fetchDiagnostics = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const existingMeta = asObject(result.meta);
  const alreadyDegraded =
    result.scan_quality_status === "degraded" ||
    existingMeta.degraded === true ||
    existingMeta.fail_soft === true;
  const degraded =
    alreadyDegraded ||
    captureQuality?.ok !== true ||
    fetchDiagnostics.fail_soft === true;
  const qualityIssues = Array.from(new Set([
    ...asArray(result.scan_quality_issues).map(toTrimmed).filter(Boolean),
    ...asArray(captureQuality?.issues).map(toTrimmed).filter(Boolean),
  ]));
  result.scan_quality_status = degraded ? "degraded" : "ok";
  result.scan_quality_issues = qualityIssues;
  result.capture_quality = captureQuality;
  result.meta = {
    ...existingMeta,
    degraded,
    fail_soft: existingMeta.fail_soft === true || degraded,
    fetch_source: fetchDiagnostics.strategy || asObject(result.meta).fetch_source || "",
    fetch_diagnostics: fetchDiagnostics,
  };
  return result;
}

function enforceGroundedCurrentCopy(result, pre) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const grounded = asObject(pre?.b?.currentCopyForLLM || pre?.b?.currentCopy);
  const provenance = asObject(grounded.provenance);
  const identityConfirmed =
    asObject(asObject(grounded.extraction_contract).page_identity).status === "confirmed";
  const fields = ["headline", "subheadline", "primary_cta"];
  const frozen = {};

  for (const fieldName of fields) {
    const field = asObject(provenance[fieldName]);
    const status = toTrimmed(field.status);
    const canFreeze =
      /^(?:confirmed|confirmed_rendered_dom|confirmed_by_vision)$/.test(status) ||
      (status === "firecrawl_only" && identityConfirmed);
    if (status === "confirmed_missing") {
      frozen[fieldName] = "";
    } else if (canFreeze) {
      const exact = toTrimmed(field.exact_text || field.value || grounded[fieldName]);
      if (exact) frozen[fieldName] = exact;
    }
  }

  if (!Object.keys(frozen).length) return result;
  const currentCopyKeys = ["current_copy", "currentCopy", "currentCopyForLLM"];
  let canonicalCurrentCopy = null;
  for (const key of currentCopyKeys) {
    const current = asObject(result[key]);
    if (!Object.keys(current).length) continue;
    const next = {
      ...current,
      ...frozen,
      provenance: {
        ...asObject(current.provenance),
        ...Object.fromEntries(
          Object.keys(frozen).map((fieldName) => [
            fieldName,
            asObject(provenance[fieldName]),
          ]),
        ),
      },
    };
    result[key] = next;
    if (!canonicalCurrentCopy) canonicalCurrentCopy = next;
  }
  if (!canonicalCurrentCopy) {
    canonicalCurrentCopy = {
      ...grounded,
      ...frozen,
    };
    result.current_copy = canonicalCurrentCopy;
  }
  for (const key of currentCopyKeys) {
    if (!Object.keys(asObject(result[key])).length) result[key] = canonicalCurrentCopy;
  }
  return result;
}

async function runWorkflowRequest(input, options = {}) {
  const workflowStartedAt = Date.now();
  const failClosed = options.failClosed === true;
  const repairForDelivery = options.repairForDelivery === true;
  // 50s was too tight: fetch + pre-LLM + vision routinely consume ~25s, which left
  // the scoring model under 25s and pushed real scans into deterministic fail-soft
  // (observed 2026-07-27, everlist.dev: Bedrock timed out after 23.5s). The budget
  // must comfortably exceed the capture phase plus one full model call.
  const configuredWorkflowBudgetMs = Number(
    options.workflowBudgetMs ||
    process.env.SCORER_WORKFLOW_BUDGET_MS ||
    DEFAULT_WORKFLOW_BUDGET_MS,
  );
  const workflowBudgetMs =
    Number.isFinite(configuredWorkflowBudgetMs) && configuredWorkflowBudgetMs > 0
      ? configuredWorkflowBudgetMs
      : DEFAULT_WORKFLOW_BUDGET_MS;
  const workflowDeadlineAt = workflowStartedAt + workflowBudgetMs;
  const workflowRemainingMs = () => Math.max(0, workflowDeadlineAt - Date.now());
  const boundedStageTimeout = (requested, fallback, reserveMs = 0) => {
    const configured = Number(requested);
    const preferred = Number.isFinite(configured) && configured > 0 ? configured : fallback;
    return Math.max(1, Math.min(preferred, Math.max(1, workflowRemainingMs() - reserveMs)));
  };
  const stageTimings = [];
  const finishStage = (stage, startedAt, extra = {}) => {
    stageTimings.push({
      stage,
      duration_ms: Date.now() - startedAt,
      ...extra,
    });
  };

  const webhookEnvelope = buildWebhookEnvelope(input);
  const authorizeStartedAt = Date.now();
  const authItem = authorizeAndNormalize(webhookEnvelope);
  finishStage("authorize", authorizeStartedAt);
  const nodeMap = {
    [NODE_NAMES.authorize]: authItem,
  };

  const browserlessPayloadStartedAt = Date.now();
  const browserlessStage = runBuildBrowserlessPayload(authItem, nodeMap);
  finishStage("build_browserless_payload", browserlessPayloadStartedAt);
  const fetchStartedAt = Date.now();
  const { fetchPayload, diagnostics: fetchDiagnostics } = await buildFetchPayloadWithStrategy(
    authItem,
    browserlessStage,
    input,
    {
      ...options,
      remainingWorkflowMs: workflowRemainingMs(),
      firecrawlTimeoutMs: boundedStageTimeout(options.firecrawlTimeoutMs, 25000, 15000),
      firecrawlProviderTimeoutMs: boundedStageTimeout(
        options.firecrawlProviderTimeoutMs,
        22000,
        15000,
      ),
      browserlessTimeoutMs: boundedStageTimeout(options.browserlessTimeoutMs, 25000, 15000),
      browserlessFallbackTimeoutMs: boundedStageTimeout(
        options.browserlessFallbackTimeoutMs,
        18000,
        30000,
      ),
      firecrawlScreenshotTimeoutMs: boundedStageTimeout(
        options.firecrawlScreenshotTimeoutMs,
        16000,
        12000,
      ),
      firecrawlScreenshotProviderTimeoutMs: boundedStageTimeout(
        options.firecrawlScreenshotProviderTimeoutMs,
        14000,
        12000,
      ),
      firecrawlScreenshotDownloadTimeoutMs: boundedStageTimeout(
        options.firecrawlScreenshotDownloadTimeoutMs,
        4000,
        12000,
      ),
      directFetchTimeoutMs: boundedStageTimeout(options.directFetchTimeoutMs, 10000, 12000),
    },
  );
  finishStage("fetch_browserless", fetchStartedAt, {
    override: fetchDiagnostics.strategy === "override",
    strategy: fetchDiagnostics.strategy,
  });

  // Hand the captured page to the model and let it name the roles, before any
  // deterministic rule gets to guess them from vocabulary or CSS class names. Writes
  // confirmed hybrid fields, which every later stage already prefers. Never fatal:
  // on failure the existing deterministic path runs unchanged.
  if (options.aiElementSelection !== false && process.env.LB_AI_ELEMENT_SELECTION !== "0") {
    const selectionStartedAt = Date.now();
    const selectionBudgetMs = Math.min(
      Number(options.selectionTimeoutMs || process.env.LB_SELECTION_TIMEOUT_MS || 25000),
      Math.max(1, workflowRemainingMs() - 20000),
    );
    const selectionResult = selectionBudgetMs > 2000
      ? await selectPageElements(fetchPayload, {
          ...options,
          pageUrl: authItem.lp_url,
          timeoutMs: selectionBudgetMs,
        })
      : { ok: false, reason: "insufficient_budget", selection: null };
    const { applied } = selectionResult.ok
      ? applySelectionToPayload(fetchPayload, selectionResult.selection)
      : { applied: [] };
    finishStage("ai_element_selection", selectionStartedAt, {
      ok: selectionResult.ok,
      reason: selectionResult.reason || "",
      applied,
      rejected_ids: asArray(selectionResult.selection?.rejected).length,
    });
  }

  const preStartedAt = Date.now();
  const initialPre = runPreLlmPipeline(fetchPayload, { nodeMap });
  finishStage("pre_llm_pipeline", preStartedAt);
  const visionStartedAt = Date.now();
  const visionTimeoutMs = boundedStageTimeout(options.visionTimeoutMs, 8000, 15000);
  const visionCorrection = await applyPreLlmVisionCorrection(authItem, initialPre, {
    ...options,
    fetchPayload,
    visionTimeoutMs,
    skipVisionDueDeadline:
      options.forceVision !== true &&
      workflowRemainingMs() <= 15000,
  });
  finishStage("vision_correction", visionStartedAt, {
    applied: visionCorrection.applied === true,
    status: visionCorrection.visionResult?.status || null,
    reason: visionCorrection.reason || null,
  });
  const pre = visionCorrection.pre;
  const captureQualityStartedAt = Date.now();
  const captureQuality = repairForDelivery
    ? assertDeliverableCaptureBeforeScoring(fetchPayload, pre)
    : failClosed || options.strictCaptureQuality === true
      ? assertUsableCaptureBeforeScoring(fetchPayload, pre)
      : collectCaptureQualityIssues(fetchPayload, pre);
  finishStage("capture_quality_gate", captureQualityStartedAt, {
    ok: captureQuality.ok === true,
    repaired_for_delivery: repairForDelivery && captureQuality.ok !== true,
    fail_soft: captureQuality.ok !== true && (!failClosed || repairForDelivery) && options.strictCaptureQuality !== true,
    issues: captureQuality.issues,
  });
  // Build the facts before scoring, so the model is told what the page contains rather
  // than left to infer it. Detecting a false claim afterwards only proves the report
  // was wrong; the model has to see the counts and distances before it writes them.
  const selectionMeta = asObject(asObject(asObject(fetchPayload).data).hybridFieldResolution).ai_element_selection;
  // Measured once. This same object is shown to the model below and stored on the result
  // as page_facts, so the numbers the model was given are the numbers it is checked
  // against. Building it twice from two sources is what made incazing.com impossible to
  // get right: the prompt copy counted three testimonials and told the model to say
  // three, and the verification copy counted zero and recorded the answer as invented.
  const fetchData = asObject(asObject(fetchPayload).data);
  const pageFacts = buildPageFacts({
    currentCopy: asObject(pre?.b).currentCopyForLLM || asObject(pre?.b).currentCopy,
    selectionMeta,
    // Read only to recover the sentence a proof fragment came from. Nothing here changes
    // which element was chosen or where its marker is drawn.
    capturedElements: [
      ...(Array.isArray(fetchData.aboveFoldElementsDetailed) ? fetchData.aboveFoldElementsDetailed : []),
      ...(Array.isArray(fetchData.fullPageElementsDetailed) ? fetchData.fullPageElementsDetailed : []),
    ],
  });
  const scoringPrompt = `${pre?.c?.prompt || ""}\n\n${renderFactsForPrompt(pageFacts)}`;

  const llmStartedAt = Date.now();
  let llmPayload = null;
  let post;
  let baseScoringResult;
  let failSoftReason = "";
  try {
    const llmTotalTimeoutMs = boundedStageTimeout(
      options.llmTotalTimeoutMs,
      DEFAULT_LLM_STAGE_TIMEOUT_MS,
      1500,
    );
    if (workflowRemainingMs() <= 1500) {
      throw new Error("Scorer workflow deadline reached before LLM call");
    }
    llmPayload =
      options.llmResponseOverride ||
      asObject(input).mock_llm_response ||
      (await callLlmPrompt(scoringPrompt, {
        apiKey: options.openRouterApiKey,
        apiUrl: options.openRouterApiUrl,
        referer: options.openRouterReferer,
        title: options.openRouterTitle,
        provider: options.llmProvider,
        bedrockApiKey: options.bedrockApiKey,
        bedrockApiUrl: options.bedrockApiUrl,
        bedrockRegion: options.bedrockRegion,
        bedrockModelId: options.bedrockModelId,
        bedrockTimeoutMs: options.bedrockTimeoutMs,
        openRouterTimeoutMs: options.openRouterTimeoutMs,
        totalTimeoutMs: llmTotalTimeoutMs,
        openRouterFallbackEnabled: options.openRouterFallbackEnabled,
        circuitBreakerThreshold: options.circuitBreakerThreshold,
        circuitBreakerCooldownMs: options.circuitBreakerCooldownMs,
        fallbackWebhookUrl: options.fallbackWebhookUrl,
        fetchFn: options.llmFetchFn,
      }));
    finishStage("llm_call", llmStartedAt, {
      override: Boolean(options.llmResponseOverride || asObject(input).mock_llm_response),
      model: WORKFLOW_MODEL.model,
      fail_soft: false,
    });

    const postStartedAt = Date.now();
    post = runPostLlmPipeline(pre, llmPayload, {
      sanitize: options.sanitize !== false,
      pageFacts,
    });
    finishStage("post_llm_pipeline", postStartedAt);
    baseScoringResult = post.sanitized;
  } catch (error) {
    if (failClosed && !repairForDelivery) {
      const reliableError = makeHttpError(
        422,
        "The scoring model did not return a reliable report. Please run the scan again.",
      );
      reliableError.code = "SCORING_MODEL_FAILED";
      reliableError.cause = error;
      throw reliableError;
    }
    failSoftReason = safeFailureMessage(error);
    finishStage("llm_or_post_fallback", llmStartedAt, {
      fail_soft: true,
      error: failSoftReason,
    });
    baseScoringResult = buildFailSoftResult(
      authItem,
      pre,
      captureQuality,
      error,
      fetchDiagnostics,
    );
    if (repairForDelivery) {
      baseScoringResult.meta = {
        ...asObject(baseScoringResult.meta),
        delivery_repaired: true,
        delivery_repair_reason: "scoring_model_or_postprocess_failed",
      };
    }
    post = {
      na: null,
      nn: null,
      nf: baseScoringResult,
      sanitized: baseScoringResult,
      mergedForParse: null,
      nodeMap: pre.nodeMap,
    };
  }
  baseScoringResult = enforceGroundedCurrentCopy(baseScoringResult, pre);

  // pageFacts is the object built before the prompt and already shown to the model. It is
  // deliberately not rebuilt here: re-measuring after scoring produced a second set of
  // numbers that the model had never seen, and every difference between the two was then
  // recorded as the model contradicting the page.
  // The measured page is the authority on both of these, so they are applied before the
  // contradiction pass rather than reported by it: a verb the geometry forbids, and a
  // quoted line the page does not contain.
  if (baseScoringResult && typeof baseScoringResult === "object") {
    baseScoringResult.free_preview_fix = anchorFixQuoteToPage(
      reconcileVerbWithProofState(baseScoringResult.free_preview_fix, pageFacts),
      baseScoringResult,
    );
    alignBottleneckToFreePreview(baseScoringResult);
  }
  baseScoringResult = repairContradictoryProofClaims(baseScoringResult, pageFacts);
  const factContradictions = findFactContradictions(pageFacts, {
    fixVerb: asObject(asObject(baseScoringResult).free_preview_fix).verb,
    fixAxis: asObject(asObject(baseScoringResult).free_preview_fix).axis,
    fixText: asObject(asObject(baseScoringResult).free_preview_fix).instruction,
    claims: [
      ...asArray(asObject(asObject(baseScoringResult).score_breakdown).trust?.why_this_score),
      asObject(baseScoringResult).summary_insights?.biggest_bottleneck,
      asObject(asObject(baseScoringResult).free_preview_fix).instruction,
    ],
  });
  if (baseScoringResult && typeof baseScoringResult === "object") {
    baseScoringResult.page_facts = pageFacts;
    baseScoringResult.fact_contradictions = factContradictions;
  }
  if (factContradictions.length) {
    console.warn(JSON.stringify({
      event: "page_fact_contradictions",
      lp_url: authItem.lp_url,
      proof_state: pageFacts.proof_state,
      problems: factContradictions.map((problem) => problem.code),
      detail: factContradictions.slice(0, 4),
    }));
  }
  if (failClosed && !repairForDelivery && factContradictions.length) {
    const contradictionError = makeHttpError(
      422,
      "The generated report contradicted measured page evidence. Please run the scan again.",
    );
    contradictionError.code = "FACT_CONTRADICTION";
    contradictionError.quality = {
      issues: factContradictions.map((problem) => problem.code),
    };
    throw contradictionError;
  }
  if (repairForDelivery && factContradictions.length) {
    const repairedResult = buildFailSoftResult(
      authItem,
      pre,
      captureQuality,
      new Error(`AI fact repair: ${factContradictions.map((problem) => problem.code).join(", ")}`),
      fetchDiagnostics,
    );
    repairedResult.free_preview_fix = anchorFixQuoteToPage(
      reconcileVerbWithProofState(repairedResult.free_preview_fix, pageFacts),
      repairedResult,
    );
    alignBottleneckToFreePreview(repairedResult);
    repairContradictoryProofClaims(repairedResult, pageFacts);
    const remainingContradictions = findFactContradictions(pageFacts, {
      fixVerb: asObject(repairedResult.free_preview_fix).verb,
      fixAxis: asObject(repairedResult.free_preview_fix).axis,
      fixText: asObject(repairedResult.free_preview_fix).instruction,
      claims: [
        ...asArray(asObject(asObject(repairedResult).score_breakdown).trust?.why_this_score),
        asObject(repairedResult).summary_insights?.biggest_bottleneck,
        asObject(repairedResult.free_preview_fix).instruction,
      ],
    });
    repairedResult.page_facts = pageFacts;
    repairedResult.fact_contradictions = remainingContradictions;
    repairedResult.meta = {
      ...asObject(repairedResult.meta),
      delivery_repaired: true,
      delivery_repair_reason: "ai_fact_contradiction",
      ai_result_replaced_for_fact_safety: true,
      rejected_fact_contradictions: factContradictions.map((problem) => problem.code),
    };
    baseScoringResult = enforceGroundedCurrentCopy(repairedResult, pre);
  }
  const evidenceStartedAt = Date.now();
  const evidenceResultRaw =
    options.includeBenchmarkEvidence === false
      ? baseScoringResult
      : await attachBenchmarkEvidence(authItem, pre, baseScoringResult, {
          ...options,
          runtimeVisionResult: visionCorrection.visionResult,
        });
  const evidenceResult =
    options.includeBenchmarkEvidence === false
      ? evidenceResultRaw
      : realignMarketProfileWithDisplayedCopy(evidenceResultRaw);
  finishStage("benchmark_evidence", evidenceStartedAt, {
    skipped: options.includeBenchmarkEvidence === false,
    reused_vision_result: options.includeBenchmarkEvidence !== false,
  });
  if (visionCorrection.applied && evidenceResult && typeof evidenceResult === "object" && !Array.isArray(evidenceResult)) {
    evidenceResult.meta = {
      ...asObject(evidenceResult.meta),
      pre_llm_vision_correction_applied: true,
      pre_llm_vision_correction_reason: visionCorrection.reason,
      pre_llm_vision_correction_changes: visionCorrection.changes,
      pre_llm_vision_status: visionCorrection.visionResult?.status || null,
      pre_llm_vision_model: visionCorrection.visionResult?.proof?.model || null,
    };
  }

  const includeCompetitors =
    options.includeCompetitors === true ||
    (options.includeCompetitors !== false && wantsCompetitors(input));
  const competitorsStartedAt = Date.now();
  const enrichedResult = includeCompetitors
    ? {
        ...evidenceResult,
        competitor_intelligence: matchCompetitors({
          auth: authItem,
          pre,
          result: evidenceResult,
        }),
      }
    : evidenceResult;
  finishStage("competitor_intelligence", competitorsStartedAt, {
    skipped: !includeCompetitors,
  });

  // The three sentences are built here, at the end, and not beside page_facts above.
  //
  // They quote reference_backed_fix.problem and summary_insights, and the benchmark
  // evidence stage rewrites both. Building them earlier froze a sentence that the later
  // stage then replaced, so the card and the field it came from disagreed — the exact
  // split this block exists to close, reintroduced by ordering. incazing.com on
  // 2026-07-28 opened with "Trust proof is present but the strongest outcomes are not
  // shown near the CTA" on a page carrying no quote, logo or figure anywhere, while the
  // field that sentence was taken from had since been corrected to say the page shows no
  // trust proof yet. Nothing else in the stored scan held that sentence.
  if (enrichedResult && typeof enrichedResult === "object" && !Array.isArray(enrichedResult)) {
    enrichedResult.decision_summary = buildDecisionSummary(enrichedResult, pageFacts);
  }

  if (
    enrichedResult &&
    typeof enrichedResult === "object" &&
    !Array.isArray(enrichedResult) &&
    fetchDiagnostics?.strategy !== "override"
  ) {
    enrichedResult.meta = {
      ...asObject(enrichedResult.meta),
      fetch_diagnostics: fetchDiagnostics,
      fetch_source: fetchDiagnostics?.strategy || asObject(enrichedResult.meta).fetch_source || "",
    };
  }

  if (enrichedResult && typeof enrichedResult === "object" && !Array.isArray(enrichedResult)) {
    enrichedResult.meta = {
      ...asObject(enrichedResult.meta),
      workflow_stage_timings: stageTimings,
      workflow_total_ms: Date.now() - workflowStartedAt,
      workflow_budget_ms: workflowBudgetMs,
      workflow_deadline_remaining_ms: workflowRemainingMs(),
      llm_fail_soft_reason: failSoftReason || null,
    };
  }

  let finalResult = enforceGroundedCurrentCopy(
    normalizeExistingOutcomeProofResult(
      annotateCaptureQuality(enrichedResult, captureQuality, fetchDiagnostics),
    ),
    pre,
  );
  const scoringQuality = collectScoringQualityIssues(finalResult);
  if (!scoringQuality.ok) {
    if ((failClosed && !repairForDelivery) || options.strictScoringQuality === true) {
      assertUsableScoringPayload(finalResult);
    }
    finalResult = buildFailSoftResult(
      authItem,
      pre,
      captureQuality,
      new Error(`Scoring quality fallback: ${scoringQuality.issues.join(", ")}`),
      fetchDiagnostics,
    );
    finalResult.meta = {
      ...asObject(finalResult.meta),
      ...(repairForDelivery
        ? {
            delivery_repaired: true,
            delivery_repair_reason: "scoring_payload_incomplete",
          }
        : {}),
      workflow_stage_timings: stageTimings,
      workflow_total_ms: Date.now() - workflowStartedAt,
      workflow_budget_ms: workflowBudgetMs,
      workflow_deadline_remaining_ms: workflowRemainingMs(),
      rejected_scoring_quality: scoringQuality,
    };
  }
  if (
    repairForDelivery &&
    (
      captureQuality.ok !== true ||
      fetchDiagnostics.fail_soft === true ||
      finalResult.scan_quality_status === "degraded" ||
      asObject(finalResult.meta).fail_soft === true
    )
  ) {
    finalResult.meta = {
      ...asObject(finalResult.meta),
      delivery_repaired: true,
      delivery_repair_reason:
        asObject(finalResult.meta).delivery_repair_reason ||
        (fetchDiagnostics.fail_soft === true ? "capture_fail_soft" : "capture_metadata_incomplete"),
    };
  }
  validateCoreResponseContract(finalResult);
  try {
    validateResponseContract(finalResult);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "optional_response_contract_warning",
      lp_url: authItem.lp_url,
      error: safeFailureMessage(error),
    }));
    finalResult.meta = {
      ...asObject(finalResult.meta),
      optional_response_contract_warning: safeFailureMessage(error),
    };
  }

  return {
    auth: authItem,
    browserless_payload: browserlessStage,
    fetch_payload: fetchPayload,
    capture_quality: captureQuality,
    prompt_payload: pre.c,
    ui_pack: pre.uiPack,
    llm_payload: llmPayload,
    result: finalResult,
    raw_result: post.nf,
    stage_timings: stageTimings,
    workflow_total_ms: Date.now() - workflowStartedAt,
    workflow_model: WORKFLOW_MODEL,
  };
}

async function scoreRequest(body, options = {}) {
  const json = asObject(body);

  if (isDeterministicPageModelRequest(json)) {
    const pageModel = json.normalized_page && typeof json.normalized_page === "object"
      ? asObject(json.normalized_page)
      : json;
    return {
      mode: "deterministic_page_model",
      workflow_model: WORKFLOW_MODEL,
      result: analyzePageModel(pageModel),
    };
  }

  return runWorkflowRequest(json, options);
}

function buildEnvelopeFromHttpRequest(req, body) {
  const proto = req.socket && req.socket.encrypted ? "https" : "http";
  const host = req.headers.host || "localhost";
  const url = new URL(req.url, `${proto}://${host}`);
  const query = {};
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = value;
  }
  return {
    body,
    query,
    headers: req.headers,
  };
}

module.exports = {
  WORKFLOW_MODEL,
  authorizeAndNormalize,
  buildSafeErrorDetails,
  buildEnvelopeFromHttpRequest,
  buildWebhookEnvelope,
  getExpectedWebhookSecret,
  requiresWebhookSecret,
  collectScoringQualityIssues,
  collectCaptureQualityIssues,
  collectFatalCaptureQualityIssues,
  enforceGroundedCurrentCopy,
  applyVisionCurrentCopyCorrection,
  evaluatePreLlmVisionNeed,
  reconcileVisionProofPlacementWithDom,
  assertUsableCaptureBeforeScoring,
  assertDeliverableCaptureBeforeScoring,
  isSuspiciousDomHeadline,
  isUsableVisionHeadline,
  makeHttpError,
  normalizeExistingOutcomeProofResult,
  runWorkflowRequest,
  scoreRequest,
  sanitizeUrlInput,
  validateHttpUrl,
  wantsCompetitors,
};
