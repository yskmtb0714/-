import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sanitizeForFree } from "../_shared/sanitize-free.ts";
import { buildReferenceBackedFix } from "../_shared/reference-backed-fix.ts";
import { buildPositioningDiagnosis } from "../_shared/positioning-diagnosis.ts";
import {
  enforceConfirmedProvenanceCopy,
  resolvePageCategory,
} from "../_shared/scan-copy-integrity.ts";
import {
  derivePageValidity,
  deriveCanonicalScanProfile,
  extractDomain,
  getScanMatchProfile,
  querySimilarPages,
  type AuxSignals,
  type MatchedPage,
  type PageValidity,
  type ScanData,
} from "../_shared/similar-pages-query.ts";

// Declare EdgeRuntime for Supabase Edge Functions background tasks
declare const EdgeRuntime: {
  waitUntil: (promise: Promise<any>) => void;
};

function toDataUrl(base64: string | null | undefined, mimeType: string | null | undefined, fallbackMime = "image/jpeg"): string | null {
  if (!base64 || typeof base64 !== "string") return null;
  const trimmed = base64.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:image/")) return trimmed;
  const resolvedType =
    typeof mimeType === "string" && mimeType.trim()
      ? mimeType.trim()
      : fallbackMime;
  return `data:${resolvedType};base64,${trimmed}`;
}

// =============================================================================
// PAGE CATEGORY INFERENCE v2 — intent-based keyword scoring
// =============================================================================

const CATEGORY_VERSION = 2;
const IMPROVEMENT_QUALIFICATION_VERSION = "content-hash-v2-2026-06-11";
const IMPROVEMENT_SCORE_COMPARE_VERSION = `lp-score-category-${CATEGORY_VERSION}`;

interface CategoryResult {
  page_category: string;
  category_version: number;
}

// Phrases get 3× weight to reduce false positives from single generic words
const V2_PHRASES: Record<string, [string, number][]> = {
  saas: [
    ["free trial", 3], ["start free trial", 3], ["project management", 3],
    ["workflow automation", 3], ["api key", 3], ["developer tool", 3],
    ["team collaboration", 3], ["sign up free", 3], ["get started free", 3],
    ["per month", 2], ["per seat", 3], ["14 day trial", 3], ["no credit card", 3],
    ["integrations with", 2], ["connect your", 2], ["sync your", 2],
  ],
  "lead-gen": [
    ["book a call", 3], ["book a demo", 3], ["schedule a call", 3],
    ["schedule a demo", 3], ["get a quote", 3], ["request a quote", 3],
    ["free consultation", 3], ["done for you", 3], ["let us handle", 3],
    ["talk to sales", 3], ["contact us today", 3], ["get in touch", 3],
    ["case study", 2], ["trusted by", 2], ["as seen in", 2],
    ["free assessment", 3], ["free audit", 3], ["grow your business", 2],
  ],
  ecommerce: [
    ["add to cart", 3], ["free shipping", 3], ["buy now", 3],
    ["shop now", 3], ["order now", 3], ["limited edition", 3],
    ["in stock", 3], ["out of stock", 3], ["add to bag", 3],
    ["checkout now", 3], ["money back guarantee", 3], ["free returns", 3],
    ["save up to", 2], ["discount code", 3],
  ],
  content: [
    ["read more", 2], ["subscribe to", 2], ["join the newsletter", 3],
    ["latest articles", 3], ["blog post", 2], ["read the full", 3],
    ["get the guide", 3], ["download the", 2], ["free ebook", 3],
    ["free resource", 3], ["watch the video", 2], ["listen now", 2],
    ["weekly newsletter", 3], ["sign up for updates", 3],
  ],
  "local-business": [
    ["near you", 3], ["visit us", 3], ["open hours", 3],
    ["opening hours", 3], ["walk in", 3], ["our location", 3],
    ["directions to", 3], ["come visit", 3], ["serving the", 2],
    ["locally owned", 3], ["family owned", 3], ["in your area", 3],
    ["book an appointment", 3], ["call us today", 2],
  ],
};

const V2_WORDS: Record<string, [string, number][]> = {
  saas: [
    ["saas", 1.5], ["software", 1], ["dashboard", 1], ["api", 1],
    ["workflow", 1], ["automation", 1], ["subscription", 1], ["workspace", 1],
    ["developer", 1], ["integrations", 1], ["analytics", 1], ["platform", 0.5],
    ["tool", 0.5], ["app", 0.5],
  ],
  "lead-gen": [
    ["agency", 1.5], ["consulting", 1.5], ["freelance", 1], ["retainer", 1.5],
    ["roi", 1], ["leads", 1], ["pipeline", 1], ["outbound", 1],
    ["inbound", 1], ["b2b", 1.5], ["clients", 1], ["prospect", 1],
    ["funnel", 1], ["campaign", 0.5],
  ],
  ecommerce: [
    ["shop", 1.5], ["cart", 1.5], ["product", 1], ["shipping", 1.5],
    ["retail", 1], ["marketplace", 1], ["shopify", 1.5], ["ecommerce", 2],
    ["store", 1], ["price", 0.5], ["catalog", 1.5],
  ],
  content: [
    ["blog", 1.5], ["article", 1], ["podcast", 1.5], ["newsletter", 1.5],
    ["ebook", 1.5], ["guide", 0.5], ["resource", 0.5], ["community", 0.5],
    ["creator", 1], ["subscriber", 1.5], ["content", 0.5],
  ],
  "local-business": [
    ["restaurant", 2], ["clinic", 1.5], ["salon", 2], ["dentist", 2],
    ["gym", 1.5], ["spa", 1.5], ["bakery", 2], ["plumber", 2],
    ["electrician", 2], ["realtor", 1.5], ["attorney", 1.5], ["lawyer", 1.5],
    ["mechanic", 2], ["florist", 2], ["barber", 2], ["veterinarian", 2],
  ],
};

const V2_URL_HINTS: Record<string, [RegExp, number][]> = {
  saas: [[/\.(app|io|dev)$/i, 0.5]],
  ecommerce: [[/(shop|store|buy)/i, 0.5]],
  "local-business": [[/\.(local|town|city)/i, 0.5]],
};

const V2_CTA_SIGNALS: Record<string, [string, number][]> = {
  saas: [["start free trial", 3], ["get started", 2], ["sign up", 1.5], ["try for free", 3], ["create account", 2]],
  "lead-gen": [["book a demo", 3], ["book a call", 3], ["get a quote", 3], ["schedule", 2], ["contact us", 2], ["talk to", 2]],
  ecommerce: [["add to cart", 3], ["buy now", 3], ["shop now", 3], ["order now", 3], ["checkout", 2]],
  content: [["subscribe", 2], ["download", 2], ["read more", 2], ["get the guide", 3], ["join", 1.5]],
  "local-business": [["book appointment", 3], ["call now", 2], ["visit us", 2], ["get directions", 3]],
};

// Priority for tie-breaking (higher = preferred)
const V2_PRIORITY: Record<string, number> = {
  saas: 5, "lead-gen": 4, ecommerce: 3, "local-business": 2, content: 1,
};

function inferPageCategory(
  targetAudience: string | null,
  offerSummary: string | null,
  url: string | null,
  ctaText?: string | null,
): CategoryResult {
  const text = [targetAudience ?? "", offerSummary ?? ""].join(" ").toLowerCase();
  const ctaLower = (ctaText ?? "").toLowerCase();
  let hostname = "";
  try { hostname = new URL(url ?? "").hostname.toLowerCase(); } catch { /* ignore */ }

  const categories = Object.keys(V2_PHRASES);
  const scores: Record<string, number> = {};

  for (const cat of categories) {
    let score = 0;
    // Phrase matches (high weight)
    for (const [phrase, weight] of V2_PHRASES[cat]) {
      if (text.includes(phrase)) score += weight;
    }
    // Word matches (lower weight)
    for (const [word, weight] of V2_WORDS[cat]) {
      const re = new RegExp(`\\b${word}\\b`, "i");
      if (re.test(text)) score += weight;
    }
    // URL hints
    if (V2_URL_HINTS[cat]) {
      for (const [re, weight] of V2_URL_HINTS[cat]) {
        if (re.test(hostname)) score += weight;
      }
    }
    // CTA signals (if available)
    if (ctaLower && V2_CTA_SIGNALS[cat]) {
      for (const [signal, weight] of V2_CTA_SIGNALS[cat]) {
        if (ctaLower.includes(signal)) score += weight;
      }
    }
    scores[cat] = score;
  }

  // Find best
  let bestCat = "other";
  let bestScore = 0;
  for (const cat of categories) {
    if (scores[cat] > bestScore || (scores[cat] === bestScore && (V2_PRIORITY[cat] ?? 0) > (V2_PRIORITY[bestCat] ?? 0))) {
      bestScore = scores[cat];
      bestCat = cat;
    }
  }

  // Lowered threshold from 1.5 to 1.0 for better coverage
  if (bestScore < 1.0) bestCat = "other";

  return { page_category: bestCat, category_version: CATEGORY_VERSION };
}

// =============================================================================
// CONTENT HASH: Detect real page changes vs scoring jitter
// =============================================================================

/**
 * Compute SHA-256 hash of key content fields for change detection.
 * Uses Web Crypto API available in Deno/Edge runtime.
 */
async function computeContentHash(fullResult: any): Promise<string> {
  // Extract key text fields that matter for scoring
  const atf = fullResult?.above_the_fold_fix?.improved_copy ?? {};
  const current = fullResult?.current_copy ?? {};
  
  // Use current_copy (what's on the page) for change detection
  // Fall back to improved_copy if current_copy doesn't exist
  const headline = current.headline ?? atf.headline ?? "";
  const subheadline = current.subheadline ?? atf.subheadline ?? "";
  const primaryCta = current.primary_cta ?? atf.primary_cta ?? "";
  const trustLine = current.trust_line ?? atf.trust_line ?? "";
  
  // Build canonical string (normalized)
  const canonical = [headline, subheadline, primaryCta, trustLine]
    .map(s => (s ?? "").trim().toLowerCase())
    .join("\n---\n");
  
  // Compute SHA-256 using Web Crypto API
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  
  // Convert to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  
  return hashHex;
}

// =============================================================================
// IMPROVEMENT DETECTION SYSTEM
// Computes and stores improvement records when same-URL scans show progress
// =============================================================================

/**
 * Normalize URL for grouping scans of the same landing page.
 * Matches frontend normalizeUrl() from fixKeyUtils.ts
 */
function normalizeUrlForImprovement(url: string): string {
  if (!url || url.trim() === "") return "";
  
  try {
    const parsed = new URL(url.trim());
    const normalizedHost = parsed.host.toLowerCase().replace(/^www\./, "");
    let normalized = `${parsed.protocol}//${normalizedHost}`;
    
    let pathname = parsed.pathname;
    if (pathname !== "/" && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    normalized += pathname;
    
    // Strip tracking params
    const searchParams = new URLSearchParams(parsed.search);
    const trackingParams = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid", "ref"];
    trackingParams.forEach(p => searchParams.delete(p));
    
    const cleanSearch = searchParams.toString();
    if (cleanSearch) {
      normalized += `?${cleanSearch}`;
    }
    
    return normalized;
  } catch {
    return url.trim().replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * Determine weakest axis from scores
 */
function getWeakestAxis(clarity: number, relevance: number, trust: number, action: number): string {
  const axes = [
    { name: "clarity", score: clarity },
    { name: "relevance", score: relevance },
    { name: "trust", score: trust },
    { name: "action", score: action },
  ];
  axes.sort((a, b) => a.score - b.score);
  return axes[0].name;
}

/**
 * Compute magnitude score for ranking improvements
 */
function computeMagnitudeScore(
  overallDelta: number,
  bottleneckShifted: boolean,
  copyChanged: boolean,
  maxAxisDelta: number
): number {
  let score = 0;
  
  // Overall delta (0-40 points)
  score += Math.min(40, Math.max(0, overallDelta * 2));
  
  // Bottleneck shifted (0 or 25 points)
  if (bottleneckShifted) score += 25;
  
  // Copy changed (0 or 20 points)
  if (copyChanged) score += 20;
  
  // Max axis delta (0-15 points)
  score += Math.min(15, Math.max(0, maxAxisDelta));
  
  return Math.min(100, Math.round(score));
}

function stripImprovementVerificationColumns(payload: Record<string, unknown>): Record<string, unknown> {
  const {
    content_hash_before: _contentHashBefore,
    content_hash_after: _contentHashAfter,
    qualification_reason: _qualificationReason,
    qualification_version: _qualificationVersion,
    score_compare_version: _scoreCompareVersion,
    before_score_compare_version: _beforeScoreCompareVersion,
    after_score_compare_version: _afterScoreCompareVersion,
    page_change_verified: _pageChangeVerified,
    positive_movement_verified: _positiveMovementVerified,
    auto_share_eligible: _autoShareEligible,
    ...legacyPayload
  } = payload;
  return legacyPayload;
}

function extractScanScoreCompareVersion(scan: { full_result?: any; category_version?: number | null } | null | undefined): string {
  const fullResult = scan?.full_result && typeof scan.full_result === "object" ? scan.full_result : {};
  const meta = fullResult?.meta && typeof fullResult.meta === "object" ? fullResult.meta : {};
  const direct =
    fullResult?.score_compare_version ??
    fullResult?.improvement_score_compare_version ??
    meta?.score_compare_version ??
    meta?.improvement_score_compare_version;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const categoryVersion = scan?.category_version ?? fullResult?.category_version ?? meta?.category_version;
  if (typeof categoryVersion === "number" && Number.isFinite(categoryVersion)) {
    return `lp-score-category-${categoryVersion}`;
  }
  return "legacy_unknown";
}

/**
 * Classify improvement type
 */
function classifyImprovement(
  overallDelta: number,
  bottleneckShifted: boolean,
  copyChanged: boolean
): string {
  const hasScoreJump = overallDelta >= 10;
  
  if (hasScoreJump && copyChanged) return 'mixed';
  if (hasScoreJump) return 'score_jump';
  if (bottleneckShifted) return 'bottleneck_shift';
  if (copyChanged) return 'copy_improvement';
  return 'mixed';
}

/**
 * Generate insight message from deltas
 */
function generateInsightMessage(
  overallDelta: number,
  bottleneckBefore: string,
  bottleneckAfter: string,
  maxAxisChange: { axis: string; delta: number }
): string {
  if (overallDelta >= 15) {
    return `Major improvement: ${maxAxisChange.axis} jumped +${maxAxisChange.delta} points.`;
  }
  if (overallDelta >= 5) {
    return `Solid progress on ${maxAxisChange.axis}. Keep iterating.`;
  }
  if (bottleneckBefore !== bottleneckAfter) {
    return `Bottleneck shifted from ${bottleneckBefore} to ${bottleneckAfter} — you fixed the main issue.`;
  }
  return `Incremental improvement across multiple areas.`;
}

/**
 * Extract copy field from full_result (safe nested access)
 */
function extractCopyField(fullResult: any, field: string): string | null {
  const atf = fullResult?.above_the_fold_fix?.improved_copy;
  if (!atf) return null;
  
  switch (field) {
    case 'headline':
      return atf.headline || null;
    case 'subheadline':
      return atf.subheadline || null;
    case 'trust_line':
      return atf.trust_line || null;
    case 'primary_cta':
      return atf.primary_cta || null;
    default:
      return null;
  }
}

/**
 * Compute and store improvement if this scan qualifies.
 * Called as a background task after scan is saved.
 */
async function computeImprovementIfNeeded(
  supabaseAdmin: SupabaseClient,
  userId: string,
  newScanId: string,
  normalizedUrl: string,
  displayUrl: string,
  newScan: {
    overall_score: number;
    clarity_score: number | null;
    relevance_score: number | null;
    trust_score: number | null;
    conversion_score: number | null;
    full_result: any;
    created_at: string;
    content_hash: string | null;
  }
): Promise<void> {
  console.log(`[Improvement] Computing for scan ${newScanId}, URL: ${normalizedUrl}`);
  
  try {
    // Find previous scan for same normalized URL (must be older than current)
    const { data: previousScans, error: prevError } = await supabaseAdmin
      .from("lp_scan_history")
      .select("id, url, overall_score, clarity_score, relevance_score, trust_score, conversion_score, full_result, created_at, content_hash, category_version")
      .eq("user_id", userId)
      .neq("id", newScanId)
      .order("created_at", { ascending: false })
      .limit(50);
    
    if (prevError) {
      console.error("[Improvement] Error fetching previous scans:", prevError);
      return;
    }
    
    // Find the most recent previous scan with matching normalized URL
    let previousScan: typeof previousScans[0] | null = null;
    for (const scan of previousScans || []) {
      const scanNormUrl = normalizeUrlForImprovement(scan.url || "");
      if (scanNormUrl === normalizedUrl) {
        // Also check time gap (at least 30 seconds)
        const prevTime = new Date(scan.created_at).getTime();
        const newTime = new Date(newScan.created_at).getTime();
        if (newTime - prevTime >= 30000) {
          previousScan = scan;
          break;
        }
      }
    }
    
    if (!previousScan) {
      console.log("[Improvement] No previous scan found for this URL - skipping");
      return;
    }
    
    // Compute deltas
    const overallDelta = (newScan.overall_score || 0) - (previousScan.overall_score || 0);
    const clarityDelta = ((newScan.clarity_score ?? 0) - (previousScan.clarity_score ?? 0));
    const relevanceDelta = ((newScan.relevance_score ?? 0) - (previousScan.relevance_score ?? 0));
    const trustDelta = ((newScan.trust_score ?? 0) - (previousScan.trust_score ?? 0));
    const actionDelta = ((newScan.conversion_score ?? 0) - (previousScan.conversion_score ?? 0));
    
    // Determine bottlenecks
    const bottleneckBefore = getWeakestAxis(
      previousScan.clarity_score ?? 50,
      previousScan.relevance_score ?? 50,
      previousScan.trust_score ?? 50,
      previousScan.conversion_score ?? 50
    );
    const bottleneckAfter = getWeakestAxis(
      newScan.clarity_score ?? 50,
      newScan.relevance_score ?? 50,
      newScan.trust_score ?? 50,
      newScan.conversion_score ?? 50
    );
    const bottleneckShifted = bottleneckBefore !== bottleneckAfter;
    
    // Extract copy diffs
    const headlineBefore = extractCopyField(previousScan.full_result, 'headline');
    const headlineAfter = extractCopyField(newScan.full_result, 'headline');
    const headlineChanged = Boolean(headlineBefore !== headlineAfter && (headlineBefore || headlineAfter));
    
    const subheadlineBefore = extractCopyField(previousScan.full_result, 'subheadline');
    const subheadlineAfter = extractCopyField(newScan.full_result, 'subheadline');
    const subheadlineChanged = Boolean(subheadlineBefore !== subheadlineAfter && (subheadlineBefore || subheadlineAfter));
    
    const trustLineBefore = extractCopyField(previousScan.full_result, 'trust_line');
    const trustLineAfter = extractCopyField(newScan.full_result, 'trust_line');
    const trustLineChanged = Boolean(trustLineBefore !== trustLineAfter && (trustLineBefore || trustLineAfter));
    
    const ctaBefore = extractCopyField(previousScan.full_result, 'primary_cta');
    const ctaAfter = extractCopyField(newScan.full_result, 'primary_cta');
    const ctaChanged = Boolean(ctaBefore !== ctaAfter && (ctaBefore || ctaAfter));
    
    const copyChanged = Boolean(headlineChanged || subheadlineChanged || trustLineChanged || ctaChanged);
    
    // ==========================================================================
    // CONTENT CHANGE DETECTION (Phase 1)
    // Only create improvement logs when page content actually changed
    // This prevents fake improvements from score jitter
    // ==========================================================================
    const prevHash = previousScan.content_hash;
    const newHash = newScan.content_hash;
    const beforeScoreCompareVersion = extractScanScoreCompareVersion(previousScan);
    const afterScoreCompareVersion = extractScanScoreCompareVersion({
      full_result: newScan.full_result,
      category_version: CATEGORY_VERSION,
    });
    const sameScoreCompareVersion =
      beforeScoreCompareVersion !== "legacy_unknown" &&
      afterScoreCompareVersion !== "legacy_unknown" &&
      beforeScoreCompareVersion === afterScoreCompareVersion;
    
    // Determine if content actually changed (requires both hashes to exist)
    const contentChanged = (!!prevHash && !!newHash) ? prevHash !== newHash : false;
    
    console.log(`[Improvement] Content hash comparison:`, {
      prevHash: prevHash?.substring(0, 16) ?? "null",
      newHash: newHash?.substring(0, 16) ?? "null",
      contentChanged,
      beforeScoreCompareVersion,
      afterScoreCompareVersion,
      sameScoreCompareVersion,
    });
    
    // QUALIFICATION RULE: Only create improvement when content changed
    // This is the ONLY criterion now - score deltas alone don't qualify
    const qualifies = contentChanged;
    
    if (!qualifies) {
      console.log(`[Improvement] Scan does not qualify: contentChanged=${contentChanged}, overall_delta=${overallDelta}`);
      return;
    }
    
    // Compute magnitude and classification
    const axisDeltas = [
      { axis: "clarity", delta: clarityDelta },
      { axis: "relevance", delta: relevanceDelta },
      { axis: "trust", delta: trustDelta },
      { axis: "action", delta: actionDelta },
    ];
    const maxAxisChange = axisDeltas.reduce((max, curr) => 
      Math.abs(curr.delta) > Math.abs(max.delta) ? curr : max
    , axisDeltas[0]);
    const largestRegression = axisDeltas.reduce((min, curr) => Math.min(min, curr.delta), overallDelta);
    const positiveMovementVerified = overallDelta >= 5 || maxAxisChange.delta >= 8;
    const autoShareEligible = Boolean(
      contentChanged &&
      sameScoreCompareVersion &&
      positiveMovementVerified &&
      overallDelta >= 0 &&
      largestRegression >= -8
    );
    
    const magnitudeScore = computeMagnitudeScore(overallDelta, bottleneckShifted, copyChanged, Math.max(0, maxAxisChange.delta));
    const improvementType = classifyImprovement(overallDelta, bottleneckShifted, copyChanged);
    const insightMessage = generateInsightMessage(overallDelta, bottleneckBefore, bottleneckAfter, maxAxisChange);
    
    const improvementPayload = {
      user_id: userId,
      before_scan_id: previousScan.id,
      after_scan_id: newScanId,
      normalized_url: normalizedUrl,
      display_url: displayUrl,
      overall_delta: overallDelta,
      clarity_delta: clarityDelta,
      relevance_delta: relevanceDelta,
      trust_delta: trustDelta,
      action_delta: actionDelta,
      bottleneck_before: bottleneckBefore,
      bottleneck_after: bottleneckAfter,
      bottleneck_shifted: bottleneckShifted,
      headline_before: headlineBefore,
      headline_after: headlineAfter,
      headline_changed: headlineChanged,
      subheadline_before: subheadlineBefore,
      subheadline_after: subheadlineAfter,
      subheadline_changed: subheadlineChanged,
      trust_line_before: trustLineBefore,
      trust_line_after: trustLineAfter,
      trust_line_changed: trustLineChanged,
      primary_cta_before: ctaBefore,
      primary_cta_after: ctaAfter,
      cta_changed: ctaChanged,
      insight_message: insightMessage,
      improvement_type: improvementType,
      magnitude_score: magnitudeScore,
      before_scanned_at: previousScan.created_at,
      after_scanned_at: newScan.created_at,
      before_score: previousScan.overall_score,
      after_score: newScan.overall_score,
      content_hash_before: prevHash,
      content_hash_after: newHash,
      qualification_reason: sameScoreCompareVersion ? "content_hash_changed" : "content_hash_changed_engine_version_mismatch",
      qualification_version: IMPROVEMENT_QUALIFICATION_VERSION,
      score_compare_version: IMPROVEMENT_SCORE_COMPARE_VERSION,
      before_score_compare_version: beforeScoreCompareVersion,
      after_score_compare_version: afterScoreCompareVersion,
      page_change_verified: true,
      positive_movement_verified: positiveMovementVerified,
      auto_share_eligible: autoShareEligible,
    };

    // Insert improvement record
    let { error: insertError } = await supabaseAdmin
      .from("lp_improvements")
      .insert(improvementPayload);

    if (insertError?.code === "42703") {
      console.warn("[Improvement] Verification columns missing; retrying legacy insert. Apply migration 20260611123000_add_improvement_verification_evidence.sql to persist share evidence.", {
        code: insertError.code,
        message: insertError.message,
      });
      const legacyInsert = await supabaseAdmin
        .from("lp_improvements")
        .insert(stripImprovementVerificationColumns(improvementPayload));
      insertError = legacyInsert.error;
    }
    
    if (insertError) {
      // Duplicate key is expected if this pair already computed
      if (insertError.code === '23505') {
        console.log("[Improvement] Duplicate pair - already computed");
      } else {
        console.error("[Improvement] Insert error:", insertError);
      }
    } else {
      console.log(`[Improvement] Created improvement record: overall_delta=${overallDelta}, magnitude=${magnitudeScore}, type=${improvementType}, auto_share_eligible=${autoShareEligible}`);
    }
  } catch (err) {
    console.error("[Improvement] Unexpected error:", err);
  }
}

// =============================================================================
// SECURE CONFIGURATION: All sensitive values from environment variables
// =============================================================================

// Import Stripe for PDF purchase verification
import Stripe from "https://esm.sh/stripe@14.21.0";

/**
 * Verify if a pdf_session_id corresponds to a paid Stripe checkout session.
 * Used to allow unauthenticated PDF purchasers to scan in production.
 */
async function verifyPdfSessionPaid(pdfSessionId: string): Promise<boolean> {
  const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) {
    console.error("[PDF_BYPASS] STRIPE_SECRET_KEY not configured");
    return false;
  }
  
  try {
    const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });
    const session = await stripe.checkout.sessions.retrieve(pdfSessionId);
    const isPaid = session.payment_status === "paid";
    console.log(`[PDF_BYPASS] Stripe verification: session=${pdfSessionId.substring(0, 20)}..., paid=${isPaid}`);
    return isPaid;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error("[PDF_BYPASS] Stripe verification failed:", errorMessage);
    return false;
  }
}

