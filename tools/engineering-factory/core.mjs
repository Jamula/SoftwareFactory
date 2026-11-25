// Snapshot evaluation only: this module cannot read from or mutate GitHub.
const exact = (value, keys) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const text = value => typeof value === 'string' && value.length > 0;
const integer = value => Number.isSafeInteger(value) && value > 0;
// JSON-shaped arrays must have an own entry at every index.
const dense = value => Array.isArray(value) && Object.keys(value).length === value.length &&
  Array.from({length: value.length}, (_, i) => Object.hasOwn(value, i)).every(Boolean);
const unique = values => new Set(values).size === values.length;
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const identity = value => value.toLowerCase();
const pathValid = path => text(path) && !path.startsWith('/') &&
  !path.includes('\\') && !path.split('/').some(part => part === '..' || part === '.');

export function validPolicy(p) {
  if (!exact(p, ['version', 'repository', 'defaultBranch', 'mergeMethod', 'mode',
    'killSwitch', 'checks', 'reviewers', 'coverage', 'owners', 'maxActive',
    'creditLimit', 'riskClasses'])) return false;
  return p.version === 1 && text(p.repository) && /^[^/]+\/[^/]+$/.test(p.repository) &&
    text(p.defaultBranch) && ['merge', 'squash', 'rebase'].includes(p.mergeMethod) &&
    ['disabled', 'shadow'].includes(p.mode) && typeof p.killSwitch === 'boolean' &&
    dense(p.checks) && p.checks.length > 0 &&
    p.checks.every(c => exact(c, ['name', 'appId']) && text(c.name) && integer(c.appId)) &&
    unique(p.checks.map(c => c.name)) &&
    dense(p.reviewers) && p.reviewers.length > 0 &&
    p.reviewers.every(text) && unique(p.reviewers.map(identity)) &&
    exact(p.coverage, ['line', 'branch']) &&
    [p.coverage.line, p.coverage.branch].every(n => Number.isFinite(n) && n >= 0 && n <= 100) &&
    (identity(p.repository) !== 'jamula/softwarefactory' || (p.coverage.line >= 98 && p.coverage.branch >= 95)) &&
    dense(p.owners) && p.owners.length > 0 &&
    p.owners.every(o => exact(o, ['prefix', 'owner']) && pathValid(o.prefix) && text(o.owner)) &&
    unique(p.owners.map(o => o.prefix)) && integer(p.maxActive) &&
    Number.isFinite(p.creditLimit) && p.creditLimit > 0 &&
    dense(p.riskClasses) && p.riskClasses.length > 0 &&
    p.riskClasses.every(text) && unique(p.riskClasses);
}

const result = (state, reason) => Object.freeze({ state, reason, shadow: true });

// All evidence is intentionally required; absent or ambiguous evidence blocks eligibility.
export function evaluate(policy, s) {
  if (!validPolicy(policy)) return result('blocked', 'INVALID_POLICY');
  if (!s || s.policySource !== 'trusted-default-branch' || s.repository !== policy.repository)
    return result('blocked', 'UNTRUSTED_POLICY');
  if (policy.mode !== 'shadow' || policy.killSwitch) return result('blocked', 'STOPPED');
  if (!integer(s.issue) || !integer(s.pr) || !sha(s.head) || !sha(s.observedHead) ||
      !sha(s.base) || !sha(s.observedBase)) return result('blocked', 'INVALID_IDENTITY');
  if (s.head !== s.observedHead || s.base !== s.observedBase || s.baseBranch !== policy.defaultBranch)
    return result('blocked', 'STALE_HEAD_OR_BASE');
  if (s.rateLimited !== false) return result('blocked', 'RATE_LIMIT_OR_UNKNOWN');
  if (!Number.isFinite(s.remainingCredits) || s.remainingCredits <= 0 ||
      s.remainingCredits > policy.creditLimit || !Number.isSafeInteger(s.activeCount) ||
      s.activeCount < 0 || s.activeCount >= policy.maxActive)
    return result('blocked', 'BUDGET_OR_CONCURRENCY');
  if (s.providerReady !== true) return result('blocked', 'PROVIDER_UNKNOWN');
  if (!policy.riskClasses.includes(s.risk) || !Number.isSafeInteger(s.priority))
    return result('blocked', 'RISK_OR_PRIORITY_UNKNOWN');
  if (!dense(s.paths) || !s.paths.length || !s.paths.every(pathValid) ||
      s.paths.some(path => !policy.owners.some(owner => path === owner.prefix ||
        path.startsWith(owner.prefix.endsWith('/') ? owner.prefix : `${owner.prefix}/`))))
    return result('blocked', 'PATH_OWNERSHIP_UNKNOWN');
  if (!dense(s.dependencies) || s.dependencies.some(d =>
    !exact(d, ['issue', 'accepted']) || !integer(d.issue) || d.issue === s.issue ||
    d.accepted !== true)) return result('blocked', 'DEPENDENCIES_BLOCKED');
  if (s.acceptanceComplete !== true) return result('blocked', 'ACCEPTANCE_INCOMPLETE');
  if (s.baseCompatible !== true || s.mainHealthy !== true)
    return result('blocked', 'BASE_OR_MAIN_UNHEALTHY');
  if (s.threadsResolved !== true || s.securityClear !== true)
    return result('blocked', 'THREADS_OR_SECURITY_UNKNOWN');
  if (!exact(s.coverage, ['head', 'line', 'branch', 'complete']) ||
      s.coverage.head !== s.head || s.coverage.complete !== true ||
      !Number.isFinite(s.coverage.line) || !Number.isFinite(s.coverage.branch) ||
      s.coverage.line < policy.coverage.line || s.coverage.branch < policy.coverage.branch ||
      s.coverage.line > 100 || s.coverage.branch > 100)
    return result('blocked', 'COVERAGE_INCOMPLETE');
  if (!dense(s.checks) || s.checks.some(c =>
    !exact(c, ['name', 'head', 'appId', 'status', 'conclusion'])) || policy.checks.some(required => {
    const matches = s.checks.filter(c => c.name === required.name);
    return matches.length !== 1 || matches[0].head !== s.head ||
      matches[0].appId !== required.appId || matches[0].status !== 'completed' ||
      matches[0].conclusion !== 'success';
  })) return result('blocked', 'CHECKS_INCOMPLETE');
  if (!dense(s.reviews) || !text(s.author) || !text(s.agent))
    return result('blocked', 'REVIEW_MISSING');
  // A later comment or dismissal does not establish that an earlier request was cleared.
  if (s.reviews.some(r => !exact(r, ['reviewer', 'head', 'state']) || !text(r.reviewer) ||
        !sha(r.head) || !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(r.state)) ||
      !unique(s.reviews.map(r => identity(r.reviewer))) ||
      s.reviews.some(r => r.state !== 'APPROVED') ||
      !s.reviews.some(r => policy.reviewers.map(identity).includes(identity(r.reviewer)) &&
        identity(r.reviewer) !== identity(s.author) && identity(r.reviewer) !== identity(s.agent) &&
        r.head === s.head && r.state === 'APPROVED'))
    return result('blocked', 'REVIEW_MISSING');
  return result('eligible', 'SHADOW_ELIGIBLE');
}
