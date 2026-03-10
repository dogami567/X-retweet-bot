import filters from "../lib/bulk-follow-filters.js";

const {
  evaluateBulkFollowCandidate,
  normalizeBulkFollowCandidateProfile,
  normalizeBulkFollowFilterRules,
} = filters;

function assert(condition, message) {
  if (condition) return;
  throw new Error(message);
}

function main() {
  const rules = normalizeBulkFollowFilterRules({
    requireVerified: true,
    requireChineseBio: true,
  });

  const verifiedChinese = normalizeBulkFollowCandidateProfile({
    handle: "verified_cn",
    verified: true,
    verifiedKnown: true,
    bioText: "金融科技创业者，欢迎交流",
    bioKnown: true,
  });
  const unverifiedChinese = normalizeBulkFollowCandidateProfile({
    handle: "plain_cn",
    verified: false,
    verifiedKnown: true,
    bioText: "中文简介，持续更新",
    bioKnown: true,
  });
  const verifiedEnglish = normalizeBulkFollowCandidateProfile({
    handle: "verified_en",
    verified: true,
    verifiedKnown: true,
    bioText: "Building products for the future",
    bioKnown: true,
  });

  const allow = evaluateBulkFollowCandidate(verifiedChinese, rules);
  const skipVerified = evaluateBulkFollowCandidate(unverifiedChinese, rules);
  const skipBio = evaluateBulkFollowCandidate(verifiedEnglish, rules);

  assert(allow.allow === true && allow.skipReason === "", "verified + 中文 bio 应允许继续 follow");
  assert(skipVerified.allow === false && skipVerified.skipReason === "filtered_unverified", "未认证账号应命中过滤 skipReason");
  assert(skipBio.allow === false && skipBio.skipReason === "filtered_bio_no_chinese", "纯英文 bio 应命中过滤 skipReason");

  const unknownProfile = normalizeBulkFollowCandidateProfile({
    handle: "unknown_profile",
    verifiedKnown: false,
    bioKnown: false,
  });
  const unknownResult = evaluateBulkFollowCandidate(unknownProfile, rules);
  assert(unknownResult.allow === true, "未知 profile 信号不应被误判为过滤命中");

  console.log("[FOLLOW-FILTER-SMOKE] ok rules=verified+bio fixtures=4");
}

main();
