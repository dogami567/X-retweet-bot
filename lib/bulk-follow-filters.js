"use strict";

function safeString(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeHandle(handle) {
  return safeString(handle).trim().replace(/^@/, "");
}

function profileBioHasChineseSignal(text) {
  return /[\u3400-\u9fff]/.test(safeString(text));
}

function normalizeBulkFollowFilterRules(raw) {
  const next = raw && typeof raw === "object" ? raw : {};
  return {
    requireVerified: next.requireVerified === true,
    requireChineseBio: next.requireChineseBio === true,
  };
}

function normalizeBulkFollowCandidateProfile(raw) {
  const next = raw && typeof raw === "object" ? raw : {};
  const bioText = safeString(next.bioText).replace(/\s+/g, " ").trim();
  const verifiedKnown = next.verifiedKnown !== false;
  const bioKnown = next.bioKnown !== false;
  const bioHasChinese = next.bioHasChinese === true || profileBioHasChineseSignal(bioText);

  return {
    handle: normalizeHandle(next.handle),
    displayName: safeString(next.displayName).replace(/\s+/g, " ").trim(),
    bioText,
    verified: next.verified === true,
    verifiedKnown,
    bioHasChinese,
    bioKnown,
  };
}

function evaluateBulkFollowCandidate(profile, rules) {
  const candidate = normalizeBulkFollowCandidateProfile(profile);
  const normalizedRules = normalizeBulkFollowFilterRules(rules);

  if (normalizedRules.requireVerified && candidate.verifiedKnown && !candidate.verified) {
    return { allow: false, skipReason: "filtered_unverified", profile: candidate };
  }

  if (normalizedRules.requireChineseBio && candidate.bioKnown && !candidate.bioHasChinese) {
    return { allow: false, skipReason: "filtered_bio_no_chinese", profile: candidate };
  }

  return { allow: true, skipReason: "", profile: candidate };
}

module.exports = {
  evaluateBulkFollowCandidate,
  normalizeBulkFollowCandidateProfile,
  normalizeBulkFollowFilterRules,
  profileBioHasChineseSignal,
};
