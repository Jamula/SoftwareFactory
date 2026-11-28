import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  EXACT_PROTECTED_CONTROL_PLANE_PATHS
} from '../../tools/engineering-factory/anti-rogue-audit.mjs';
import {
  GITHUB_ACTIONS_APP_ID,
  GITHUB_CODE_SCANNING_APP_ID,
  MAX_ENQUEUE_PER_TICK,
  PROTECTED_CONTROL_PLANE_PREFIXES,
  SOFTWARE_FACTORY_REPO,
  SOFTWARE_FACTORY_REPO_ID,
  evaluateAutomodePullRequests
} from '../../tools/engineering-factory/automode-enqueuer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(here, '..', '..', '.github', 'workflows', 'factory-automode-enqueue.yml');

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const OLD_SHA = 'c'.repeat(40);

const CLEAR_COPILOT_BODY = [
  '<!-- ccr-overview-v2 -->',
  '### 🟢 Approval recommended',
  '',
  '**No open issues** 🎉'
].join('\n');

const ACTIONABLE_COPILOT_BODY = [
  '<!-- ccr-overview-v2 -->',
  '### 🟡 Changes recommended',
  '',
  '<details><summary><strong>1 open issue</strong></summary>Fix validation.</details>'
].join('\n');

function makePassingChecks(headSha = HEAD_A, useAnalyzePair = false) {
  const base = [
    {name: 'build-test', status: 'completed', conclusion: 'success', appId: GITHUB_ACTIONS_APP_ID, headSha},
    {
      name: 'upload-coverage-javascript',
      status: 'completed',
      conclusion: 'success',
      appId: GITHUB_ACTIONS_APP_ID,
      headSha
    },
    {
      name: 'windows-aspire-runtime',
      status: 'completed',
      conclusion: 'success',
      appId: GITHUB_ACTIONS_APP_ID,
      headSha
    },
    {
      name: 'copilot-pull-request-reviewer',
      status: 'completed',
      conclusion: 'success',
      appId: GITHUB_ACTIONS_APP_ID,
      headSha
    }
  ];
  if (useAnalyzePair) {
    base.push(
      {
        name: 'Analyze (javascript-typescript)',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        appId: GITHUB_ACTIONS_APP_ID,
        headSha
      },
      {
        name: 'Analyze (actions)',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        appId: GITHUB_ACTIONS_APP_ID,
        headSha
      }
    );
  } else {
    base.push({
      name: 'CodeQL',
      status: 'completed',
      conclusion: 'success',
      appId: GITHUB_CODE_SCANNING_APP_ID,
      headSha
    });
  }
  return base;
}

function makeEligiblePr(overrides = {}) {
  const number = overrides.number ?? 180;
  const headRefOid = overrides.headRefOid ?? HEAD_A;
  const artifactSha = typeof headRefOid === 'string' && /^[0-9a-f]{40}$/.test(headRefOid) ? headRefOid : HEAD_A;
  return {
    id: `PR_kwDOV7Loe88AAAA${String(number).padStart(6, '0')}`,
    number,
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRepositoryId: SOFTWARE_FACTORY_REPO_ID,
    headRefOid,
    mergeQueueEntry: null,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    authorLogin: 'copilot-swe-agent',
    authorIsBot: true,
    changedFilesComplete: true,
    files: ['tools/engineering-factory/curated-lessons.mjs'],
    reviewThreadsComplete: true,
    unresolvedThreadCount: 0,
    reviewsComplete: true,
    reviews: [
      {
        id: 5001,
        reviewerLogin: 'copilot-pull-request-reviewer',
        reviewerIsBot: true,
        state: 'COMMENTED',
        commitOid: artifactSha,
        body: CLEAR_COPILOT_BODY
      }
    ],
    checkRunsComplete: true,
    statusCheckRollupState: 'SUCCESS',
    checkRuns: makePassingChecks(artifactSha),
    ...overrides
  };
}

function makeInput(pullRequests = [makeEligiblePr()], overrides = {}) {
  return {
    repository: SOFTWARE_FACTORY_REPO,
    repositoryId: SOFTWARE_FACTORY_REPO_ID,
    killSwitchActive: false,
    automodeEnabled: true,
    pullRequests,
    ...overrides
  };
}