interface ScoringBackendTarget {
  url: string;
  secret: string;
  kind: "primary" | "legacy_n8n";
  label: string;
}

function hasFiniteScore(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function hasUsableAxisScore(value: unknown): boolean {
  return hasFiniteScore(value) && value >= 0 && value <= 100;
}

function normalizeTextSignal(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasMeaningfulText(value: unknown): boolean {
  const text = normalizeTextSignal(value);
  return text.length > 0 && !["n/a", "na", "none", "unknown", "null"].includes(text);
}

function firstMeaningfulText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && hasMeaningfulText(value)) return value.trim();
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && hasMeaningfulText(entry)) return entry.trim();
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const nested = firstMeaningfulText(record.label, record.text, record.cta, record.primary_cta, record.primaryCta);
          if (nested) return nested;
        }
      }
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const nested = firstMeaningfulText(record.label, record.text, record.cta, record.primary_cta, record.primaryCta);
      if (nested) return nested;
    }
  }
  return "";
}

function normalizeCtaText(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
}

function isGenericHeaderOrAccountCta(value: unknown): boolean {
  const text = normalizeCtaText(value);
  return /^(sign up|sign in|log in|login|get started|start free|try free|try for free|start now|join now|create account|launch app)$/.test(text);
}

function extractVisibleCtaFromVision(scoreData: any): string {
  const rawVision =
    scoreData?.vision_proof?.raw ??
    scoreData?.visionProof?.raw ??
    scoreData?.vision_proof?.merged?.raw_vision ??
    scoreData?.visionProof?.merged?.raw_vision ??
    {};
  const mergedVision = scoreData?.vision_proof?.merged ?? scoreData?.visionProof?.merged ?? {};

  const candidates = [
    rawVision.visual_primary_cta_text,
    mergedVision.visual_primary_cta_text,
  ].filter((value) => hasMeaningfulText(value));

  const evidenceNotes = [
    ...(Array.isArray(rawVision.evidence_notes) ? rawVision.evidence_notes : []),
    ...(Array.isArray(mergedVision.evidence_notes) ? mergedVision.evidence_notes : []),
  ];

  for (const note of evidenceNotes) {
    if (typeof note !== "string" || !/\bcta\b|call-to-action|submit-style button/i.test(note)) continue;
    const quoted = [...note.matchAll(/[“"]([^”"]{3,80})[”"]/g)].map((match) => match[1]?.trim()).filter(Boolean);
    candidates.push(...quoted);
  }

  const generic = candidates.find((value) => isGenericHeaderOrAccountCta(value));
  const specific = candidates.find((value) => {
    const text = normalizeCtaText(value);
    return text && !isGenericHeaderOrAccountCta(value) && !/\bcta adjacent\b|\bcall to action\b/.test(text);
  });

  return specific || generic || "";
}

function reconcileCurrentCopyWithVisibleCta(scoreData: any): boolean {
  const visibleCta = extractVisibleCtaFromVision(scoreData);
  if (!visibleCta) return false;

  let changed = false;
  for (const key of ["current_copy", "currentCopy", "currentCopyForLLM"]) {
    const current = scoreData?.[key];
    if (!current || typeof current !== "object") continue;
    const existing = firstMeaningfulText(
      current.primary_cta,
      current.primaryCta,
      current.cta,
      current.cta_text,
      current.primary_cta_text,
    );
    if (!existing || (isGenericHeaderOrAccountCta(existing) && normalizeCtaText(existing) !== normalizeCtaText(visibleCta))) {
      current.primary_cta = visibleCta;
      current.primaryCta = visibleCta;
      current.visible_primary_cta_source = "vision_evidence";
      changed = true;
    }
  }
  return changed;
}

function normalizedCopyLine(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
}

function proofLikeText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return firstMeaningfulText(record.quote, record.text, record.line, record.label);
}

function isLikelyOutcomeOrRealProof(value: unknown): boolean {
  const normalized = normalizedCopyLine(proofLikeText(value));
  if (!normalized) return false;
  return (
    /\btrusted by\b|\bused by\b|\bno credit card\b|\bfree trial\b|\bguarantee\b|\bcase study\b/.test(normalized) ||
    /\b\d[\d,.]*\s*(?:k|m|%)?\+?\s*(?:users|customers|teams|founders|signups|leads|reviews|countries|minutes|hours)\b/.test(normalized) ||
    /\b(?:increased|grew|improved|generated|booked|saved|reduced)\b.{0,48}\b\d/.test(normalized)
  );
}

function isHeroEchoTrustLine(value: unknown, current: Record<string, unknown>): boolean {
  const text = normalizedCopyLine(proofLikeText(value));
  if (!text || isLikelyOutcomeOrRealProof(value)) return false;
  const anchors = [
    current.headline,
    current.subheadline,
    current.primary_cta,
    current.primaryCta,
    current.secondary_cta,
    current.secondaryCta,
  ].map(normalizedCopyLine).filter(Boolean);
  return anchors.some((anchor) =>
    text === anchor ||
    (text.length >= 8 && anchor.includes(text)) ||
    (anchor.length >= 8 && text.includes(anchor))
  );
}

function sanitizeCurrentCopyTrustFields(current: any): any {
  if (!current || typeof current !== "object") return current;
  const out = { ...current };
  const stringTrustKeys = [
    "proof_signal",
    "trust_line",
    "trust_social_proof",
    "trust_primary",
    "trust_near_cta_primary",
    "trust_near_cta_social_proof",
  ];
  for (const key of stringTrustKeys) {
    if (isHeroEchoTrustLine(out[key], out)) out[key] = "";
  }

  const filterEchoes = (value: unknown[]) =>
    value.filter((item) => !isHeroEchoTrustLine(item, out));

  for (const key of ["trust_signals", "trust_near_cta_top", "testimonials_top", "testimonials_all", "testimonials_near_cta_top"]) {
    if (Array.isArray(out[key])) out[key] = filterEchoes(out[key]);
  }

  const testimonialCount =
    (Array.isArray(out.testimonials_top) ? out.testimonials_top.length : 0) +
    (Array.isArray(out.testimonials_all) ? out.testimonials_all.length : 0) +
    (Array.isArray(out.testimonials_near_cta_top) ? out.testimonials_near_cta_top.length : 0);
  if (testimonialCount === 0) out.has_testimonial = false;

  const trustSignalsCount =
    (Array.isArray(out.trust_signals) ? out.trust_signals.length : 0) +
    (out.trust_social_proof ? 1 : 0) +
    (out.trust_line ? 1 : 0) +
    (out.trust_near_cta_social_proof ? 1 : 0);
  if (trustSignalsCount === 0) out.has_trust_signal = false;

  return out;
}

function normalizedProofText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function looksLikeProductDetailMetric(value: unknown): boolean {
  const raw = typeof value === "string" ? value.trim() : "";
  const text = normalizedProofText(raw);
  if (!text) return false;
  if (/^\d+\s*(?:min|mins|minutes?|sec|seconds?|hours?|hrs?)\b/.test(text)) return true;
  if (/\b(?:starting deep work|stuck on a problem|pre meeting reset|end of day shutdown|breath|focus session)\b/.test(text)) return true;
  if (/\b\d+\s*(?:min|minutes?)\b/.test(text) && !/\b(users|customers|teams|developers|sessions completed|completed sessions|saved|reduced|increased|generated|booked|uptime|api calls|queries|requests)\b/.test(text)) return true;
  return false;
}

function isRealMarketProofLine(value: unknown, marketFamily = ""): boolean {
  const text = normalizedProofText(value);
  if (!text || looksLikeProductDetailMetric(value)) return false;
  if (/\b(no credit card|no card|free trial|free plan|try for free|start for free|cancel anytime|refund|guarantee|risk free)\b/.test(text)) return true;
  if (/\b(trusted by|used by|loved by|joined by|installed by|downloaded by|waitlist)\b/.test(text)) return true;
  if (/\b(rated|reviews?|star rating|product hunt|g2|capterra|github stars?|featured on|featured in)\b/.test(text)) return true;
  if (/\b\d[\d,.]*\s*(?:k|m)?\+?\s*(?:users|customers|teams|developers|founders|students|creators|signups|installs|downloads|members|companies|startups|people)\b/.test(text)) return true;
  if (/\b(saved|reduced|increased|improved|generated|booked|recovered|grew|cut|lifted|boosted|converted|shipped|closed|won)\b.{0,56}\b\d[\d,.]*\s*(?:k|m|%|x|hours?|days?|minutes?|leads?|signups?|customers?|revenue|sales|demos?|users?)\b/.test(text)) return true;
  const techMarket = /developer_workflow|attribution_analytics|ai_visibility|landing_page_optimization|website_builder|productivity_docs/.test(marketFamily);
  if (techMarket && (
    /\b\d[\d,.]*\s*(?:k|m|b)?\+?\s*(?:api calls|requests|queries|events|logs|deploys|builds|checks|tests|scans)\s*(?:per|processed|served|handled|run)\b/.test(text) ||
    /\b99(?:\.\d+)?%\s*(?:uptime|sla|availability)\b/.test(text) ||
    /\b(?:soc ?2|iso ?27001|hipaa|gdpr)\b/.test(text) ||
    /\bgithub\b.{0,32}\b\d[\d,.]*\s*(?:stars?|forks?)\b/.test(text)
  )) return true;
  return false;
}

function hasRealCurrentTrustProof(scoreData: any): boolean {
  const current = scoreData?.current_copy ?? scoreData?.currentCopyForLLM ?? scoreData?.currentCopy ?? {};
  const marketFamily = String(scoreData?.market_profile?.market_family ?? scoreData?.page_profile?.market_family ?? "");
  const candidates = [
    current.trust_social_proof,
    current.trust_line,
    current.trust_risk_reversal,
    current.trust_near_cta_social_proof,
    current.trust_near_cta_risk_reversal,
    ...(Array.isArray(current.trust_signals) ? current.trust_signals : []),
    ...(Array.isArray(current.trust_near_cta_top) ? current.trust_near_cta_top : []),
    ...(Array.isArray(current.testimonials_top) ? current.testimonials_top.map((item: any) => typeof item === "string" ? item : item?.quote) : []),
    ...(Array.isArray(current.testimonials_all) ? current.testimonials_all.map((item: any) => typeof item === "string" ? item : item?.quote) : []),
  ];
  return candidates.some((line) => isRealMarketProofLine(line, marketFamily));
}

function hasOnlyProductArtifactTrust(scoreData: any): boolean {
  const rawVision =
    scoreData?.vision_proof?.raw ??
    scoreData?.visionProof?.raw ??
    scoreData?.vision_proof?.merged?.raw_vision ??
    scoreData?.visionProof?.merged?.raw_vision ??
    {};
  const mergedVision = scoreData?.vision_proof?.merged ?? scoreData?.visionProof?.merged ?? {};
  const productArtifactPresent = Boolean(
    mergedVision.product_artifact_present ||
      rawVision.visual_product_ui_screenshot_present ||
      rawVision.visual_product_artifact_type
  );
  if (!productArtifactPresent || hasRealCurrentTrustProof(scoreData)) return false;
  if (
    rawVision.visual_testimonial_cards_present ||
    rawVision.visual_logo_wall_present ||
    rawVision.visual_star_rating_present ||
    rawVision.visual_review_badge_present ||
    rawVision.visual_producthunt_badge_present ||
    rawVision.visual_g2_capterra_badge_present ||
    rawVision.visual_before_after_present
  ) return false;
  const marketFamily = String(scoreData?.market_profile?.market_family ?? scoreData?.page_profile?.market_family ?? "");
  const metricLines = Array.isArray(rawVision.visual_metric_lines) ? rawVision.visual_metric_lines : [];
  return !metricLines.some((line: unknown) => isRealMarketProofLine(line, marketFamily));
}

/**
 * Whether a sentence the scorer produced can be put in front of a founder.
 *
 * Empty, a stub, or written about the scan's own machinery rather than their page.
 * Anything else is theirs and is left alone.
 */
function isShowableScanCopy(text: unknown): boolean {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t === "N/A") return false;
  if (t.split(" ").filter(Boolean).length < 4) return false;
  return !/\b(weakest axis|the scan|this scan|fix kit|implementation spec|placeholder)\b/i.test(t);
}

function normalizeProductArtifactOnlyTrustState(scoreData: any): boolean {
  if (!scoreData || typeof scoreData !== "object" || !hasOnlyProductArtifactTrust(scoreData)) return false;
  const patchProfile = (profile: any) => {
    if (!profile || typeof profile !== "object") return profile;
    profile.trust_evidence_state = "product_artifact_only";
    profile.proof_pattern = profile.proof_pattern === "product_artifact_proof" ? "weak_or_missing_proof" : profile.proof_pattern;
    profile.proofPattern = profile.proofPattern === "product_artifact_proof" ? "weak_or_missing_proof" : profile.proofPattern;
    profile.proof_gap = "proof_absent";
    profile.proofGap = "proof_absent";
    profile.proof_hierarchy = {
      ...(profile.proof_hierarchy && typeof profile.proof_hierarchy === "object" ? profile.proof_hierarchy : {}),
      gap: "proof_absent",
      near_cta_proof_lines: [],
      strongest_near_cta_proof: "",
      strongest_proof_line: "",
      strongest_outcome_proof: "",
      outcome_proof_lines: [],
      proof_strength: { strongest_near_cta: 0, strongest_overall: 0, strongest_outcome: 0 },
    };
    profile.proofHierarchy = profile.proof_hierarchy;
    return profile;
  };
  scoreData.page_profile = patchProfile(scoreData.page_profile);
  scoreData.market_profile = patchProfile(scoreData.market_profile);
  if (scoreData.meta && typeof scoreData.meta === "object") {
    scoreData.meta.trust_evidence_state = "product_artifact_only";
    scoreData.meta.proof_pattern = scoreData.meta.proof_pattern === "product_artifact_proof" ? "weak_or_missing_proof" : scoreData.meta.proof_pattern;
    scoreData.meta.proof_gap = "proof_absent";
    scoreData.meta.market_profile = patchProfile(scoreData.meta.market_profile);
  }
  // Everything above is a factual correction to the proof state and stays unconditional.
  // The copy below does not correct anything — it replaces eight sentences the scorer
  // already wrote, and it replaced them whenever this state was detected rather than
  // when the sentences were actually wrong. That fired on 46 of 178 scans in 30 days,
  // and a second override inside the scorer covered another 103, so 149 of 178 reports
  // opened with one of two fixed sentences. Each line is now kept unless it cannot be
  // shown to a founder.
  const fix = scoreData.free_preview_fix;
  if (fix && typeof fix === "object" && String(fix.axis || "").toLowerCase() === "trust") {
    if (!isShowableScanCopy(fix.title)) fix.title = "Add one real trust cue under CTA";
    if (!isShowableScanCopy(fix.instruction)) {
      fix.instruction = "Add one real early-user quote, waitlist count, usage number, rating, or no-risk line under the primary CTA.";
    }
    if (!isShowableScanCopy(fix.acceptance_check)) {
      fix.acceptance_check = "The CTA has one real proof cue or a clearly marked placeholder for founder-provided proof.";
    }
    if (!isShowableScanCopy(fix.reason)) {
      fix.reason = "The page shows what the product is, but nothing at the decision point shows that anyone has used it.";
    }
    if (!isShowableScanCopy(fix.patch?.after)) {
      fix.patch = { ...(fix.patch || {}), after: "Add one real proof cue under the CTA." };
    }
  }
  const insights = scoreData.ai_insights ?? scoreData.summary_insights;
  if (insights && typeof insights === "object") {
    const bottleneckBefore = String(insights.biggest_bottleneck ?? "").replace(/\s+/g, " ").trim();
    if (!isShowableScanCopy(insights.biggest_bottleneck)) {
      insights.biggest_bottleneck = "The page shows the product, but it does not show real trust proof yet.";
    }
    // decision_summary.observed is built inside the scorer, before this function runs, and
    // it quotes biggest_bottleneck. Changing the field here without following through left
    // the report's opening line holding a sentence that existed nowhere else in the scan:
    // incazing.com opened with "Trust proof is present…" on a page carrying no proof at
    // all, while the field it came from had already been corrected to say the opposite.
    const summary = scoreData.decision_summary;
    if (
      summary && typeof summary === "object" &&
      bottleneckBefore &&
      String(summary.observed ?? "").replace(/\s+/g, " ").trim() === bottleneckBefore &&
      insights.biggest_bottleneck !== bottleneckBefore
    ) {
      summary.observed = insights.biggest_bottleneck;
    }
    if (!isShowableScanCopy(insights.fastest_win)) {
      insights.fastest_win = "Add one real early-user proof cue under the main button.";
    }
    if (!isShowableScanCopy(insights.estimated_impact)) {
      insights.estimated_impact = "More visitors understand why it is safe to take the next step.";
    }
    scoreData.ai_insights = insights;
    scoreData.summary_insights = insights;
  }
  scoreData.trust_evidence_state = "product_artifact_only";
  return true;
}

function extractCurrentCopyFromScoringPayload(scoreData: any) {
  const current = scoreData?.current_copy ?? scoreData?.currentCopyForLLM ?? scoreData?.currentCopy ?? {};
  const atfCurrent = scoreData?.above_the_fold_fix?.current_copy ?? {};
  const snapshot = scoreData?.user_snapshot ?? {};
  const pageSnapshot = scoreData?.page_snapshot ?? {};
  const source = [current, atfCurrent, snapshot, pageSnapshot, scoreData].filter(
    (value) => value && typeof value === "object",
  );

  const pick = (...keys: string[]) => {
    const values: unknown[] = [];
    for (const record of source) {
      for (const key of keys) values.push((record as Record<string, unknown>)[key]);
    }
    return firstMeaningfulText(...values);
  };

  const headline = pick("headline", "hero_headline", "title", "main_headline");
  const subheadline = pick("subheadline", "hero_subheadline", "subtitle", "description");
  const primaryCta = pick("primary_cta", "primaryCta", "cta", "cta_text", "primary_cta_text", "cta_buttons", "ctaButtons", "ctas");
  const trustSocialProof = pick("trust_social_proof", "trustSocialProof", "trust_line", "trustLine", "trustCue", "proof", "risk_reversal", "trust_risk_reversal");
  const sectionOrder = Array.isArray(current?.section_order)
    ? current.section_order
    : Array.isArray(atfCurrent?.section_order)
      ? atfCurrent.section_order
      : Array.isArray(scoreData?.section_order)
        ? scoreData.section_order
        : [];

  if (![headline, subheadline, primaryCta, trustSocialProof].some(hasMeaningfulText)) {
    return null;
  }

  return {
    ...(current && typeof current === "object" ? current : {}),
    headline: headline || undefined,
    subheadline: subheadline || undefined,
    primary_cta: primaryCta || undefined,
    trust_social_proof: trustSocialProof || undefined,
    section_order: sectionOrder,
    source: "scoring_backend_current_page",
  };
}

function attachCurrentCopy(scoreData: any) {
  const currentCopy = extractCurrentCopyFromScoringPayload(scoreData);
  if (!currentCopy) return false;
  scoreData.current_copy = {
    ...(scoreData.current_copy && typeof scoreData.current_copy === "object" ? scoreData.current_copy : {}),
    ...currentCopy,
  };
  reconcileCurrentCopyWithVisibleCta(scoreData);
  for (const key of ["current_copy", "currentCopy", "currentCopyForLLM"]) {
    if (scoreData[key] && typeof scoreData[key] === "object") {
      scoreData[key] = sanitizeCurrentCopyTrustFields(scoreData[key]);
    }
  }
  scoreData.current_copy = sanitizeCurrentCopyTrustFields(scoreData.current_copy);
  const repaired = enforceConfirmedProvenanceCopy(scoreData);
  if (repaired.length) {
    console.warn("[current_copy] restored confirmed extraction for:", repaired.join(", "));
  }
  return true;
}

function getScoreValue(scoreData: any, key: string, fallbackKey?: string): unknown {
  const scores = (scoreData as any)?.scores ?? scoreData;
  return scores?.[key]
    ?? (fallbackKey ? scores?.[fallbackKey] : undefined)
    ?? (scoreData as any)?.[key]
    ?? (fallbackKey ? (scoreData as any)?.[fallbackKey] : undefined);
}

function getScoringPayloadIssues(scoreData: any): string[] {
  const issues: string[] = [];
  if (!scoreData || typeof scoreData !== "object") return ["not_object"];

  const axisScores = [
    getScoreValue(scoreData, "clarity_100"),
    getScoreValue(scoreData, "relevance_100"),
    getScoreValue(scoreData, "trust_100"),
    getScoreValue(scoreData, "action_100", "conversion_100"),
  ];
  const overallScore = getScoreValue(scoreData, "overall_100");
  const zeroAxisCount = axisScores.filter((score) => Number(score) === 0).length;
  const usableAxes = axisScores.filter(hasUsableAxisScore).length;

  if (!hasUsableAxisScore(overallScore)) issues.push("overall_score_missing_or_zero");
  if (usableAxes < 4) issues.push("axis_score_missing_or_zero");
  if (zeroAxisCount >= 2) issues.push("majority_zero_axes");

  const previewFix = (scoreData as any)?.free_preview_fix;
  if (
    !previewFix ||
    typeof previewFix !== "object" ||
    !hasMeaningfulText(previewFix?.title)
  ) {
    issues.push("preview_fix_missing");
  }

  return issues;
}

function looksLikeUsableScoringPayload(scoreData: any): boolean {
  return getScoringPayloadIssues(scoreData).length === 0;
}

function isDegradedScoringPayload(scoreData: any): boolean {
  const meta = scoreData && typeof scoreData.meta === "object" ? scoreData.meta : {};
  return (
    scoreData?.scan_quality_status === "degraded" ||
    scoreData?.scan_quality?.degraded === true ||
    meta?.degraded === true ||
    meta?.fail_soft === true
  );
}

function isDeliveryRepairedScoringPayload(scoreData: any): boolean {
  const meta = scoreData && typeof scoreData.meta === "object" ? scoreData.meta : {};
  return meta?.delivery_repaired === true;
}

function clipDiagnosticText(value: unknown, max = 300): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.slice(0, max);
}

