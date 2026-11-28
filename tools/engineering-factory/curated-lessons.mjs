// Deterministic M02.03 (#14) evaluator for short, portable, selectively loaded
// repository guidance, provenance-bound curated lessons, checkpoint-aware context
// deduplication, and matched >=5-unit exploration/rework/context cohort comparison.
// Metadata-only, read-only, fail-closed, with zero external knowledge-store dependency.
import {types} from 'node:util';
import {
  SOFTWARE_FACTORY_REPOSITORY_ID,
  isSafeRepoRelativePath,
  parseTraceparent
} from './anti-rogue-audit.mjs';

export const SOFTWARE_FACTORY_REPOSITORY_SLUG = 'Jamula/SoftwareFactory';
export const MAX_GUIDANCE_TEXT_CHARS = 512;
export const MIN_COMPARABLE_COHORT_UNITS = 5;
export const DEFAULT_MAX_SELECTED_GUIDANCE = 8;
export const DEFAULT_MAX_SELECTED_LESSONS = 8;
export const DEFAULT_MAX_CONTEXT_BYTES = 4096;
export const MAX_FRESHNESS_CEILING_MS = 31_536_000_000;

export const ALLOWED_SPECIALIST_ROLES = Object.freeze([
  'api',
  'data',
  'security',
  'test',
  'infra',
  'ui',
  'docs',
  'coordinator'
]);

export const ALLOWED_LESSON_SOURCES = Object.freeze([
  'accepted-pr',
  'accepted-issue'
]);

export const ALLOWED_GUIDANCE_SOURCES = Object.freeze([
  'trusted-repo-doc',
  'trusted-lane-contract'
]);

const specialistRoleSet = new Set(ALLOWED_SPECIALIST_ROLES);
const lessonSourceSet = new Set(ALLOWED_LESSON_SOURCES);
const guidanceSourceSet = new Set(ALLOWED_GUIDANCE_SOURCES);

const SELECTION_REQUIRED_KEYS = [
  'repositoryId',
  'repositorySlug',
  'expectedHeadSha',
  'nowMs',
  'targetComponent',
  'specialistRole',
  'changedPaths',
  'guidanceEntries',
  'curatedLessons'
];

const SELECTION_OPTIONAL_KEYS = [
  'issueNumber',
  'policy',
  'checkpointEvidence',
  'externalKnowledgeStoreRequired'
];

const SELECTION_POLICY_KEYS = [
  'minLineCoveragePct',
  'minBranchCoveragePct',
  'maxSelectedGuidance',
  'maxSelectedLessons',
  'maxContextBytes'
];

const CHECKPOINT_REQUIRED_KEYS = [
  'checkpointId',
  'repositoryId',
  'issueNumber',
  'headSha',
  'sequence',
  'digestSha256',
  'traceparent',
  'completedSupersteps'
];

const CHECKPOINT_OPTIONAL_KEYS = ['verifiedPaths'];

const GUIDANCE_REQUIRED_KEYS = [
  'guidanceId',
  'repositoryId',
  'revisionSha',
  'source',
  'sourcePath',
  'componentScope',
  'guidanceText'
];

const GUIDANCE_OPTIONAL_KEYS = [
  'specialistRoles',
  'pathPrefixes',
  'proposedMinLineCoveragePct',
  'proposedMinBranchCoveragePct'
];

const LESSON_REQUIRED_KEYS = [
  'lessonId',
  'repositoryId',
  'sourceKind',
  'sourceNumber',
  'sourceCommitSha',
  'verifiedHeadSha',
  'componentScope',
  'guidanceText',
  'observedAtMs',
  'maxFreshnessMs'
];

const LESSON_OPTIONAL_KEYS = [
  'visibility',
  'specialistRoles',
  'pathPrefixes',
  'proposedMinLineCoveragePct',
  'proposedMinBranchCoveragePct'
];

const COHORT_REQUIRED_KEYS = [
  'repositoryId',
  'cohortId',
  'windowStartMs',
  'windowEndMs',
  'provenanceVerified',
  'independentReviewVerified',
  'units'
];

const COHORT_OPTIONAL_KEYS = ['quotaCreditsRemaining'];

const UNIT_REQUIRED_KEYS = [
  'unitId',
  'accepted',
  'explorationSteps',
  'contextBytesLoaded',
  'repeatedContextLoads',
  'reworkIterations',
  'aiCredits',
  'incrementalBilledUsdCents',
  'coveredLines',
  'totalLines',
  'coveredBranches',
  'totalBranches',
  'securityFindings',
  'duplicateWork',
  'unsupportedRouting'
];

const COHORT_POLICY_KEYS = [
  'minLineCoveragePct',
  'minBranchCoveragePct',
  'quotaCreditsRemaining'
];

const SECRET_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\b(?:authorization\s*:\s*bearer\s+\S+|bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:api[_-]?key|client[_-]?secret|access[_-]?token|password|passwd|private[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{8,})/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@[^\s]+/i
];

const PROMPT_INJECTION_OVERRIDE_PATTERN =
  /(?:\b|(?<=_))(?:ignore|disregard|forget|override)[\s_-]+(?:(?:all|any|the|these|those|our|your|existing|current)[\s_-]+)*(?:(?:previous|prior|above|system|developer|repository|safety|security)[\s_-]+)+(?:instructions?|prompts?|rules?|constraints?|polic(?:y|ies)|gates?|directives?|guardrails?)(?=\b|_)/gi;

const UNCONDITIONAL_PROMPT_INJECTION_PATTERNS = [
  /(?:<\s*\/?\s*(?:system|developer|assistant|user|tool_call|system_instruction)\s*>|\[\s*(?:SYSTEM|INST|ADMIN_OVERRIDE)\s*\]|\byou\s+are\s+now\s+(?:unrestricted|in\s+developer\s+mode|authorized\s+to\s+bypass)\b)/i,
  /(?:\bexfiltrate\b|\b(?:curl|wget)\b[\s\S]*https?:\/\/|\bsend\s+(?:secrets?|tokens?|env|credentials?)\s+to\b)/i
];

const PRIVATE_CROSS_REPO_PHRASE =
  /(?:\b|(?<=_))(?:private[\s_-]+cross[\s_-]+repo|cross[\s_-]+repo[\s_-]+private|internal[\s_-]+only[\s_-]+repo|customer[\s_-]+private[\s_-]+repo|copied[\s_-]+from[\s_-]+private[\s_-]+repo)(?=\b|_)/i;

const CANONICAL_GITHUB_HTTPS_PATTERN =
  /^(?:https?:\/\/)?github\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:(?:\/[A-Za-z0-9_./-]*)?(?:#[A-Za-z0-9_.-]*)?)?$/i;

const CANONICAL_GITHUB_SSH_PATTERN =
  /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i;

const CANONICAL_RAW_GITHUB_PATTERN =
  /^(?:https?:\/\/)?raw\.githubusercontent\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_./-]*)?$/i;