test('exports frozen protected control-plane prefixes and enforces kill-switch, main health, and repository scope', () => {
  assert.equal(Object.isFrozen(PROTECTED_CONTROL_PLANE_PREFIXES), true);
  for (const exactPath of EXACT_PROTECTED_CONTROL_PLANE_PATHS) {
    assert.equal(PROTECTED_CONTROL_PLANE_PREFIXES.includes(exactPath), true);
  }
  assert.deepEqual(PROTECTED_CONTROL_PLANE_PREFIXES, [
    '.github/workflows/',
    'config/',
    'SECURITY.md',
    'docs/POLICY.md',
    'docs/ENGINEERING-STANDARDS.md',
    'tools/engineering-factory/core.mjs',
    'tools/engineering-factory/protected-squash.mjs',
    'tools/engineering-factory/platform-merge-gates.mjs',
    'tools/engineering-factory/coverage-evidence.mjs',
    'tools/engineering-factory/budget.mjs',
    'tools/engineering-factory/anti-rogue-audit.mjs',
    'tools/engineering-factory/cloud-agent-admission.mjs',
    'tools/engineering-factory/gh-aw-lock-verifier.mjs',
    'tools/engineering-factory/review-batch.mjs',
    'tools/engineering-factory/automode-enqueuer.mjs',
    'tools/engineering-factory/main-health-audit.mjs'
  ]);
  assert.equal(MAX_ENQUEUE_PER_TICK, 5);

  const killed = evaluateAutomodePullRequests(makeInput([makeEligiblePr()], {killSwitchActive: true}));
  assert.equal(Object.isFrozen(killed), true);
  assert.deepEqual(killed, {
    active: false,
    reason: 'AUTOMODE_DISABLED',
    enqueue: [],
    updateBranch: [],
    decisions: []
  });

  const disabled = evaluateAutomodePullRequests(makeInput([makeEligiblePr()], {automodeEnabled: false}));
  assert.equal(disabled.active, false);
  assert.equal(disabled.reason, 'AUTOMODE_DISABLED');

  const wrongSlug = evaluateAutomodePullRequests(makeInput([makeEligiblePr()], {repository: 'other/repo', mainHealthy: false}));
  assert.equal(wrongSlug.active, false);
  assert.equal(wrongSlug.reason, 'UNTRUSTED_REPOSITORY');

  const wrongId = evaluateAutomodePullRequests(makeInput([makeEligiblePr()], {repositoryId: 999}));
  assert.equal(wrongId.active, false);
  assert.equal(wrongId.reason, 'UNTRUSTED_REPOSITORY');

  const unhealthyMain = evaluateAutomodePullRequests(makeInput([makeEligiblePr()], {mainHealthy: false}));
  assert.deepEqual(unhealthyMain, {
    active: false,
    reason: 'MAIN_UNHEALTHY',
    enqueue: [],
    updateBranch: [],
    decisions: []
  });

  const healthyMainExplicit = evaluateAutomodePullRequests(
    makeInput([makeEligiblePr()], {mainHealthy: true, branchUpdateSupported: true})
  );
  assert.equal(healthyMainExplicit.active, true);
  assert.equal(healthyMainExplicit.enqueue.length, 1);

  const defaultsOmitted = evaluateAutomodePullRequests({
    repository: SOFTWARE_FACTORY_REPO,
    repositoryId: SOFTWARE_FACTORY_REPO_ID,
    pullRequests: [makeEligiblePr()]
  });
  assert.equal(defaultsOmitted.active, true);
  assert.equal(defaultsOmitted.enqueue.length, 1);
});

test('sorts PRs ascending for FIFO fairness, caps maxEnqueuePerTick, and suppresses BEHIND churn while enqueuing', () => {
  const prs = [
    makeEligiblePr({number: 186, mergeStateStatus: 'UNSTABLE', checkRuns: makePassingChecks(HEAD_A, true)}),
    makeEligiblePr({number: 182, mergeStateStatus: 'CLEAN'}),
    makeEligiblePr({number: 181, mergeStateStatus: 'BEHIND', checkRunsComplete: false, statusCheckRollupState: null}),
    makeEligiblePr({number: 184, mergeStateStatus: 'HAS_HOOKS'}),
    makeEligiblePr({number: 183, mergeStateStatus: 'BLOCKED'}),
    makeEligiblePr({number: 187, mergeStateStatus: 'CLEAN'}),
    makeEligiblePr({number: 185, mergeStateStatus: 'CLEAN'})
  ];
  const res = evaluateAutomodePullRequests(makeInput(prs));
  assert.equal(res.active, true);
  assert.equal(res.reason, 'EVALUATED');
  assert.deepEqual(res.enqueue.map(e => e.number), [182, 183, 184, 185, 186]);
  assert.deepEqual(res.updateBranch, []);
  assert.deepEqual(res.decisions, [
    {number: 181, action: 'SKIP', reason: 'BEHIND_DEFERRED'},
    {number: 182, action: 'ENQUEUE', reason: 'ELIGIBLE'},
    {number: 183, action: 'ENQUEUE', reason: 'ELIGIBLE'},
    {number: 184, action: 'ENQUEUE', reason: 'ELIGIBLE'},
    {number: 185, action: 'ENQUEUE', reason: 'ELIGIBLE'},
    {number: 186, action: 'ENQUEUE', reason: 'ELIGIBLE'},
    {number: 187, action: 'SKIP', reason: 'MAX_ENQUEUE_LIMIT_REACHED'}
  ]);

  // Custom maxEnqueuePerTick override
  const customCap = evaluateAutomodePullRequests(
    makeInput([makeEligiblePr({number: 190}), makeEligiblePr({number: 191})], {maxEnqueuePerTick: 1})
  );
  assert.deepEqual(customCap.enqueue.map(e => e.number), [190]);
  assert.equal(customCap.decisions[1].reason, 'MAX_ENQUEUE_LIMIT_REACHED');

  // When enqueue is empty, updates at most 1 lowest-numbered BEHIND branch
  const behindOnly = evaluateAutomodePullRequests(
    makeInput([
      makeEligiblePr({
        number: 195,
        headRefOid: HEAD_B,
        mergeStateStatus: 'BEHIND',
        reviews: [
          {
            id: 5010,
            reviewerLogin: 'copilot-pull-request-reviewer[bot]',
            reviewerIsBot: true,
            state: 'COMMENTED',
            commitOid: HEAD_B,
            body: CLEAR_COPILOT_BODY
          }
        ]
      }),
      makeEligiblePr({
        number: 192,
        headRefOid: HEAD_A,
        mergeStateStatus: 'BEHIND',
        checkRunsComplete: false,
        statusCheckRollupState: 'PENDING',
        checkRuns: []
      })
    ])
  );
  assert.deepEqual(behindOnly.enqueue, []);
  assert.deepEqual(behindOnly.updateBranch, [{number: 192, expectedHeadOid: HEAD_A}]);
  assert.deepEqual(behindOnly.decisions, [
    {number: 192, action: 'UPDATE_BRANCH', reason: 'BEHIND_UPDATE_BRANCH'},
    {number: 195, action: 'SKIP', reason: 'BEHIND_DEFERRED'}
  ]);

  // When branchUpdateSupported is false, BEHIND PRs never emit updateBranch and skip with BRANCH_UPDATE_UNSUPPORTED
  const behindUnsupported = evaluateAutomodePullRequests(
    makeInput(
      [
        makeEligiblePr({
          number: 192,
          headRefOid: HEAD_A,
          mergeStateStatus: 'BEHIND',
          checkRunsComplete: false,
          statusCheckRollupState: 'PENDING',
          checkRuns: []
        }),
        makeEligiblePr({number: 193, mergeStateStatus: 'CLEAN'})
      ],
      {branchUpdateSupported: false}
    )
  );
  assert.deepEqual(behindUnsupported.enqueue.map(e => e.number), [193]);
  assert.deepEqual(behindUnsupported.updateBranch, []);
  assert.deepEqual(behindUnsupported.decisions, [
    {number: 192, action: 'SKIP', reason: 'BRANCH_UPDATE_UNSUPPORTED'},
    {number: 193, action: 'ENQUEUE', reason: 'ELIGIBLE'}
  ]);

  const behindOnlyUnsupported = evaluateAutomodePullRequests(
    makeInput(
      [
        makeEligiblePr({
          number: 196,
          headRefOid: HEAD_A,
          mergeStateStatus: 'BEHIND',
          checkRunsComplete: false,
          statusCheckRollupState: null,
          checkRuns: []
        })
      ],
      {branchUpdateSupported: false}
    )
  );
  assert.deepEqual(behindOnlyUnsupported.enqueue, []);
  assert.deepEqual(behindOnlyUnsupported.updateBranch, []);
  assert.deepEqual(behindOnlyUnsupported.decisions, [
    {number: 196, action: 'SKIP', reason: 'BRANCH_UPDATE_UNSUPPORTED'}
  ]);
});