function summarizeFetchDiagnostics(scoreData: any): Record<string, unknown> {
  const meta = scoreData && typeof scoreData.meta === "object" ? scoreData.meta : {};
  const diagnostics =
    meta.fetch_diagnostics && typeof meta.fetch_diagnostics === "object"
      ? meta.fetch_diagnostics
      : {};
  return {
    fetchSource: meta.fetch_source ?? diagnostics.strategy ?? null,
    failSoft: diagnostics.fail_soft === true || meta.fail_soft === true,
    browserlessUsed: diagnostics.browserless_used === true,
    browserlessError: clipDiagnosticText(diagnostics.browserless_error),
    browserlessDurationMs: diagnostics.browserless_duration_ms ?? null,
    browserlessFallbackConfigured: diagnostics.browserless_fallback_configured === true,
    browserlessFallbackAttempted: diagnostics.browserless_fallback_attempted === true,
    browserlessFallbackUsed: diagnostics.browserless_fallback_used === true,
    browserlessFallbackError: clipDiagnosticText(diagnostics.browserless_fallback_error),
    browserlessRetryAttempted: diagnostics.browserless_retry_attempted === true,
    browserlessRetryError: clipDiagnosticText(diagnostics.browserless_retry_error, 200),
    firecrawlUsed: diagnostics.firecrawl_used === true,
    firecrawlScreenshotFallbackUsed: diagnostics.firecrawl_screenshot_fallback_used === true,
  };
}

function hasFactContradictions(scoreData: any): boolean {
  return Array.isArray(scoreData?.fact_contradictions) && scoreData.fact_contradictions.length > 0;
}

function pageInaccessibleResponse(detail: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "We couldn't get a usable scan from this URL. It may be misspelled, inaccessible, or blocked by the site. Please check the spelling and try again.",
      code: "PAGE_INACCESSIBLE",
      detail,
      ...extra,
    }),
    { status: 422, headers: corsHeaders }
  );
}

function getPrimaryScoringBackend(): ScoringBackendTarget {
  const primaryUrl = Deno.env.get("SCORING_BACKEND_URL")?.trim();
  const primarySecret = (
    Deno.env.get("SCORING_BACKEND_SECRET") ||
    Deno.env.get("N8N_LP_SCORING_SECRET")
  )?.trim();

  if (primaryUrl) {
    if (!primarySecret) {
      throw new Error("SCORING_BACKEND_SECRET not configured");
    }
    return {
      url: primaryUrl,
      secret: primarySecret,
      kind: "primary",
      label: "configured scoring backend",
    };
  }

  const legacyUrl = Deno.env.get("N8N_LP_SCORING_URL")?.trim();
  const legacySecret = Deno.env.get("N8N_LP_SCORING_SECRET")?.trim();
  if (!legacyUrl || !legacySecret) {
    throw new Error("No scoring backend configured");
  }

  return {
    url: legacyUrl,
    secret: legacySecret,
    kind: "legacy_n8n",
    label: "legacy n8n backend",
  };
}

function getFallbackScoringBackend(primary: ScoringBackendTarget): ScoringBackendTarget | null {
  const legacyUrl = Deno.env.get("N8N_LP_SCORING_URL")?.trim();
  const legacySecret = Deno.env.get("N8N_LP_SCORING_SECRET")?.trim();
  if (!legacyUrl || !legacySecret) return null;
  if (legacyUrl === primary.url) return null;

  return {
    url: legacyUrl,
    secret: legacySecret,
    kind: "legacy_n8n",
    label: "legacy n8n backend",
  };
}

// Paid plans that get UNLIMITED scans (includes legacy 'agency' for migration safety)
const PAID_PLANS = ['pro', 'lifetime', 'agency'];

// =============================================================================
// BYPASS USER: Loaded from environment variables (secure)
// If env vars are missing, bypass is disabled entirely (secure default)
// =============================================================================
function getBypassConfig(): { userId: string | null; email: string | null } {
  return {
    userId: Deno.env.get("BYPASS_USER_ID") || null,
    email: Deno.env.get("BYPASS_EMAIL")?.toLowerCase().trim() || null,
  };
}

// Helper: Check if plan is paid (unlimited scans)
function isPaidUser(plan: string | null | undefined): boolean {
  return PAID_PLANS.includes(plan || '');
}

// Free user limits (server-side source of truth)
// - New users: 1 free scan. +1 only after sharing (max 2).
// - free_scan_limit is NOT NULL (enforced by DB constraint).
const FREE_SCAN_LIMIT_NEW_USER = 1;
const API_KEY_PREFIX = "lpapi_";
// Shared across API, CLI, and MCP scans (all authenticate via lpapi_ keys and are
// counted from lp_scan_history rows where source = "api"). Raised from 10 to 50/month
// for MCP: coding agents naturally loop scan -> apply fix -> rescan, so a single
// working session can burn 3-5+ scans. Keep in sync with verify-api-key/index.ts and
// the /api-access page copy.
const API_MONTHLY_QUOTA = 50;
const API_DAILY_QUOTA = 15;

interface ApiKeyAuthContext {
  id: string;
  userId: string;
  plan: string;
  keyHash: string;
  totalCalls: number;
  monthlyUsedBefore: number;
  monthlyLimit: number;
}

async function computeApiKeyHash(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getCurrentMonthStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)).toISOString();
}

function getCurrentDayStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)).toISOString();
}

async function authenticateApiKeyForScan(
  supabaseAdmin: SupabaseClient,
  apiKey: string,
  requestId: string,
): Promise<ApiKeyAuthContext | Response> {
  const keyHash = await computeApiKeyHash(apiKey);
  const keyPrefix = apiKey.substring(0, 12);

  const { data: apiKeyData, error: apiKeyError } = await supabaseAdmin
    .from("lp_api_keys")
    .select("id, user_id, key_prefix, key_hash, plan, total_calls, revoked_at")
    .eq("key_hash", keyHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (apiKeyError) {
    console.error(`[${requestId}] API key lookup error:`, apiKeyError);
    return new Response(
      JSON.stringify({ ok: false, error: "Internal API key verification error", code: "API_KEY_LOOKUP_FAILED" }),
      { status: 500, headers: corsHeaders },
    );
  }

  if (!apiKeyData || apiKeyData.key_prefix !== keyPrefix) {
    console.log(`[${requestId}] API key rejected`);
    return new Response(
      JSON.stringify({ ok: false, error: "Invalid API key", code: "INVALID_API_KEY" }),
      { status: 403, headers: corsHeaders },
    );
  }

  const plan = String(apiKeyData.plan || "free");
  if (!isPaidUser(plan)) {
    console.log(`[${requestId}] API key plan not authorized:`, plan);
    return new Response(
      JSON.stringify({ ok: false, error: "Plan not authorized for API access", code: "API_PLAN_NOT_AUTHORIZED" }),
      { status: 403, headers: corsHeaders },
    );
  }

  const monthStartIso = getCurrentMonthStartIso();
  const { count, error: usageError } = await supabaseAdmin
    .from("lp_scan_history")
    .select("id", { count: "exact", head: true })
    .eq("user_id", apiKeyData.user_id)
    .eq("source", "api")
    .gte("created_at", monthStartIso);

  if (usageError) {
    console.error(`[${requestId}] API monthly usage lookup error:`, usageError);
    return new Response(
      JSON.stringify({ ok: false, error: "Internal API usage verification error", code: "API_USAGE_LOOKUP_FAILED" }),
      { status: 500, headers: corsHeaders },
    );
  }

  const monthlyUsedBefore = count ?? 0;
  if (monthlyUsedBefore >= API_MONTHLY_QUOTA) {
    console.log(`[${requestId}] API monthly quota exceeded`, {
      userId: apiKeyData.user_id,
      monthlyUsedBefore,
      monthlyLimit: API_MONTHLY_QUOTA,
    });
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Monthly API scan limit exceeded",
        code: "API_QUOTA_EXCEEDED",
        api_calls_used: monthlyUsedBefore,
        api_calls_limit: API_MONTHLY_QUOTA,
        api_calls_remaining: 0,
      }),
      { status: 429, headers: corsHeaders },
    );
  }

  // Daily cap guards against a runaway agent loop (MCP tools naturally scan repeatedly)
  // burning the whole monthly quota in one session.
  const dayStartIso = getCurrentDayStartIso();
  const { count: dailyCount, error: dailyUsageError } = await supabaseAdmin
    .from("lp_scan_history")
    .select("id", { count: "exact", head: true })
    .eq("user_id", apiKeyData.user_id)
    .eq("source", "api")
    .gte("created_at", dayStartIso);

  if (dailyUsageError) {
    console.error(`[${requestId}] API daily usage lookup error:`, dailyUsageError);
    return new Response(
      JSON.stringify({ ok: false, error: "Internal API usage verification error", code: "API_USAGE_LOOKUP_FAILED" }),
      { status: 500, headers: corsHeaders },
    );
  }

  const dailyUsedBefore = dailyCount ?? 0;
  if (dailyUsedBefore >= API_DAILY_QUOTA) {
    console.log(`[${requestId}] API daily quota exceeded`, {
      userId: apiKeyData.user_id,
      dailyUsedBefore,
      dailyLimit: API_DAILY_QUOTA,
    });
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Daily API scan limit exceeded. Resets at midnight UTC.",
        code: "API_DAILY_QUOTA_EXCEEDED",
        api_calls_used: monthlyUsedBefore,
        api_calls_limit: API_MONTHLY_QUOTA,
        api_calls_remaining: Math.max(0, API_MONTHLY_QUOTA - monthlyUsedBefore),
      }),
      { status: 429, headers: corsHeaders },
    );
  }

  return {
    id: apiKeyData.id,
    userId: apiKeyData.user_id,
    plan,
    keyHash,
    totalCalls: typeof apiKeyData.total_calls === "number" ? apiKeyData.total_calls : 0,
    monthlyUsedBefore,
    monthlyLimit: API_MONTHLY_QUOTA,
  };
}

const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-lb-client-request-id, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// =============================================================================
// Origin-based environment detection
// =============================================================================
const PREVIEW_HOST_SUFFIXES = ["lovable.app", "lovableproject.com"];
const PRODUCTION_HOSTS = ["landingboost.app", "www.landingboost.app"];
type LocalDebugBillingOverrideMode = "none" | "free" | "full_scan" | "lifetime";

function getRequestOriginHost(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).hostname;
    } catch {
      // Invalid origin URL
    }
  }

  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).hostname;
    } catch {
      // Invalid referer URL
    }
  }

  return null;
}

function isPreviewHost(host: string): boolean {
  if (host === "localhost") return true;
  if (host.endsWith(".localhost")) return true;
  return PREVIEW_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}

function isProductionHost(host: string): boolean {
  return PRODUCTION_HOSTS.includes(host);
}

function isLocalDebugHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

function parseLocalDebugBillingOverride(raw: unknown): LocalDebugBillingOverrideMode {
  return raw === "free" || raw === "full_scan" || raw === "lifetime" ? raw : "none";
}

// =============================================================================
// Preview rate limiting (DB-backed for persistence across cold starts)
// =============================================================================
const PREVIEW_LIMIT = 5; // requests per window
const PREVIEW_WINDOW_MS = 60_000; // 1 minute window

function getClientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// DB-backed rate limiting - survives cold starts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function checkPreviewRateLimitDb(
  supabaseAdmin: any,
  ip: string,
  route: string = "lp-score"
): Promise<boolean> {
  const windowStart = new Date(Date.now() - PREVIEW_WINDOW_MS).toISOString();
  
  try {
    // Count recent events for this IP
    const { count, error: countError } = await supabaseAdmin
      .from("rate_limit_events")
      .select("*", { count: "exact", head: true })
      .eq("ip_address", ip)
      .eq("route", route)
      .gte("created_at", windowStart);
    
    if (countError) {
      console.error("[RateLimit] Error counting events:", countError);
      // Fail open to avoid blocking legitimate users, but log for monitoring
      return true;
    }
    
    const currentCount = count ?? 0;
    
    if (currentCount >= PREVIEW_LIMIT) {
      console.log(`[RateLimit] Limit exceeded for IP ${ip}: ${currentCount}/${PREVIEW_LIMIT}`);
      return false;
    }
    
    // Record this request
    const { error: insertError } = await supabaseAdmin
      .from("rate_limit_events")
      .insert({ ip_address: ip, route });
    
    if (insertError) {
      console.error("[RateLimit] Error inserting event:", insertError);
      // Still allow the request if we can't record it
    }
    
    // Periodically cleanup old events (1% chance per request)
    if (Math.random() < 0.01) {
      supabaseAdmin.rpc("cleanup_old_rate_limit_events");
    }
    
    return true;
  } catch (err) {
    console.error("[RateLimit] Unexpected error:", err);
    return true; // Fail open
  }
}

// =============================================================================
// SSRF Protection: Validate URL to prevent internal network access
// =============================================================================
function validateUrlForSsrf(url: string): { valid: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  // Only allow http/https protocols
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { valid: false, error: "Only HTTP/HTTPS protocols allowed" };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variants
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]" ||
    hostname === "::1"
  ) {
    return { valid: false, error: "Localhost URLs are not allowed" };
  }

  // Block private IP ranges: 10.0.0.0/8
  if (/^10\./.test(hostname)) {
    return { valid: false, error: "Private IP addresses are not allowed" };
  }

  // Block private IP ranges: 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
  const match172 = hostname.match(/^172\.(\d+)\./);
  if (match172) {
    const second = parseInt(match172[1], 10);
    if (second >= 16 && second <= 31) {
      return { valid: false, error: "Private IP addresses are not allowed" };
    }
  }

  // Block private IP ranges: 192.168.0.0/16
  if (/^192\.168\./.test(hostname)) {
    return { valid: false, error: "Private IP addresses are not allowed" };
  }

  // Block link-local / cloud metadata IPs: 169.254.x.x
  if (/^169\.254\./.test(hostname) || hostname === "169.254.169.254") {
    return { valid: false, error: "Metadata endpoint URLs are not allowed" };
  }

  // Block common cloud metadata hostnames
  const blockedHostnames = [
    "metadata.google.internal",
    "metadata.azure.com",
    "instance-data.ec2.internal",
  ];
  if (blockedHostnames.includes(hostname)) {
    return { valid: false, error: "Cloud metadata endpoints are not allowed" };
  }

  return { valid: true };
}

// Helper: Check if a date is in the current calendar month (UTC)
const isCurrentMonth = (dateString: string | null): boolean => {
  if (!dateString) return false;
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return false;
    const now = new Date();
    return (
      date.getUTCFullYear() === now.getUTCFullYear() &&
      date.getUTCMonth() === now.getUTCMonth()
    );
  } catch {
    return false;
  }
};

// Truncate text to first sentence only (for Free user previews - security)
function truncateToFirstSentence(text: unknown): string {
  if (typeof text !== "string") return "";
  const t = text.trim();
  if (!t) return "";
  // Match first sentence ending with . ! or ?
  const match = t.match(/^(.+?[.!?])(\s|$)/);
  if (match && match[1]) return match[1].trim();
  // Fallback: split on newline or period
  const firstLine = t.split(/\n+/)[0]?.trim() ?? "";
  if (!firstLine) return "";
  const firstDot = firstLine.split(".")[0]?.trim();
  if (!firstDot) return "";
  return firstDot.endsWith(".") ? firstDot : firstDot + ".";
}

function previewFixMentionsCtaProof(fix: {
  title?: string;
  instruction?: string;
  where?: string;
  category?: string;
} | null | undefined): boolean {
  const text = [
    fix?.title,
    fix?.instruction,
    fix?.where,
    fix?.category,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    /\btrust\b|\bsocial proof\b|\btestimonial\b|\brisk[-\s]?reversal\b|\bcredibility\b/.test(text) &&
    /\bcta\b|\bbutton\b|\bclick\b|under the primary cta|below the primary cta|near the cta/.test(text)
  );
}

function extractLikelyCurrentTrustText(data: any): string {
  const current = data?.current_copy ?? {};
  const atfCurrent = data?.above_the_fold_fix?.current_copy ?? {};
  const improved = data?.above_the_fold_fix?.improved_copy ?? {};
  const snapshot = data?.user_snapshot ?? {};
  const fields = [
    current.trust_line,
    current.trust_social_proof,
    current.risk_reversal,
    current.primary_cta,
    current.subheadline,
    atfCurrent.trust_line,
    atfCurrent.trust_social_proof,
    atfCurrent.risk_reversal,
    atfCurrent.primary_cta,
    atfCurrent.subheadline,
    improved.trust_line,
    snapshot.trust_line,
    snapshot.trust_social_proof,
  ];

  return fields
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function extractLikelyCurrentCtaProofLines(data: any): string[] {
  const current = data?.current_copy ?? {};
  const atfCurrent = data?.above_the_fold_fix?.current_copy ?? {};
  const sources = [current, atfCurrent].filter((value) => value && typeof value === "object");
  const lines: string[] = [];

  const pushValue = (value: unknown) => {
    if (typeof value === "string" && value.trim()) lines.push(value.trim());
    if (value && typeof value === "object") {
      const text = firstMeaningfulText(
        (value as Record<string, unknown>).quote,
        (value as Record<string, unknown>).text,
        (value as Record<string, unknown>).line,
        (value as Record<string, unknown>).label,
      );
      if (text) lines.push(text);
    }
  };

  for (const source of sources) {
    pushValue((source as Record<string, unknown>).trust_near_cta_primary);
    pushValue((source as Record<string, unknown>).trust_near_cta_social_proof);
    pushValue((source as Record<string, unknown>).trust_near_cta_risk_reversal);
    pushValue((source as Record<string, unknown>).trust_near_cta_security);
    const nearCtaTop = (source as Record<string, unknown>).trust_near_cta_top;
    if (Array.isArray(nearCtaTop)) nearCtaTop.forEach(pushValue);
  }

  return [...new Set(lines.filter(Boolean))];
}

function hasExistingCtaProofSignal(data: any, fix: {
  instruction?: string;
} | null | undefined): boolean {
  const nearCtaTrustText = extractLikelyCurrentCtaProofLines(data).join(" ").toLowerCase();
  const currentTrustText = nearCtaTrustText || extractLikelyCurrentTrustText(data);
  const instruction = String(fix?.instruction || "").toLowerCase();
  const combined = `${currentTrustText} ${instruction}`;

  return (
    /\bno credit card\b|\bfree analysis\b|\bfree scan\b|\btrusted by\b|\bfounders?\b|\busers?\b|\bcustomers?\b|\btestimonial\b|\brisk[-\s]?reversal\b|\bguarantee\b|\bmoney[-\s]?back\b|\bcase stud/.test(combined) ||
    /\bexisting risk[-\s]?reversal\b|\bkeeping the existing\b/.test(instruction)
  );
}

function isBackendProofHierarchyFix(fix: {
  title?: string;
  instruction?: string;
} | null | undefined): boolean {
  const text = [fix?.title, fix?.instruction].filter(Boolean).join(" ").toLowerCase();
  // Only trust backend hierarchy instructions that actually ask for a stronger
  // proof type. Generic phrases like "customer proof" can appear inside the
  // existing page copy and must not suppress duplicate-proof correction.
  return (
    /\b(?:replace|rewrite|make|turn|upgrade|strengthen)\b.{0,80}\bproof\b.{0,80}\b(?:specific|concrete|outcome|named|quote|testimonial|customer count|result)\b/.test(text) ||
    /\b(?:specific|concrete|outcome|named|quote|testimonial|customer count|result)\b.{0,80}\bproof\b/.test(text) ||
    /\bproof hierarchy\b/.test(text)
  );
}

function fixRepeatsExistingCtaProof(data: any, fix: any): boolean {
  const currentProofLines = extractLikelyCurrentCtaProofLines(data)
    .map(normalizedCopyLine)
    .filter((line) => line.length >= 12);
  if (currentProofLines.length === 0) return false;

  const patchBefore = normalizedCopyLine(fix?.patch?.before);
  const patchAfter = normalizedCopyLine(fix?.patch?.after);
  const exactEdit = normalizedCopyLine(fix?.do_this_first || fix?.instruction);
  const quote = normalizedCopyLine(fix?.quote);

  if (patchAfter && patchBefore && patchAfter === patchBefore) return true;
  return currentProofLines.some((line) =>
    (patchAfter && (patchAfter === line || patchAfter.includes(line) || line.includes(patchAfter))) ||
    (quote && (quote === line || quote.includes(line) || line.includes(quote))) ||
    (exactEdit && exactEdit.includes(line))
  );
}

function refineDuplicateCtaProofFix(
  data: any,
  fix: {
    title: string;
    instruction: string;
    where: string;
    success_metric: string;
    category: string;
  } | null
): {
  title: string;
  instruction: string;
  where: string;
  success_metric: string;
  category: string;
} | null {
  if (!fix) return null;
  const proofGap = String(
    (fix as any)?.market_profile_context?.proof_gap ||
    (fix as any)?.market_profile_context?.proof_hierarchy?.gap ||
    data?.market_profile?.proof_gap ||
    data?.meta?.proof_gap ||
    data?.meta?.market_profile?.proof_gap ||
    ""
  );
  const backendAlreadyResolvedProofHierarchy = [
    "outcome_proof_buried",
    "generic_trust_near_cta",
    "self_issued_badge_risk",
    "proof_present_but_misprioritized",
  ].includes(proofGap);
  const repeatsExistingCtaProof = fixRepeatsExistingCtaProof(data, fix);
  if (backendAlreadyResolvedProofHierarchy && !repeatsExistingCtaProof) return fix;
  if (!previewFixMentionsCtaProof(fix)) return fix;
  if (!hasExistingCtaProofSignal(data, fix)) return fix;
  if (!repeatsExistingCtaProof && isBackendProofHierarchyFix(fix)) return fix;

  return {
    ...fix,
    title: "Make the CTA proof more specific",
    instruction:
      "Keep the existing CTA-near trust line, but make it more outcome-specific. Replace vague reassurance with one concrete result, customer count, or founder quote that proves the click is worth it.",
    where: "Existing trust line near the primary CTA",
    success_metric: "Visitors see a specific reason to trust the CTA before they click",
    patch: {
      ...(fix as any).patch,
      after:
        "Replace the existing CTA-near trust line with one concrete outcome, customer count, founder quote, or named testimonial that proves the click is worth it.",
    },
  };
}

// =============================================================================
// Free Preview Fix Extraction
// Extracts ONE actionable fix for free users based on the weakest score
// =============================================================================
function extractFreePreviewFix(data: any): {
  title: string;
  instruction: string;
  where: string;
  success_metric: string;
  category: string;
} | null {
  const scores = data?.scores ?? {};
  const breakdown = data?.score_breakdown ?? {};
  
  // Find the weakest score category
  const categoryScores = [
    { key: "clarity", score: scores.clarity_100 ?? 100 },
    { key: "relevance", score: scores.relevance_100 ?? 100 },
    { key: "trust", score: scores.trust_100 ?? 100 },
    { key: "action", score: scores.action_100 ?? scores.conversion_100 ?? 100 },
  ];
  
  categoryScores.sort((a, b) => a.score - b.score);
  const weakest = categoryScores[0];
  
  if (!weakest || !breakdown[weakest.key]) {
    return null;
  }
  
  const categoryBreakdown = breakdown[weakest.key];
  const howToFix = categoryBreakdown?.how_to_fix?.[0];
  const whyThisScore = categoryBreakdown?.why_this_score?.[0];
  
  if (!howToFix) {
    return null;
  }
  
  // Map category to user-friendly title
  const categoryTitles: Record<string, string> = {
    clarity: "Make Your Message Crystal Clear",
    relevance: "Connect With Your Target Audience",
    trust: "Build Instant Credibility",
    action: "Strengthen Your Call to Action",
  };
  
  // Map category to location hint
  const categoryLocations: Record<string, string> = {
    clarity: "Above the fold headline & subheadline",
    relevance: "Hero section & value proposition",
    trust: "Social proof area (testimonials, logos, stats)",
    action: "CTA buttons & conversion elements",
  };
  
  // Map category to success metric
  const successMetrics: Record<string, string> = {
    clarity: "Visitors understand your offer in under 5 seconds",
    relevance: "Target audience recognizes themselves immediately",
    trust: "Skeptical visitors gain confidence to proceed",
    action: "More visitors click your primary CTA",
  };
  
  return {
    title: categoryTitles[weakest.key] || "Improve This Section",
    instruction: howToFix,
    where: categoryLocations[weakest.key] || "Above the fold",
    success_metric: successMetrics[weakest.key] || "Improved conversion rate",
    category: weakest.key,
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstUsableFamilyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed && isUsableBackendFamily(trimmed)) return trimmed;
  }
  return null;
}

function stringArrayFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

