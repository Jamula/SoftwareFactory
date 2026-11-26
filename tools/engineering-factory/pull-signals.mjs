import {readPullIdentity} from './event-envelope.mjs';

const repository = 'Jamula/SoftwareFactory';
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const text = (value, max=120) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const timestamp = value => typeof value === 'string' && value.length <= 40 &&
  Number.isFinite(Date.parse(value));
const failed = reason => ({shadow:true,evidenceComplete:false,reason});

async function readJson(url, request) {
  try {
    const response = await request(url, {method:'GET',redirect:'error',signal:AbortSignal.timeout(5000),
      headers:{accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
    if ([401,403,429].includes(response.status)) return {ok:false,reason:'RATE_OR_PERMISSION_UNKNOWN'};
    if (!response.ok || !response.body) return {ok:false,reason:'READ_FAILED'};
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8',{fatal:true});
    let raw = '', bytes = 0;
    try {
      for (;;) {
        const {done,value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 524288) return {ok:false,reason:'RESPONSE_LIMIT'};
        raw += decoder.decode(value,{stream:true});
      }
      raw += decoder.decode();
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return {ok:true,value:JSON.parse(raw),hasNext:response.headers.get('link')?.includes('rel="next"')===true};
  } catch {
    return {ok:false,reason:'READ_FAILED'};
  }
}

function normalizeReviews(value, hasNext, number, head) {
  if (hasNext || !Array.isArray(value) || value.length > 100) return {ok:false,reason:'PAGE_LIMIT'};
  const seen = new Set(), reviews = [];
  for (const row of value) {
    if (!row || !positive(row.id) || seen.has(row.id) || !row.user ||
        !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(row.user.login ?? '') ||
        (row.user.id !== null && row.user.id !== undefined && !positive(row.user.id)) ||
        !['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED','PENDING'].includes(row.state) ||
        !sha(row.commit_id) || !timestamp(row.submitted_at)) return {ok:false,reason:'REVIEW_METADATA_UNKNOWN'};
    if (row.commit_id !== head) return {ok:false,reason:'REVIEW_HEAD_MISMATCH'};
    seen.add(row.id);
    reviews.push({id:row.id,reviewer:row.user.login,reviewerId:positive(row.user.id)?row.user.id:null,
      state:row.state,head:row.commit_id,submittedAt:row.submitted_at});
  }
  return {ok:true,reviews};
}

const conclusions = new Set(['success','failure','neutral','cancelled','skipped','timed_out',
  'action_required','stale','startup_failure']);
function normalizeChecks(value, hasNext, head) {
  if (hasNext || !value || !Number.isSafeInteger(value.total_count) || value.total_count < 0 ||
      value.total_count > 100 || !Array.isArray(value.check_runs) ||
      value.check_runs.length !== value.total_count) return {ok:false,reason:'PAGE_LIMIT'};
  const seen = new Set(), checks = [];
  for (const row of value.check_runs) {
    if (!row || !positive(row.id) || seen.has(row.id) || !text(row.name,100) || !sha(row.head_sha) ||
        !row.app || !positive(row.app.id) || !/^[a-z0-9-]{1,100}$/.test(row.app.slug ?? '') ||
        !['queued','in_progress','completed'].includes(row.status)) return {ok:false,reason:'CHECK_METADATA_UNKNOWN'};
    if (row.head_sha !== head) return {ok:false,reason:'CHECK_HEAD_MISMATCH'};
    if (row.status === 'completed') {
      if (!conclusions.has(row.conclusion) || !timestamp(row.completed_at))
        return {ok:false,reason:'CHECK_METADATA_UNKNOWN'};
    } else if (row.conclusion !== null || row.completed_at !== null) {
      return {ok:false,reason:'CHECK_METADATA_UNKNOWN'};
    }
    seen.add(row.id);
    checks.push({id:row.id,name:row.name,appId:row.app.id,app:row.app.slug,head:row.head_sha,
      status:row.status,conclusion:row.conclusion,completedAt:row.completed_at});
  }
  return {ok:true,checks};
}

/** Read bounded review/check metadata for a fresh same-repository pull head.
 * This is a read-only snapshot, not a trusted event, policy decision or merge receipt.
 */
export async function readPullSignals(number, expectedHead, request=fetch) {
  if (!positive(number)) return failed('INVALID_PULL');
  if (!sha(expectedHead)) return failed('INVALID_HEAD');
  const pull = await readPullIdentity(number, request);
  if (pull.reason !== 'IDENTITY_ONLY' || pull.repositoryId !== 1471342715 || pull.number !== number)
    return failed(pull.reason === 'RATE_OR_PERMISSION_UNKNOWN' ? pull.reason : 'PULL_IDENTITY_UNKNOWN');
  if (pull.head !== expectedHead) return failed('HEAD_CHANGED');

  const root = 'https://api.github.com/repos/' + repository;
  const [reviewResult, checkResult] = await Promise.all([
    readJson(root + '/pulls/' + number + '/reviews?per_page=100&page=1', request),
    readJson(root + '/commits/' + expectedHead + '/check-runs?per_page=100&page=1', request)
  ]);
  if (!reviewResult.ok) return failed(reviewResult.reason);
  if (!checkResult.ok) return failed(checkResult.reason);
  const reviews = normalizeReviews(reviewResult.value,reviewResult.hasNext,number,expectedHead);
  if (!reviews.ok) return failed(reviews.reason);
  const checks = normalizeChecks(checkResult.value,checkResult.hasNext,expectedHead);
  if (!checks.ok) return failed(checks.reason);
  return {shadow:true,evidenceComplete:false,reason:'PULL_SIGNALS_METADATA_ONLY',repositoryId:pull.repositoryId,
    number,head:pull.head,base:pull.base,state:pull.state,draft:pull.draft,
    reviewSnapshotComplete:true,reviews:reviews.reviews,checkSnapshotComplete:true,checks:checks.checks,
    liveDispatch:false,liveMerge:false};
}