test('enforces basic PR identity, same-repository origin, draft, queue, conflict, and changed-file path gates', () => {
  const cases = [
    [{id: 'bad-id'}, 'INVALID_PR_IDENTITY'],
    [{headRefOid: 'not-a-sha'}, 'INVALID_PR_IDENTITY'],
    [{state: 'CLOSED'}, 'NOT_OPEN'],
    [{isDraft: true}, 'DRAFT_PR'],
    [{mergeStateStatus: 'DRAFT'}, 'DRAFT_PR'],
    [{baseRefName: 'develop'}, 'NON_MAIN_BASE'],
    [{headRepositoryId: null}, 'UNTRUSTED_HEAD_REPOSITORY'],
    [{headRepositoryId: 999999}, 'UNTRUSTED_HEAD_REPOSITORY'],
    [{mergeQueueEntry: {id: 'MQE_123'}}, 'ALREADY_IN_MERGE_QUEUE'],
    [{mergeable: 'CONFLICTING'}, 'CONFLICTING'],
    [{mergeStateStatus: 'DIRTY'}, 'CONFLICTING'],
    [{mergeable: 'UNKNOWN'}, 'MERGE_STATE_UNKNOWN'],
    [{mergeStateStatus: 'UNKNOWN'}, 'MERGE_STATE_UNKNOWN'],
    [{changedFilesComplete: false}, 'CHANGED_FILES_INCOMPLETE'],
    [{files: []}, 'CHANGED_FILES_INCOMPLETE'],
    [{files: ['../config/policy.json']}, 'CHANGED_FILES_INCOMPLETE'],
    [{files: ['./docs/README.md']}, 'CHANGED_FILES_INCOMPLETE'],
    [{files: ['/etc/passwd']}, 'CHANGED_FILES_INCOMPLETE'],
    [{files: ['docs//README.md']}, 'CHANGED_FILES_INCOMPLETE'],
    [{files: ['docs\\README.md']}, 'CHANGED_FILES_INCOMPLETE'],
    [{files: ['docs/\u0000bad.md']}, 'CHANGED_FILES_INCOMPLETE'],
    [{files: ['']}, 'CHANGED_FILES_INCOMPLETE']
  ];
  for (const [patch, expectedReason] of cases) {
    const res = evaluateAutomodePullRequests(makeInput([makeEligiblePr(patch)]));
    assert.equal(res.enqueue.length, 0);
    assert.equal(res.decisions[0].reason, expectedReason);
  }
});