const GENERIC_BACKEND_FAMILIES = new Set([
  "",
  "generic",
  "generic_saas",
  "other_saas",
  "other",
  "unknown",
  "invalid_or_placeholder",
  "broken_or_placeholder",
]);

const NON_MARKET_INTENT_TAGS = new Set(["invalid_or_placeholder", "broken_or_placeholder"]);

function marketIntentTags(...values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const item of stringArrayFrom(value)) {
      const key = item.trim().toLowerCase();
      if (!key || NON_MARKET_INTENT_TAGS.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(item.trim());
    }
  }
  return out;
}

function normalizeFamilyKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasInvalidMarketFamily(value: any): boolean {
  if (!value || typeof value !== "object") return false;
  const family = normalizeFamilyKey(
    value.market_family ?? value.marketFamily ?? value.family
  );
  const subtype = normalizeFamilyKey(
    value.profile_subtype ?? value.profileSubtype ?? value.market_subtype ?? value.marketSubtype ?? value.subtype
  );
  return family === "invalid_or_placeholder" || subtype === "broken_or_placeholder";
}

function isUsableBackendFamily(value: unknown): boolean {
  const key = normalizeFamilyKey(value);
  return key.length > 0 && !GENERIC_BACKEND_FAMILIES.has(key);
}

function pickString(obj: any, keys: string[]): string {
  if (!obj || typeof obj !== "object") return "";
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pickStringArray(obj: any, keys: string[]): string[] {
  if (!obj || typeof obj !== "object") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const value = obj[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item !== "string") continue;
      const trimmed = item.trim();
      if (!trimmed) continue;
      const normalized = trimmed.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(trimmed);
    }
  }
  return out;
}

const AUTH_FAMILY_KEYS = ["market_family", "marketFamily", "family"];
const AUTH_SUBTYPE_KEYS = ["profile_subtype", "profileSubtype", "market_subtype", "marketSubtype", "subtype"];
const AUTH_INTENT_KEYS = ["profile_intent_tags", "profileIntentTags", "intent_tags", "intentTags"];
const AUTH_CONVMODEL_KEYS = ["conversion_model", "conversionModel"];

type AuthoritativeProfile = {
  family: string;
  subtype: string;
  intentTags: string[];
  conversionModel: string;
  source: "meta" | "market_profile" | "page_profile";
};

function readAuthoritativeBackendProfile(scoreData: any): AuthoritativeProfile | null {
  if (!scoreData || typeof scoreData !== "object") return null;
  const sources: Array<{ key: "meta" | "market_profile" | "page_profile"; obj: any }> = [
    { key: "meta", obj: scoreData.meta },
    { key: "meta", obj: scoreData.meta?.market_profile },
    { key: "market_profile", obj: scoreData.market_profile },
    { key: "page_profile", obj: scoreData.page_profile },
  ];
  for (const { key, obj } of sources) {
    if (!obj || typeof obj !== "object") continue;
    const family = pickString(obj, AUTH_FAMILY_KEYS);
    if (!isUsableBackendFamily(family)) continue;
    return {
      family,
      subtype: pickString(obj, AUTH_SUBTYPE_KEYS),
      intentTags: pickStringArray(obj, AUTH_INTENT_KEYS),
      conversionModel: pickString(obj, AUTH_CONVMODEL_KEYS),
      source: key,
    };
  }
  return null;
}

function buildMatcherAuxSignals(scoreData: any): AuxSignals {
  const marketContext =
    scoreData?.canonical_scan_profile ??
    scoreData?.benchmark_match_profile ??
    scoreData?.free_preview_fix?.market_profile_context ??
    scoreData?.market_profile_context ??
    scoreData?.user_snapshot?.market_profile_context ??
    {};
  const snapshot = marketContext?.input_snapshot ?? scoreData?.user_snapshot ?? {};
  const authoritative = readAuthoritativeBackendProfile(scoreData);

  return {
    fullResult: scoreData,
    intelProfile: {
      market_family: firstUsableFamilyString(
        authoritative?.family,
        marketContext?.family,
        marketContext?.market_family,
        marketContext?.benchmark_profile_family
      ),
      market_subtype: firstString(
        authoritative?.subtype,
        marketContext?.subtype,
        marketContext?.market_subtype,
        marketContext?.benchmark_profile_subtype,
        marketContext?.lp_role
      ),
      intent_tags: marketIntentTags(
        authoritative?.intentTags,
        marketContext?.intent_tags,
        marketContext?.intentTags,
        marketContext?.benchmark_profile_intent_tags
      ),
      conversion_model: firstString(
        authoritative?.conversionModel,
        marketContext?.conversion_model,
        marketContext?.conversionModel,
        scoreData?.conversion_model,
        scoreData?.free_preview_fix?.conversion_model
      ),
      input_snapshot: {
        cross_tags: [
          ...stringArrayFrom(snapshot?.cross_tags),
          ...stringArrayFrom(marketContext?.cross_tags),
        ],
        semantic_buckets: [
          ...stringArrayFrom(snapshot?.semantic_buckets),
          ...stringArrayFrom(marketContext?.semantic_buckets),
        ],
        proof_objects: [
          ...stringArrayFrom(snapshot?.proof_objects),
          ...stringArrayFrom(marketContext?.proof_objects),
        ],
        content_angles: [
          ...stringArrayFrom(snapshot?.content_angles),
          ...stringArrayFrom(marketContext?.content_angles),
        ],
      },
    },
  };
}

function buildReferenceSourceForMatcher(
  scoreData: any,
  lpUrl: string,
  inferredPageCategory: string,
  scores: {
    overallScore: number;
    clarityScore: number | null;
    relevanceScore: number | null;
    trustScore: number | null;
    conversionScore: number | null;
  }
): ScanData & { full_result: any } {
  const currentCopy = scoreData?.current_copy ?? {};
  const snapshot = scoreData?.user_snapshot ?? {};
  const nestedData = scoreData?.data ?? {};
  const insights = scoreData?.ai_insights ?? scoreData?.summary_insights ?? {};
  const primaryBottleneck = firstString(
    insights.biggest_bottleneck,
    scoreData?.primary_bottleneck,
    scoreData?.free_preview_fix?.category
  );

  const source: ScanData & { full_result: any } = {
    url: lpUrl,
    screenshot_url: null,
    // Keep this broad category only as a fallback. The matcher now ignores
    // generic buckets like "saas", "content", "lead-gen", and "other" so they
    // cannot overpower real page copy.
    page_category: firstString(nestedData.page_category, scoreData?.page_category, inferredPageCategory),
    offer_summary: firstString(
      snapshot.offer_summary,
      scoreData?.offer_summary,
      nestedData.offer_summary,
      [currentCopy.headline, currentCopy.subheadline].filter(Boolean).join(" ")
    ),
    target_audience: firstString(snapshot.target_audience, scoreData?.target_audience, nestedData.target_audience),
    overall_score: scores.overallScore,
    clarity_score: scores.clarityScore,
    relevance_score: scores.relevanceScore,
    trust_score: scores.trustScore,
    conversion_score: scores.conversionScore,
    primary_bottleneck: primaryBottleneck,
    full_result: scoreData,
  };

  const authoritative = readAuthoritativeBackendProfile(scoreData);
  if (authoritative) {
    source.benchmark_profile_family = authoritative.family;
    if (authoritative.subtype) source.benchmark_profile_subtype = authoritative.subtype;
    if (authoritative.intentTags.length) source.benchmark_profile_intent_tags = authoritative.intentTags;
    if (authoritative.conversionModel) source.benchmark_conversion_model = authoritative.conversionModel;
  }

  const canonicalProfile = deriveCanonicalScanProfile(source, buildMatcherAuxSignals(scoreData));
  return {
    ...source,
    benchmark_profile_family: canonicalProfile.family,
    benchmark_profile_subtype: canonicalProfile.subtype,
    benchmark_profile_intent_tags: canonicalProfile.intent_tags,
    benchmark_conversion_model: canonicalProfile.conversion_model,
  };
}

function buildCanonicalBenchmarkEvidence(
  source: ScanData & { full_result: any },
  matches: MatchedPage[],
  canonicalProfile = deriveCanonicalScanProfile(source, buildMatcherAuxSignals(source.full_result))
) {
  const sourceIntentTags = Array.isArray(canonicalProfile.intent_tags) ? canonicalProfile.intent_tags : [];
  const references = matches.map((match) => {
    const candidateIntentTags = Array.isArray(match._benchmarkProfile?.intentTags) ? match._benchmarkProfile.intentTags : [];
    const candidateIntentSet = new Set(candidateIntentTags.map((tag) => String(tag).trim()).filter(Boolean));
    const matchedIntentTags = Array.from(new Set([
      ...(((match as any)._sharedSpecificIntentTags || []) as string[]),
      ...(((match as any)._sharedIntentTags || []) as string[]),
      ...sourceIntentTags.filter((tag) => candidateIntentSet.has(tag)),
    ].map((tag) => String(tag || "").trim()).filter(Boolean)));
    return ({
    slug: match.id || undefined,
    name: match.benchmark_name || extractDomain(match.url),
    url: match.url,
    revenue_signal_usd: match.benchmark_revenue_signal_usd ?? undefined,
    mrr_usd: match.benchmark_mrr_usd ?? undefined,
    revenue_last_30d_usd: match.benchmark_revenue_last_30d_usd ?? undefined,
    headline: match.benchmark_headline ?? undefined,
    subheadline: match.offer_summary ?? undefined,
    primary_cta: match.benchmark_primary_cta ?? undefined,
    secondary_cta: match.benchmark_secondary_cta ?? undefined,
    trust_social_proof: match.benchmark_trust_cue ?? undefined,
    reference_status: match.benchmark_reference_status ?? undefined,
    reference_quality: match.benchmark_reference_quality ?? undefined,
    benchmark_snapshot: match.benchmark_snapshot ?? undefined,
    conversion_model: match._benchmarkProfile?.subtype ?? undefined,
    lp_role: match._matchStage,
    proof_pattern: match.benchmark_trust_cue ? "visible_proof_before_click" : undefined,
    market_family: match._benchmarkProfile?.family,
    profile_family: match._benchmarkProfile?.family,
    profile_subtype: match._benchmarkProfile?.subtype,
    intent_tags: candidateIntentTags,
    matched_intent_tags: matchedIntentTags,
    match_confidence: match._matchConfidence,
    section_order: match.benchmark_section_order ?? [],
    why_match: match._matchReasons ?? [],
    deep_intel: {
      semantic_buckets: match.benchmark_semantic_buckets ?? [],
      cross_tags: match.benchmark_cross_tags ?? [],
      proof_objects: match.benchmark_proof_objects ?? [],
      content_angles: match.benchmark_content_angles ?? [],
      market_evidence_summary: match.benchmark_market_evidence_summary ?? null,
      library_intel_version: match.benchmark_library_intel_version ?? null,
    },
    });
  });

  return {
    matcher_version: "trustmrr_canonical_v1",
    source_profile: {
      family: canonicalProfile.family,
      subtype: canonicalProfile.subtype,
      intent_tags: canonicalProfile.intent_tags,
      label: canonicalProfile.label,
      conversion_model: canonicalProfile.conversion_model,
    },
    summary: {
      total_references: references.length,
      proof_before_click_count: references.filter((ref) => Boolean(ref.trust_social_proof)).length,
      specific_cta_count: references.filter((ref) => Boolean(ref.primary_cta)).length,
      short_hero_count: references.filter((ref) => String(ref.headline || "").split(/\s+/).filter(Boolean).length <= 9).length,
    },
    references,
  };
}

function suppressesBenchmarkReferences(pageValidity: PageValidity | null | undefined, scoreData?: any): boolean {
  if (
    pageValidity?.status === "prelaunch_waitlist" &&
    String(scoreData?.trust_evidence_state || scoreData?.meta?.trust_evidence_state || "").toLowerCase() === "product_artifact_only"
  ) {
    return true;
  }
  return Boolean(
    pageValidity &&
      ["hard_broken", "soft_placeholder", "non_marketing_page"].includes(pageValidity.status)
  );
}

function buildEmptyCanonicalBenchmarkEvidence(
  canonicalProfile: ReturnType<typeof deriveCanonicalScanProfile>,
  pageValidity: PageValidity | null | undefined,
  reason: string
) {
  return {
    matcher_version: "trustmrr_canonical_v1",
    source_profile: {
      family: canonicalProfile.family,
      subtype: canonicalProfile.subtype,
      intent_tags: canonicalProfile.intent_tags,
      label: canonicalProfile.label,
      conversion_model: canonicalProfile.conversion_model,
      page_validity: pageValidity ?? null,
    },
    summary: {
      total_references: 0,
      proof_before_click_count: 0,
      specific_cta_count: 0,
      short_hero_count: 0,
      suppressed_reason: reason,
    },
    references: [],
  };
}

function safeMarketFamilyFromCanonical(canonicalProfile: ReturnType<typeof deriveCanonicalScanProfile>): string {
  return canonicalProfile.family === "generic" ? "other_saas" : canonicalProfile.family;
}

function stripInvalidSignals(value: unknown): string[] {
  return stringArrayFrom(value).filter((signal) => !/invalid_or_placeholder|broken_or_placeholder/i.test(signal));
}