const VERIFIED_GITHUB_URL_SPAN_PATTERN =
  /(?<![A-Za-z0-9_./:-])(?:https?:\/\/)?(?:github\.com|raw\.githubusercontent\.com)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]*)?(?:#[A-Za-z0-9_.-]*)?/gi;

const OUTER_WRAPPER_TRIM_PATTERN =
  /^[`'"([<{*_~“”‘’«»\u2012-\u2015]+|[`'")\]>},;.!?*_~“”‘’«»\u2012-\u2015]+$/g;
const MARKDOWN_LINK_PATTERN =
  /(?<![A-Za-z0-9_./:\\-])\[((?:\\[\s\S]|[^\[\]\\])+)\]\(\s*(<[^<>\s]+>|[^\s()]+)(?:\s+(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|\(((?:\\[\s\S]|[^()\\])*)\)))?\s*\)(?!\S*\.\.)(?=(?:[`'")\]>},;.!?*_~“”‘’«»\u2012-\u2015])*(?:$|\s))/g;
const IDNA_DOT_PATTERN = /[\u3002\uFF0E\uFF61]/g;
const PERCENT_RUN_PATTERN = /(?:%[0-9a-fA-F]{2})+/g;
const UTF8_DECODER = new TextDecoder('utf-8', {fatal: false});
const PREFIX_WRAPPER_PATTERN =
  /^(?:[A-Za-z0-9_-]+=|#[0-9]+[\u2012-\u2015]+)(.+)$/;

const REPO_QUALIFIER_PATTERN =
  /(?:(?<![A-Za-z0-9])repo[:=]|--repo\s+)([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)/gi;

const SHORTHAND_REPO_REF_PATTERN =
  /(?<![A-Za-z0-9])([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)#\d+\b/g;

const POLICY_WEAKENING_PATTERNS = [
  /(?:\b|(?<=_))(?:skip|bypass|disable|deactivate|waive|relax|lower|reduce|drop|ignore|override|weaken|circumvent|turn[\s_-]+off|suppress)[\s_-]+(?:(?:the|a|an|all|any|our|these|those|required|mandatory|strict|independent|existing|current|enforced|blocking|full|consumer|stricter|automated)[\s_-]+)*(?:coverage(?:[\s_-]+(?:gate|check|floor|threshold)s?)?|lines?[\s_-]+coverage(?:[\s_-]+(?:gate|check|floor|threshold)s?)?|branch(?:es)?[\s_-]+coverage(?:[\s_-]+(?:gate|check|floor|threshold)s?)?|codeql(?:[\s_-]+(?:gate|check|scan)s?)?|security[\s_-]+(?:gate|check|scan|review|guard)s?|independent[\s_-]+reviews?(?:[\s_-]+gates?)?|review[\s_-]+(?:gate|check|requirement)s?|merge[\s_-]+queues?|ci[\s_-]+(?:gate|check)s?|validations?(?:[\s_-]+(?:gate|check)s?)?|ownership[\s_-]+(?:guard|gate|check)s?|budget[\s_-]+(?:gate|check|guard|cap)s?|zero[\s_-]+spend(?:[\s_-]+(?:gate|policy|guard)s?)?)(?=\b|_)/gi,
  /(?:\b|(?<=_))(?:allow|enable|authorize|permit)[\s_-]+(?:(?:the|a|an|all|any|optional|temporary|manual|emergency)[\s_-]+)*(?:self[\s_-]+approvals?|self[\s_-]+merges?|unreviewed[\s_-]+merges?|direct[\s_-]+push(?:es)?[\s_-]+to[\s_-]+main|live[\s_-]+dispatch(?:es)?|live[\s_-]+merges?|paid[\s_-]+fallbacks?|unapproved[\s_-]+spend|--no-verify)(?=\b|_)/gi
];

const CARVEOUT_CLAUSE_SOURCE =
  '(?:unless|except|but|however|instead|otherwise|though|although|if|when|whenever|where|while|provided|once|until|during|in\\s+case|as\\s+long\\s+as|so\\s+long\\s+as|even\\s+(?:if|when|though)|only\\s+(?:if|when|for|on|in|after|during|until)|other\\s+than|apart\\s+from|save\\s+for)';

const SENTENCE_CARVEOUT_PATTERN = new RegExp(`\\b${CARVEOUT_CLAUSE_SOURCE}\\b`, 'i');

const TRAILING_CARVEOUT_CLAUSE_PATTERN = new RegExp(
  `^[\\s([\\{<«'"\`“”‘’*_~\\u2012-\\u2015-]*${CARVEOUT_CLAUSE_SOURCE}\\b`,
  'i'
);

const POLARITY_REVERSER_PATTERN =
  /(?:n['’]t|\b(?:cannot|not|never|no|without|neither|refuse|forbid|prohibit|hesitate|fail|stop|avoid|prevent))\b/gi;

const IMMEDIATE_REJECTION_PREFIX_PATTERN =
  /\b(?:reject|fail|block|deny|forbid|prohibit|disallow)(?:\s+(?:any|all|every))?\s*$/i;

const NEGATION_ANCHOR_PATTERN =
  /\b(?:never|do\s+not|don['’]t|must\s+not|mustn['’]t|cannot|can['’]t|shall\s+not|should\s+not|shouldn['’]t|will\s+not|won['’]t|refuse\s+to)\s+(?:ever\s+)?/gi;

const PROHIBITED_SEGMENT_PATTERN =
  /^(?:skip|bypass|disable|deactivate|waive|relax|lower|reduce|drop|ignore|disregard|forget|override|weaken|circumvent|turn[\s_-]+off|suppress|allow|enable|authorize|permit)(?:\s+[A-Za-z0-9_-]+){1,6}$/i;

const PROHIBITED_CONNECTOR_SPLIT = /(?:,\s*(?:or|nor)\s+|\s+(?:or|nor)\s+|,\s+)/i;

const UPPER_BOUND_OP_PATTERN = /^(?:<=?|(?:under|below|at[\s_-]+most|up[\s_-]+to|max|maximum))$/i;

const COVERAGE_PAIR_PATTERN =
  /(?:([<>]=?|\b(?:under|below|at[\s_-]+most|up[\s_-]+to|max|maximum)\b)\s*)?(\d+(?:\.\d+)?)\s*%\s*\/\s*(\d+(?:\.\d+)?)\s*%/gi;
const LINE_PCT_BEFORE_PATTERN =
  /(?:([<>]=?|\b(?:under|below|at[\s_-]+most|up[\s_-]+to|max|maximum)\b)\s*)?(\d+(?:\.\d+)?)\s*%\s*(?:(?:minimum|min|source)[\s_-]+)*(?:lines?(?:[\s_-]+coverage)?|overall[\s_-]+coverage)(?:[\s_-]+(?:threshold|floor|gate|target)s?)*(?=\b|_)/gi;
const LINE_PCT_AFTER_PATTERN =
  /(?:\b|(?<=_))(?:lines?|overall)[\s_-]+coverage(?:[\s_-]+(?:threshold|floor|gate|target|min|minimum|of|to|is|at))*(?:\s*([<>]=?|==?|:|\b(?:under|below|at[\s_-]+most|up[\s_-]+to|max|maximum)\b))?\s*(\d+(?:\.\d+)?)\s*%/gi;
const BRANCH_PCT_BEFORE_PATTERN =
  /(?:([<>]=?|\b(?:under|below|at[\s_-]+most|up[\s_-]+to|max|maximum)\b)\s*)?(\d+(?:\.\d+)?)\s*%\s*(?:(?:minimum|min)[\s_-]+)*branch(?:es)?(?:[\s_-]+coverage)?(?:[\s_-]+(?:threshold|floor|gate|target)s?)*(?=\b|_)/gi;
const BRANCH_PCT_AFTER_PATTERN =
  /(?:\b|(?<=_))branch(?:es)?[\s_-]+coverage(?:[\s_-]+(?:threshold|floor|gate|target|min|minimum|of|to|is|at))*(?:\s*([<>]=?|==?|:|\b(?:under|below|at[\s_-]+most|up[\s_-]+to|max|maximum)\b))?\s*(\d+(?:\.\d+)?)\s*%/gi;
const GENERAL_COVERAGE_BEFORE_PATTERN =
  /(?:([<>]=?|\b(?:under|below|at[\s_-]+most|up[\s_-]+to|max|maximum)\b)\s*)?(\d+(?:\.\d+)?)\s*%\s*(?:(?:minimum|min)[\s_-]+)*coverage(?:[\s_-]+(?:threshold|floor|gate|target)s?)*(?=\b|_)/gi;
const GENERAL_COVERAGE_AFTER_PATTERN =
  /(?:\b|(?<=_))coverage(?:[\s_-]+(?:threshold|floor|gate|target|min|minimum|of|to|is|at))*(?:\s*([<>]=?|==?|:|\b(?:under|below|at[\s_-]+most|up[\s_-]+to|max|maximum)\b))?\s*(\d+(?:\.\d+)?)\s*%/gi;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !types.isProxy(value) &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOwnEnumerableData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && descriptor.enumerable === true &&
    Object.hasOwn(descriptor, 'value') && descriptor.value !== undefined;
}

function exactRecord(value, requiredKeys, optionalKeys = []) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key) || !hasOwnEnumerableData(value, key))) {
    return false;
  }
  return requiredKeys.every(key => hasOwnEnumerableData(value, key));
}

function denseDataArray(value, maxLen) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  if (value.length > maxLen || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    if (!hasOwnEnumerableData(value, i)) return false;
  }
  return true;
}

const positiveInt = n => Number.isSafeInteger(n) && n > 0;
const nonnegInt = n => Number.isSafeInteger(n) && n >= 0;
const isSha40 = s => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
const isSha256 = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const isIdentifier = s => typeof s === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(s);
const isComponentToken = s => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
const isCohortId = s => typeof s === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s);
function isRepositorySlug(s) {
  if (typeof s !== 'string' || s.length > 160 || /\.git$/i.test(s)) return false;
  const match = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  return match !== null && match[2] !== '.' && match[2] !== '..';
}
const validCounts = (covered, total) =>
  nonnegInt(covered) && positiveInt(total) && covered <= total && total <= 100_000_000;

function uniqueStrings(list) {
  return new Set(list).size === list.length;
}

function validUniquePathList(list, maxLen) {
  return denseDataArray(list, maxLen) && list.length > 0 &&
    list.every(isSafeRepoRelativePath) && uniqueStrings(list);
}

function validRoleSubset(roles) {
  return denseDataArray(roles, ALLOWED_SPECIALIST_ROLES.length) && roles.length > 0 &&
    roles.every(role => specialistRoleSet.has(role)) && uniqueStrings(roles);
}

function normalizeComponentScope(scope) {
  if (isComponentToken(scope)) return Object.freeze([scope]);
  if (denseDataArray(scope, 32) && scope.length > 0 &&
      scope.every(isComponentToken) && uniqueStrings(scope)) {
    return Object.freeze([...scope]);
  }
  return null;
}

function matchesPrefix(prefix, candidatePath) {
  return candidatePath === prefix || candidatePath.startsWith(`${prefix}/`);
}

function resolveCoverageFloors(repositoryId, rawLine, rawBranch) {
  const isFactory = repositoryId === SOFTWARE_FACTORY_REPOSITORY_ID;
  const lineFloor = isFactory ? 98 : 95;
  const branchFloor = isFactory ? 95 : 90;
  const minLineCoveragePct = rawLine === undefined ? lineFloor : rawLine;
  const minBranchCoveragePct = rawBranch === undefined ? branchFloor : rawBranch;

  if (!Number.isFinite(minLineCoveragePct) || minLineCoveragePct > 100 ||
      !Number.isFinite(minBranchCoveragePct) || minBranchCoveragePct > 100) {
    return {ok: false, reason: 'INVALID_POLICY'};
  }
  if (minLineCoveragePct < lineFloor || minBranchCoveragePct < branchFloor) {
    return {ok: false, reason: 'POLICY_WEAKENING_REJECTED'};
  }
  return {ok: true, minLineCoveragePct, minBranchCoveragePct};
}

function resolveSelectionPolicy(raw, repositoryId) {
  if (raw === undefined) {
    const base = resolveCoverageFloors(repositoryId, undefined, undefined);
    return {
      ok: true,
      minLineCoveragePct: base.minLineCoveragePct,
      minBranchCoveragePct: base.minBranchCoveragePct,
      maxSelectedGuidance: DEFAULT_MAX_SELECTED_GUIDANCE,
      maxSelectedLessons: DEFAULT_MAX_SELECTED_LESSONS,
      maxContextBytes: DEFAULT_MAX_CONTEXT_BYTES
    };
  }
  if (!exactRecord(raw, [], SELECTION_POLICY_KEYS)) {
    return {ok: false, reason: 'INVALID_POLICY'};
  }
  const floors = resolveCoverageFloors(repositoryId, raw.minLineCoveragePct, raw.minBranchCoveragePct);
  if (!floors.ok) return floors;

  const maxSelectedGuidance = raw.maxSelectedGuidance === undefined
    ? DEFAULT_MAX_SELECTED_GUIDANCE
    : raw.maxSelectedGuidance;
  const maxSelectedLessons = raw.maxSelectedLessons === undefined
    ? DEFAULT_MAX_SELECTED_LESSONS
    : raw.maxSelectedLessons;
  const maxContextBytes = raw.maxContextBytes === undefined
    ? DEFAULT_MAX_CONTEXT_BYTES
    : raw.maxContextBytes;

  if (!positiveInt(maxSelectedGuidance) || maxSelectedGuidance > 32 ||
      !positiveInt(maxSelectedLessons) || maxSelectedLessons > 32 ||
      !positiveInt(maxContextBytes) || maxContextBytes < 128 || maxContextBytes > 16_384) {
    return {ok: false, reason: 'INVALID_POLICY'};
  }
  return {
    ok: true,
    minLineCoveragePct: floors.minLineCoveragePct,
    minBranchCoveragePct: floors.minBranchCoveragePct,
    maxSelectedGuidance,
    maxSelectedLessons,
    maxContextBytes
  };
}

function validateProposedGateThresholds(item, policy, invalidSchemaReason) {
  if (hasOwnEnumerableData(item, 'proposedMinLineCoveragePct')) {
    const proposedLine = item.proposedMinLineCoveragePct;
    if (!Number.isFinite(proposedLine) || proposedLine < 0 || proposedLine > 100) {
      return {ok: false, reason: invalidSchemaReason};
    }
    if (proposedLine < policy.minLineCoveragePct) {
      return {ok: false, reason: 'POLICY_WEAKENING_REJECTED'};
    }
  }
  if (hasOwnEnumerableData(item, 'proposedMinBranchCoveragePct')) {
    const proposedBranch = item.proposedMinBranchCoveragePct;
    if (!Number.isFinite(proposedBranch) || proposedBranch < 0 || proposedBranch > 100) {
      return {ok: false, reason: invalidSchemaReason};
    }
    if (proposedBranch < policy.minBranchCoveragePct) {
      return {ok: false, reason: 'POLICY_WEAKENING_REJECTED'};
    }
  }
  return {ok: true};
}

function isHardSentenceDelimiterAt(text, index) {
  const ch = text[index];
  if (ch === '!' || ch === '?') return true;
  if (ch === '.') {
    if (index + 1 === text.length) return true;
    if (!/\s/.test(text[index + 1])) return false;
    return !/^\s+[a-z0-9]/.test(text.slice(index + 1));
  }
  return false;
}

function isClauseDelimiterAt(text, index) {
  const ch = text[index];
  if (ch === ';') return true;
  if (ch === ':') {
    return index + 1 === text.length || /\s/.test(text[index + 1]);
  }
  return isHardSentenceDelimiterAt(text, index);
}

function clauseAndSentenceBoundsAt(text, matchIndex, matchLength) {
  let start = 0;
  let compoundStart = 0;
  let foundClauseStart = false;
  for (let i = matchIndex - 1; i >= 0; i--) {
    if (!foundClauseStart && isClauseDelimiterAt(text, i)) {
      start = i + 1;
      foundClauseStart = true;
    }
    if (isHardSentenceDelimiterAt(text, i)) {
      compoundStart = i + 1;
      break;
    }
  }
  let end = text.length;
  let compoundEnd = text.length;
  let foundClauseEnd = false;
  for (let i = matchIndex + matchLength; i < text.length; i++) {
    if (!foundClauseEnd && isClauseDelimiterAt(text, i)) {
      end = i;
      foundClauseEnd = true;
    }
    if (isHardSentenceDelimiterAt(text, i)) {
      compoundEnd = i;
      break;
    }
  }
  return {start, end, compoundStart, compoundEnd};
}

function hasCarveoutAroundClause(text, bounds) {
  return SENTENCE_CARVEOUT_PATTERN.test(text.slice(bounds.compoundStart, bounds.compoundEnd)) ||
    (bounds.end < text.length && TRAILING_CARVEOUT_CLAUSE_PATTERN.test(text.slice(bounds.end + 1))) ||
    (bounds.compoundEnd < text.length &&
      bounds.compoundEnd !== bounds.end &&
      TRAILING_CARVEOUT_CLAUSE_PATTERN.test(text.slice(bounds.compoundEnd + 1)));
}

const ALLOWED_PROHIBITION_SUBJECT_PATTERN =
  /^\s*(?:(?:you|we|agents?|workers?|executors?|specialists?|lanes?|callers?)\s+)?$/i;

const ALLOWED_REJECTION_LEAD_PATTERN =
  /^\s*(?:(?:you|we|ci|gates?|agents?|evaluators?)\s+|(?:reject|fail|block|deny|forbid|prohibit|disallow)\b[^'"`“”‘’]*?\band\s+)?$/i;

function countPolarityReversers(segment) {
  return [...segment.matchAll(POLARITY_REVERSER_PATTERN)].length;
}

function isUnconditionalRejectionClause(text, matchIndex, matchLength) {
  const normalized = text.replaceAll('_', ' ');
  const bounds = clauseAndSentenceBoundsAt(normalized, matchIndex, matchLength);
  const sentence = normalized.slice(bounds.start, bounds.end);
  if (hasCarveoutAroundClause(normalized, bounds) || /['"`“”‘’]/.test(sentence)) return false;
  const prefix = normalized.slice(bounds.start, matchIndex);
  const immediateMatch = IMMEDIATE_REJECTION_PREFIX_PATTERN.exec(prefix);
  if (immediateMatch === null) return false;
  const beforeVerb = prefix.slice(0, immediateMatch.index);
  const suffix = normalized.slice(matchIndex + matchLength, bounds.end);
  return ALLOWED_REJECTION_LEAD_PATTERN.test(beforeVerb) &&
    countPolarityReversers(beforeVerb) === 0 &&
    countPolarityReversers(suffix) === 0;
}

function hasWeakCoverageMatch(text, pattern, floor) {
  for (const match of text.matchAll(pattern)) {
    const rawOp = match[1];
    const value = Number.parseFloat(match[2]);
    if (value < floor) return true;
    if (rawOp !== undefined &&
        UPPER_BOUND_OP_PATTERN.test(rawOp.trim()) &&
        !isUnconditionalRejectionClause(text, match.index, match[0].length)) {
      return true;
    }
  }
  return false;
}

function hasGithubDomainLabels(host) {
  const labels = host.replace(/^-+|-+$/g, '').toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2 || labels.at(-1) !== 'com') return false;
  const secondLevel = labels.at(-2);
  return secondLevel === 'github' || secondLevel === 'githubusercontent';
}

function decodeAuthorityText(value) {
  const percentDecoded = value.replace(PERCENT_RUN_PATTERN, run => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    }
    return UTF8_DECODER.decode(bytes);
  });
  return percentDecoded.normalize('NFKC').replace(IDNA_DOT_PATTERN, '.');
}

function mentionsGithubAuthority(token) {
  if (URL.canParse(token) && hasGithubDomainLabels(new URL(token).hostname)) {
    return true;
  }
  const segments = decodeAuthorityText(token).split(/[^A-Za-z0-9.-]+/);
  return segments.some(seg => seg.length > 0 && hasGithubDomainLabels(seg));
}

function isDisallowedRawOrUnwrappedCandidate(rawToken, candidate, expectedSlugLower) {
  if (rawToken.includes('\\') || rawToken.includes('%') || rawToken.includes('..') ||
      /(?:^|\/)\.[`'")\]>},;.!?*_~“”‘’«»\u2012-\u2015]*$/.test(rawToken)) {
    return true;
  }
  const parsed =
    CANONICAL_GITHUB_HTTPS_PATTERN.exec(candidate) ??
    CANONICAL_GITHUB_SSH_PATTERN.exec(candidate) ??
    CANONICAL_RAW_GITHUB_PATTERN.exec(candidate);
  return parsed === null || parsed[1].toLowerCase() !== expectedSlugLower;
}

function unwrapOuterCandidate(rawToken) {
  const prefixMatch = PREFIX_WRAPPER_PATTERN.exec(rawToken);
  if (prefixMatch !== null) {
    return prefixMatch[1].replace(OUTER_WRAPPER_TRIM_PATTERN, '');
  }
  return rawToken.replace(OUTER_WRAPPER_TRIM_PATTERN, '');
}

function hasDisallowedGithubHostToken(text, expectedSlugLower) {
  for (const linkMatch of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const rawDestination = linkMatch[2];
    const unwrappedDestination = rawDestination.startsWith('<') && rawDestination.endsWith('>')
      ? rawDestination.slice(1, -1)
      : rawDestination;
    if ((mentionsGithubAuthority(rawDestination) || mentionsGithubAuthority(unwrappedDestination)) &&
        isDisallowedRawOrUnwrappedCandidate(rawDestination, unwrappedDestination, expectedSlugLower)) {
      return true;
    }
  }
  const remainingText = text.replace(
    MARKDOWN_LINK_PATTERN,
    (_, label, _dest, dqTitle, sqTitle, parenTitle) => {
      const unescapedLabel = label.replace(/\\([\s\S])/g, '$1');
      const unescapedTitle = (dqTitle ?? sqTitle ?? parenTitle ?? '').replace(/\\([\s\S])/g, '$1');
      return ` ${unescapedLabel} ${unescapedTitle} `;
    }
  );
  for (const rawPart of remainingText.split(/\s+/)) {
    if (rawPart.length === 0) continue;
    const candidate = unwrapOuterCandidate(rawPart);
    if ((mentionsGithubAuthority(rawPart) || mentionsGithubAuthority(candidate)) &&
        isDisallowedRawOrUnwrappedCandidate(rawPart, candidate, expectedSlugLower)) {
      return true;
    }
  }
  return false;
}

function hasForeignShorthandRepoMatch(text, expectedSlugLower) {
  for (const match of text.matchAll(SHORTHAND_REPO_REF_PATTERN)) {
    const cleaned = match[1].replace(/\.$/, '').replace(/\.git$/i, '').toLowerCase();
    if (cleaned !== expectedSlugLower) return true;
    if (match.index > 0 && /[/.\\@]/.test(text[match.index - 1])) return true;
  }
  return false;
}

function hasForeignRepoQualifierMatch(text, expectedSlugLower) {
  for (const match of text.matchAll(REPO_QUALIFIER_PATTERN)) {
    const cleaned = match[1].replace(/\.$/, '').replace(/\.git$/i, '').toLowerCase();
    if (cleaned !== expectedSlugLower) return true;
  }
  return false;
}

function isValidProhibitedVerbChain(between, suffix) {
  const orTail = /^(.*?)(?:,\s*|\s+)(?:or|nor)\s+$/i.exec(between);
  let body;
  if (orTail !== null) {
    body = orTail[1];
  } else {
    const commaTail = /^(.*?),\s+$/i.exec(between);
    if (commaTail === null || !/^(?:,\s*)?\b(?:or|nor)\b/i.test(suffix)) {
      return false;
    }
    body = commaTail[1];
  }
  const segments = body.split(PROHIBITED_CONNECTOR_SPLIT);
  return segments.length <= 8 && segments.every(seg => PROHIBITED_SEGMENT_PATTERN.test(seg));
}

function isNegatedSafetyProhibition(text, matchIndex, matchLength) {
  const normalized = text.replaceAll('_', ' ');
  const bounds = clauseAndSentenceBoundsAt(normalized, matchIndex, matchLength);
  if (hasCarveoutAroundClause(normalized, bounds)) return false;

  const prefix = normalized.slice(bounds.start, matchIndex);
  const suffix = normalized.slice(matchIndex + matchLength, bounds.end);
  if (countPolarityReversers(prefix) !== 1 || countPolarityReversers(suffix) !== 0) {
    return false;
  }

  const [negMatch] = prefix.matchAll(NEGATION_ANCHOR_PATTERN);
  if (negMatch === undefined) return false;
  if (!ALLOWED_PROHIBITION_SUBJECT_PATTERN.test(prefix.slice(0, negMatch.index))) {
    return false;
  }

  const between = prefix.slice(negMatch.index + negMatch[0].length);
  if (between.length === 0) return true;
  return isValidProhibitedVerbChain(between, suffix);
}

function hasPromptInjectionDirective(text) {
  if (UNCONDITIONAL_PROMPT_INJECTION_PATTERNS.some(pattern => pattern.test(text))) {
    return true;
  }
  for (const match of text.matchAll(PROMPT_INJECTION_OVERRIDE_PATTERN)) {
    if (!isNegatedSafetyProhibition(text, match.index, match[0].length)) {
      return true;
    }
  }
  return false;
}

function hasPolicyWeakeningDirective(text) {
  for (const pattern of POLICY_WEAKENING_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (!isNegatedSafetyProhibition(text, match.index, match[0].length)) {
        return true;
      }
    }
  }
  return false;
}

function inspectGuidanceContent(text, expectedSlugLower, policy) {
  if (typeof text !== 'string') return {ok: false, reason: 'INVALID_GUIDANCE_TEXT'};
  if (text.length > MAX_GUIDANCE_TEXT_CHARS) return {ok: false, reason: 'GUIDANCE_TEXT_TOO_LONG'};
  if (!text.isWellFormed() || text.trim().length === 0 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(text)) {
    return {ok: false, reason: 'INVALID_GUIDANCE_TEXT'};
  }
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) {
    return {ok: false, reason: 'SECRET_OR_CREDENTIAL_DETECTED'};
  }
  if (hasPromptInjectionDirective(text)) {
    return {ok: false, reason: 'PROMPT_INJECTION_DETECTED'};
  }
  const maskPreservingNewlines = match => match.replace(/[^\r\n]/g, ' ');
  if (PRIVATE_CROSS_REPO_PHRASE.test(text) ||
      hasDisallowedGithubHostToken(text, expectedSlugLower) ||
      hasForeignRepoQualifierMatch(text, expectedSlugLower) ||
      hasForeignShorthandRepoMatch(
        text.replace(VERIFIED_GITHUB_URL_SPAN_PATTERN, maskPreservingNewlines),
        expectedSlugLower
      )) {
    return {ok: false, reason: 'CROSS_REPO_PRIVATE_DATA_REJECTED'};
  }
  if (hasPolicyWeakeningDirective(text)) {
    return {ok: false, reason: 'POLICY_WEAKENING_REJECTED'};
  }
  for (const match of text.matchAll(COVERAGE_PAIR_PATTERN)) {
    const rawOp = match[1];
    const linePct = Number.parseFloat(match[2]);
    const branchPct = Number.parseFloat(match[3]);
    if (linePct < policy.minLineCoveragePct || branchPct < policy.minBranchCoveragePct) {
      return {ok: false, reason: 'POLICY_WEAKENING_REJECTED'};
    }
    if (rawOp !== undefined &&
        UPPER_BOUND_OP_PATTERN.test(rawOp.trim()) &&
        !isUnconditionalRejectionClause(text, match.index, match[0].length)) {
      return {ok: false, reason: 'POLICY_WEAKENING_REJECTED'};
    }
  }
  const textWithoutPairs = text.replace(COVERAGE_PAIR_PATTERN, maskPreservingNewlines);
  if (hasWeakCoverageMatch(textWithoutPairs, LINE_PCT_BEFORE_PATTERN, policy.minLineCoveragePct) ||
      hasWeakCoverageMatch(textWithoutPairs, LINE_PCT_AFTER_PATTERN, policy.minLineCoveragePct) ||
      hasWeakCoverageMatch(textWithoutPairs, BRANCH_PCT_BEFORE_PATTERN, policy.minBranchCoveragePct) ||
      hasWeakCoverageMatch(textWithoutPairs, BRANCH_PCT_AFTER_PATTERN, policy.minBranchCoveragePct)) {
    return {ok: false, reason: 'POLICY_WEAKENING_REJECTED'};
  }
  const textWithoutScopedCoverage = textWithoutPairs
    .replace(LINE_PCT_BEFORE_PATTERN, maskPreservingNewlines)
    .replace(LINE_PCT_AFTER_PATTERN, maskPreservingNewlines)
    .replace(BRANCH_PCT_BEFORE_PATTERN, maskPreservingNewlines)
    .replace(BRANCH_PCT_AFTER_PATTERN, maskPreservingNewlines);
  const strongerCoverageFloor = Math.max(policy.minLineCoveragePct, policy.minBranchCoveragePct);
  if (hasWeakCoverageMatch(textWithoutScopedCoverage, GENERAL_COVERAGE_BEFORE_PATTERN, strongerCoverageFloor) ||
      hasWeakCoverageMatch(textWithoutScopedCoverage, GENERAL_COVERAGE_AFTER_PATTERN, strongerCoverageFloor)) {
    return {ok: false, reason: 'POLICY_WEAKENING_REJECTED'};
  }
  return {ok: true, textBytes: Buffer.byteLength(text, 'utf8')};
}

function validateRepositoryIdentity(repositoryId, repositorySlug) {
  if (!positiveInt(repositoryId) || !isRepositorySlug(repositorySlug)) {
    return {ok: false, reason: 'INVALID_SELECTION_INPUT'};
  }
  const isFactoryId = repositoryId === SOFTWARE_FACTORY_REPOSITORY_ID;
  const isFactorySlug = repositorySlug.toLowerCase() === SOFTWARE_FACTORY_REPOSITORY_SLUG.toLowerCase();
  if (isFactoryId !== isFactorySlug ||
      (isFactorySlug && repositorySlug !== SOFTWARE_FACTORY_REPOSITORY_SLUG)) {
    return {ok: false, reason: 'REPOSITORY_IDENTITY_MISMATCH'};
  }
  return {ok: true};
}

export function validateCuratedLesson(lesson, context) {
  if (!exactRecord(context, ['repositoryId', 'repositorySlug', 'expectedHeadSha', 'nowMs'], ['policy']) ||
      !isSha40(context.expectedHeadSha) || !nonnegInt(context.nowMs)) {
    return Object.freeze({valid: false, reason: 'INVALID_LESSON_CONTEXT'});
  }
  const repoCheck = validateRepositoryIdentity(context.repositoryId, context.repositorySlug);
  if (!repoCheck.ok) return Object.freeze({valid: false, reason: repoCheck.reason});

  const policy = resolveSelectionPolicy(context.policy, context.repositoryId);
  if (!policy.ok) return Object.freeze({valid: false, reason: policy.reason});

  return validateLessonInternal(lesson, context.repositoryId, context.repositorySlug.toLowerCase(),
    context.expectedHeadSha, context.nowMs, policy);
}

function validateLessonInternal(lesson, expectedRepoId, expectedSlugLower, expectedHeadSha, nowMs, policy) {
  if (!exactRecord(lesson, LESSON_REQUIRED_KEYS, LESSON_OPTIONAL_KEYS) ||
      !isIdentifier(lesson.lessonId) || !positiveInt(lesson.repositoryId) ||
      !isSha40(lesson.sourceCommitSha) || !isSha40(lesson.verifiedHeadSha) ||
      !nonnegInt(lesson.observedAtMs) || !positiveInt(lesson.maxFreshnessMs) ||
      lesson.maxFreshnessMs > MAX_FRESHNESS_CEILING_MS) {
    return Object.freeze({valid: false, reason: 'INVALID_LESSON_SCHEMA'});
  }
  const normalizedComponents = normalizeComponentScope(lesson.componentScope);
  if (normalizedComponents === null) {
    return Object.freeze({valid: false, reason: 'INVALID_LESSON_SCHEMA'});
  }
  if (hasOwnEnumerableData(lesson, 'visibility') && lesson.visibility !== 'same-repo') {
    return Object.freeze({valid: false, reason: 'CROSS_REPO_PRIVATE_DATA_REJECTED'});
  }
  if (lesson.repositoryId !== expectedRepoId) {
    return Object.freeze({valid: false, reason: 'CROSS_REPO_ISOLATION_VIOLATION'});
  }
  if (!lessonSourceSet.has(lesson.sourceKind)) {
    return Object.freeze({valid: false, reason: 'UNTRUSTED_INSTRUCTION_SOURCE'});
  }
  if (!positiveInt(lesson.sourceNumber)) {
    return Object.freeze({valid: false, reason: 'INVALID_LESSON_SCHEMA'});
  }
  let specialistRoles = null;
  if (hasOwnEnumerableData(lesson, 'specialistRoles')) {
    if (!validRoleSubset(lesson.specialistRoles)) {
      return Object.freeze({valid: false, reason: 'INVALID_LESSON_SCHEMA'});
    }
    specialistRoles = Object.freeze([...lesson.specialistRoles]);
  }
  let pathPrefixes = null;
  if (hasOwnEnumerableData(lesson, 'pathPrefixes')) {
    if (!validUniquePathList(lesson.pathPrefixes, 32)) {
      return Object.freeze({valid: false, reason: 'INVALID_LESSON_SCHEMA'});
    }
    pathPrefixes = Object.freeze([...lesson.pathPrefixes]);
  }
  const thresholdCheck = validateProposedGateThresholds(lesson, policy, 'INVALID_LESSON_SCHEMA');
  if (!thresholdCheck.ok) {
    return Object.freeze({valid: false, reason: thresholdCheck.reason});
  }
  if (lesson.verifiedHeadSha !== expectedHeadSha) {
    return Object.freeze({valid: false, reason: 'UNVERIFIED_LESSON_HEAD_SHA'});
  }
  if (lesson.observedAtMs > nowMs || nowMs - lesson.observedAtMs > lesson.maxFreshnessMs) {
    return Object.freeze({valid: false, reason: 'STALE_CURATED_LESSON'});
  }
  const contentCheck = inspectGuidanceContent(lesson.guidanceText, expectedSlugLower, policy);
  if (!contentCheck.ok) {
    return Object.freeze({valid: false, reason: contentCheck.reason});
  }
  return Object.freeze({
    valid: true,
    lesson: Object.freeze({
      lessonId: lesson.lessonId,
      repositoryId: lesson.repositoryId,
      sourceKind: lesson.sourceKind,
      sourceNumber: lesson.sourceNumber,
      sourceCommitSha: lesson.sourceCommitSha,
      verifiedHeadSha: lesson.verifiedHeadSha,
      componentScope: normalizedComponents,
      specialistRoles,
      pathPrefixes,
      guidanceText: lesson.guidanceText,
      observedAtMs: lesson.observedAtMs,
      maxFreshnessMs: lesson.maxFreshnessMs,
      ageMs: nowMs - lesson.observedAtMs,
      textBytes: contentCheck.textBytes
    })
  });
}

function validateGuidanceEntry(entry, expectedRepoId, expectedSlugLower, expectedHeadSha, policy) {
  if (!exactRecord(entry, GUIDANCE_REQUIRED_KEYS, GUIDANCE_OPTIONAL_KEYS) ||
      !isIdentifier(entry.guidanceId) || !positiveInt(entry.repositoryId) ||
      !isSha40(entry.revisionSha) || !isSafeRepoRelativePath(entry.sourcePath)) {
    return {valid: false, reason: 'INVALID_GUIDANCE_SCHEMA'};
  }
  const normalizedComponents = normalizeComponentScope(entry.componentScope);
  if (normalizedComponents === null) {
    return {valid: false, reason: 'INVALID_GUIDANCE_SCHEMA'};
  }
  if (entry.repositoryId !== expectedRepoId) {
    return {valid: false, reason: 'CROSS_REPO_ISOLATION_VIOLATION'};
  }
  if (!guidanceSourceSet.has(entry.source)) {
    return {valid: false, reason: 'UNTRUSTED_INSTRUCTION_SOURCE'};
  }
  if (entry.revisionSha !== expectedHeadSha) {
    return {valid: false, reason: 'STALE_GUIDANCE_REVISION'};
  }
  let specialistRoles = null;
  if (hasOwnEnumerableData(entry, 'specialistRoles')) {
    if (!validRoleSubset(entry.specialistRoles)) {
      return {valid: false, reason: 'INVALID_GUIDANCE_SCHEMA'};
    }
    specialistRoles = Object.freeze([...entry.specialistRoles]);
  }
  let pathPrefixes = null;
  if (hasOwnEnumerableData(entry, 'pathPrefixes')) {
    if (!validUniquePathList(entry.pathPrefixes, 32)) {
      return {valid: false, reason: 'INVALID_GUIDANCE_SCHEMA'};
    }
    pathPrefixes = Object.freeze([...entry.pathPrefixes]);
  }
  const thresholdCheck = validateProposedGateThresholds(entry, policy, 'INVALID_GUIDANCE_SCHEMA');
  if (!thresholdCheck.ok) return {valid: false, reason: thresholdCheck.reason};

  const contentCheck = inspectGuidanceContent(entry.guidanceText, expectedSlugLower, policy);
  if (!contentCheck.ok) return {valid: false, reason: contentCheck.reason};

  return {
    valid: true,
    guidance: Object.freeze({
      guidanceId: entry.guidanceId,
      repositoryId: entry.repositoryId,
      revisionSha: entry.revisionSha,
      source: entry.source,
      sourcePath: entry.sourcePath,
      componentScope: normalizedComponents,
      specialistRoles,
      pathPrefixes,
      guidanceText: entry.guidanceText,
      textBytes: contentCheck.textBytes
    })
  };
}

function validateCheckpointEvidence(checkpoint, expectedRepoId, expectedIssueNumber, expectedHeadSha, changedPaths) {
  if (expectedIssueNumber === null ||
      !exactRecord(checkpoint, CHECKPOINT_REQUIRED_KEYS, CHECKPOINT_OPTIONAL_KEYS) ||
      !isIdentifier(checkpoint.checkpointId) || !positiveInt(checkpoint.repositoryId) ||
      !positiveInt(checkpoint.issueNumber) || !isSha40(checkpoint.headSha) ||
      !positiveInt(checkpoint.sequence) || !isSha256(checkpoint.digestSha256) ||
      !parseTraceparent(checkpoint.traceparent).valid ||
      !denseDataArray(checkpoint.completedSupersteps, 32) ||
      checkpoint.completedSupersteps.length === 0 ||
      !checkpoint.completedSupersteps.every(isComponentToken) ||
      !uniqueStrings(checkpoint.completedSupersteps)) {
    return {ok: false, reason: 'INVALID_CHECKPOINT_EVIDENCE'};
  }
  if (checkpoint.repositoryId !== expectedRepoId) {
    return {ok: false, reason: 'CROSS_REPO_ISOLATION_VIOLATION'};
  }
  if (checkpoint.issueNumber !== expectedIssueNumber) {
    return {ok: false, reason: 'CHECKPOINT_ISSUE_MISMATCH'};
  }
  if (checkpoint.headSha !== expectedHeadSha) {
    return {ok: false, reason: 'STALE_CHECKPOINT_EVIDENCE'};
  }
  let verifiedPaths = [];
  if (hasOwnEnumerableData(checkpoint, 'verifiedPaths')) {
    if (!denseDataArray(checkpoint.verifiedPaths, 100) ||
        !checkpoint.verifiedPaths.every(isSafeRepoRelativePath) ||
        !uniqueStrings(checkpoint.verifiedPaths)) {
      return {ok: false, reason: 'INVALID_CHECKPOINT_EVIDENCE'};
    }
    verifiedPaths = checkpoint.verifiedPaths;
  }
  const verifiedSet = new Set(verifiedPaths);
  const skippedPaths = changedPaths.filter(path => verifiedSet.has(path));
  const unverifiedPaths = changedPaths.filter(path => !verifiedSet.has(path));

  return {
    ok: true,
    unverifiedPaths,
    summary: Object.freeze({
      checkpointId: checkpoint.checkpointId,
      issueNumber: checkpoint.issueNumber,
      sequence: checkpoint.sequence,
      completedSupersteps: Object.freeze([...checkpoint.completedSupersteps]),
      skippedAlreadyVerifiedPaths: Object.freeze(skippedPaths)
    })
  };
}

function blockedSelection(reason) {
  return Object.freeze({
    valid: false,
    state: 'blocked',
    shadow: true,
    readOnly: true,
    autoPolicyMutation: false,
    externalKnowledgeStoreRequired: false,
    reason,
    selectedGuidance: Object.freeze([]),
    selectedLessons: Object.freeze([])
  });
}

function computeScopeMatch(item, targetComponent, specialistRole, changedPaths, unverifiedPaths) {
  if (!item.componentScope.includes(targetComponent)) {
    return {state: 'out-of-scope', specificity: 0};
  }
  if (item.specialistRoles !== null && !item.specialistRoles.includes(specialistRole)) {
    return {state: 'out-of-scope', specificity: 0};
  }
  const roleScore = item.specialistRoles !== null ? 1 : 0;
  if (item.pathPrefixes === null) {
    return {state: 'matched', specificity: roleScore};
  }
  const matchesAnyChanged = changedPaths.some(changed =>
    item.pathPrefixes.some(prefix => matchesPrefix(prefix, changed)));
  if (!matchesAnyChanged) {
    return {state: 'out-of-scope', specificity: 0};
  }
  const matchesUnverified = unverifiedPaths.some(changed =>
    item.pathPrefixes.some(prefix => matchesPrefix(prefix, changed)));
  if (!matchesUnverified) {
    return {state: 'already-checkpointed', specificity: 0};
  }
  return {state: 'matched', specificity: roleScore + 2};
}

export function selectScopedGuidanceAndLessons(input) {
  if (!exactRecord(input, SELECTION_REQUIRED_KEYS, SELECTION_OPTIONAL_KEYS)) {
    return blockedSelection('INVALID_SELECTION_INPUT');
  }
  if (hasOwnEnumerableData(input, 'externalKnowledgeStoreRequired')) {
    if (typeof input.externalKnowledgeStoreRequired !== 'boolean') {
      return blockedSelection('INVALID_SELECTION_INPUT');
    }
    if (input.externalKnowledgeStoreRequired) {
      return blockedSelection('EXTERNAL_KNOWLEDGE_STORE_FORBIDDEN');
    }
  }
  const repoCheck = validateRepositoryIdentity(input.repositoryId, input.repositorySlug);
  if (!repoCheck.ok) return blockedSelection(repoCheck.reason);

  let expectedIssueNumber = null;
  if (hasOwnEnumerableData(input, 'issueNumber')) {
    if (!positiveInt(input.issueNumber)) {
      return blockedSelection('INVALID_SELECTION_INPUT');
    }
    expectedIssueNumber = input.issueNumber;
  }

  if (!isSha40(input.expectedHeadSha) || !nonnegInt(input.nowMs) ||
      !isComponentToken(input.targetComponent) || !specialistRoleSet.has(input.specialistRole) ||
      !validUniquePathList(input.changedPaths, 200) ||
      !denseDataArray(input.guidanceEntries, 100) ||
      !denseDataArray(input.curatedLessons, 200)) {
    return blockedSelection('INVALID_SELECTION_INPUT');
  }

  const policy = resolveSelectionPolicy(input.policy, input.repositoryId);
  if (!policy.ok) return blockedSelection(policy.reason);

  let unverifiedPaths = input.changedPaths;
  let checkpointBinding = null;
  if (hasOwnEnumerableData(input, 'checkpointEvidence')) {
    const cpCheck = validateCheckpointEvidence(
      input.checkpointEvidence,
      input.repositoryId,
      expectedIssueNumber,
      input.expectedHeadSha,
      input.changedPaths
    );
    if (!cpCheck.ok) return blockedSelection(cpCheck.reason);
    unverifiedPaths = cpCheck.unverifiedPaths;
    checkpointBinding = cpCheck.summary;
  }

  const slugLower = input.repositorySlug.toLowerCase();
  const seenGuidanceIds = new Set();
  const validatedGuidance = [];
  let fullCatalogBytes = 0;

  for (const rawEntry of input.guidanceEntries) {
    const check = validateGuidanceEntry(rawEntry, input.repositoryId, slugLower, input.expectedHeadSha, policy);
    if (!check.valid) return blockedSelection(check.reason);
    if (seenGuidanceIds.has(check.guidance.guidanceId)) {
      return blockedSelection('DUPLICATE_GUIDANCE_ID');
    }
    seenGuidanceIds.add(check.guidance.guidanceId);
    fullCatalogBytes += check.guidance.textBytes;
    validatedGuidance.push(check.guidance);
  }

  const seenLessonIds = new Set();
  const validatedLessons = [];
  for (const rawLesson of input.curatedLessons) {
    const check = validateLessonInternal(
      rawLesson,
      input.repositoryId,
      slugLower,
      input.expectedHeadSha,
      input.nowMs,
      policy
    );
    if (!check.valid) return blockedSelection(check.reason);
    if (seenLessonIds.has(check.lesson.lessonId)) {
      return blockedSelection('DUPLICATE_LESSON_ID');
    }
    seenLessonIds.add(check.lesson.lessonId);
    fullCatalogBytes += check.lesson.textBytes;
    validatedLessons.push(check.lesson);
  }

  let omittedOutOfScopeCount = 0;
  let omittedCheckpointedCount = 0;
  const matchedGuidance = [];
  for (const item of validatedGuidance) {
    const match = computeScopeMatch(
      item,
      input.targetComponent,
      input.specialistRole,
      input.changedPaths,
      unverifiedPaths
    );
    if (match.state === 'matched') {
      matchedGuidance.push({item, specificity: match.specificity});
    } else if (match.state === 'already-checkpointed') {
      omittedCheckpointedCount += 1;
    } else {
      omittedOutOfScopeCount += 1;
    }
  }

  const matchedLessons = [];
  for (const item of validatedLessons) {
    const match = computeScopeMatch(
      item,
      input.targetComponent,
      input.specialistRole,
      input.changedPaths,
      unverifiedPaths
    );
    if (match.state === 'matched') {
      matchedLessons.push({item, specificity: match.specificity});
    } else if (match.state === 'already-checkpointed') {
      omittedCheckpointedCount += 1;
    } else {
      omittedOutOfScopeCount += 1;
    }
  }

  const compareUniqueIds = (left, right) => (left < right ? -1 : 1);

  matchedGuidance.sort((left, right) =>
    right.specificity - left.specificity ||
    compareUniqueIds(left.item.guidanceId, right.item.guidanceId));

  matchedLessons.sort((left, right) =>
    right.specificity - left.specificity ||
    right.item.observedAtMs - left.item.observedAtMs ||
    compareUniqueIds(left.item.lessonId, right.item.lessonId));

  const selectedGuidance = [];
  const selectedLessons = [];
  let selectedContextBytes = 0;
  let truncatedByBudgetCount = 0;

  for (const candidate of matchedGuidance) {
    if (selectedGuidance.length >= policy.maxSelectedGuidance ||
        selectedContextBytes + candidate.item.textBytes > policy.maxContextBytes) {
      truncatedByBudgetCount += 1;
      continue;
    }
    selectedGuidance.push(candidate.item);
    selectedContextBytes += candidate.item.textBytes;
  }

  for (const candidate of matchedLessons) {
    if (selectedLessons.length >= policy.maxSelectedLessons ||
        selectedContextBytes + candidate.item.textBytes > policy.maxContextBytes) {
      truncatedByBudgetCount += 1;
      continue;
    }
    selectedLessons.push(candidate.item);
    selectedContextBytes += candidate.item.textBytes;
  }

  return Object.freeze({
    valid: true,
    state: 'selected',
    shadow: true,
    readOnly: true,
    autoPolicyMutation: false,
    externalKnowledgeStoreRequired: false,
    reason: 'SCOPED_KNOWLEDGE_SELECTED',
    repositoryId: input.repositoryId,
    repositorySlug: input.repositorySlug,
    expectedHeadSha: input.expectedHeadSha,
    targetComponent: input.targetComponent,
    specialistRole: input.specialistRole,
    effectiveGates: Object.freeze({
      minLineCoveragePct: policy.minLineCoveragePct,
      minBranchCoveragePct: policy.minBranchCoveragePct
    }),
    checkpointBinding,
    selectedGuidance: Object.freeze(selectedGuidance),
    selectedLessons: Object.freeze(selectedLessons),
    omittedOutOfScopeCount,
    omittedCheckpointedCount,
    truncatedByBudgetCount,
    fullCatalogBytes,
    selectedContextBytes,
    contextBytesSaved: fullCatalogBytes - selectedContextBytes
  });
}

function nearestRankP50(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.5 * sorted.length) - 1];
}

function resolveCohortPolicy(raw, repositoryId) {
  if (raw === undefined) {
    const base = resolveCoverageFloors(repositoryId, undefined, undefined);
    return {
      ok: true,
      minLineCoveragePct: base.minLineCoveragePct,
      minBranchCoveragePct: base.minBranchCoveragePct,
      quotaCreditsRemaining: null
    };
  }
  if (!exactRecord(raw, [], COHORT_POLICY_KEYS)) {
    return {ok: false, reason: 'INVALID_POLICY'};
  }
  const floors = resolveCoverageFloors(repositoryId, raw.minLineCoveragePct, raw.minBranchCoveragePct);
  if (!floors.ok) return floors;

  let quotaCreditsRemaining = null;
  if (hasOwnEnumerableData(raw, 'quotaCreditsRemaining')) {
    if (!nonnegInt(raw.quotaCreditsRemaining)) {
      return {ok: false, reason: 'INVALID_POLICY'};
    }
    quotaCreditsRemaining = raw.quotaCreditsRemaining;
  }
  return {
    ok: true,
    minLineCoveragePct: floors.minLineCoveragePct,
    minBranchCoveragePct: floors.minBranchCoveragePct,
    quotaCreditsRemaining
  };
}

function validCohortUnit(unit) {
  if (!exactRecord(unit, UNIT_REQUIRED_KEYS)) return false;
  if (!isIdentifier(unit.unitId) || unit.accepted !== true) return false;
  if (!nonnegInt(unit.explorationSteps) || unit.explorationSteps > 100_000) return false;
  if (!nonnegInt(unit.contextBytesLoaded) || unit.contextBytesLoaded > 100_000_000) return false;
  if (!nonnegInt(unit.repeatedContextLoads) || unit.repeatedContextLoads > 100_000) return false;
  if (!nonnegInt(unit.reworkIterations) || unit.reworkIterations > 1000) return false;
  if (!nonnegInt(unit.aiCredits) || unit.aiCredits > 1_000_000) return false;
  if (!nonnegInt(unit.incrementalBilledUsdCents) || unit.incrementalBilledUsdCents > 10_000_000) return false;
  if (!validCounts(unit.coveredLines, unit.totalLines)) return false;
  if (!validCounts(unit.coveredBranches, unit.totalBranches)) return false;
  if (!nonnegInt(unit.securityFindings) || unit.securityFindings > 100_000) return false;
  if (typeof unit.duplicateWork !== 'boolean') return false;
  if (typeof unit.unsupportedRouting !== 'boolean') return false;
  return true;
}

function validateCohortEnvelope(cohort) {
  if (!exactRecord(cohort, COHORT_REQUIRED_KEYS, COHORT_OPTIONAL_KEYS) ||
      !positiveInt(cohort.repositoryId) || !isCohortId(cohort.cohortId) ||
      !nonnegInt(cohort.windowStartMs) || !nonnegInt(cohort.windowEndMs) ||
      cohort.windowEndMs <= cohort.windowStartMs ||
      typeof cohort.provenanceVerified !== 'boolean' ||
      typeof cohort.independentReviewVerified !== 'boolean' ||
      (hasOwnEnumerableData(cohort, 'quotaCreditsRemaining') && !nonnegInt(cohort.quotaCreditsRemaining)) ||
      !denseDataArray(cohort.units, 500)) {
    return {ok: false, reason: 'INVALID_COHORT_SCHEMA'};
  }
  if (!cohort.provenanceVerified) {
    return {ok: false, reason: 'UNVERIFIED_COHORT_PROVENANCE'};
  }
  if (!cohort.independentReviewVerified) {
    return {ok: false, reason: 'INDEPENDENT_REVIEW_REQUIRED'};
  }
  const seenUnits = new Set();
  for (const unit of cohort.units) {
    if (!validCohortUnit(unit) || seenUnits.has(unit.unitId)) {
      return {ok: false, reason: 'INVALID_COHORT_UNIT'};
    }
    seenUnits.add(unit.unitId);
  }
  return {ok: true};
}

function meetsCoverageFloor(coveredLines, totalLines, coveredBranches, totalBranches, policy) {
  return coveredLines * 100 >= policy.minLineCoveragePct * totalLines &&
    coveredBranches * 100 >= policy.minBranchCoveragePct * totalBranches;
}

function summarizeCohort(cohort, policy) {
  const unitCount = cohort.units.length;
  const windowDurationMs = cohort.windowEndMs - cohort.windowStartMs;
  let totalReworkIterations = 0;
  let aiCreditsTotal = 0;
  let incrementalBilledUsdCents = 0;
  let coveredLines = 0;
  let totalLines = 0;
  let coveredBranches = 0;
  let totalBranches = 0;
  let securityFindings = 0;
  let duplicateWorkCount = 0;
  let unsupportedRoutingCount = 0;
  let allUnitsMeetFloor = true;

  for (const unit of cohort.units) {
    totalReworkIterations += unit.reworkIterations;
    aiCreditsTotal += unit.aiCredits;
    incrementalBilledUsdCents += unit.incrementalBilledUsdCents;
    coveredLines += unit.coveredLines;
    totalLines += unit.totalLines;
    coveredBranches += unit.coveredBranches;
    totalBranches += unit.totalBranches;
    securityFindings += unit.securityFindings;
    if (unit.duplicateWork === true) duplicateWorkCount += 1;
    if (unit.unsupportedRouting === true) unsupportedRoutingCount += 1;
    if (!meetsCoverageFloor(unit.coveredLines, unit.totalLines, unit.coveredBranches, unit.totalBranches, policy)) {
      allUnitsMeetFloor = false;
    }
  }

  return {
    allUnitsMeetFloor,
    totalReworkIterations,
    coveredLines,
    totalLines,
    coveredBranches,
    totalBranches,
    metrics: Object.freeze({
      unitCount,
      explorationStepsP50: nearestRankP50(cohort.units.map(u => u.explorationSteps)),
      contextBytesLoadedP50: nearestRankP50(cohort.units.map(u => u.contextBytesLoaded)),
      repeatedContextLoadsP50: nearestRankP50(cohort.units.map(u => u.repeatedContextLoads)),
      reworkIterationsRateBps: Math.round((totalReworkIterations * 10_000) / unitCount),
      aiCreditsTotal,
      aiCreditsPerUnit: aiCreditsTotal / unitCount,
      incrementalBilledUsdCents,
      acceptedUnitsPerDay: (unitCount * 86_400_000) / windowDurationMs,
      lineCoveragePct: (coveredLines * 100) / totalLines,
      branchCoveragePct: (coveredBranches * 100) / totalBranches,
      securityFindings,
      duplicateWorkCount,
      unsupportedRoutingCount
    })
  };
}

function invalidCohortResult(reason) {
  return Object.freeze({
    valid: false,
    shadow: true,
    readOnly: true,
    status: 'INVALID_COHORT_INPUT',
    adoptionApproved: false,
    reason,
    rejectionReasons: Object.freeze([])
  });
}

export function compareExplorationContextReduction(baselineCohort, candidateCohort, policy = undefined) {
  const baseCheck = validateCohortEnvelope(baselineCohort);
  if (!baseCheck.ok) return invalidCohortResult(baseCheck.reason);

  const candCheck = validateCohortEnvelope(candidateCohort);
  if (!candCheck.ok) return invalidCohortResult(candCheck.reason);

  if (baselineCohort.repositoryId !== candidateCohort.repositoryId ||
      baselineCohort.cohortId !== candidateCohort.cohortId) {
    return invalidCohortResult('COHORT_MISMATCH');
  }
  if (baselineCohort.windowEndMs > candidateCohort.windowStartMs ||
      baselineCohort.windowEndMs - baselineCohort.windowStartMs !==
      candidateCohort.windowEndMs - candidateCohort.windowStartMs) {
    return invalidCohortResult('WINDOWS_NOT_COMPARABLE');
  }

  const resolvedPolicy = resolveCohortPolicy(policy, baselineCohort.repositoryId);
  if (!resolvedPolicy.ok) return invalidCohortResult(resolvedPolicy.reason);

  const candidateQuota = hasOwnEnumerableData(candidateCohort, 'quotaCreditsRemaining')
    ? candidateCohort.quotaCreditsRemaining
    : null;
  if (resolvedPolicy.quotaCreditsRemaining !== null &&
      candidateQuota !== null &&
      resolvedPolicy.quotaCreditsRemaining !== candidateQuota) {
    return invalidCohortResult('INVALID_POLICY');
  }
  const effectiveQuota = resolvedPolicy.quotaCreditsRemaining !== null
    ? resolvedPolicy.quotaCreditsRemaining
    : candidateQuota;
  if (effectiveQuota === null) {
    return invalidCohortResult('QUOTA_REMAINING_REQUIRED');
  }

  if (baselineCohort.units.length < MIN_COMPARABLE_COHORT_UNITS ||
      candidateCohort.units.length < MIN_COMPARABLE_COHORT_UNITS) {
    return Object.freeze({
      valid: true,
      shadow: true,
      readOnly: true,
      status: 'INSUFFICIENT_COHORT',
      adoptionApproved: false,
      reason: 'INSUFFICIENT_COMPARABLE_UNITS',
      minimumRequiredUnits: MIN_COMPARABLE_COHORT_UNITS,
      baselineUnitCount: baselineCohort.units.length,
      candidateUnitCount: candidateCohort.units.length,
      rejectionReasons: Object.freeze([])
    });
  }

  const baseSummary = summarizeCohort(baselineCohort, resolvedPolicy);
  if (!baseSummary.allUnitsMeetFloor) {
    return invalidCohortResult('BASELINE_COVERAGE_BELOW_FLOOR');
  }
  if (baseSummary.metrics.incrementalBilledUsdCents > 0) {
    return invalidCohortResult('BASELINE_UNAPPROVED_SPEND');
  }

  const candSummary = summarizeCohort(candidateCohort, resolvedPolicy);
  const baseMetrics = baseSummary.metrics;
  const candMetrics = candSummary.metrics;
  const rejectionReasons = [];

  if (!candSummary.allUnitsMeetFloor) {
    rejectionReasons.push('COVERAGE_BELOW_FLOOR');
  }
  if (BigInt(candSummary.coveredLines) * BigInt(baseSummary.totalLines) <
      BigInt(baseSummary.coveredLines) * BigInt(candSummary.totalLines) ||
      BigInt(candSummary.coveredBranches) * BigInt(baseSummary.totalBranches) <
      BigInt(baseSummary.coveredBranches) * BigInt(candSummary.totalBranches)) {
    rejectionReasons.push('COVERAGE_REGRESSED');
  }
  if (candMetrics.securityFindings > 0) {
    rejectionReasons.push('SECURITY_REGRESSION');
  }
  if (candMetrics.duplicateWorkCount > 0 || candMetrics.unsupportedRoutingCount > 0) {
    rejectionReasons.push('ROUTING_OR_DUPLICATE_WORK_VIOLATION');
  }
  if (candMetrics.unitCount < baseMetrics.unitCount) {
    rejectionReasons.push('THROUGHPUT_REGRESSED');
  }
  if (candMetrics.incrementalBilledUsdCents > 0 ||
      candMetrics.aiCreditsTotal > effectiveQuota ||
      BigInt(candMetrics.aiCreditsTotal) * BigInt(baseMetrics.unitCount) >
      BigInt(baseMetrics.aiCreditsTotal) * BigInt(candMetrics.unitCount)) {
    rejectionReasons.push('COST_REGRESSION');
  }
  if (candMetrics.explorationStepsP50 > baseMetrics.explorationStepsP50 ||
      candMetrics.contextBytesLoadedP50 > baseMetrics.contextBytesLoadedP50 ||
      candMetrics.repeatedContextLoadsP50 > baseMetrics.repeatedContextLoadsP50 ||
      BigInt(candSummary.totalReworkIterations) * BigInt(baseMetrics.unitCount) >
      BigInt(baseSummary.totalReworkIterations) * BigInt(candMetrics.unitCount)) {
    rejectionReasons.push('EXPLORATION_OR_REWORK_REGRESSED');
  }

  const deltas = Object.freeze({
    explorationStepsP50Delta: candMetrics.explorationStepsP50 - baseMetrics.explorationStepsP50,
    contextBytesLoadedP50Delta: candMetrics.contextBytesLoadedP50 - baseMetrics.contextBytesLoadedP50,
    repeatedContextLoadsP50Delta: candMetrics.repeatedContextLoadsP50 - baseMetrics.repeatedContextLoadsP50,
    reworkIterationsRateBpsDelta: candMetrics.reworkIterationsRateBps - baseMetrics.reworkIterationsRateBps,
    aiCreditsPerUnitDelta: candMetrics.aiCreditsPerUnit - baseMetrics.aiCreditsPerUnit,
    acceptedUnitsPerDayDelta: candMetrics.acceptedUnitsPerDay - baseMetrics.acceptedUnitsPerDay
  });

  if (rejectionReasons.length > 0) {
    return Object.freeze({
      valid: true,
      shadow: true,
      readOnly: true,
      status: 'REJECTED_REGRESSION',
      adoptionApproved: false,
      reason: rejectionReasons[0],
      rejectionReasons: Object.freeze(rejectionReasons),
      baselineMetrics: baseMetrics,
      candidateMetrics: candMetrics,
      deltas
    });
  }

  const materialReduction =
    candMetrics.explorationStepsP50 < baseMetrics.explorationStepsP50 ||
    candMetrics.contextBytesLoadedP50 < baseMetrics.contextBytesLoadedP50 ||
    candMetrics.repeatedContextLoadsP50 < baseMetrics.repeatedContextLoadsP50 ||
    BigInt(candSummary.totalReworkIterations) * BigInt(baseMetrics.unitCount) <
      BigInt(baseSummary.totalReworkIterations) * BigInt(candMetrics.unitCount);

  return Object.freeze({
    valid: true,
    shadow: true,
    readOnly: true,
    status: materialReduction ? 'ADOPTION_APPROVED' : 'NO_MATERIAL_REDUCTION',
    adoptionApproved: materialReduction,
    reason: materialReduction ? 'EXPLORATION_AND_CONTEXT_REDUCED' : 'NO_EXPLORATION_OR_CONTEXT_REDUCTION',
    rejectionReasons: Object.freeze([]),
    baselineMetrics: baseMetrics,
    candidateMetrics: candMetrics,
    deltas
  });
}