test('enforces anti-rogue protected control-plane circuit breaker across all prefixes and bot identities', () => {
  for (const prefix of PROTECTED_CONTROL_PLANE_PREFIXES) {
    const targetFile = prefix.endsWith('/') ? `${prefix}gate.yml` : prefix;
    const blocked = evaluateAutomodePullRequests(makeInput([makeEligiblePr({files: [targetFile]})]));
    assert.equal(blocked.enqueue.length, 0);
    assert.equal(blocked.decisions[0].reason, 'PROTECTED_CONTROL_PLANE_REQUIRES_HUMAN_APPROVAL');
  }

  for (const extraProtected of [
    'Docs/Engineering-Standards.md',
    'security.md',
    '.github/aw/dispatcher.lock.yml',
    '.github/aw/dispatcher.LOCK.YML',
    'ops/rulesets/main.json',
    'scripts/kill-switch.mjs'
  ]) {
    const blocked = evaluateAutomodePullRequests(makeInput([makeEligiblePr({files: [extraProtected]})]));
    assert.equal(blocked.enqueue.length, 0);
    assert.equal(blocked.decisions[0].reason, 'PROTECTED_CONTROL_PLANE_REQUIRES_HUMAN_APPROVAL');
  }

  // Case-folded path & bot login regex even when authorIsBot is false
  for (const botLogin of [
    'copilot-swe-agent',
    'custom-app[bot]',
    'anthropic-code-agent',
    'openai-code-agent',
    'github-actions'
  ]) {
    const blockedBot = evaluateAutomodePullRequests(
      makeInput([
        makeEligiblePr({
          authorLogin: botLogin,
          authorIsBot: false,
          files: ['.GitHub/Workflows/factory-automode-enqueue.yml']
        })
      ])
    );
    assert.equal(blockedBot.decisions[0].reason, 'PROTECTED_CONTROL_PLANE_REQUIRES_HUMAN_APPROVAL');
  }

  // Blocked when reviewsComplete is false, stale human approval, bot approval, or dismissed/overturned human approval
  assert.equal(
    evaluateAutomodePullRequests(
      makeInput([makeEligiblePr({files: ['config/policy.json'], reviewsComplete: false})])
    ).decisions[0].reason,
    'PROTECTED_CONTROL_PLANE_REQUIRES_HUMAN_APPROVAL'
  );

  const staleHumanApproval = evaluateAutomodePullRequests(
    makeInput([
      makeEligiblePr({
        files: ['config/policy.json'],
        reviews: [
          {
            id: 6001,
            reviewerLogin: 'cyrusjamula',
            reviewerIsBot: false,
            state: 'APPROVED',
            commitOid: OLD_SHA,
            body: 'Approved earlier commit'
          }
        ]
      })
    ])
  );
  assert.equal(staleHumanApproval.decisions[0].reason, 'PROTECTED_CONTROL_PLANE_REQUIRES_HUMAN_APPROVAL');

  const dismissedHumanApproval = evaluateAutomodePullRequests(
    makeInput([
      makeEligiblePr({
        files: ['config/policy.json'],
        reviews: [
          {
            id: 6002,
            reviewerLogin: 'cyrusjamula',
            reviewerIsBot: false,
            state: 'APPROVED',
            commitOid: HEAD_A,
            body: 'LGTM'
          },
          {
            id: 6003,
            reviewerLogin: 'cyrusjamula',
            reviewerIsBot: false,
            state: 'DISMISSED',
            commitOid: HEAD_A,
            body: ''
          }
        ]
      })
    ])
  );
  assert.equal(dismissedHumanApproval.decisions[0].reason, 'PROTECTED_CONTROL_PLANE_REQUIRES_HUMAN_APPROVAL');

  // Allowed when independent non-bot human explicitly APPROVED exact headRefOid (even with subsequent COMMENTED reply)
  const humanApprovedProtected = evaluateAutomodePullRequests(
    makeInput([
      makeEligiblePr({
        files: ['.github/workflows/factory-automode-enqueue.yml'],
        reviews: [
          {
            id: 6004,
            reviewerLogin: 'copilot-pull-request-reviewer',
            reviewerIsBot: true,
            state: 'COMMENTED',
            commitOid: HEAD_A,
            body: CLEAR_COPILOT_BODY
          },
          {
            id: 6005,
            reviewerLogin: 'cyrusjamula',
            reviewerIsBot: false,
            state: 'APPROVED',
            commitOid: HEAD_A,
            body: 'Owner approved workflow change on exact head'
          },
          {
            id: 6006,
            reviewerLogin: 'cyrusjamula',
            reviewerIsBot: false,
            state: 'COMMENTED',
            commitOid: HEAD_A,
            body: ''
          }
        ]
      })
    ])
  );
  assert.equal(humanApprovedProtected.enqueue.length, 1);

  // Human-authored PR touching protected path passes with clear independent Copilot review
  const humanAuthorPr = evaluateAutomodePullRequests(
    makeInput([
      makeEligiblePr({
        authorLogin: 'cyrusjamula',
        authorIsBot: false,
        files: ['tools/engineering-factory/automode-enqueuer.mjs']
      })
    ])
  );
  assert.equal(humanAuthorPr.enqueue.length, 1);
});