function realignMarketProfileToCanonical(
  scoreData: any,
  canonicalProfile: ReturnType<typeof deriveCanonicalScanProfile>,
  pageValidity: PageValidity
) {
  const safeMarketFamily = safeMarketFamilyFromCanonical(canonicalProfile);
  const safeSubtype = canonicalProfile.subtype === "generic" ? "other_saas" : canonicalProfile.subtype;
  const safeIntentTags = Array.isArray(canonicalProfile.intent_tags) ? canonicalProfile.intent_tags : [];
  const safeLabel = canonicalProfile.label || `${safeMarketFamily} / ${safeSubtype}`;
  const safeConversionModel = canonicalProfile.conversion_model || undefined;

  const familyFor = (obj: any) => pickString(obj, ["family", "market_family", "marketFamily", "profile_family", "profileFamily"]);
  const shouldPatchProfile = (obj: any) => {
    if (!obj || typeof obj !== "object") return true;
    if (hasInvalidMarketFamily(obj)) return true;
    const family = familyFor(obj);
    if (!isUsableBackendFamily(family)) return true;
    return Boolean(
      isUsableBackendFamily(safeMarketFamily) &&
        normalizeFamilyKey(family) !== normalizeFamilyKey(safeMarketFamily)
    );
  };

  const patchProfile = (obj: any) => {
    const exists = obj && typeof obj === "object";
    const out = exists ? obj : {};
    const shouldPatch = !exists || shouldPatchProfile(out);
    out.page_validity = pageValidity;
    out.pageValidity = pageValidity;
    if (!shouldPatch) return out;
    out.family = safeMarketFamily;
    out.market_family = safeMarketFamily;
    out.marketFamily = safeMarketFamily;
    out.profile_family = safeMarketFamily;
    out.profileFamily = safeMarketFamily;
    out.profile_subtype = safeSubtype;
    out.profileSubtype = safeSubtype;
    out.market_subtype = safeSubtype;
    out.marketSubtype = safeSubtype;
    out.subtype = safeSubtype;
    out.intent_tags = safeIntentTags;
    out.intentTags = safeIntentTags;
    out.profile_intent_tags = safeIntentTags;
    out.profileIntentTags = safeIntentTags;
    if (safeConversionModel) {
      out.conversion_model = safeConversionModel;
      out.conversionModel = safeConversionModel;
    }
    out.readable_profile = safeLabel;
    out.readableProfile = safeLabel;
    out.label = safeLabel;
    out.signals = stripInvalidSignals(out.signals);
    out.canonical_override = true;
    return out;
  };

  scoreData.market_profile = patchProfile(scoreData.market_profile);
  scoreData.page_profile = patchProfile(scoreData.page_profile);
  scoreData.market_profile_context = patchProfile(scoreData.market_profile_context);
  if (scoreData.free_preview_fix && typeof scoreData.free_preview_fix === "object") {
    scoreData.free_preview_fix.market_profile_context = patchProfile(scoreData.free_preview_fix.market_profile_context);
  }
  if (scoreData.user_snapshot?.market_profile_context && typeof scoreData.user_snapshot.market_profile_context === "object") {
    scoreData.user_snapshot.market_profile_context = patchProfile(scoreData.user_snapshot.market_profile_context);
  }
  if (scoreData.meta && typeof scoreData.meta === "object") {
    scoreData.meta.market_profile = patchProfile(scoreData.meta.market_profile);
    if (shouldPatchProfile(scoreData.meta)) {
      scoreData.meta.family = safeMarketFamily;
      scoreData.meta.market_family = safeMarketFamily;
      scoreData.meta.marketFamily = safeMarketFamily;
      scoreData.meta.profile_family = safeMarketFamily;
      scoreData.meta.profileFamily = safeMarketFamily;
      scoreData.meta.profile_subtype = safeSubtype;
      scoreData.meta.profileSubtype = safeSubtype;
      scoreData.meta.market_subtype = safeSubtype;
      scoreData.meta.marketSubtype = safeSubtype;
      scoreData.meta.subtype = safeSubtype;
      scoreData.meta.profile_intent_tags = safeIntentTags;
      scoreData.meta.profileIntentTags = safeIntentTags;
      scoreData.meta.intent_tags = safeIntentTags;
      scoreData.meta.intentTags = safeIntentTags;
      if (safeConversionModel) {
        scoreData.meta.conversion_model = safeConversionModel;
        scoreData.meta.conversionModel = safeConversionModel;
      }
      scoreData.meta.readable_profile = safeLabel;
      scoreData.meta.readableProfile = safeLabel;
      scoreData.meta.label = safeLabel;
      scoreData.meta.canonical_override = true;
    }
    scoreData.meta.page_validity = pageValidity;
    scoreData.meta.pageValidity = pageValidity;
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasVerifiedReferenceQuality(ref: unknown): boolean {
  const record = readRecord(ref);
  const quality = readRecord(record.reference_quality);
  const status = String(record.reference_status || record.referenceStatus || quality.status || "").trim();
  if (status === "verified" || status === "corrected") return true;
  return Boolean(
    quality.can_use_as_revenue_backed_reference ||
      quality.canUseAsRevenueBackedReference
  );
}

function hasUsableBackendBenchmarkEvidence(
  scoreData: any,
  canonicalProfile?: ReturnType<typeof deriveCanonicalScanProfile> | null
): boolean {
  const evidence = scoreData?.benchmark_evidence;
  if (!evidence || typeof evidence !== "object") return false;
  // Only skip rebuilding when the evidence was already produced by the
  // canonical matcher. Upstream/LLM-provided benchmark_evidence can be
  // same-family and verified, but still be too broad for reference-specific
  // winning patterns. Always route those through querySimilarPages so the
  // shared purity gates and proof-object filters apply.
  if (String(evidence.matcher_version || "").trim() !== "trustmrr_canonical_v1") return false;
  const refs = Array.isArray(evidence.references) ? evidence.references : [];
  if (refs.length === 0) return false;

  const source = evidence.source_profile && typeof evidence.source_profile === "object"
    ? evidence.source_profile
    : {};
  const family = pickString(source, ["family", "market_family", "marketFamily", "profile_family", "profileFamily"]);
  if (!isUsableBackendFamily(family)) return false;
  if (
    canonicalProfile?.family &&
    isUsableBackendFamily(canonicalProfile.family) &&
    normalizeFamilyKey(family) !== normalizeFamilyKey(canonicalProfile.family)
  ) {
    return false;
  }
  const authoritative = readAuthoritativeBackendProfile(scoreData);
  if (authoritative && normalizeFamilyKey(family) !== normalizeFamilyKey(authoritative.family)) {
    return false;
  }

  return refs.some((ref: unknown) => {
    if (!ref || typeof ref !== "object") return false;
    if (!hasVerifiedReferenceQuality(ref)) return false;
    const refFamily = pickString(ref, ["market_family", "marketFamily", "profile_family", "profileFamily"]);
    return normalizeFamilyKey(refFamily) === normalizeFamilyKey(family);
  });
}

async function applyCanonicalBenchmarkEvidence(
  supabaseAdmin: SupabaseClient,
  scoreData: any,
  lpUrl: string,
  inferredPageCategory: string,
  requestId: string,
  scores: {
    overallScore: number;
    clarityScore: number | null;
    relevanceScore: number | null;
    trustScore: number | null;
    conversionScore: number | null;
  }
) {
  const source = buildReferenceSourceForMatcher(scoreData, lpUrl, inferredPageCategory, scores);
  const aux = buildMatcherAuxSignals(scoreData);
  const canonicalProfile = deriveCanonicalScanProfile(source, aux);
  source.benchmark_profile_family = canonicalProfile.family;
  source.benchmark_profile_subtype = canonicalProfile.subtype;
  source.benchmark_profile_intent_tags = canonicalProfile.intent_tags;
  source.benchmark_conversion_model = canonicalProfile.conversion_model || undefined;
  const pageValidity = derivePageValidity(source);
  (scoreData as any).page_validity = pageValidity;
  realignMarketProfileToCanonical(scoreData, canonicalProfile, pageValidity);
  const profile = getScanMatchProfile(source);
  (scoreData as any).canonical_scan_profile = canonicalProfile;
  (scoreData as any).benchmark_match_profile = profile;

  if (hasUsableBackendBenchmarkEvidence(scoreData, canonicalProfile)) {
    const evidence = scoreData?.benchmark_evidence;
    const sourceProfile = evidence?.source_profile && typeof evidence.source_profile === "object"
      ? evidence.source_profile
      : {};
    const refs = Array.isArray(evidence?.references) ? evidence.references : [];
    console.log(`[${requestId}] Canonical benchmark evidence skipped: backend evidence already usable`, {
      lpUrl,
      family: pickString(sourceProfile, ["family", "market_family", "marketFamily", "profile_family", "profileFamily"]),
      refs: refs.slice(0, 5).map((ref: any) => ({
        name: ref?.name,
        family: ref?.market_family || ref?.profile_family,
        subtype: ref?.profile_subtype,
        matched_intent_tags: Array.isArray(ref?.matched_intent_tags) ? ref.matched_intent_tags : [],
      })),
    });
    return;
  }

  const authoritative = readAuthoritativeBackendProfile(scoreData);
  if (
    authoritative &&
    canonicalProfile?.family &&
    normalizeFamilyKey(canonicalProfile.family) !== normalizeFamilyKey(authoritative.family)
  ) {
    console.warn(`[${requestId}] Canonical benchmark evidence overriding conflicting backend family`, {
      lpUrl,
      authoritative_family: authoritative.family,
      authoritative_source: authoritative.source,
      canonical_family: canonicalProfile.family,
      canonical_subtype: canonicalProfile?.subtype ?? null,
    });
  }

  if (suppressesBenchmarkReferences(pageValidity, scoreData)) {
    (scoreData as any).benchmark_evidence = buildEmptyCanonicalBenchmarkEvidence(
      canonicalProfile,
      pageValidity,
      (scoreData as any)?.trust_evidence_state === "product_artifact_only"
        ? "trust_evidence_state:product_artifact_only"
        : `page_validity:${pageValidity.status}`
    );
    console.warn(`[${requestId}] Canonical benchmark evidence suppressed by page validity`, {
      lpUrl,
      page_validity: pageValidity,
      profile: canonicalProfile,
    });
    return;
  }

  const matches = await querySimilarPages(supabaseAdmin, source, 3, { aux, requestId });
  console.log(`[${requestId}] canonicalBenchmarkEvidence:after_query`, {
    event: "canonicalBenchmarkEvidence:after_query",
    requestId,
    url: lpUrl,
    source_family: canonicalProfile?.family ?? null,
    source_subtype: canonicalProfile?.subtype ?? null,
    query_returned_count: matches.length,
    query_returned_names: matches.map((match) => match.benchmark_name ?? null).slice(0, 20),
    query_returned_families: matches.map((match) => match._benchmarkProfile?.family ?? null).slice(0, 20),
    final_benchmark_reference_count: null,
    suppressed_reason: null,
    status: matches.length === 0 ? "empty_from_matcher" : "matcher_returned",
  });
  if (matches.length === 0) {
    (scoreData as any).benchmark_evidence = buildEmptyCanonicalBenchmarkEvidence(
      canonicalProfile,
      pageValidity,
      `no_references_for_family:${canonicalProfile.family}`
    );
    console.warn(`[${requestId}] Canonical benchmark evidence skipped: no matches`, {
      lpUrl,
      profile: canonicalProfile,
    });
    return;
  }

  (scoreData as any).benchmark_evidence = buildCanonicalBenchmarkEvidence(source, matches, canonicalProfile);
  console.log(`[${requestId}] Canonical benchmark evidence applied`, {
    lpUrl,
    profile: canonicalProfile,
    final_benchmark_reference_count: matches.length,
    status: "applied",
    references: matches.map((match) => ({
      name: match.benchmark_name,
      family: match._benchmarkProfile?.family,
      stage: match._matchStage,
      confidence: match._matchConfidence,
    })),
  });
}

// sanitizeForFree is now imported from ../_shared/sanitize-free.ts

/**
 * FIXED BILLING LOGIC — Split entitlement check + post-success credit consumption.
 *
 * CONCURRENCY POLICY:
 * We prioritize avoiding false credit loss over preventing rare extra results.
 * After moving credit consumption to post-n8n-success, a rare race condition
 * (two tabs pass entitlement, both get n8n results, only one atomic UPDATE succeeds)
 * checkScanEntitlement atomically reserves a free slot before the expensive
 * backend call. The request-level finally block refunds it on failure.
 * Paid plans are still tracked only after a successful result.
 */

interface EntitlementResult {
  plan: string;
  canScan: boolean;
  scanCount: number;
  scanLimit: number;
  remainingScans: number;
  /** Free allowance is atomically reserved before the expensive backend call. */
  freeCreditReserved?: boolean;
  /** UTC month owning the reservation, so a late refund cannot alter a newer month. */
  freeCreditPeriodStart?: string;
  /** If set, this scan is funded by a prepurchased $9 credit (pdf_purchases.id) */
  creditId?: string;
  confirmationRescan?: boolean;
  /** The stripe_session_id from the prepurchased credit row, used to stamp pdf_session_id */
  creditStripeSessionId?: string;
}

/** Window in which a $9 buyer may re-scan the page they paid for, to check the edit. */
const CONFIRMATION_RESCAN_WINDOW_DAYS = 14;
/** Generous cap: the promise is one confirmation, the buffer avoids denying a paying customer. */
const CONFIRMATION_RESCAN_MAX = 2;

function normalizedUrlKey(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/**
 * $9 buys the decision for one page, and the only way to learn whether the edit worked
 * is to scan that page again. Charging a second time for the answer put the proof of
 * value behind another paywall, so the loop never closed: of 534 improvement records
 * only 73 showed a page that had actually changed.
 *
 * Grants scan_unlock — without consuming a credit — when the same user re-scans a URL
 * they already paid to unlock, inside the window and under the cap. Fails open by
 * design: the downside is a handful of $0.07 scans, the downside of failing closed is a
 * paying customer being denied something the paywall promised.
 */
async function findConfirmationRescanGrant(
  supabase: any,
  userId: string,
  lpUrl: string | null | undefined,
): Promise<{ granted: boolean; purchaseScanId?: string; rescanCount?: number }> {
  const target = normalizedUrlKey(lpUrl);
  if (!userId || !target) return { granted: false };

  try {
    const cutoff = new Date(Date.now() - CONFIRMATION_RESCAN_WINDOW_DAYS * 86400000).toISOString();
    const { data: purchases } = await supabase
      .from("pdf_purchases")
      .select("scan_id, created_at")
      .eq("user_id", userId)
      .eq("status", "consumed")
      .not("scan_id", "is", null)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(10);

    for (const purchase of Array.isArray(purchases) ? purchases : []) {
      const { data: paidScan } = await supabase
        .from("lp_scan_history")
        .select("url")
        .eq("id", purchase.scan_id)
        .maybeSingle();
      if (normalizedUrlKey(paidScan?.url) !== target) continue;

      // Count scans of this page since the purchase; the paid scan itself is older.
      const { count } = await supabase
        .from("lp_scan_history")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gt("created_at", purchase.created_at);
      const rescanCount = Number(count ?? 0);
      if (rescanCount >= CONFIRMATION_RESCAN_MAX) {
        console.log("[Billing] Confirmation rescan cap reached", { target, rescanCount });
        return { granted: false, rescanCount };
      }
      return { granted: true, purchaseScanId: purchase.scan_id as string, rescanCount };
    }
  } catch (error) {
    console.warn("[Billing] Confirmation rescan lookup failed (non-fatal):", error);
  }
  return { granted: false };
}

async function checkScanEntitlement(
  supabase: any,
  userId: string,
  lpUrl?: string | null
): Promise<EntitlementResult> {
  console.log(`[Billing] ===== START checkScanEntitlement =====`);
  console.log(`[Billing] userId: ${userId}`);

  // Fetch user's plan from profiles
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("plan")
    .eq("id", userId)
    .maybeSingle();

  if (profileError) {
    console.error("[Billing] Error fetching profile:", profileError);
    throw new Error("Failed to verify billing status");
  }

  const profileData = profile as { plan?: string } | null;
  const plan = profileData?.plan || "free";
  console.log(`[Billing] User plan from profiles: ${plan}`);

  // =========================================================================
  // FREE USER LOGIC — READ-ONLY ENTITLEMENT CHECK
  // =========================================================================
  if (plan === "free") {
    console.log(`[Billing] Processing FREE user entitlement check...`);

    // Fetch current scan usage including frozen limit
    const { data: usage, error: usageError } = await supabase
      .from("lp_scan_usage")
      .select("scan_count, free_scan_limit, last_scan_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (usageError) {
      console.error("[Billing] Error fetching free user usage:", usageError);
      throw new Error("Failed to verify scan usage");
    }

    const usageData = usage as { scan_count?: number; free_scan_limit?: number | null; last_scan_at?: string | null } | null;
    let currentScanCount = usageData?.scan_count ?? 0;
    let effectiveLimit = usageData?.free_scan_limit ?? null;

    // Every free account gets a fresh base scan each UTC calendar month.
    // Keep the lifetime scan counter table for compatibility, but reset the
    // enforceable period lazily on the first scan attempt of a new month.
    // A one-time share bonus expires with the month in which it was claimed.
    const monthStartIso = getCurrentMonthStartIso();
    const startsNewMonthlyPeriod = Boolean(
      usageData && (!usageData.last_scan_at || usageData.last_scan_at < monthStartIso)
    );
    if (startsNewMonthlyPeriod) {
      const resetAt = new Date().toISOString();
      const { data: resetRow, error: resetError } = await supabase
        .from("lp_scan_usage")
        .update({
          scan_count: 0,
          free_scan_limit: FREE_SCAN_LIMIT_NEW_USER,
          last_scan_at: resetAt,
        })
        .eq("user_id", userId)
        .or(`last_scan_at.is.null,last_scan_at.lt.${monthStartIso}`)
        .select("scan_count, free_scan_limit, last_scan_at")
        .maybeSingle();

      if (resetError) {
        console.error("[Billing] Failed to start monthly free period:", resetError);
        throw new Error("Failed to refresh monthly scan allowance");
      }
      if (resetRow) {
        currentScanCount = 0;
        effectiveLimit = FREE_SCAN_LIMIT_NEW_USER;
        console.log("[Billing] Started new monthly free period", { userId, monthStartIso });
      } else {
        // Another request won the conditional reset. Use its latest counters;
        // never reset the already-reserved slot back to zero.
        const { data: latestUsage, error: latestUsageError } = await supabase
          .from("lp_scan_usage")
          .select("scan_count, free_scan_limit")
          .eq("user_id", userId)
          .maybeSingle();
        if (latestUsageError) throw new Error("Failed to refresh monthly scan allowance");
        currentScanCount = Number((latestUsage as any)?.scan_count ?? 0);
        effectiveLimit = Number((latestUsage as any)?.free_scan_limit ?? FREE_SCAN_LIMIT_NEW_USER);
      }
    }

    const confirmation = await findConfirmationRescanGrant(supabase, userId, lpUrl);
    if (confirmation.granted) {
      console.log(`[Billing] *** CONFIRMATION RESCAN GRANTED (already paid for this page) ***`, {
        userId,
        purchaseScanId: confirmation.purchaseScanId,
        rescanCount: confirmation.rescanCount,
      });
      return {
        plan: "free",
        remainingScans: Math.max(0, (effectiveLimit ?? FREE_SCAN_LIMIT_NEW_USER) - currentScanCount),
        scanLimit: effectiveLimit ?? FREE_SCAN_LIMIT_NEW_USER,
        confirmationRescan: true,
      };
    }

    console.log(`[Billing] Free user state:`, { currentScanCount, effectiveLimit });

    // For brand-new users (no row yet), create row with default limit
    if (!usageData) {
      const { error: insertError } = await supabase
        .from("lp_scan_usage")
        .insert({
          user_id: userId,
          scan_count: 0,
          last_scan_at: new Date().toISOString(),
          free_scan_limit: FREE_SCAN_LIMIT_NEW_USER,
        });

      if (insertError) {
        console.log(`[Billing] Insert race (expected):`, insertError.message);
      } else {
        console.log(`[Billing] Created new usage record with limit: ${FREE_SCAN_LIMIT_NEW_USER}`);
      }
      effectiveLimit = FREE_SCAN_LIMIT_NEW_USER;
    }

    // Safety: for NEW entitlement decisions, cap at MAX_FREE_LIMIT
    // (grace users with higher limits from the one-time reset are grandfathered —
    // their DB value is already set correctly and will drain naturally)
    const MAX_FREE_LIMIT = 2;
    const rawLimit = effectiveLimit ?? FREE_SCAN_LIMIT_NEW_USER;
    // Trust DB value if it's above MAX (grace reset set scan_count+1 for exhausted users)
    // but prevent any NEW writes from exceeding MAX
    const finalLimit = rawLimit;
    const canScan = currentScanCount < finalLimit;
    const remainingScans = Math.max(0, finalLimit - currentScanCount);

    // A paid one-page credit always wins over the free allowance. Otherwise a
    // customer can pay $9, run a scan, and still receive the free/sanitized UX
    // while their paid credit remains unused.
    const { data: creditId, error: creditError } = await supabase
      .rpc("claim_prepurchased_credit", { p_user_id: userId })
      .maybeSingle();

    if (creditError) {
      console.error("[Billing] Error claiming prepurchased credit:", creditError);
    }

    if (creditId) {
      console.log(`[Billing] *** PREPURCHASED CREDIT CLAIMED BEFORE FREE ALLOWANCE ***`, { userId, creditId });

      const { data: creditRow, error: creditRowError } = await supabase
        .from("pdf_purchases")
        .select("stripe_session_id")
        .eq("id", creditId)
        .single();

      if (creditRowError || !(creditRow as any)?.stripe_session_id) {
        console.error("[Billing] Claimed credit is missing its Stripe session; releasing reservation", creditRowError);
        await supabase
          .from("pdf_purchases")
          .update({ status: "available", reserved_at: null })
          .eq("id", creditId)
          .eq("user_id", userId)
          .eq("status", "reserved");
        throw new Error("Failed to verify purchased scan credit");
      }

      return {
        plan: "free",
        canScan: true,
        scanCount: currentScanCount,
        scanLimit: finalLimit,
        remainingScans,
        creditId,
        creditStripeSessionId: (creditRow as any).stripe_session_id,
      };
    }

    if (!canScan) {
      console.log(`[Billing] Free limit exceeded and no prepurchased credit is available`, { userId, finalLimit, currentScanCount });
      throw {
        code: "LIMIT_EXCEEDED",
        plan: "free",
        remainingScans: 0,
        scanLimit: finalLimit,
      };
    }

    // Reserve before Browserless/scoring starts. The previous post-response
    // increment let concurrent cloned requests all receive a result while only
    // one increment succeeded. The outer finally block refunds this reservation
    // on every unsuccessful return.
    const { data: reservedUsage, error: reservationError } = await supabase
      .rpc("consume_scan_credit_atomic", { p_user_id: userId })
      .maybeSingle();
    if (reservationError) {
      console.error("[Billing] Failed to reserve monthly free scan:", reservationError);
      throw new Error("Failed to reserve monthly scan allowance");
    }
    if (!reservedUsage) {
      throw {
        code: "LIMIT_EXCEEDED",
        plan: "free",
        remainingScans: 0,
        scanLimit: finalLimit,
      };
    }
    const reservedCount = Number((reservedUsage as any).scan_count ?? currentScanCount + 1);
    const reservedLimit = Number((reservedUsage as any).free_scan_limit ?? finalLimit);

    console.log(`[Billing] *** FREE SCAN RESERVED ***`, {
      userId,
      reservedCount,
      reservedLimit,
    });

    console.log(`[Billing] ===== END checkScanEntitlement =====`);

    return {
      plan: "free",
      canScan: true,
      scanCount: reservedCount,
      scanLimit: reservedLimit,
      remainingScans: Math.max(0, reservedLimit - reservedCount),
      freeCreditReserved: true,
      freeCreditPeriodStart: monthStartIso,
    };
  }

  // =========================================================================
  // PAID USER LOGIC — UNLIMITED SCANS (Pro, Lifetime, legacy Agency)
  // =========================================================================
  if (isPaidUser(plan)) {
    console.log(`[Billing] Paid user (${plan}) — unlimited scans, entitled`);
    console.log(`[Billing] ===== END checkScanEntitlement =====`);
    return {
      plan,
      canScan: true,
      scanCount: 0,
      scanLimit: 999999,
      remainingScans: 999999,
    };
  }

  // Fallback: unknown plan treated as free (shouldn't happen)
  console.log(`[Billing] Unknown plan "${plan}" — treating as free, denying`);
  throw { code: "LIMIT_EXCEEDED", plan: "free", remainingScans: 0, scanLimit: 2 };
}

/**
 * consumeScanCredit — Called ONLY after successful n8n response.
 * Atomic conditional UPDATE prevents race conditions.
 * For paid users, increments for tracking only (no limit enforcement).
 */
async function consumeScanCredit(
  supabase: any,
  userId: string,
  entitlement: EntitlementResult
): Promise<{ remainingScans: number; scanLimit: number }> {
  console.log(`[Billing] ===== START consumeScanCredit =====`);

  if (isPaidUser(entitlement.plan)) {
    // Paid users: increment for tracking only (no limit enforcement)
    const { data: usage } = await supabase
      .from("lp_scan_usage")
      .select("scan_count")
      .eq("user_id", userId)
      .maybeSingle();

    const usageData = usage as { scan_count?: number } | null;
    const currentScanCount = usageData?.scan_count ?? 0;

    if (usageData) {
      await supabase
        .from("lp_scan_usage")
        .update({
          scan_count: currentScanCount + 1,
          last_scan_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    } else {
      // Paid user with no usage row — create with correct default limit (not 999999).
      // If they downgrade to free later, they'll have a sane limit.
      await supabase
        .from("lp_scan_usage")
        .insert({
          user_id: userId,
          scan_count: 1,
          last_scan_at: new Date().toISOString(),
          free_scan_limit: FREE_SCAN_LIMIT_NEW_USER,
        });
    }

    console.log(`[Billing] Paid user credit tracked (no enforcement)`);
    console.log(`[Billing] ===== END consumeScanCredit =====`);
    return { remainingScans: 999999, scanLimit: 999999 };
  }

  // FREE USER: Atomic conditional UPDATE using RPC-style SQL increment
  // IMPORTANT: Use raw SQL increment (scan_count + 1) instead of stale snapshot
  // to prevent race conditions when multiple scans fire concurrently.
  const { data: atomicResult, error: atomicError } = await supabase
    .rpc("consume_scan_credit_atomic", { p_user_id: userId })
    .maybeSingle();

  if (atomicError) {
    console.error("[Billing] Atomic credit consumption error:", atomicError);
    // Don't throw — the user already got the result. Log for monitoring.
    console.log(`[Billing] ===== END consumeScanCredit (error, not blocking) =====`);
    return { remainingScans: entitlement.remainingScans, scanLimit: entitlement.scanLimit };
  }

  if (!atomicResult) {
    // Race condition: another tab consumed the last credit during n8n call.
    // User already received the result — we accept this rare case per concurrency policy.
    console.log(`[Billing] Race condition: credit already consumed by concurrent request. Accepting.`);
    console.log(`[Billing] ===== END consumeScanCredit (race, accepted) =====`);
    return { remainingScans: 0, scanLimit: entitlement.scanLimit };
  }

  const newScanCount = atomicResult.scan_count;
  const finalLimit = atomicResult.free_scan_limit;
  const remainingAfterScan = Math.max(0, finalLimit - newScanCount);

  console.log(`[Billing] *** CREDIT CONSUMED ***`, {
    userId,
    scanNumber: newScanCount,
    finalLimit,
    remainingAfterScan,
    willBeBlockedNextTime: remainingAfterScan === 0,
  });

  console.log(`[Billing] ===== END consumeScanCredit =====`);
  return { remainingScans: remainingAfterScan, scanLimit: finalLimit };
}

serve(async (req) => {
  // Use the browser-generated ID when it has the expected opaque shape. This lets a
  // browser recover only the history row produced by this invocation after a response
  // relay/network drop, instead of guessing from "same URL in the last two minutes".
  const clientRequestId = (req.headers.get("x-lb-client-request-id") || "").trim();
  const requestId = /^[A-Za-z0-9_-]{8,64}$/.test(clientRequestId)
    ? clientRequestId
    : crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();
  const edgeStageTimingsMs: Record<string, number> = {};

  const logEdgeStage = (
    stage: string,
    status: "started" | "finished" | "failed" | "summary",
    extra: Record<string, unknown> = {},
  ) => {
    try {
      console.log(`[${requestId}] EDGE_STAGE ${stage}`, {
        status,
        elapsed_ms: Date.now() - t0,
        ...extra,
      });
    } catch {
      // Logging must never affect scan completion.
    }
  };

  const recordEdgeStage = (
    stage: string,
    durationMs: number,
    status: "finished" | "failed",
    extra: Record<string, unknown> = {},
  ) => {
    edgeStageTimingsMs[`${stage}_ms`] = durationMs;
    logEdgeStage(stage, status, {
      duration_ms: durationMs,
      edge_stage_timings_ms: edgeStageTimingsMs,
      ...extra,
    });
  };

  const timeEdgeStage = async <T>(
    stage: string,
    fn: () => T | PromiseLike<T>,
    extra: Record<string, unknown> = {},
  ): Promise<T> => {
    const startedAt = Date.now();
    logEdgeStage(stage, "started", extra);
    try {
      const result = await fn();
      recordEdgeStage(stage, Date.now() - startedAt, "finished", extra);
      return result;
    } catch (error) {
      recordEdgeStage(stage, Date.now() - startedAt, "failed", {
        ...extra,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const timeEdgeStageSync = <T>(
    stage: string,
    fn: () => T,
    extra: Record<string, unknown> = {},
  ): T => {
    const startedAt = Date.now();
    logEdgeStage(stage, "started", extra);
    try {
      const result = fn();
      recordEdgeStage(stage, Date.now() - startedAt, "finished", extra);
      return result;
    } catch (error) {
      recordEdgeStage(stage, Date.now() - startedAt, "failed", {
        ...extra,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  // ==========================================================================
  // Log key headers for debugging environment detection
  // ==========================================================================
  console.log(`[${requestId}] Headers`, {
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    host: req.headers.get("host"),
    "x-forwarded-host": req.headers.get("x-forwarded-host"),
    "x-forwarded-for": req.headers.get("x-forwarded-for"),
    "cf-connecting-ip": req.headers.get("cf-connecting-ip"),
    "user-agent": req.headers.get("user-agent"),
  });

  // ==========================================================================
  // Origin-based environment detection (replaces LB_ENV)
  // ==========================================================================
  const originHost = getRequestOriginHost(req);
  const isProduction = originHost ? isProductionHost(originHost) : true; // secure default
  const isPreview = originHost ? isPreviewHost(originHost) : false;
  const canUseLocalDebugBillingOverride = originHost ? isLocalDebugHost(originHost) : false;

  console.log(`[${requestId}] env`, {
    originHost,
    isProduction,
    isPreview,
    canUseLocalDebugBillingOverride,
  });

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Only allow POST
  if (req.method !== "POST") {
    console.log(`[${requestId}] Method not allowed:`, req.method);
    return new Response(
      JSON.stringify({ ok: false, error: "Method not allowed" }),
      { status: 405, headers: corsHeaders }
    );
  }

  // Hoisted so the outer catch can still mark a failed scan_attempt_events row.
  let outerScanAttemptEventId: string | null = null;
  // If a prepaid credit is reserved, release it on every early return/error path
  // unless the successful history insert explicitly consumes it below.
  let reservedCreditForCleanup: { userId: string; creditId: string } | null = null;
  let reservedFreeCreditForCleanup: { userId: string; periodStart: string } | null = null;
  try {
    // Parse request body
    let body: {
      lpUrl?: string;
      url?: string;
      compact?: boolean;
      responseMode?: "full" | "compact";
      freePreviewMode?: boolean;
      pdf_session_id?: string;
      debugBillingOverride?: LocalDebugBillingOverrideMode;
    };
    try {
      body = await req.json();
    } catch {
      console.log(`[${requestId}] Invalid JSON body`);
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid JSON body" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Extract freePreviewMode flag (will be validated with user email later)
    const freePreviewModeRequested = body.freePreviewMode === true;
    const requestedDebugBillingOverride = parseLocalDebugBillingOverride(body.debugBillingOverride);
    const requestUrl = new URL(req.url);
    const compactResponseRequested =
      body.responseMode === "compact" ||
      body.compact === true ||
      requestUrl.searchParams.get("compact") === "true";
    
    // Extract pdf_session_id for $9 one-page purchase tracking
    const pdfSessionId = body.pdf_session_id || null;

    // Validate lpUrl presence - support both "url" and "lpUrl" keys
    const lpUrl = body.lpUrl || body.url;
    if (!lpUrl || typeof lpUrl !== "string") {
      console.log(`[${requestId}] lpUrl is required but was:`, lpUrl);
      return new Response(
        JSON.stringify({ ok: false, error: "lpUrl is required" }),
        { status: 400, headers: corsHeaders }
      );
    }
    
    console.log(`[${requestId}] Request params:`, { 
      lpUrl, 
      hasPdfSessionId: !!pdfSessionId,
      freePreviewModeRequested,
      requestedDebugBillingOverride,
      compactResponseRequested,
    });

    // SSRF Protection: Validate URL before any downstream processing
    const urlValidation = validateUrlForSsrf(lpUrl);
    if (!urlValidation.valid) {
      console.log(`[${requestId}] URL validation failed:`, urlValidation.error);
      return new Response(
        JSON.stringify({
          ok: false,
          error: urlValidation.error || "Invalid or restricted URL",
          code: "INVALID_URL",
        }),
        { status: 400, headers: corsHeaders }
      );
    }

    console.log(`[${requestId}] Processing LP score request for URL:`, lpUrl);

    // Initialize Supabase client with service role for billing checks
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Create client with anon key to verify user's JWT
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);

    // Create admin client for database operations
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Extract and verify user from auth header
    let userId: string | null = null;
    let attemptUserEmail: string | null = null;
    let authError: Error | null = null;
    let profilePlan: string | null = null;
    let profileError: Error | null = null;
    let billingInfo: {
      plan: string;
      remainingScans: number;
      scanLimit: number;
      source?: "ui" | "api";
      api_calls_used?: number;
      api_calls_limit?: number;
      api_calls_remaining?: number;
    } | null = null;
    let scanEntitlement: EntitlementResult | null = null;
    let apiKeyAuth: ApiKeyAuthContext | null = null;
    const activeLocalDebugBillingOverride = canUseLocalDebugBillingOverride
      ? requestedDebugBillingOverride
      : "none";
    const localDebugBillingOverrideActive = activeLocalDebugBillingOverride !== "none";
    const localDebugPremiumUnlock =
      activeLocalDebugBillingOverride === "full_scan" || activeLocalDebugBillingOverride === "lifetime";

    // ==========================================================================
    // Preview Pro Mode: Detect by hostname (Origin/Referer header)
    // Preview hosts (*.lovable.app, *.lovableproject.com) get Pro access
    // with no billing checks or DB state changes
    // ==========================================================================
    const previewPro = isPreview; // isPreview is already calculated from originHost
    
    console.log(`[${requestId}] Preview Pro check`, {
      originHost,
      isPreview,
      previewPro,
    });

    const authHeader = req.headers.get("authorization");
    const hasAuthHeader = !!authHeader?.startsWith("Bearer ");

    // ==========================================================================
    // UNLIMITED TEST ACCOUNTS: Skip billing checks for specific test emails
    // These users can scan without any limits, but their plan remains unchanged
    // Emails are loaded from environment variable for security
    // ==========================================================================
    const UNLIMITED_TEST_EMAILS = Deno.env.get("UNLIMITED_TEST_EMAILS")
      ?.split(",")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean) || [];

    // ==========================================================================
    // FREE PREVIEW MODE: Allowed ONLY for specific email
    // When active: skip billing, no DB writes, return sanitized Free user response
    // ==========================================================================
    const FREE_PREVIEW_ALLOWED_EMAIL = "contact@ysk-automation.com";

    console.log(`[${requestId}] [LIMIT_BYPASS_CHECK] Request received`, { 
      hasAuthHeader, 
      origin: req.headers.get("origin"), 
      host: req.headers.get("host"),
      previewPro,
      isProduction,
      hasUnlimitedTestConfig: UNLIMITED_TEST_EMAILS.length > 0,
      freePreviewModeRequested,
      activeLocalDebugBillingOverride,
    });

    // Track if Free Preview Mode is active (validated server-side)
    let isFreePreviewModeActive = false;
    let isBypassUser = false;
    let isUnlimitedUser = false;

    if (hasAuthHeader && authHeader!.replace("Bearer ", "").trim().startsWith(API_KEY_PREFIX)) {
      const apiKey = authHeader!.replace("Bearer ", "").trim();
      const apiAuthResult = await authenticateApiKeyForScan(supabaseAdmin, apiKey, requestId);
      if (apiAuthResult instanceof Response) return apiAuthResult;

      apiKeyAuth = apiAuthResult;
      userId = apiKeyAuth.userId;
      profilePlan = apiKeyAuth.plan;
      billingInfo = {
        plan: apiKeyAuth.plan,
        remainingScans: Math.max(0, apiKeyAuth.monthlyLimit - apiKeyAuth.monthlyUsedBefore),
        scanLimit: apiKeyAuth.monthlyLimit,
        source: "api",
        api_calls_used: apiKeyAuth.monthlyUsedBefore,
        api_calls_limit: apiKeyAuth.monthlyLimit,
        api_calls_remaining: Math.max(0, apiKeyAuth.monthlyLimit - apiKeyAuth.monthlyUsedBefore),
      };

      console.log(`[${requestId}] API key authenticated`, {
        userId,
        plan: apiKeyAuth.plan,
        monthlyUsedBefore: apiKeyAuth.monthlyUsedBefore,
        monthlyLimit: apiKeyAuth.monthlyLimit,
      });
    } else if (hasAuthHeader) {
      const token = authHeader!.replace("Bearer ", "");
      const {
        data: { user },
        error: userError,
      } = await supabaseAuth.auth.getUser(token);

      if (userError) {
        authError = new Error(userError.message);
        console.log(`[${requestId}] Auth error:`, userError.message);
      } else if (user) {
        userId = user.id;
        const userEmail = user.email || null;
        attemptUserEmail = userEmail;
        const userEmailLower = userEmail?.toLowerCase()?.trim() || null;
        isUnlimitedUser = !!(userEmailLower && UNLIMITED_TEST_EMAILS.includes(userEmailLower));
        
        // ==========================================================================
        // BYPASS USER CHECK: Loaded from env vars (secure)
        // If env vars are missing, bypass is disabled entirely (secure default)
        // ==========================================================================
        const bypassConfig = getBypassConfig();
        const isBypassUserById = bypassConfig.userId && userId === bypassConfig.userId;
        const isBypassUserByEmail = bypassConfig.email && userEmailLower === bypassConfig.email;
        // Primary: userId match. Secondary: email match (fallback if email present)
        isBypassUser = !!(isBypassUserById && (isBypassUserByEmail || !userEmailLower));
        
        // ==========================================================================
        // BYPASS USER LOGGING: Always log for debugging (mask sensitive data)
        // ==========================================================================
        const maskEmail = (email: string | null): string => {
          if (!email) return "null";
          if (email.length <= 6) return "***";
          return `${email.slice(0, 3)}***${email.slice(-4)}`;
        };
        
        const bypassDiagnostics = {
          userId,
          bypassConfigured: !!bypassConfig.userId,
          userIdMatches: isBypassUserById,
          userEmailMasked: maskEmail(userEmailLower),
          emailMatches: isBypassUserByEmail,
          isBypassUser,
          reason: !bypassConfig.userId 
            ? "bypass_not_configured" 
            : !isBypassUserById 
              ? "user_id_mismatch" 
              : !isBypassUserByEmail && userEmailLower
                ? "email_mismatch_but_id_ok"
                : "bypass_active",
        };
        console.log(`[${requestId}] [BYPASS_USER]`, JSON.stringify(bypassDiagnostics));
        
        // ==========================================================================
        // FREE PREVIEW MODE: Legacy - still supported but BYPASS_USER takes priority
        // ==========================================================================
        const expectedEmailLower = FREE_PREVIEW_ALLOWED_EMAIL.toLowerCase().trim();
        const emailMatchesPreview = userEmailLower === expectedEmailLower;
        const isFreePreviewAllowed = freePreviewModeRequested === true && emailMatchesPreview;
        
        console.log(`[${requestId}] [LIMIT_BYPASS_CHECK] User authenticated`, { 
          userId, 
          isUnlimitedUser,
          isBypassUser,
          freePreviewModeRequested,
          isFreePreviewAllowed,
          userEmailMasked: maskEmail(userEmailLower),
        });

        // Fetch profile to get plan (for debugging)
        const { data: profileData, error: profError } = await supabaseAdmin
          .from("profiles")
          .select("plan, is_scan_limit_exempt")
          .eq("id", userId)
          .maybeSingle();

        if (profError) {
          profileError = new Error(profError.message);
          console.log(`[${requestId}] Profile fetch error:`, profError.message);
        } else {
          const typedProfile = profileData as { plan?: string; is_scan_limit_exempt?: boolean } | null;
          profilePlan = typedProfile?.plan || null;
          isUnlimitedUser = isUnlimitedUser || typedProfile?.is_scan_limit_exempt === true;
          console.log(`[${requestId}] [LIMIT_BYPASS_CHECK] Profile plan:`, {
            profilePlan,
            isScanLimitExempt: typedProfile?.is_scan_limit_exempt === true,
            userEmail,
          });
        }

        // ==========================================================================
        // BILLING CHECK PRIORITY:
        // 1. BYPASS_USER (highest) - completely skip all billing, always succeed
        // 2. isFreePreviewAllowed - skip billing, show Free UX
        // 3. isUnlimitedUser - skip billing
        // 4. previewPro - fake pro mode
        // 5. Normal billing check
        // ==========================================================================
        if (isBypassUser) {
          // BYPASS USER: Skip billing check but ALLOW scan history saves
          // This enables Share flow testing while still bypassing limits
          // NOTE: Do NOT set isFreePreviewModeActive = true here
          billingInfo = { plan: "free", remainingScans: 9999, scanLimit: 9999 };
          console.log(`[${requestId}] [BYPASS_USER] Active - billing bypassed, history saved`, { 
            userId, 
            userEmailMasked: maskEmail(userEmailLower),
            skippedBilling: true,
            skippedHistory: false,
          });
        } else if (isFreePreviewAllowed) {
          // FREE PREVIEW MODE: Skip billing, return fake "free" billing info
          // User sees exact Free UX without consuming scan credits
          isFreePreviewModeActive = true;
          billingInfo = { plan: "free", remainingScans: 0, scanLimit: 2 };
          console.log(`[${requestId}] [FREE PREVIEW MODE] Active - skipping billing, no DB writes`, { userEmail });
        } else if (isUnlimitedUser) {
          // Unlimited test user: use real plan but skip all billing checks
          billingInfo = { plan: profilePlan || "free", remainingScans: 999, scanLimit: 999 };
          console.log(`[${requestId}] [UNLIMITED TEST USER HIT] Skipping billing check entirely`, { userEmail, plan: billingInfo.plan });
        } else if (!previewPro) {
          console.log(`[${requestId}] [BILLING_CHECK_CALL] About to call checkScanEntitlement`, { userEmail, userId });
          try {
            scanEntitlement = await checkScanEntitlement(supabaseAdmin, userId, lpUrl);
            if (scanEntitlement.creditId) {
              reservedCreditForCleanup = {
                userId,
                creditId: scanEntitlement.creditId,
              };
            }
            if (scanEntitlement.freeCreditReserved) {
              reservedFreeCreditForCleanup = {
                userId,
                periodStart: scanEntitlement.freeCreditPeriodStart || getCurrentMonthStartIso(),
              };
            }
            billingInfo = {
              plan: scanEntitlement.plan,
              remainingScans: scanEntitlement.remainingScans,
              scanLimit: scanEntitlement.scanLimit,
            };
            console.log(`[${requestId}] Entitlement check passed:`, billingInfo);
          } catch (billingError: unknown) {
            if (typeof billingError === "object" && billingError !== null && "code" in billingError) {
              const err = billingError as { code: string; plan: string; remainingScans: number; scanLimit: number };
              if (err.code === "LIMIT_EXCEEDED") {
                console.log(`[${requestId}] Scan limit exceeded for user:`, userId);
                return new Response(
                  JSON.stringify({
                    ok: false,
                    error: "Free scan limit reached",
                    code: "LIMIT_EXCEEDED",
                    paywall: true,
                    message: "Free scan limit reached",
                    plan: err.plan,
                    remainingScans: err.remainingScans,
                    scanLimit: err.scanLimit,
                  }),
                  { status: 402, headers: corsHeaders }
                );
              }
            }
            throw billingError;
          }
        } else {
          // Preview Pro mode: set fake billing info without touching DB
          billingInfo = { plan: "pro", remainingScans: 999, scanLimit: 999 };
          console.log(`[${requestId}] Preview Pro mode - skipping billing check, using fake pro billing`);
        }
      }
    }

    if (localDebugBillingOverrideActive) {
      billingInfo =
        activeLocalDebugBillingOverride === "lifetime"
          ? { plan: "lifetime", remainingScans: 9999, scanLimit: 9999 }
          : { plan: "free", remainingScans: 1, scanLimit: 1 };
      console.log(`[${requestId}] [LOCAL_DEBUG_BILLING_OVERRIDE] Active`, {
        activeLocalDebugBillingOverride,
        userId,
        resolvedBillingInfo: billingInfo,
      });
    }

    // ==========================================================================
    // Auth enforcement: Production requires JWT, Preview allows unauthenticated
    // EXCEPTION: pdf_session_id with valid Stripe payment bypasses 401
    // ==========================================================================
    let pdfPurchaseBypassGranted = false;
    
    if (isProduction && !userId && !localDebugBillingOverrideActive) {
      // Check if PDF purchase bypass is possible
      if (pdfSessionId) {
        console.log(`[${requestId}] Production guest with pdf_session_id - verifying Stripe payment...`);
        const isPaid = await verifyPdfSessionPaid(pdfSessionId);
        
        if (isPaid) {
          // ── Consumption guard: only allow ONE scan per pdf_session_id ──
          const { count: existingCount, error: countError } = await supabaseAdmin
            .from("lp_scan_history")
            .select("id", { count: "exact", head: true })
            .eq("pdf_session_id", pdfSessionId);

          if (countError) {
            console.error(`[${requestId}] [PDF_BYPASS] Error checking consumption:`, countError);
          }

          if ((existingCount ?? 0) >= 1) {
            console.log(`[${requestId}] [PDF_BYPASS] DENIED - pdf_session_id already consumed (count=${existingCount})`);
            return new Response(
              JSON.stringify({
                ok: false,
                error: "This unlock has already been used. Purchase another to scan a different page.",
                code: "SESSION_ALREADY_CONSUMED",
              }),
              { status: 403, headers: corsHeaders }
            );
          }

          pdfPurchaseBypassGranted = true;
          console.log(`[${requestId}] [PDF_BYPASS] Granted - pdf_session_id is paid and unused, allowing scan`);
        } else {
          console.log(`[${requestId}] [PDF_BYPASS] Denied - pdf_session_id not paid or invalid`);
          return new Response(
            JSON.stringify({
              ok: false,
              error: "Payment verification failed",
              code: "PAYMENT_NOT_VERIFIED",
            }),
            { status: 401, headers: corsHeaders }
          );
        }
      } else {
        // No pdf_session_id - standard 401
        console.log(`[${requestId}] Production request without auth - returning 401`);
        return new Response(
          JSON.stringify({
            ok: false,
            error: "Authentication required",
            code: "AUTH_REQUIRED",
          }),
          { status: 401, headers: corsHeaders }
        );
      }
    }

    // Preview unauthenticated: apply DB-backed rate limiting
    if (isPreview && !userId && !localDebugBillingOverrideActive) {
      const ip = getClientIp(req);
      const allowed = await checkPreviewRateLimitDb(supabaseAdmin, ip);
      if (!allowed) {
        console.log(`[${requestId}] Preview rate limit exceeded for IP:`, ip);
        return new Response(
          JSON.stringify({ ok: false, error: "Rate limit exceeded", code: "RATE_LIMIT" }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      console.log(`[${requestId}] Preview unauthenticated request allowed for IP:`, ip);
    }

    // Resolve plan: 
    // - If previewPro is true, force "pro" plan (no billing checks, no DB updates)
    // - Otherwise use billingInfo if available, else "free" ONLY in preview
    const resolvedPlan =
      activeLocalDebugBillingOverride === "lifetime"
        ? "lifetime"
        : activeLocalDebugBillingOverride === "full_scan"
          ? "free"
          : previewPro
            ? "pro"
            : (billingInfo?.plan ?? "free");

    console.log(`[${requestId}] Plan resolution`, {
      hasAuthHeader,
      userId,
      profilePlan,
      billingPlan: billingInfo?.plan ?? null,
      resolvedPlan,
      isProduction,
      isPreview,
      previewPro,
    });

    // Resolve scoring backend(s)
    let scoringBackend: ScoringBackendTarget;
    let fallbackBackend: ScoringBackendTarget | null = null;
    try {
      scoringBackend = getPrimaryScoringBackend();
      fallbackBackend = getFallbackScoringBackend(scoringBackend);
    } catch (backendError) {
      console.error("Scoring backend not configured");
      return new Response(
        JSON.stringify({ ok: false, error: "Server configuration error" }),
        { status: 500, headers: corsHeaders }
      );
    }

    // === TIMING INSTRUMENTATION ===
    const lap = (step: string, extra?: Record<string, unknown>) => {
      console.log(`[${requestId}] TIMING ${step}`, {
        elapsed_ms: Date.now() - t0,
        user_id: userId,
        lp_url: lpUrl,
        ...extra,
      });
    };

    const invokeScoringBackend = async (target: ScoringBackendTarget) => {
      lap("before_scoring_backend_fetch", {
        backendUrl: target.url,
        backendKind: target.kind,
      });
      try {
        // Must stay above the scorer's own workflow budget (SCORER_WORKFLOW_BUDGET_MS,
        // default 85s). If the edge aborts first the user gets a hard failure instead
        // of the scorer's degraded-but-usable result, which is strictly worse.
        const configuredTimeoutMs = Number(Deno.env.get("SCORING_BACKEND_TIMEOUT_MS") || 95000);
        const backendTimeoutMs =
          Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
            ? configuredTimeoutMs
            : 95000;
        const response = await timeEdgeStage(`scoring_backend_fetch_${target.kind}`, () =>
          fetch(target.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-LB-SECRET": target.secret,
            },
            body: JSON.stringify({
              lp_url: lpUrl,
              force_refresh: true,
              request_id: requestId,
              requested_at: new Date().toISOString(),
            }),
            signal: AbortSignal.timeout(backendTimeoutMs),
          }), {
            backendUrl: target.url,
            backendKind: target.kind,
            lp_url: lpUrl,
            user_id: userId,
          }
        );
        lap("after_scoring_backend_fetch", {
          status: response.status,
          backendUrl: target.url,
          backendKind: target.kind,
        });
        return response;
      } catch (backendFetchError) {
        const message =
          backendFetchError instanceof Error ? backendFetchError.message : String(backendFetchError);
        const timedOut =
          backendFetchError instanceof Error &&
          /(?:abort|timeout)/i.test(`${backendFetchError.name} ${backendFetchError.message}`);
        console.error(`[${requestId}] Scoring backend fetch failed`, {
          backendUrl: target.url,
          backendKind: target.kind,
          error: message,
        });
        return new Response(
          JSON.stringify({
            ok: false,
            error: timedOut ? "Scoring backend timed out" : "Scoring backend fetch failed",
            detail: message,
          }),
          {
            status: timedOut ? 598 : 599,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    };
    const configuredFallbackStartBudgetMs = Number(
      Deno.env.get("SCORING_FALLBACK_START_BUDGET_MS") || 15000,
    );
    const fallbackStartBudgetMs =
      Number.isFinite(configuredFallbackStartBudgetMs) && configuredFallbackStartBudgetMs > 0
        ? configuredFallbackStartBudgetMs
        : 15000;
    const canStartFallbackBackend = () =>
      Date.now() - t0 < fallbackStartBudgetMs;

    // ========================================================================
    // Durable scan-attempt logging — records every lp-score invocation so we
    // can trace failures that occur BEFORE lp_scan_history is inserted (e.g.
    // empty/invalid responses from the scoring backend). Writes are best-effort
    // and must never block scoring.
    // ========================================================================
    let scanAttemptEventId: string | null = null;
    try {
      const { data: attemptRow, error: attemptInsertError } = await supabaseAdmin
        .from("scan_attempt_events")
        .insert({
          request_id: requestId,
          user_id: userId,
          user_email: attemptUserEmail,
          submitted_url: lpUrl,
          status: "started",
          stage: "scoring_backend_invoke",
          source: apiKeyAuth ? "api" : "ui",
        })
        .select("id")
        .single();
      if (attemptInsertError) {
        console.warn(`[${requestId}] scan_attempt_events insert failed:`, attemptInsertError.message);
      } else {
        scanAttemptEventId = attemptRow?.id ?? null;
        outerScanAttemptEventId = scanAttemptEventId;
        
      }
    } catch (attemptErr) {
      console.warn(`[${requestId}] scan_attempt_events insert threw:`, attemptErr);
    }

    const markScanAttempt = async (
      status: "failed" | "completed",
      patch: {
        stage?: string;
        error_code?: string;
        error_message?: string;
        scan_id?: string | null;
        backend_kind?: string;
      } = {},
    ) => {
      if (!scanAttemptEventId) return;
      try {
        await supabaseAdmin
          .from("scan_attempt_events")
          .update({
            status,
            ...patch,
            updated_at: new Date().toISOString(),
          })
          .eq("id", scanAttemptEventId);
      } catch (markErr) {
        console.warn(`[${requestId}] markScanAttempt(${status}) failed:`, markErr);
      }
    };

    let activeBackend = scoringBackend;
    let scoringResponse = await invokeScoringBackend(activeBackend);

    // Helper: release a reserved prepurchased credit back to 'available' on failure
    const releaseCredit = async () => {
      if (scanEntitlement?.creditId) {
        try {
          await supabaseAdmin
            .from("pdf_purchases")
            .update({ status: "available", reserved_at: null })
            .eq("id", scanEntitlement.creditId)
            .eq("status", "reserved");
          console.log(`[${requestId}] Released prepurchased credit back to available:`, scanEntitlement.creditId);
        } catch (e) {
          console.error(`[${requestId}] Failed to release credit:`, e);
        }
      }
    };

    // Handle non-200 responses
    if (
      !scoringResponse.ok &&
      fallbackBackend &&
      scoringResponse.status !== 598 &&
      scoringResponse.status !== 422 &&
      canStartFallbackBackend()
    ) {
      const primaryErrorText = await scoringResponse.text().catch(() => "Unknown error");
      console.error("Primary scoring backend error response:", {
        backendUrl: activeBackend.url,
        backendKind: activeBackend.kind,
        status: scoringResponse.status,
        errorText: primaryErrorText,
      });
      console.warn(`[${requestId}] Falling back to legacy n8n backend`);
      activeBackend = fallbackBackend;
      scoringResponse = await invokeScoringBackend(activeBackend);
    }

    if (!scoringResponse.ok) {
      const errorText = await scoringResponse.text().catch(() => "Unknown error");
      console.error("Scoring backend error response:", errorText);
      let backendError: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(errorText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          backendError = parsed as Record<string, unknown>;
        }
      } catch {
        // Preserve the HTTP status and request ID even when the backend body is plain text.
      }
      const backendErrorCode = typeof backendError.code === "string"
        ? backendError.code
        : `HTTP_${scoringResponse.status}`;
      const backendErrorMessage = typeof backendError.error === "string"
        ? backendError.error
        : typeof backendError.message === "string"
          ? backendError.message
          : "The scan could not be completed.";
      await releaseCredit();
      await markScanAttempt("failed", {
        stage: "scoring_backend_http_error",
        error_code: backendErrorCode,
        error_message: errorText?.substring(0, 500) ?? null,
        backend_kind: activeBackend.kind,
      });
      return new Response(
        JSON.stringify({
          ok: false,
          error: backendErrorMessage,
          code: backendErrorCode,
          detail: backendError.detail ?? null,
          status: scoringResponse.status,
          requestId,
        }),
        { status: scoringResponse.status, headers: corsHeaders }
      );
    }

    // Parse and return successful response
    let responseText = await timeEdgeStage("scoring_backend_text", () => scoringResponse.text(), {
      backendKind: activeBackend.kind,
      lp_url: lpUrl,
      user_id: userId,
    });
    lap("after_scoring_backend_text");

    // Safety: detect empty/non-JSON responses
    if (!responseText || responseText.trim().length === 0) {
      console.error(`[${requestId}] scoring backend returned empty body`);
      if (activeBackend.kind === "primary" && fallbackBackend && canStartFallbackBackend()) {
        console.warn(`[${requestId}] Empty body from primary backend — falling back to legacy n8n backend`);
        activeBackend = fallbackBackend;
        scoringResponse = await invokeScoringBackend(activeBackend);
        responseText = await timeEdgeStage("scoring_backend_text_after_empty_fallback", () => scoringResponse.text(), {
          backendKind: activeBackend.kind,
          lp_url: lpUrl,
          user_id: userId,
        });
      } else {
        await releaseCredit();
        await markScanAttempt("failed", {
          stage: "scoring_backend_empty_body",
          error_code: "EMPTY_RESPONSE",
          error_message: "Scoring service returned empty response",
          backend_kind: activeBackend.kind,
        });
        return new Response(
          JSON.stringify({ ok: false, error: "Scoring service returned empty response", requestId }),
          { status: 502, headers: corsHeaders }
        );
      }
    }

    let rawData: any;
    try {
      rawData = timeEdgeStageSync("scoring_backend_json_parse", () => JSON.parse(responseText), {
        backendKind: activeBackend.kind,
        responseBytes: responseText.length,
        lp_url: lpUrl,
        user_id: userId,
      });
    } catch (parseErr) {
      console.error(`[${requestId}] scoring backend JSON parse failed. First 500 chars:`, responseText.substring(0, 500));
      if (activeBackend.kind === "primary" && fallbackBackend && canStartFallbackBackend()) {
        console.warn(`[${requestId}] Invalid JSON from primary backend — falling back to legacy n8n backend`);
        activeBackend = fallbackBackend;
        scoringResponse = await invokeScoringBackend(activeBackend);
        responseText = await timeEdgeStage("scoring_backend_text_after_json_fallback", () => scoringResponse.text(), {
          backendKind: activeBackend.kind,
          lp_url: lpUrl,
          user_id: userId,
        });
        try {
          rawData = timeEdgeStageSync("scoring_backend_json_parse_after_fallback", () => JSON.parse(responseText), {
            backendKind: activeBackend.kind,
            responseBytes: responseText.length,
            lp_url: lpUrl,
            user_id: userId,
          });
        } catch {
          await releaseCredit();
          await markScanAttempt("failed", {
            stage: "scoring_backend_invalid_json_after_fallback",
            error_code: "INVALID_JSON",
            backend_kind: activeBackend.kind,
          });
          return new Response(
            JSON.stringify({ ok: false, error: "Scoring service returned invalid JSON", requestId }),
            { status: 502, headers: corsHeaders }
          );
        }
      } else {
        await releaseCredit();
        await markScanAttempt("failed", {
          stage: "scoring_backend_invalid_json",
          error_code: "INVALID_JSON",
          backend_kind: activeBackend.kind,
        });
        return new Response(
          JSON.stringify({ ok: false, error: "Scoring service returned invalid JSON", requestId }),
          { status: 502, headers: corsHeaders }
        );
      }
    }
    lap("after_scoring_backend_parse");

    // Diagnostic: log raw response shape
    console.log(`[${requestId}] scoring backend raw response shape:`, {
      isArray: Array.isArray(rawData),
      topKeys: rawData ? Object.keys(Array.isArray(rawData) ? rawData[0] ?? {} : rawData).slice(0, 15) : [],
      hasScores: !!(Array.isArray(rawData) ? rawData[0]?.scores : rawData?.scores),
    });

    // Normalize backend response: handle array [{ ... }] or object { ... }
    let scoreData = Array.isArray(rawData) ? rawData[0] : rawData;

    if (!scoreData || typeof scoreData !== "object") {
      console.error("Invalid scoring backend response shape:", rawData);
      if (activeBackend.kind === "primary" && fallbackBackend && canStartFallbackBackend()) {
        console.warn(`[${requestId}] Invalid response shape from primary backend — falling back to legacy n8n backend`);
        activeBackend = fallbackBackend;
        scoringResponse = await invokeScoringBackend(activeBackend);
        responseText = await timeEdgeStage("scoring_backend_text_after_shape_fallback", () => scoringResponse.text(), {
          backendKind: activeBackend.kind,
          lp_url: lpUrl,
          user_id: userId,
        });
        try {
          rawData = timeEdgeStageSync("scoring_backend_json_parse_after_shape_fallback", () => JSON.parse(responseText), {
            backendKind: activeBackend.kind,
            responseBytes: responseText.length,
            lp_url: lpUrl,
            user_id: userId,
          });
          scoreData = Array.isArray(rawData) ? rawData[0] : rawData;
        } catch {
          await releaseCredit();
          await markScanAttempt("failed", {
            stage: "scoring_backend_invalid_json_after_shape_fallback",
            error_code: "INVALID_JSON",
            backend_kind: activeBackend.kind,
          });
          return new Response(
            JSON.stringify({ ok: false, error: "Scoring service returned invalid JSON", requestId }),
            { status: 502, headers: corsHeaders }
          );
        }
        if (!scoreData || typeof scoreData !== "object") {
          await releaseCredit();
          await markScanAttempt("failed", {
            stage: "scoring_backend_invalid_shape_after_fallback",
            error_code: "INVALID_SHAPE",
            backend_kind: activeBackend.kind,
          });
          return new Response(
            JSON.stringify({ ok: false, error: "Invalid scoring response format", requestId }),
            { status: 502, headers: corsHeaders }
          );
        }
      } else {
        await releaseCredit();
        await markScanAttempt("failed", {
          stage: "scoring_backend_invalid_shape",
          error_code: "INVALID_SHAPE",
          backend_kind: activeBackend.kind,
        });
        return new Response(
          JSON.stringify({ ok: false, error: "Invalid scoring response format", requestId }),
          { status: 502, headers: corsHeaders }
        );
      }
    }

    console.log(`[${requestId}] scoring backend fetch diagnostics:`, summarizeFetchDiagnostics(scoreData));

    if (isDegradedScoringPayload(scoreData)) {
      const deliveryRepaired = isDeliveryRepairedScoringPayload(scoreData);
      console.warn(`[${requestId}] Scoring payload used a repair path`, {
        backendUrl: activeBackend.url,
        backendKind: activeBackend.kind,
        scanQualityStatus: (scoreData as any)?.scan_quality_status ?? null,
        failSoft: (scoreData as any)?.meta?.fail_soft === true,
        deliveryRepaired,
        ...summarizeFetchDiagnostics(scoreData),
      });
      if (!deliveryRepaired) {
        await releaseCredit();
        await markScanAttempt("failed", {
          stage: "scoring_backend_degraded_payload",
          error_code: "UNVERIFIED_DEGRADED_SCORING_PAYLOAD",
          backend_kind: activeBackend.kind,
        });
        return new Response(
          JSON.stringify({
            ok: false,
            error: "The scoring service returned an unverified repair payload.",
            code: "UNVERIFIED_REPAIR_PAYLOAD",
            requestId,
          }),
          { status: 502, headers: corsHeaders },
        );
      }
    }

    if (hasFactContradictions(scoreData)) {
      const contradictionCodes = (scoreData as any).fact_contradictions
        .map((problem: any) => String(problem?.code || "unknown"))
        .slice(0, 8);
      console.error(`[${requestId}] Refusing fact-contradicting scoring payload`, {
        backendUrl: activeBackend.url,
        backendKind: activeBackend.kind,
        contradictionCodes,
      });
      await releaseCredit();
      await markScanAttempt("failed", {
        stage: "scoring_backend_fact_contradiction",
        error_code: "FACT_CONTRADICTION",
        backend_kind: activeBackend.kind,
      });
      return pageInaccessibleResponse("Scoring contradicted measured page evidence and was discarded.", {
        requestId,
        contradictionCodes,
      });
    }

    if (!looksLikeUsableScoringPayload(scoreData)) {
      const payloadIssues = getScoringPayloadIssues(scoreData);
      console.error(`[${requestId}] Scoring backend response failed minimum payload checks`, {
        backendUrl: activeBackend.url,
        backendKind: activeBackend.kind,
        payloadIssues,
        hasScores: !!((scoreData as any)?.scores || (scoreData as any)?.overall_100),
        hasFreePreviewFix: !!(scoreData as any)?.free_preview_fix,
        hasUserSnapshot: !!((scoreData as any)?.user_snapshot || (scoreData as any)?.offer_summary || (scoreData as any)?.target_audience),
      });

      if (activeBackend.kind === "primary" && fallbackBackend && canStartFallbackBackend()) {
        console.warn(`[${requestId}] Thin response from primary backend — falling back to legacy n8n backend`);
        activeBackend = fallbackBackend;
        scoringResponse = await invokeScoringBackend(activeBackend);
        responseText = await timeEdgeStage("scoring_backend_text_after_payload_fallback", () => scoringResponse.text(), {
          backendKind: activeBackend.kind,
          lp_url: lpUrl,
          user_id: userId,
        });

        try {
          rawData = timeEdgeStageSync("scoring_backend_json_parse_after_payload_fallback", () => JSON.parse(responseText), {
            backendKind: activeBackend.kind,
            responseBytes: responseText.length,
            lp_url: lpUrl,
            user_id: userId,
          });
          scoreData = Array.isArray(rawData) ? rawData[0] : rawData;
        } catch {
          await releaseCredit();
          return new Response(
            JSON.stringify({ ok: false, error: "Scoring service returned invalid JSON" }),
            { status: 502, headers: corsHeaders }
          );
        }

        if (!looksLikeUsableScoringPayload(scoreData)) {
          const fallbackPayloadIssues = getScoringPayloadIssues(scoreData);
          console.error(`[${requestId}] Fallback scoring backend response also failed payload checks`, {
            backendUrl: activeBackend.url,
            backendKind: activeBackend.kind,
            payloadIssues: fallbackPayloadIssues,
          });
          await releaseCredit();
          return new Response(
            JSON.stringify({
              ok: false,
              error: "The scoring service did not return the core report fields.",
              code: "SCORING_CORE_FIELDS_MISSING",
              requestId,
              payloadIssues: fallbackPayloadIssues,
            }),
            { status: 502, headers: corsHeaders },
          );
        }
      } else {
        await releaseCredit();
        return new Response(
          JSON.stringify({
            ok: false,
            error: "The scoring service did not return the core report fields.",
            code: "SCORING_CORE_FIELDS_MISSING",
            requestId,
            payloadIssues,
          }),
          { status: 502, headers: corsHeaders },
        );
      }
    }

    const attachedCurrentCopy = timeEdgeStageSync("current_copy_attach", () => attachCurrentCopy(scoreData), {
      lp_url: lpUrl,
      user_id: userId,
    });
    lap("after_current_copy_attach", {
      attachedCurrentCopy,
      hasHeadline: !!(scoreData as any)?.current_copy?.headline,
      hasCta: !!(scoreData as any)?.current_copy?.primary_cta,
      hasTrust: !!(scoreData as any)?.current_copy?.trust_social_proof,
    });

    const normalizedProductArtifactOnlyTrust = timeEdgeStageSync(
      "product_artifact_only_trust_normalize",
      () => normalizeProductArtifactOnlyTrustState(scoreData),
      { lp_url: lpUrl, user_id: userId },
    );
    lap("after_product_artifact_only_trust_normalize", {
      applied: normalizedProductArtifactOnlyTrust,
      trust_evidence_state: (scoreData as any)?.trust_evidence_state ?? null,
      proof_gap: (scoreData as any)?.page_profile?.proof_gap ?? (scoreData as any)?.market_profile?.proof_gap ?? null,
    });

    // Extract scores from nested scores object or top-level
    const scoresObj = (scoreData as any).scores || {};

    const rawOverallScore = Number(scoresObj.overall_100 ?? (scoreData as any).overall_100 ?? 0);
    const clarityScore = scoresObj.clarity_100 ?? (scoreData as any).clarity_100 ?? null;
    const relevanceScore = scoresObj.relevance_100 ?? (scoreData as any).relevance_100 ?? null;
    const trustScore = scoresObj.trust_100 ?? (scoreData as any).trust_100 ?? null;
    const conversionScore = scoresObj.conversion_100
      ?? scoresObj.action_100
      ?? (scoreData as any).conversion_100
      ?? (scoreData as any).action_100
      ?? null;
    const rawAxisScores = [clarityScore, relevanceScore, trustScore, conversionScore];
    const averageAxisScores = rawAxisScores.map((score) => Number(score));
    const canAverageAxes = rawAxisScores.every((score) => score !== null && score !== undefined && score !== "")
      && averageAxisScores.every((score) => Number.isFinite(score) && score >= 0 && score <= 100);
    const overallScore = canAverageAxes
      ? Math.round(averageAxisScores.reduce((sum, score) => sum + score, 0) / 4)
      : rawOverallScore;
    if ((scoreData as any).scores && typeof (scoreData as any).scores === "object") {
      (scoreData as any).scores.overall_100 = overallScore;
      (scoreData as any).scores.conversion_100 = conversionScore;
      (scoreData as any).scores.action_100 = conversionScore;
    }
    (scoreData as any).overall_100 = overallScore;
    // Extract user_snapshot fields with fallback to nested user_snapshot object
    const targetAudience = (scoreData as any).target_audience 
      ?? (scoreData as any).user_snapshot?.target_audience ?? null;
    const offerSummary = (scoreData as any).offer_summary 
      ?? (scoreData as any).user_snapshot?.offer_summary ?? null;
    const userFitDiagnosis = (scoreData as any).user_fit_diagnosis 
      ?? (scoreData as any).user_snapshot?.user_fit_diagnosis ?? null;
    const ctaForCategory = scoreData?.above_the_fold_fix?.improved_copy?.primary_cta ?? null;
    const keywordCategory = inferPageCategory(targetAudience, offerSummary, lpUrl, ctaForCategory);
    const inferredCategory = resolvePageCategory(scoreData, keywordCategory);

    lap("after_score_extraction", { overallScore, clarityScore, relevanceScore, trustScore, conversionScore });

    const zeroAxisCount = rawAxisScores.filter((score) => Number(score) === 0).length;
    const allScoresZero = overallScore === 0
      && Number(clarityScore ?? 0) === 0
      && Number(relevanceScore ?? 0) === 0
      && Number(trustScore ?? 0) === 0
      && Number(conversionScore ?? 0) === 0;

    if (!allScoresZero && zeroAxisCount >= 2) {
      console.error(`[${requestId}] Refusing to persist suspicious scoring payload`, {
        backendUrl: activeBackend.url,
        backendKind: activeBackend.kind,
        zeroAxisCount,
        overallScore,
        clarityScore,
        relevanceScore,
        trustScore,
        conversionScore,
      });
      await releaseCredit();
      return new Response(
        JSON.stringify({
          ok: false,
          error: "The scoring service could not reconstruct the core score axes.",
          code: "SCORING_CORE_FIELDS_INVALID",
          requestId,
          zeroAxisCount,
        }),
        { status: 502, headers: corsHeaders },
      );
    }

    // ========================================================================
    // PAGE INACCESSIBLE GUARD
    // If ALL scores are 0, the page was likely unreachable (DNS error, SSL error,
    // security checkpoint, server error). Detect this and return a specific error
    // so the frontend can show a helpful message instead of fake 0 scores.
    // Do NOT consume a scan credit for inaccessible pages.
    // ========================================================================
    if (allScoresZero) {
      const bottleneck = String(
        (scoreData as any)?.ai_insights?.biggest_bottleneck
        ?? (scoreData as any)?.summary_insights?.biggest_bottleneck
        ?? ""
      ).toLowerCase();

      // Heuristic: check if the AI flagged a page-access issue
      const accessErrorKeywords = [
        "dns", "ssl", "certificate", "security checkpoint", "cloudflare",
        "unreachable", "server error", "not found", "404", "403", "502", "503",
        "couldn't access", "cannot access", "blocked", "failed to verify",
        "connection refused", "timeout", "timed out", "page is completely blocked",
      ];
      const isPageInaccessible = accessErrorKeywords.some(kw => bottleneck.includes(kw));

      console.log(`[${requestId}] ALL SCORES ZERO detected`, {
        isPageInaccessible,
        bottleneckSnippet: bottleneck.substring(0, 200),
        lpUrl,
      });

      if (isPageInaccessible) {
        // Return a specific error — do NOT save scan, do NOT consume credit
        await releaseCredit();
        return pageInaccessibleResponse(bottleneck);
      }
    }

    try {
      await timeEdgeStage("canonical_benchmark_evidence", () =>
        applyCanonicalBenchmarkEvidence(
          supabaseAdmin,
          scoreData,
          lpUrl,
          inferredCategory.page_category,
          requestId,
          {
            overallScore,
            clarityScore,
            relevanceScore,
            trustScore,
            conversionScore,
          }
        ), {
          page_category: inferredCategory.page_category,
          lp_url: lpUrl,
          user_id: userId,
        }
      );
      lap("after_canonical_benchmark_evidence", {
        family: (scoreData as any)?.benchmark_evidence?.source_profile?.family,
        refs: (scoreData as any)?.benchmark_evidence?.references?.length ?? 0,
      });
    } catch (canonicalEvidenceError) {
      console.error(`[${requestId}] Canonical benchmark evidence non-fatal error`, canonicalEvidenceError);
      lap("after_canonical_benchmark_evidence_error");
    }

    const shouldRunPositioningDiagnosis =
      previewPro ||
      localDebugPremiumUnlock ||
      pdfPurchaseBypassGranted ||
      activeLocalDebugBillingOverride === "lifetime" ||
      activeLocalDebugBillingOverride === "full_scan" ||
      resolvedPlan !== "free" ||
      Boolean(scanEntitlement?.creditId);

    if (shouldRunPositioningDiagnosis) {
      try {
        const positioningDiagnosis = await timeEdgeStage("positioning_diagnosis", () =>
          buildPositioningDiagnosis(supabaseAdmin, scoreData, inferredCategory.page_category, requestId), {
            page_category: inferredCategory.page_category,
            lp_url: lpUrl,
            user_id: userId,
          }
        );
        if (positioningDiagnosis) {
          (scoreData as any).positioning_diagnosis = positioningDiagnosis;
          lap("after_positioning_diagnosis", {
            shown: positioningDiagnosis.confidence_gate.show,
            userFrame: positioningDiagnosis.user_frame.label,
            clusterFrame: positioningDiagnosis.cluster_frame.dominant,
            clusterSize: positioningDiagnosis.cluster_frame.cluster_size,
          });
        } else {
          lap("after_positioning_diagnosis_skipped");
        }
      } catch (positioningError) {
        console.error(`[${requestId}] Positioning diagnosis non-fatal error`, positioningError);
        lap("after_positioning_diagnosis_error");
      }
    } else {
      lap("after_positioning_diagnosis_skipped_free");
      console.log(`[${requestId}] Positioning diagnosis skipped for free scan to keep LLM cost bounded`, {
        resolvedPlan,
        isFreePreviewModeActive,
        previewPro,
      });
    }

    // Store full_result server-side for authenticated users
    // SKIP saving for Free Preview Mode (no DB writes)
    let scanId: string | null = null;
    let contentHash: string | null = null;
    
    // Compute content hash for change detection (for authenticated users or PDF bypass)
    const canSaveScan = (userId || pdfPurchaseBypassGranted || localDebugBillingOverrideActive) && !isFreePreviewModeActive;
    
    if (canSaveScan) {
      try {
        contentHash = await timeEdgeStage("content_hash_compute", () => computeContentHash(scoreData), {
          lp_url: lpUrl,
          user_id: userId,
        });
        console.log(`[${requestId}] Content hash computed:`, contentHash?.substring(0, 16));
      } catch (hashError) {
        console.error(`[${requestId}] Error computing content hash:`, hashError);
        // Continue without hash - improvements won't be created but scan will be saved
      }
    }
    
    // ==========================================================================
    // EXTRACT FREE PREVIEW DATA for Dashboard restoration (safe for free users)
    // ==========================================================================
    let freePreviewFixData: object | null = null;
    let aiInsightsPreviewData: object | null = null;
    let primaryBottleneckLabel: string | null = null;
    
    if (canSaveScan) {
      // Extract free_preview_fix (already computed in sanitizeForFree logic)
      const rawFreePreviewFix = (scoreData as any)?.free_preview_fix;
      if (rawFreePreviewFix?.instruction && rawFreePreviewFix.instruction.trim() !== "") {
        freePreviewFixData = refineDuplicateCtaProofFix(scoreData, rawFreePreviewFix);
      } else {
        // Fallback: extract locally
        freePreviewFixData = refineDuplicateCtaProofFix(scoreData, extractFreePreviewFix(scoreData));
      }
      if (freePreviewFixData) {
        (scoreData as any).free_preview_fix = freePreviewFixData;
      }
      
      // Extract truncated AI insights (1-sentence versions)
      const insights = (scoreData as any)?.ai_insights ?? (scoreData as any)?.summary_insights ?? {};
      aiInsightsPreviewData = {
        biggest_bottleneck: truncateToFirstSentence(insights.biggest_bottleneck),
        fastest_win: truncateToFirstSentence(insights.fastest_win),
        estimated_impact: truncateToFirstSentence(insights.estimated_impact),
      };
      
      // Determine primary bottleneck (weakest axis)
      const axisScores = [
        { key: "clarity", score: clarityScore ?? 100 },
        { key: "relevance", score: relevanceScore ?? 100 },
        { key: "trust", score: trustScore ?? 100 },
        { key: "action", score: conversionScore ?? 100 },
      ];
      axisScores.sort((a, b) => a.score - b.score);
      primaryBottleneckLabel = axisScores[0]?.key ?? null;
      
      console.log(`[${requestId}] Free preview data extracted:`, {
        hasFreePreviewFix: !!freePreviewFixData,
        hasAiInsightsPreview: !!aiInsightsPreviewData,
        primaryBottleneck: primaryBottleneckLabel,
      });
    }

    try {
      if (!(scoreData as any)?.free_preview_fix?.instruction) {
        const fallbackPreviewFix = refineDuplicateCtaProofFix(scoreData, extractFreePreviewFix(scoreData));
        if (fallbackPreviewFix) {
          (scoreData as any).free_preview_fix = fallbackPreviewFix;
          if (!freePreviewFixData) freePreviewFixData = fallbackPreviewFix;
        }
      }
      const referenceBackedFix = buildReferenceBackedFix(scoreData);
      if (referenceBackedFix) {
        (scoreData as any).reference_backed_fix = referenceBackedFix;
        console.log(`[${requestId}] Reference-backed fix built:`, {
          axis: referenceBackedFix.axis,
          refs: referenceBackedFix.references.length,
          confidence: referenceBackedFix.confidence,
        });
      } else {
        console.log(`[${requestId}] Reference-backed fix skipped: no safe fix/reference payload`);
      }
    } catch (referenceFixError) {
      console.error(`[${requestId}] Reference-backed fix non-fatal error`, referenceFixError);
    }

    if (!scoreData.meta || typeof scoreData.meta !== "object") {
      scoreData.meta = {};
    }
    // Persist and return the server-authoritative entitlement with the scan.
    // This makes the immediate response and every later rehydrate agree, so a
    // $9 buyer never falls back into the free result/paywall state.
    const responseEffectiveTier =
      scanEntitlement?.creditId || scanEntitlement?.confirmationRescan || pdfPurchaseBypassGranted || activeLocalDebugBillingOverride === "full_scan"
        ? "scan_unlock"
        : isPaidUser(resolvedPlan)
          ? "paid"
          : "free";
    (scoreData as any).effective_tier = responseEffectiveTier;
    (scoreData as any).score_compare_version = IMPROVEMENT_SCORE_COMPARE_VERSION;
    (scoreData.meta as Record<string, unknown>).score_compare_version = IMPROVEMENT_SCORE_COMPARE_VERSION;
    (scoreData.meta as Record<string, unknown>).category_version = CATEGORY_VERSION;
    
    // Save scan for authenticated users OR pdf purchase bypass users
    const shouldSaveScan = (userId || pdfPurchaseBypassGranted || localDebugBillingOverrideActive) && !isFreePreviewModeActive;
    
    // Track screenshot URL for response
    let screenshotUrl: string | null = null;
    let screenshotFullUrlImmediate: string | null = null;
    
    if (shouldSaveScan) {
      // Strip screenshot base64 from scoreData BEFORE inserting into full_result (prevents JSONB bloat)
      const screenshotB64 = scoreData?.screenshot_b64 as string | undefined;
      const screenshotType = scoreData?.screenshot_type as string | undefined;
      const screenshotFullB64 = scoreData?.screenshot_full as string | undefined;
      const screenshotFullType = scoreData?.screenshot_full_type as string | undefined;

      if (localDebugBillingOverrideActive) {
        screenshotUrl = toDataUrl(screenshotB64, screenshotType);
      }
      // Browserless already returned this capture. Turning it into a data URL
      // makes the immediate response usable without another browser/AI call;
      // the same bytes are persisted to Storage below for later restores.
      screenshotFullUrlImmediate = toDataUrl(screenshotFullB64, screenshotFullType);

      delete scoreData.screenshot_b64;
      delete scoreData.screenshot_type;
      delete scoreData.screenshot_full;
      delete scoreData.screenshot_full_type;
      
      // Build insert payload - conditionally include pdf_session_id if provided and valid
      const insertPayload: Record<string, unknown> = {
        user_id: userId, // May be null for PDF purchase bypass
        url: lpUrl,
        overall_score: overallScore,
        clarity_score: clarityScore,
        relevance_score: relevanceScore,
        trust_score: trustScore,
        conversion_score: conversionScore,
        target_audience: targetAudience,
        offer_summary: offerSummary,
        user_fit_diagnosis: userFitDiagnosis,
        full_result: scoreData, // Store as object, not array - ALWAYS saved for PDF purchasers
        content_hash: contentHash, // Store content hash for change detection
        // NEW: Free preview data for Dashboard restoration (safe for free users)
        free_preview_fix: freePreviewFixData,
        ai_insights_preview: aiInsightsPreviewData,
        primary_bottleneck: primaryBottleneckLabel,
        source: apiKeyAuth ? "api" : "ui",
      };

      insertPayload.page_category = inferredCategory.page_category;
      insertPayload.category_version = inferredCategory.category_version;
      console.log(`[${requestId}] Page category resolved: ${inferredCategory.page_category} (v${inferredCategory.category_version}, source=${inferredCategory.category_source}, keyword=${keywordCategory.page_category})`);
      
      // Include pdf_session_id if provided (for $9 one-page purchase tracking)
      // This is REQUIRED for PDF purchase bypass to link scan to payment
      if (pdfSessionId) {
        insertPayload.pdf_session_id = pdfSessionId;
        console.log(`[${requestId}] Including pdf_session_id in scan record (bypass: ${pdfPurchaseBypassGranted})`);
      }
      
      const { data: insertedScan, error: insertError } = await timeEdgeStage("history_insert", () =>
        supabaseAdmin
          .from("lp_scan_history")
          .insert(insertPayload)
          .select("id")
          .single(), {
            lp_url: lpUrl,
            user_id: userId,
            pdfPurchaseBypassGranted,
            localDebugBillingOverrideActive,
          }
      );

      lap("after_history_insert", { scanId: insertedScan?.id, insertError: insertError?.message });

      if (insertError) {
        if (insertError.code === "23505" && insertError.message?.includes("idx_unique_pdf_session_id")) {
          console.log(`[${requestId}] [PDF_BYPASS] Race condition caught - pdf_session_id unique constraint violated`);
          return new Response(
            JSON.stringify({
              ok: false,
              error: "This unlock has already been used. Purchase another to scan a different page.",
              code: "SESSION_ALREADY_CONSUMED",
            }),
            { status: 403, headers: corsHeaders }
          );
        }
        if (scanEntitlement?.creditId) {
          throw new Error("Failed to save purchased scan");
        }
        console.error("Error saving scan to history:", insertError);
      } else if (insertedScan) {
        scanId = insertedScan.id;
        console.log("Scan saved with ID:", scanId);

        if (apiKeyAuth) {
          const usedAfterThisScan = apiKeyAuth.monthlyUsedBefore + 1;
          const remainingAfterThisScan = Math.max(0, apiKeyAuth.monthlyLimit - usedAfterThisScan);

          try {
            const { error: apiUsageError } = await timeEdgeStage("api_key_usage_update", () =>
              supabaseAdmin
                .from("lp_api_keys")
                .update({
                  last_used_at: new Date().toISOString(),
                  total_calls: apiKeyAuth.totalCalls + 1,
                })
                .eq("id", apiKeyAuth.id), {
                  scanId,
                  lp_url: lpUrl,
                  user_id: userId,
                  monthlyUsedBefore: apiKeyAuth.monthlyUsedBefore,
                  monthlyUsedAfter: usedAfterThisScan,
                }
            );

            if (apiUsageError) {
              console.error(`[${requestId}] API key usage update error:`, apiUsageError);
            } else {
              console.log(`[${requestId}] API key usage updated:`, {
                scanId,
                monthlyUsedAfter: usedAfterThisScan,
                monthlyLimit: apiKeyAuth.monthlyLimit,
              });
            }
          } catch (apiUsageUpdateError) {
            console.error(`[${requestId}] API key usage update error (non-blocking):`, apiUsageUpdateError);
          }

          if (billingInfo) {
            billingInfo.remainingScans = remainingAfterThisScan;
            billingInfo.scanLimit = apiKeyAuth.monthlyLimit;
            billingInfo.api_calls_used = usedAfterThisScan;
            billingInfo.api_calls_limit = apiKeyAuth.monthlyLimit;
            billingInfo.api_calls_remaining = remainingAfterThisScan;
          }
        }

        // ======================================================================
        // CONSUME CREDIT — Only after successful n8n + successful DB insert.
        // This is the ONLY place where scan credits are decremented.
        // ======================================================================
        const isCreditFundedScan = !!(scanEntitlement?.creditId);

        if (isCreditFundedScan && scanEntitlement) {
          // PREPURCHASED CREDIT: Consume the credit and stamp pdf_session_id
          const { data: consumedCredit, error: consumeErr } = await timeEdgeStage("prepurchased_credit_consume", () =>
            supabaseAdmin
              .from("pdf_purchases")
              .update({ status: "consumed", scan_id: scanId, reserved_at: null })
              .eq("id", scanEntitlement.creditId)
              .eq("user_id", userId)
              .eq("status", "reserved")
              .select("id")
              .maybeSingle(), {
                scanId,
                creditId: scanEntitlement.creditId,
                lp_url: lpUrl,
                user_id: userId,
              }
          );

          if (consumeErr || !consumedCredit) {
            console.error(`[${requestId}] Credit consumption error:`, consumeErr || "reserved credit was not consumed");
            throw new Error("Failed to consume purchased scan credit");
          }

          reservedCreditForCleanup = null;
          console.log(`[${requestId}] Prepurchased credit consumed:`, { creditId: scanEntitlement.creditId, scanId });

          // Stamp pdf_session_id on the scan row so rehydration works. The
          // purchase row is already authoritative, so a stamp failure is logged
          // but must not turn a successfully consumed purchase into an error.
          if (scanEntitlement.creditStripeSessionId) {
            const { error: stampError } = await timeEdgeStage("credit_pdf_session_stamp", () =>
              supabaseAdmin
                .from("lp_scan_history")
                .update({ pdf_session_id: scanEntitlement.creditStripeSessionId })
                .eq("id", scanId), {
                  scanId,
                  lp_url: lpUrl,
                  user_id: userId,
                }
            );
            if (stampError) {
              console.error(`[${requestId}] Failed to stamp pdf_session_id on consumed scan:`, stampError);
            } else {
              console.log(`[${requestId}] Stamped pdf_session_id on scan from credit:`, scanEntitlement.creditStripeSessionId);
            }
          }
          // Do NOT call consumeScanCredit — credit-funded scans don't decrement free limit
        } else if (scanEntitlement?.freeCreditReserved) {
          // Already atomically consumed before the scoring backend was invoked.
          if (billingInfo) {
            billingInfo.remainingScans = scanEntitlement.remainingScans;
            billingInfo.scanLimit = scanEntitlement.scanLimit;
          }
        } else if (userId && scanEntitlement && !isBypassUser && !isUnlimitedUser && !pdfPurchaseBypassGranted) {
          try {
            const creditResult = await timeEdgeStage("scan_credit_consume", () =>
              consumeScanCredit(supabaseAdmin, userId, scanEntitlement), {
                scanId,
                lp_url: lpUrl,
                user_id: userId,
                plan: scanEntitlement.plan,
              }
            );
            // Update billingInfo with post-consumption remaining scans
            if (billingInfo) {
              billingInfo.remainingScans = creditResult.remainingScans;
              billingInfo.scanLimit = creditResult.scanLimit;
            }
            console.log(`[${requestId}] Credit consumed post-success:`, creditResult);
            lap("credit_consumed_pre_response", { scanId, remaining: creditResult.remainingScans });
          } catch (creditError) {
            // Never block the response — credit consumption failure is logged but not fatal
            console.error(`[${requestId}] Credit consumption error (non-blocking):`, creditError);
          }
        }

        // === BACKGROUND TASKS via EdgeRuntime.waitUntil ===
        // Previously synchronous — caused timeouts. Now runs after response.
        const bgScanId = scanId;
        const bgScreenshotB64 = screenshotB64;
        const bgScreenshotType = screenshotType;
        const bgScreenshotFullB64 = screenshotFullB64;
        const bgScreenshotFullType = screenshotFullType;

        EdgeRuntime.waitUntil((async () => {
          const bgLap = (step: string, extra?: Record<string, unknown>) => {
            console.log(`[${requestId}] BG_TIMING ${step}`, { elapsed_ms: Date.now() - t0, ...extra });
          };

          if (!localDebugBillingOverrideActive) {
            try {
              await supabaseAdmin.rpc("increment_global_scan_count");
              bgLap("bg_global_count_done");
            } catch (e) { console.error(`[${requestId}] BG: global count error:`, e); }

            try {
              await supabaseAdmin.rpc("refresh_top_rankings");
              bgLap("bg_rankings_refresh_done");
            } catch (e) { console.error(`[${requestId}] BG: rankings refresh error:`, e); }
          }

          if (bgScreenshotB64 && typeof bgScreenshotB64 === "string" && bgScanId) {
            try {
              let ext = "webp";
              let sContentType = "image/webp";
              const rawType = (bgScreenshotType || "").toLowerCase().trim();
              let cleanB64 = bgScreenshotB64;
              if (cleanB64.startsWith("data:")) {
                const match = cleanB64.match(/^data:(image\/\w+);base64,/);
                if (match) {
                  const extractedType = match[1];
                  cleanB64 = cleanB64.replace(/^data:image\/\w+;base64,/, "");
                  if (!rawType && extractedType) {
                    if (extractedType === "image/png") { ext = "png"; sContentType = "image/png"; }
                    else if (extractedType === "image/jpeg" || extractedType === "image/jpg") { ext = "jpg"; sContentType = "image/jpeg"; }
                  }
                }
              }
              if (rawType === "image/png") { ext = "png"; sContentType = "image/png"; }
              else if (rawType === "image/jpeg" || rawType === "image/jpg") { ext = "jpg"; sContentType = "image/jpeg"; }
              else if (rawType === "image/webp") { ext = "webp"; sContentType = "image/webp"; }

              const binaryString = atob(cleanB64);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) { bytes[i] = binaryString.charCodeAt(i); }

              if (bytes.length > 2 * 1024 * 1024) {
                console.warn(`[${requestId}] Screenshot too large (${bytes.length} bytes), skipping`);
              } else {
                const filePath = `${bgScanId}.${ext}`;
                const { error: uploadError } = await supabaseAdmin.storage
                  .from("screenshots")
                  .upload(filePath, bytes, { contentType: sContentType, upsert: false });
                if (uploadError) {
                  console.error(`[${requestId}] Screenshot upload failed:`, uploadError);
                } else {
                  const supabaseUrl = Deno.env.get("SUPABASE_URL");
                  const bgScreenshotUrl = `${supabaseUrl}/storage/v1/object/public/screenshots/${filePath}`;
                  console.log(`[${requestId}] Screenshot uploaded: ${bgScreenshotUrl}`);
                  const { error: updateError } = await supabaseAdmin
                    .from("lp_scan_history")
                    .update({ screenshot_url: bgScreenshotUrl })
                    .eq("id", bgScanId);
                  if (updateError) console.error(`[${requestId}] Failed to save screenshot_url:`, updateError);
                }
              }
              bgLap("bg_screenshot_done");
            } catch (screenshotError) {
              console.error(`[${requestId}] BG: Screenshot error:`, screenshotError);
            }
          }

          if (bgScreenshotFullB64 && typeof bgScreenshotFullB64 === "string" && bgScanId) {
            try {
              let ext = "jpg";
              let sContentType = "image/jpeg";
              const rawType = (bgScreenshotFullType || "").toLowerCase().trim();
              let cleanB64 = bgScreenshotFullB64;
              if (cleanB64.startsWith("data:")) {
                const match = cleanB64.match(/^data:(image\/\w+);base64,/);
                if (match) {
                  cleanB64 = cleanB64.replace(/^data:image\/\w+;base64,/, "");
                  if (!rawType && match[1] === "image/png") {
                    ext = "png";
                    sContentType = "image/png";
                  }
                }
              }
              if (rawType === "image/png") {
                ext = "png";
                sContentType = "image/png";
              } else if (rawType === "image/webp") {
                ext = "webp";
                sContentType = "image/webp";
              }

              const binaryString = atob(cleanB64);
              const bytes = new Uint8Array(binaryString.length);
              for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

              if (bytes.length > 8 * 1024 * 1024) {
                console.warn(`[${requestId}] Full screenshot too large (${bytes.length} bytes), skipping`);
              } else {
                const filePath = `${bgScanId}-full.${ext}`;
                const { error: uploadError } = await supabaseAdmin.storage
                  .from("screenshots")
                  .upload(filePath, bytes, { contentType: sContentType, upsert: false });
                if (uploadError) {
                  console.error(`[${requestId}] Full screenshot upload failed:`, uploadError);
                } else {
                  const supabaseUrl = Deno.env.get("SUPABASE_URL");
                  const bgScreenshotFullUrl = `${supabaseUrl}/storage/v1/object/public/screenshots/${filePath}`;
                  const { error: updateError } = await supabaseAdmin
                    .from("lp_scan_history")
                    .update({ screenshot_full_url: bgScreenshotFullUrl })
                    .eq("id", bgScanId);
                  if (updateError) console.error(`[${requestId}] Failed to save screenshot_full_url:`, updateError);
                  else console.log(`[${requestId}] Full screenshot uploaded: ${bgScreenshotFullUrl}`);
                }
              }
              bgLap("bg_screenshot_full_done");
            } catch (screenshotFullError) {
              console.error(`[${requestId}] BG: Full screenshot error:`, screenshotFullError);
            }
          }

          if (userId && bgScanId && !localDebugBillingOverrideActive) {
            try {
              const normalizedUrl = normalizeUrlForImprovement(lpUrl);
              await computeImprovementIfNeeded(supabaseAdmin, userId, bgScanId, normalizedUrl, lpUrl, {
                overall_score: overallScore,
                clarity_score: clarityScore,
                relevance_score: relevanceScore,
                trust_score: trustScore,
                conversion_score: conversionScore,
                full_result: scoreData,
                created_at: new Date().toISOString(),
                content_hash: contentHash,
              });
              bgLap("bg_improvement_done");
            } catch (e) { console.error(`[${requestId}] BG: Improvement error:`, e); }
          }

          // Build the durable scan intelligence profile used by personalized email,
          // library comparisons, and future content surfaces. Fire-and-forget.
          if (bgScanId && !localDebugBillingOverrideActive) {
            try {
              const supabaseUrlEnv = Deno.env.get("SUPABASE_URL");
              const cronSecret = Deno.env.get("CRON_SECRET");
              if (supabaseUrlEnv && cronSecret) {
                fetch(`${supabaseUrlEnv}/functions/v1/build-scan-intelligence-profile`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "x-cron-secret": cronSecret,
                  },
                  body: JSON.stringify({ scan_id: bgScanId, user_id: userId }),
                }).catch((e: unknown) => console.error(`[${requestId}] BG: Scan intelligence trigger error:`, e));
                bgLap("bg_scan_intelligence_triggered");
              }
            } catch (e) { console.error(`[${requestId}] BG: Scan intelligence error:`, e); }
          }

          // Trigger post-scan personalized email (fire-and-forget)
          if (userId && !localDebugBillingOverrideActive && !apiKeyAuth) {
            try {
              const supabaseUrlEnv = Deno.env.get("SUPABASE_URL");
              const cronSecret = Deno.env.get("CRON_SECRET");
              if (supabaseUrlEnv && cronSecret) {
                fetch(`${supabaseUrlEnv}/functions/v1/send-post-scan-email`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "x-cron-secret": cronSecret,
                  },
                  body: JSON.stringify({ scan_id: bgScanId, user_id: userId }),
                }).catch((e: unknown) => console.error(`[${requestId}] BG: Post-scan email trigger error:`, e));
                bgLap("bg_post_scan_email_triggered");
              }
            } catch (e) { console.error(`[${requestId}] BG: Post-scan email error:`, e); }
          }

          bgLap("bg_all_done");
        })());
      }
    } else if (isFreePreviewModeActive) {
      console.log(`[${requestId}] [FREE PREVIEW MODE] Skipping scan history save - no DB writes`);
    }

    // Sanitize response for free users (skip in preview environments OR previewPro mode)
    // ALWAYS sanitize for Free Preview Mode to show exact Free UX
    // PDF purchase bypass users and credit-funded scan users get the FULL unsanitized response
    const isFree = resolvedPlan === "free";
    const isCreditFunded = !!(scanEntitlement?.creditId);
    const shouldSanitize = localDebugBillingOverrideActive
      ? !localDebugPremiumUnlock
      : isFreePreviewModeActive || (isFree && !isPreview && !previewPro && !pdfPurchaseBypassGranted && !isCreditFunded);

    // Diagnostic log for $9 one-page bypass scans
    if (pdfPurchaseBypassGranted) {
      const htfCounts = scoreData?.score_breakdown
        ? Object.entries(scoreData.score_breakdown).map(
            ([axis, v]: [string, any]) => `${axis}:${v?.how_to_fix?.length ?? 0}`
          )
        : [];
      const hasImprovedCopy = !!scoreData?.above_the_fold_fix?.improved_copy;
      console.log(`[${requestId}] [PDF_BYPASS] Sanitization decision`, {
        pdfPurchaseBypassGranted,
        shouldSanitize,
        howToFixCounts: htfCounts,
        hasImprovedCopy,
      });
    }

    // Inject screenshot_url into scoreData so sanitizeForFree can access it
    if (screenshotUrl) {
      scoreData.screenshot_url = screenshotUrl;
    }
    if (screenshotFullUrlImmediate) {
      scoreData.screenshot_full = screenshotFullUrlImmediate;
      scoreData.screenshot_full_type = "image/jpeg";
    }
    const responseData = shouldSanitize ? sanitizeForFree(scoreData) : scoreData;

    console.log(`[${requestId}] Response preparation`, {
      resolvedPlan,
      isFree,
      isPreview,
      previewPro,
      isFreePreviewModeActive,
      pdfPurchaseBypassGranted,
      shouldSanitize,
    });

    // Build response with optional debug info for dev origins
    // Include page_category for frontend market positioning
    const responseBody: Record<string, any> = {
      ok: true,
      data: responseData,
      scanId,
      billing: billingInfo,
      effective_tier: responseEffectiveTier,
      page_category: inferredCategory.page_category,
      // Include flag so client knows Free Preview is active
      freePreviewModeActive: isFreePreviewModeActive || undefined,
      // Include requestId for log correlation
      requestId,
      // Screenshot URL at top-level for frontend injection
      screenshot_url: screenshotUrl || undefined,
      screenshot_full: screenshotFullUrlImmediate || undefined,
    };

    // Include debug object ONLY for preview origins
    if (isPreview || previewPro || localDebugBillingOverrideActive) {
      responseBody._debug = {
        requestId,
        hasAuthHeader,
        userId,
        profilePlan,
        billingPlan: billingInfo?.plan ?? null,
        resolvedPlan,
        sanitizeApplied: shouldSanitize,
        preview_pro: previewPro, // Debug flag for preview Pro mode
        freePreviewModeActive: isFreePreviewModeActive,
        localDebugBillingOverride: activeLocalDebugBillingOverride,
      };
      console.log(`[${requestId}] Debug info attached`, {
        previewPro,
        freePreviewModeActive: isFreePreviewModeActive,
        localDebugBillingOverride: activeLocalDebugBillingOverride,
      });
    }

    if (compactResponseRequested) {
      const benchmarkEvidence = responseData?.benchmark_evidence ?? null;
      const references = Array.isArray(benchmarkEvidence?.references)
        ? benchmarkEvidence.references.slice(0, 3).map((ref: Record<string, any>) => ({
            name: ref.name ?? null,
            family: ref.market_family ?? ref.profile_family ?? null,
            match_confidence: ref.match_confidence ?? null,
            why_match: Array.isArray(ref.why_match) ? ref.why_match.slice(0, 2) : [],
          }))
        : [];
      const oneEdit = responseData?.free_preview_fix ?? responseData?.reference_backed_fix ?? null;

      responseBody.data = undefined;
      Object.assign(responseBody, {
        url: responseData?.url ?? responseData?.lp_url ?? lpUrl,
        final_url: responseData?.finalUrlStr ?? null,
        scores: responseData?.scores ?? {
          clarity_100: responseData?.clarity_100 ?? null,
          relevance_100: responseData?.relevance_100 ?? null,
          trust_100: responseData?.trust_100 ?? null,
          action_100: responseData?.action_100 ?? responseData?.conversion_100 ?? null,
          overall_100: responseData?.overall_100 ?? overallScore,
        },
        weakest_axis: responseData?.weakest_axis ?? responseData?.primary_bottleneck ?? null,
        one_edit: oneEdit
          ? {
              axis: oneEdit.axis ?? responseData?.weakest_axis ?? null,
              title: oneEdit.title ?? null,
              instruction: oneEdit.instruction ?? oneEdit.do_this_first ?? null,
              where: oneEdit.where ?? oneEdit.place ?? null,
              reason: oneEdit.reason ?? oneEdit.why_this_edit ?? null,
              patch: oneEdit.patch ?? null,
            }
          : null,
        benchmark_summary: {
          profile: benchmarkEvidence?.source_profile ?? null,
          reference_count: Array.isArray(benchmarkEvidence?.references) ? benchmarkEvidence.references.length : 0,
          references,
        },
        usage: billingInfo
          ? {
              plan: billingInfo.plan,
              source: billingInfo.source ?? "ui",
              api_calls_used: billingInfo.api_calls_used ?? null,
              api_calls_limit: billingInfo.api_calls_limit ?? null,
              api_calls_remaining: billingInfo.api_calls_remaining ?? null,
            }
          : null,
      });
    }

    const responseJson = JSON.stringify(responseBody);
    lap("before_final_response", { overallScore, scanId, responseSize: responseJson.length });
    logEdgeStage("summary", "summary", {
      total_ms: Date.now() - t0,
      edge_stage_timings_ms: edgeStageTimingsMs,
      overallScore,
      scanId,
      responseSize: responseJson.length,
      lp_url: lpUrl,
      user_id: userId,
    });

    await markScanAttempt("completed", {
      stage: "response_sent",
      scan_id: scanId ?? null,
      backend_kind: activeBackend.kind,
    });
    // A usable result is about to be delivered. Keep the reserved free slot.
    reservedFreeCreditForCleanup = null;
    return new Response(responseJson, { status: 200, headers: corsHeaders });
  } catch (error) {
    logEdgeStage("summary", "failed", {
      total_ms: Date.now() - t0,
      edge_stage_timings_ms: edgeStageTimingsMs,
      error: (error as Error)?.message || String(error),
    });
    console.error(`[${requestId ?? "unknown"}] TIMING catch_block`, {
      elapsed_ms: typeof t0 !== "undefined" ? Date.now() - t0 : -1,
      error: (error as Error)?.message || String(error),
      stack: (error as Error)?.stack?.substring(0, 500),
    });
    console.error("Unexpected error:", error);

    // Best-effort: mark the scan_attempt_events row as failed from the outer
    // catch so unexpected exceptions remain traceable.
    if (outerScanAttemptEventId) {
      try {
        const supabaseUrlEnv = Deno.env.get("SUPABASE_URL");
        const supabaseServiceKeyEnv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (supabaseUrlEnv && supabaseServiceKeyEnv) {
          const catchAdmin = createClient(supabaseUrlEnv, supabaseServiceKeyEnv);
          await catchAdmin
            .from("scan_attempt_events")
            .update({
              status: "failed",
              stage: "unhandled_exception",
              error_code: "UNCAUGHT_EXCEPTION",
              error_message: ((error as Error)?.message || String(error)).substring(0, 500),
              updated_at: new Date().toISOString(),
            })
            .eq("id", outerScanAttemptEventId);
        }
      } catch (markErr) {
        console.warn(`[${requestId}] outer-catch markScanAttempt failed:`, markErr);
      }
    }

    return new Response(
      JSON.stringify({ ok: false, error: "Internal server error", requestId }),
      { status: 500, headers: corsHeaders }
    );
  } finally {
    if (reservedFreeCreditForCleanup) {
      const reservation = reservedFreeCreditForCleanup;
      try {
        const supabaseUrlEnv = Deno.env.get("SUPABASE_URL");
        const supabaseServiceKeyEnv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (supabaseUrlEnv && supabaseServiceKeyEnv) {
          const cleanupAdmin = createClient(supabaseUrlEnv, supabaseServiceKeyEnv);
          const { error: cleanupError } = await cleanupAdmin
            .rpc("refund_reserved_free_scan_credit", {
              p_user_id: reservation.userId,
              p_period_start: reservation.periodStart,
            });
          if (cleanupError) console.error(`[${requestId}] Failed to refund free scan reservation:`, cleanupError);
          else console.log(`[${requestId}] Refunded free scan reservation after incomplete scan`, { userId: reservation.userId });
        }
      } catch (cleanupError) {
        console.error(`[${requestId}] Failed to refund free scan reservation:`, cleanupError);
      }
    }
    if (reservedCreditForCleanup) {
      const reservation = reservedCreditForCleanup;
      try {
        const supabaseUrlEnv = Deno.env.get("SUPABASE_URL");
        const supabaseServiceKeyEnv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (supabaseUrlEnv && supabaseServiceKeyEnv) {
          const cleanupAdmin = createClient(supabaseUrlEnv, supabaseServiceKeyEnv);
          const { error: cleanupError } = await cleanupAdmin
            .from("pdf_purchases")
            .update({ status: "available", reserved_at: null })
            .eq("id", reservation.creditId)
            .eq("user_id", reservation.userId)
            .eq("status", "reserved");

          if (cleanupError) {
            console.error(`[${requestId}] Failed to release prepaid credit reservation:`, cleanupError);
          } else {
            console.log(`[${requestId}] Released prepaid credit reservation after incomplete scan:`, {
              creditId: reservation.creditId,
              userId: reservation.userId,
            });
          }
        }
      } catch (cleanupError) {
        console.error(`[${requestId}] Failed to release prepaid credit reservation:`, cleanupError);
      }
    }
  }
});