test('enforces review threads, blocking/in-progress reviews, Copilot summary classification, and review_on_push:false rules', () => {
  assert.equal(
    evaluateAutomodePullRequests(makeInput([makeEligiblePr({reviewThreadsComplete: false})])).decisions[0].reason,
    'REVIEW_THREADS_INCOMPLETE'
  );
  assert.equal(
    evaluateAutomodePullRequests(makeInput([makeEligiblePr({unresolvedThreadCount: 1})])).decisions[0].reason,
    'UNRESOLVED_REVIEW_THREADS'
  );
  assert.equal(
    evaluateAutomodePullRequests(makeInput([makeEligiblePr({reviewsComplete: false})])).decisions[0].reason,
    'REVIEWS_INCOMPLETE'
  );

  // PENDING review blocks
  assert.equal(
    evaluateAutomodePullRequests(
      makeInput([
        makeEligiblePr({
          reviews: [
            ...makeEligiblePr().reviews,
            {
              id: 7001,
              reviewerLogin: 'reviewer-two',
              reviewerIsBot: false,
              state: 'PENDING',
              commitOid: null,
              body: ''
            }
          ]
        })
      ])
    ).decisions[0].reason,
    'CHANGES_REQUESTED'
  );

  // CHANGES_REQUESTED persists across non-decision COMMENTED replies, and clears only on subsequent APPROVED
  const crWithComment = makeEligiblePr({
    reviews: [
      ...makeEligiblePr().reviews,
      {
        id: 7002,
        reviewerLogin: 'reviewer-two',
        reviewerIsBot: false,
        state: 'CHANGES_REQUESTED',
        commitOid: HEAD_A,
        body: 'Please fix edge case'
      },
      {
        id: 7003,
        reviewerLogin: 'reviewer-two',
        reviewerIsBot: false,
        state: 'COMMENTED',
        commitOid: HEAD_A,
        body: 'Thanks for replying'
      }
    ]
  });
  assert.equal(evaluateAutomodePullRequests(makeInput([crWithComment])).decisions[0].reason, 'CHANGES_REQUESTED');

  crWithComment.reviews.push({
    id: 7004,
    reviewerLogin: 'reviewer-two',
    reviewerIsBot: false,
    state: 'APPROVED',
    commitOid: HEAD_A,
    body: 'Resolved'
  });
  assert.equal(evaluateAutomodePullRequests(makeInput([crWithComment])).enqueue.length, 1);

  // In-progress Copilot review check run names block
  for (const checkName of [
    'copilot-pull-request-reviewer',
    'Running Copilot Code Review',
    'Copilot Code Review'
  ]) {
    const inProg = makeEligiblePr({
      checkRuns: [
        ...makePassingChecks(HEAD_A).filter(c => c.name !== 'copilot-pull-request-reviewer'),
        {name: checkName, status: 'in_progress', conclusion: null, appId: GITHUB_ACTIONS_APP_ID, headSha: HEAD_A}
      ]
    });
    assert.equal(
      evaluateAutomodePullRequests(makeInput([inProg])).decisions[0].reason,
      'COPILOT_REVIEW_IN_PROGRESS'
    );
  }

  // Exact-head Copilot summary classification blocks actionable and uncertain bodies
  for (const badBody of [ACTIONABLE_COPILOT_BODY, 'Plain non-overview comment']) {
    const nonClear = makeEligiblePr({
      reviews: [
        {
          id: 7010,
          reviewerLogin: 'copilot-pull-request-reviewer',
          reviewerIsBot: true,
          state: 'COMMENTED',
          commitOid: HEAD_A,
          body: badBody
        }
      ]
    });
    assert.equal(
      evaluateAutomodePullRequests(makeInput([nonClear])).decisions[0].reason,
      'COPILOT_SUMMARY_NOT_CLEAR'
    );
  }

  // review_on_push: false — actionable or uncertain prior-commit Copilot summary blocks without exact-head human approval
  for (const badBody of [ACTIONABLE_COPILOT_BODY, 'Plain non-overview comment']) {
    const priorCommitUnresolvedSummary = makeEligiblePr({
      headRefOid: HEAD_B,
      checkRuns: makePassingChecks(HEAD_B),
      reviews: [
        {
          id: 7020,
          reviewerLogin: 'copilot-pull-request-reviewer',
          reviewerIsBot: true,
          state: 'COMMENTED',
          commitOid: HEAD_A,
          body: badBody
        }
      ]
    });
    assert.equal(
      evaluateAutomodePullRequests(makeInput([priorCommitUnresolvedSummary])).decisions[0].reason,
      'COPILOT_SUMMARY_NOT_CLEAR'
    );
  }

  // Actionable prior-commit Copilot summary is allowed when an independent human explicitly APPROVED exact headRefOid
  const priorCommitHumanDispositioned = makeEligiblePr({
    headRefOid: HEAD_B,
    checkRuns: makePassingChecks(HEAD_B),
    reviews: [
      {
        id: 7020,
        reviewerLogin: 'copilot-pull-request-reviewer',
        reviewerIsBot: true,
        state: 'COMMENTED',
        commitOid: HEAD_A,
        body: ACTIONABLE_COPILOT_BODY
      },
      {
        id: 7024,
        reviewerLogin: 'cyrusjamula',
        reviewerIsBot: false,
        state: 'APPROVED',
        commitOid: HEAD_B,
        body: 'Verified summary finding fixed on HEAD_B'
      }
    ]
  });
  assert.equal(evaluateAutomodePullRequests(makeInput([priorCommitHumanDispositioned])).enqueue.length, 1);

  // Clear prior-commit Copilot review (including superseding an earlier actionable review) carries forward cleanly
  const priorCommitCopilotClear = makeEligiblePr({
    headRefOid: HEAD_B,
    checkRuns: makePassingChecks(HEAD_B),
    reviews: [
      {
        id: 7025,
        reviewerLogin: 'copilot-pull-request-reviewer',
        reviewerIsBot: true,
        state: 'COMMENTED',
        commitOid: OLD_SHA,
        body: ACTIONABLE_COPILOT_BODY
      },
      {
        id: 7026,
        reviewerLogin: 'copilot-pull-request-reviewer[bot]',
        reviewerIsBot: true,
        state: 'COMMENTED',
        commitOid: HEAD_A,
        body: CLEAR_COPILOT_BODY
      }
    ]
  });
  assert.equal(evaluateAutomodePullRequests(makeInput([priorCommitCopilotClear])).enqueue.length, 1);

  // Prior-commit human-only COMMENTED or stale human APPROVED without Copilot review blocks
  const staleHumanOnly = makeEligiblePr({
    authorLogin: 'cyrusjamula',
    authorIsBot: false,
    reviews: [
      {
        id: 7021,
        reviewerLogin: 'other-human',
        reviewerIsBot: false,
        state: 'APPROVED',
        commitOid: OLD_SHA,
        body: 'Old approval'
      }
    ]
  });
  assert.equal(
    evaluateAutomodePullRequests(makeInput([staleHumanOnly])).decisions[0].reason,
    'INDEPENDENT_REVIEW_REQUIRED'
  );

  // Self-review or spoofed non-bot copilot reviewer login blocks
  const selfOnly = makeEligiblePr({
    authorLogin: 'cyrusjamula',
    authorIsBot: false,
    reviews: [
      {
        id: 7022,
        reviewerLogin: 'CyrusJamula',
        reviewerIsBot: false,
        state: 'APPROVED',
        commitOid: HEAD_A,
        body: 'Self LGTM'
      }
    ]
  });
  assert.equal(
    evaluateAutomodePullRequests(makeInput([selfOnly])).decisions[0].reason,
    'INDEPENDENT_REVIEW_REQUIRED'
  );

  const spoofedCopilotNonBot = makeEligiblePr({
    authorLogin: 'cyrusjamula',
    authorIsBot: false,
    reviews: [
      {
        id: 7023,
        reviewerLogin: 'copilot-pull-request-reviewer',
        reviewerIsBot: false,
        state: 'COMMENTED',
        commitOid: HEAD_A,
        body: CLEAR_COPILOT_BODY
      }
    ]
  });
  assert.equal(
    evaluateAutomodePullRequests(makeInput([spoofedCopilotNonBot])).decisions[0].reason,
    'INDEPENDENT_REVIEW_REQUIRED'
  );
});

test('enforces exact-head required Actions checks, CodeQL checks, appId trust, and rollup status', () => {
  assert.equal(
    evaluateAutomodePullRequests(makeInput([makeEligiblePr({checkRunsComplete: false})])).decisions[0].reason,
    'CHECK_RUNS_INCOMPLETE'
  );
  assert.equal(
    evaluateAutomodePullRequests(makeInput([makeEligiblePr({statusCheckRollupState: 'PENDING'})])).decisions[0].reason,
    'STATUS_ROLLUP_NOT_SUCCESS'
  );
  assert.equal(
    evaluateAutomodePullRequests(makeInput([makeEligiblePr({statusCheckRollupState: null})])).decisions[0].reason,
    'STATUS_ROLLUP_NOT_SUCCESS'
  );

  // Missing required Actions check or wrong headSha
  for (const missing of ['build-test', 'upload-coverage-javascript', 'windows-aspire-runtime']) {
    const withoutReq = makeEligiblePr({
      checkRuns: makePassingChecks(HEAD_A).map(c => (c.name === missing ? {...c, headSha: OLD_SHA} : c))
    });
    assert.equal(
      evaluateAutomodePullRequests(makeInput([withoutReq])).decisions[0].reason,
      'REQUIRED_CHECKS_INCOMPLETE'
    );
  }

  // Duplicate required check where second run failed or is in_progress must fail closed
  const failedReq = makeEligiblePr({
    checkRuns: [
      ...makePassingChecks(HEAD_A),
      {name: 'build-test', status: 'completed', conclusion: 'failure', appId: GITHUB_ACTIONS_APP_ID, headSha: HEAD_A}
    ]
  });
  assert.equal(
    evaluateAutomodePullRequests(makeInput([failedReq])).decisions[0].reason,
    'REQUIRED_CHECKS_INCOMPLETE'
  );

  const queuedCodeql = makeEligiblePr({
    checkRuns: [
      ...makePassingChecks(HEAD_A),
      {name: 'Analyze (csharp)', status: 'queued', conclusion: null, appId: GITHUB_ACTIONS_APP_ID, headSha: HEAD_A}
    ]
  });
  assert.equal(
    evaluateAutomodePullRequests(makeInput([queuedCodeql])).decisions[0].reason,
    'CODEQL_CHECKS_INCOMPLETE'
  );

  // Missing CodeQL or partial Analyze without Analyze (actions) fails closed
  const partialAnalyzeOnly = makeEligiblePr({
    checkRuns: [
      ...makePassingChecks(HEAD_A).filter(c => c.name !== 'CodeQL'),
      {
        name: 'Analyze (javascript-typescript)',
        status: 'completed',
        conclusion: 'success',
        appId: GITHUB_ACTIONS_APP_ID,
        headSha: HEAD_A
      }
    ]
  });
  assert.equal(
    evaluateAutomodePullRequests(makeInput([partialAnalyzeOnly])).decisions[0].reason,
    'CODEQL_CHECKS_INCOMPLETE'
  );

  // Untrusted appId on Actions check or CodeQL check fails closed
  const untrustedActions = makeEligiblePr({
    checkRuns: makePassingChecks(HEAD_A).map(c => (c.name === 'build-test' ? {...c, appId: 57789} : c))
  });
  assert.equal(
    evaluateAutomodePullRequests(makeInput([untrustedActions])).decisions[0].reason,
    'UNTRUSTED_CHECK_APP'
  );

  const untrustedCodeql = makeEligiblePr({
    checkRuns: makePassingChecks(HEAD_A).map(c => (c.name === 'CodeQL' ? {...c, appId: 12345} : c))
  });
  assert.equal(
    evaluateAutomodePullRequests(makeInput([untrustedCodeql])).decisions[0].reason,
    'UNTRUSTED_CHECK_APP'
  );

  // CodeQL check from GITHUB_ACTIONS_APP_ID (15368) + unrelated optional skipped check passes
  const actionsCodeqlAndSkippedOptional = makeEligiblePr({
    checkRuns: [
      ...makePassingChecks(HEAD_A).map(c => (c.name === 'CodeQL' ? {...c, appId: GITHUB_ACTIONS_APP_ID} : c)),
      {name: 'inventory', status: 'completed', conclusion: 'skipped', appId: GITHUB_ACTIONS_APP_ID, headSha: HEAD_A}
    ]
  });
  assert.equal(evaluateAutomodePullRequests(makeInput([actionsCodeqlAndSkippedOptional])).enqueue.length, 1);
});

test('fails closed on malformed inputs, duplicate PR numbers, proxies, getters, sparse arrays, and prototype pollution', () => {
  const invalidInputs = [
    null,
    undefined,
    [],
    'bad',
    {...makeInput(), extra: true},
    {...makeInput(), [Symbol('s')]: 1},
    {repository: SOFTWARE_FACTORY_REPO, repositoryId: SOFTWARE_FACTORY_REPO_ID},
    makeInput([], {repository: 123}),
    makeInput([], {repositoryId: '1471342715'}),
    makeInput([], {killSwitchActive: 'true'}),
    makeInput([], {automodeEnabled: 1}),
    makeInput([], {maxEnqueuePerTick: 0}),
    makeInput([], {maxEnqueuePerTick: 6}),
    makeInput([], {mainHealthy: 'bad'}),
    makeInput([], {mainHealthy: 1}),
    makeInput([], {branchUpdateSupported: 'bad'}),
    makeInput([], {branchUpdateSupported: null}),
    makeInput('not-array'),
    makeInput([null]),
    makeInput([makeEligiblePr({number: 1}), makeEligiblePr({number: 1})]),
    makeInput([makeEligiblePr({number: 0})]),
    makeInput([makeEligiblePr({id: 123})]),
    makeInput([makeEligiblePr({state: 1})]),
    makeInput([makeEligiblePr({isDraft: 'no'})]),
    makeInput([makeEligiblePr({baseRefName: null})]),
    makeInput([makeEligiblePr({headRepositoryId: -1})]),
    makeInput([makeEligiblePr({headRefOid: 123})]),
    makeInput([makeEligiblePr({mergeQueueEntry: {id: '1', extra: 2}})]),
    makeInput([makeEligiblePr({mergeable: 'INVALID'})]),
    makeInput([makeEligiblePr({mergeStateStatus: 'INVALID'})]),
    makeInput([makeEligiblePr({authorLogin: 123})]),
    makeInput([makeEligiblePr({authorLogin: ' invalid'})]),
    makeInput([makeEligiblePr({authorIsBot: 'yes'})]),
    makeInput([makeEligiblePr({changedFilesComplete: 1})]),
    makeInput([makeEligiblePr({files: 'bad'})]),
    makeInput([makeEligiblePr({reviewThreadsComplete: null})]),
    makeInput([makeEligiblePr({unresolvedThreadCount: -1})]),
    makeInput([makeEligiblePr({reviewsComplete: 0})]),
    makeInput([makeEligiblePr({reviews: 'bad'})]),
    makeInput([makeEligiblePr({checkRunsComplete: null})]),
    makeInput([makeEligiblePr({statusCheckRollupState: 123})]),
    makeInput([makeEligiblePr({checkRuns: 'bad'})]),
    makeInput([makeEligiblePr({reviews: [null]})]),
    makeInput([makeEligiblePr({reviews: [{...makeEligiblePr().reviews[0], id: 0}]})]),
    makeInput([makeEligiblePr({reviews: [{...makeEligiblePr().reviews[0], reviewerLogin: ''}]})]),
    makeInput([makeEligiblePr({reviews: [{...makeEligiblePr().reviews[0], reviewerIsBot: 1}]})]),
    makeInput([makeEligiblePr({reviews: [{...makeEligiblePr().reviews[0], state: 'UNKNOWN'}]})]),
    makeInput([makeEligiblePr({reviews: [{...makeEligiblePr().reviews[0], commitOid: 'short'}]})]),
    makeInput([makeEligiblePr({reviews: [{...makeEligiblePr().reviews[0], body: 123}]})]),
    makeInput([makeEligiblePr({reviews: [{...makeEligiblePr().reviews[0], body: 'a\u0000b'}]})]),
    makeInput([makeEligiblePr({reviews: [{...makeEligiblePr().reviews[0], body: 'x'.repeat(65537)}]})]),
    makeInput([makeEligiblePr({checkRuns: [null]})]),
    makeInput([makeEligiblePr({checkRuns: [{...makePassingChecks()[0], name: ''}]})]),
    makeInput([makeEligiblePr({checkRuns: [{...makePassingChecks()[0], status: 123}]})]),
    makeInput([makeEligiblePr({checkRuns: [{...makePassingChecks()[0], status: 'bad'}]})]),
    makeInput([makeEligiblePr({checkRuns: [{...makePassingChecks()[0], conclusion: null}]})]),
    makeInput([makeEligiblePr({checkRuns: [{...makePassingChecks()[0], conclusion: 'bad'}]})]),
    makeInput([makeEligiblePr({checkRuns: [{...makePassingChecks()[0], status: 'queued', conclusion: 'success'}]})]),
    makeInput([makeEligiblePr({checkRuns: [{...makePassingChecks()[0], appId: -1}]})]),
    makeInput([makeEligiblePr({checkRuns: [{...makePassingChecks()[0], headSha: 'bad'}]})])
  ];

  for (const bad of invalidInputs) {
    const res = evaluateAutomodePullRequests(bad);
    assert.equal(res.active, false);
    assert.equal(res.reason, 'INVALID_INPUT');
  }

  let traps = 0;
  const boom = () => {
    traps++;
    throw new Error('trap invoked');
  };
  const handler = {get: boom, has: boom, ownKeys: boom, getOwnPropertyDescriptor: boom, getPrototypeOf: boom};
  assert.equal(evaluateAutomodePullRequests(new Proxy(makeInput(), handler)).reason, 'INVALID_INPUT');

  const withProxyArray = makeInput();
  withProxyArray.pullRequests = new Proxy([], handler);
  assert.equal(evaluateAutomodePullRequests(withProxyArray).reason, 'INVALID_INPUT');

  const sparsePrs = makeInput(new Array(2));
  assert.equal(evaluateAutomodePullRequests(sparsePrs).reason, 'INVALID_INPUT');

  const getterArrayEl = makeInput([makeEligiblePr()]);
  Object.defineProperty(getterArrayEl.pullRequests, 0, {get: boom, enumerable: true});
  assert.equal(evaluateAutomodePullRequests(getterArrayEl).reason, 'INVALID_INPUT');

  const nonEnumKey = makeInput([]);
  Object.defineProperty(nonEnumKey, 'repository', {value: SOFTWARE_FACTORY_REPO, enumerable: false});
  assert.equal(evaluateAutomodePullRequests(nonEnumKey).reason, 'INVALID_INPUT');

  const oversized = makeInput(Array.from({length: 101}, (_, i) => makeEligiblePr({number: i + 1})));
  assert.equal(evaluateAutomodePullRequests(oversized).reason, 'INVALID_INPUT');

  try {
    Object.defineProperty(Object.prototype, 'killSwitchActive', {get: boom, configurable: true});
    assert.equal(
      evaluateAutomodePullRequests({
        repository: SOFTWARE_FACTORY_REPO,
        repositoryId: SOFTWARE_FACTORY_REPO_ID,
        pullRequests: []
      }).reason,
      'INVALID_INPUT'
    );
  } finally {
    delete Object.prototype.killSwitchActive;
  }

  assert.equal(traps, 0);
});

test('verifies factory-automode-enqueue.yml privilege separation, SHA pinning, and expression safety', () => {
  const yaml = readFileSync(workflowPath, 'utf8');
  assert.match(yaml, /^name: Factory automode Merge Queue gatekeeper$/m);
  assert.match(yaml, /pull_request_target:/);
  assert.match(yaml, /workflow_run:/);
  assert.match(yaml, /schedule:/);
  assert.match(yaml, /workflow_dispatch:/);
  assert.doesNotMatch(yaml, /^\s+pull_request:\s*$/m);
  assert.doesNotMatch(yaml, /^\s+pull_request_review:\s*$/m);

  const checkoutBlocks = [
    ...yaml.matchAll(/uses: actions\/checkout@([0-9a-f]{40})[\s\S]*?(?=\n {6}- |\n  [a-z]|$)/g)
  ];
  assert.ok(checkoutBlocks.length >= 1);
  for (const [block, sha] of checkoutBlocks) {
    assert.equal(sha, '3d3c42e5aac5ba805825da76410c181273ba90b1');
    assert.match(block, /ref: refs\/heads\/main/);
    assert.match(block, /persist-credentials: false/);
  }
  assert.match(yaml, /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1/);

  const applyIdx = yaml.indexOf('  apply-queue-actions:');
  assert.ok(applyIdx > 0);
  const applySection = yaml.slice(applyIdx);
  assert.match(applySection, /needs:\s*(?:\[evaluate\]|evaluate)/);
  assert.match(applySection, /execFileSync/);

  // Ensure zero ${{ ... }} template interpolation inside run: blocks
  const runMatches = [...yaml.matchAll(/^ {8}run: \|-?\n((?: {10}.*\n|\n)+)/gm)];
  assert.ok(runMatches.length >= 2);
  for (const [, scriptBody] of runMatches) {
    assert.doesNotMatch(scriptBody, /\$\{\{/);
  }
});
