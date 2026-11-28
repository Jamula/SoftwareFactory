import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {
  ACTIVE_MAIN_WORKFLOWS,
  DEFAULT_OFF_MAIN_WORKFLOWS,
  DOTNET_AGENTS_PULL_PATH_FILTERS,
  GITHUB_ACTIONS_APP_ID,
  GITHUB_ADVANCED_SECURITY_APP_ID,
  OPTIONAL_MAIN_WORKFLOWS,
  PATH_FILTERED_DOTNET_PULL_CHECKS,
  REQUIRED_CANDIDATE_PULL_CHECKS,
  REQUIRED_CANDIDATE_RUNTIME_CHECKS,
  REQUIRED_MERGE_GROUP_CHECKS,
  REQUIRED_STATUS_CHECK_CONTEXTS,
  SOFTWARE_FACTORY_REPO,
  SOFTWARE_FACTORY_REPO_ID,
  auditProtectedMainAndCandidateGates
} from '../../tools/engineering-factory/main-health-audit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const evidencePath = join(here, '..', '..', 'docs', 'evidence', 'm01-01-main-quality-audit.json');
const recordedEvidence = JSON.parse(readFileSync(evidencePath, 'utf8'));

const MAIN_SHA = 'a'.repeat(40);
const CAND_SHA = 'b'.repeat(40);
const MG_SHA = 'c'.repeat(40);
const PEER_SHA = 'd'.repeat(40);

const CLEAR_COPILOT_SUMMARY = [
  '<!-- ccr-overview-v2 -->',
  '### 🟢 Approval recommended',
  '',
  '**No open issues** 🎉',
  '',
  '<details><summary><strong>What changed in this PR</strong></summary>Verified gates.</details>'
].join('\n');

const ACTIONABLE_COPILOT_SUMMARY = [
  '<!-- ccr-overview-v2 -->',
  '### 🟡 Changes recommended',
  '',
  '<details><summary><strong>2 open issues</strong></summary>Fix validation gap.</details>'
].join('\n');

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeHealthyMainInput() {
  let nextJobId = 1000;
  const job = (name, headSha = MAIN_SHA) => ({
    name,
    jobId: nextJobId++,
    appId: GITHUB_ACTIONS_APP_ID,
    headSha,
    status: 'completed',
    conclusion: 'success'
  });

  return {
    repository: SOFTWARE_FACTORY_REPO,
    repositoryId: SOFTWARE_FACTORY_REPO_ID,
    branch: 'main',
    ruleset: {
      strictRequiredStatusChecks: true,
      requiredStatusChecks: REQUIRED_STATUS_CHECK_CONTEXTS.map(context => ({
        context,
        integrationId: GITHUB_ACTIONS_APP_ID
      })),
      minimumCoverage: 98,
      maxCoverageDrop: 0,
      requiredApprovingReviewCount: 0,
      copilotCodeReviewOnPush: true,
      requiredReviewThreadResolution: true,
      allowedMergeMethods: ['squash'],
      mergeQueueMergeMethod: 'SQUASH',
      mergeQueueGrouping: 'ALLGREEN',
      bypassActorsCount: 0,
      secretScanningRequired: true,
      codeScanningTools: [
        {
          tool: 'CodeQL',
          securityAlertsThreshold: 'medium_or_higher',
          alertsThreshold: 'errors_and_warnings'
        }
      ]
    },
    main: {
      head: MAIN_SHA,
      protected: true,
      security: {
        secretScanningClear: true,
        openCodeScanningAlerts: 0
      },
      workflowRuns: [
        {
          workflow: 'Factory validation',
          runName: 'Factory validation',
          runId: 201,
          event: 'push',
          headSha: MAIN_SHA,
          status: 'completed',
          conclusion: 'success',
          jobs: [
            job('test-coverage'),
            job('linux-aspire-runtime'),
            job('upload-coverage-javascript'),
            job('build-test')
          ]
        },
        {
          workflow: 'Windows Aspire runtime',
          runName: 'Windows Aspire runtime',
          runId: 202,
          event: 'push',
          headSha: MAIN_SHA,
          status: 'completed',
          conclusion: 'success',
          jobs: [job('windows-aspire-runtime')]
        },
        {
          workflow: '.NET MAF specialist agents',
          runName: '.NET MAF specialist agents',
          runId: 203,
          event: 'push',
          headSha: MAIN_SHA,
          status: 'completed',
          conclusion: 'success',
          jobs: [job('linux-dotnet-agents'), job('windows-dotnet-agents')]
        },
        {
          workflow: 'Reusable replay smoke',
          runName: 'Reusable replay smoke',
          runId: 204,
          event: 'push',
          headSha: MAIN_SHA,
          status: 'completed',
          conclusion: 'success',
          jobs: [job('pinned-synthetic-replay / replay')]
        },
        {
          workflow: 'CodeQL',
          runName: 'Push on main',
          runId: 205,
          event: 'dynamic',
          headSha: MAIN_SHA,
          status: 'completed',
          conclusion: 'success',
          jobs: [
            job('Analyze (actions)'),
            job('Analyze (csharp)'),
            job('Analyze (javascript-typescript)')
          ]
        },
        {
          workflow: 'CodeQL - Code Quality',
          runName: 'Code Quality: Push on main',
          runId: 206,
          event: 'dynamic',
          headSha: MAIN_SHA,
          status: 'completed',
          conclusion: 'success',
          jobs: [
            job('Analyze (csharp)'),
            job('Analyze (javascript-typescript)')
          ]
        },
        {
          workflow: DEFAULT_OFF_MAIN_WORKFLOWS[0],
          runName: DEFAULT_OFF_MAIN_WORKFLOWS[0],
          runId: 207,
          event: 'push',
          defaultOff: true,
          headSha: MAIN_SHA,
          status: 'completed',
          conclusion: 'skipped',
          jobs: [
            {
              name: 'inventory',
              jobId: nextJobId++,
              appId: GITHUB_ACTIONS_APP_ID,
              headSha: MAIN_SHA,
              status: 'completed',
              conclusion: 'skipped'
            }
          ]
        }
      ],
      jsCoverage: {
        head: MAIN_SHA,
        expectedComponents: ['engineering-factory.core', 'engineering-factory.main-health-audit'],
        components: [
          {
            component: 'engineering-factory.core',
            head: MAIN_SHA,
            lines: 100,
            lineTotal: 100,
            branches: 98,
            branchTotal: 100
          },
          {
            component: 'engineering-factory.main-health-audit',
            head: MAIN_SHA,
            lines: 200,
            lineTotal: 200,
            branches: 192,
            branchTotal: 200
          }
        ]
      },
      dotnetCoverage: {
        head: MAIN_SHA,
        sdkVersion: '10.0.404',
        expectedComponents: ['SoftwareFactory.Agents'],
        components: [
          {
            component: 'SoftwareFactory.Agents',
            head: MAIN_SHA,
            lines: 1737,
            lineTotal: 1739,
            branches: 786,
            branchTotal: 798
          }
        ]
      }
    }
  };
}

function makeHealthyCandidate() {
  let nextJobId = 5000;
  return {
    prNumber: 145,
    head: CAND_SHA,
    base: MAIN_SHA,
    headRepository: SOFTWARE_FACTORY_REPO,
    headRepositoryId: SOFTWARE_FACTORY_REPO_ID,
    isFork: false,
    pullChecks: REQUIRED_CANDIDATE_PULL_CHECKS.map(name => ({
      name,
      jobId: nextJobId++,
      appId: GITHUB_ACTIONS_APP_ID,
      headSha: CAND_SHA,
      event: 'pull_request',
      status: 'completed',
      conclusion: 'success'
    })),
    codeScanning: {
      head: CAND_SHA,
      codeqlStatus: 'completed',
      codeqlConclusion: 'success',
      codeQualityStatus: 'completed',
      codeQualityConclusion: 'success',
      openAlerts: 0
    },
    secretScanningClear: true,
    unresolvedInlineThreads: 0,
    trustedReviewers: ['copilot-pull-request-reviewer[bot]', 'independent-human'],
    review: {
      reviewId: 901,
      head: CAND_SHA,
      reviewer: 'copilot-pull-request-reviewer[bot]',
      author: 'cyrusjamula',
      agent: 'copilot-swe-agent[bot]',
      state: 'COMMENTED',
      independent: true,
      summaryDisposition: 'clear',
      unresolvedSummaryFindings: 0,
      blockingReviewCount: 0,
      summaryBody: CLEAR_COPILOT_SUMMARY
    },
    mergeGroup: {
      head: MG_SHA,
      base: MAIN_SHA,
      headRef: `gh-readonly-queue/main/pr-145-${MAIN_SHA}`,
      memberHeads: [PEER_SHA, CAND_SHA],
      checks: REQUIRED_MERGE_GROUP_CHECKS.map(name => ({
        name,
        jobId: nextJobId++,
        appId: GITHUB_ACTIONS_APP_ID,
        headSha: MG_SHA,
        event: 'merge_group',
        status: 'completed',
        conclusion: 'success'
      }))
    },
    jsCoverage: {
      head: CAND_SHA,
      expectedComponents: ['engineering-factory.main-health-audit'],
      components: [
        {
          component: 'engineering-factory.main-health-audit',
          head: CAND_SHA,
          lines: 200,
          lineTotal: 200,
          branches: 196,
          branchTotal: 200
        }
      ]
    },
    dotnetCoverage: {
      head: CAND_SHA,
      sdkVersion: '10.0.404',
      expectedComponents: ['SoftwareFactory.Agents'],
      components: [
        {
          component: 'SoftwareFactory.Agents',
          head: CAND_SHA,
          lines: 1737,
          lineTotal: 1739,
          branches: 786,
          branchTotal: 798
        }
      ]
    }
  };
}

function makeFullHealthyInput() {
  return {
    ...makeHealthyMainInput(),
    candidate: makeHealthyCandidate()
  };
}

test('replays recorded b0924c38 main quality audit receipt with 13/13 green Push on main checks and flips to MAIN_HEALTHY once CodeQL code_scanning ruleset is present', () => {
  assert.equal(ACTIVE_MAIN_WORKFLOWS.length, 5);
  assert.deepEqual(OPTIONAL_MAIN_WORKFLOWS, [
    'CodeQL - Code Quality',
    'Factory automode Merge Queue gatekeeper'
  ]);
  assert.deepEqual(PATH_FILTERED_DOTNET_PULL_CHECKS, ['linux-dotnet-agents', 'windows-dotnet-agents']);
  assert.equal(DOTNET_AGENTS_PULL_PATH_FILTERS.length, 7);
  assert.equal(recordedEvidence.auditedHead, 'b0924c3807f797e6090e1dc3e1e65fc9caa07550');
  assert.equal(recordedEvidence.mainHealthy, false);
  assert.equal(recordedEvidence.statusSummary.allActiveWorkflowsGreen, true);
  assert.equal(recordedEvidence.statusSummary.activeWorkflowChecksPassed, 13);
  assert.equal(recordedEvidence.statusSummary.analyzePythonJobCount, 0);
  assert.equal(recordedEvidence.mergeQueueReceipt.mergedPullRequest, 157);
  assert.equal(recordedEvidence.mergeQueueReceipt.mergeGroupHead, 'b0924c3807f797e6090e1dc3e1e65fc9caa07550');

  const actual = auditProtectedMainAndCandidateGates(recordedEvidence.auditInput);
  assert.equal(Object.isFrozen(actual), true);
  assert.equal(Object.isFrozen(actual.failureReasons), true);
  assert.equal(Object.isFrozen(actual.failedMainWorkflows), true);
  assert.equal(Object.isFrozen(actual.failedMainJobs), true);
  assert.equal(Object.isFrozen(actual.coverageSummary), true);
  assert.deepEqual(actual, recordedEvidence.auditResult);

  assert.equal(actual.valid, false);
  assert.equal(actual.eligible, false);
  assert.equal(actual.mainHealthy, false);
  assert.equal(actual.dependentWorkAllowed, false);
  assert.equal(actual.reason, 'RULESET_INCOMPLETE');
  assert.deepEqual(actual.failureReasons, ['RULESET_INCOMPLETE']);
  assert.deepEqual(actual.failedMainWorkflows, []);
  assert.deepEqual(actual.failedMainJobs, []);
  assert.equal(actual.coverageSummary.mainJs.componentCount, 70);
  assert.equal(actual.coverageSummary.mainJs.lines, 40665);
  assert.equal(actual.coverageSummary.mainJs.lineTotal, 40685);
  assert.equal(actual.coverageSummary.mainJs.linePercent, '99.95%');
  assert.equal(actual.coverageSummary.mainJs.branches, 21454);
  assert.equal(actual.coverageSummary.mainJs.branchTotal, 21644);
  assert.equal(actual.coverageSummary.mainJs.branchPercent, '99.12%');
  assert.equal(actual.coverageSummary.mainDotnet.linePercent, '99.88%');
  assert.equal(actual.coverageSummary.mainDotnet.branchPercent, '98.50%');

  // Adding the CodeQL code_scanning ruleset entry to the exact b0924c38 auditInput immediately flips mainHealthy to true.
  const withCodeqlRuleset = cloneJson(recordedEvidence.auditInput);
  withCodeqlRuleset.ruleset.codeScanningTools = [
    {
      tool: 'CodeQL',
      securityAlertsThreshold: 'medium_or_higher',
      alertsThreshold: 'errors_and_warnings'
    }
  ];
  const healthyVerdict = auditProtectedMainAndCandidateGates(withCodeqlRuleset);
  assert.equal(healthyVerdict.valid, true);
  assert.equal(healthyVerdict.eligible, false);
  assert.equal(healthyVerdict.mainHealthy, true);
  assert.equal(healthyVerdict.dependentWorkAllowed, true);
  assert.equal(healthyVerdict.reason, 'MAIN_HEALTHY');
  assert.deepEqual(healthyVerdict.failureReasons, []);
  assert.deepEqual(healthyVerdict.failedMainWorkflows, []);
  assert.deepEqual(healthyVerdict.failedMainJobs, []);
});

test('verifies healthy protected main alone and full protected main + candidate integration gates', () => {
  const mainOnly = auditProtectedMainAndCandidateGates(makeHealthyMainInput());
  assert.equal(mainOnly.valid, true);
  assert.equal(mainOnly.mainHealthy, true);
  assert.equal(mainOnly.dependentWorkAllowed, true);
  assert.equal(mainOnly.eligible, false);
  assert.equal(mainOnly.candidateEvaluated, false);
  assert.equal(mainOnly.candidateHealthy, null);
  assert.equal(mainOnly.reason, 'MAIN_HEALTHY');

  const altNames = makeHealthyMainInput();
  altNames.main.workflowRuns[4].runName = 'CodeQL';
  altNames.main.workflowRuns[5].runName = 'CodeQL - Code Quality';
  altNames.main.workflowRuns[6].conclusion = 'success';
  altNames.main.workflowRuns[6].jobs[0].conclusion = 'success';
  altNames.main.workflowRuns.push({
    workflow: 'Factory automode Merge Queue gatekeeper',
    runName: 'Factory automode Merge Queue gatekeeper',
    runId: 208,
    event: 'dynamic',
    headSha: MAIN_SHA,
    status: 'completed',
    conclusion: 'success',
    jobs: [
      {
        name: 'evaluate',
        jobId: 1099,
        appId: GITHUB_ACTIONS_APP_ID,
        headSha: MAIN_SHA,
        status: 'completed',
        conclusion: 'success'
      }
    ]
  });
  assert.equal(auditProtectedMainAndCandidateGates(altNames).mainHealthy, true);

  const full = auditProtectedMainAndCandidateGates(makeFullHealthyInput());
  assert.equal(full.valid, true);
  assert.equal(full.eligible, true);
  assert.equal(full.mainHealthy, true);
  assert.equal(full.candidateEvaluated, true);
  assert.equal(full.candidateHealthy, true);
  assert.equal(full.liveMerge, false);
  assert.equal(full.liveDispatch, false);
  assert.equal(full.reason, 'MAIN_AND_CANDIDATE_HEALTHY');
  assert.equal(full.candidateHead, CAND_SHA);
  assert.equal(full.mergeGroupHead, MG_SHA);

  const humanApproved = makeFullHealthyInput();
  humanApproved.ruleset.requiredApprovingReviewCount = 1;
  humanApproved.ruleset.copilotCodeReviewOnPush = false;
  humanApproved.ruleset.codeScanningTools = [
    {
      tool: 'CodeQL',
      securityAlertsThreshold: 'all',
      alertsThreshold: 'all'
    }
  ];
  humanApproved.candidate.review = {
    reviewId: 902,
    head: CAND_SHA,
    reviewer: 'independent-human',
    author: 'cyrusjamula',
    agent: 'copilot-swe-agent[bot]',
    state: 'APPROVED',
    independent: true,
    summaryDisposition: 'clear',
    unresolvedSummaryFindings: 0,
    blockingReviewCount: 0,
    summaryBody: 'LGTM — verified exact-head checks and coverage receipts.'
  };
  assert.equal(auditProtectedMainAndCandidateGates(humanApproved).eligible, true);

  const humanSummaryActionable = cloneJson(humanApproved);
  humanSummaryActionable.candidate.review.summaryDisposition = 'actionable';
  assert.equal(
    auditProtectedMainAndCandidateGates(humanSummaryActionable).reason,
    'SUMMARY_REVIEW_FINDINGS_OPEN'
  );

  const copilotShortLogin = makeFullHealthyInput();
  copilotShortLogin.candidate.trustedReviewers = ['copilot-pull-request-reviewer'];
  copilotShortLogin.candidate.review.reviewer = 'copilot-pull-request-reviewer';
  copilotShortLogin.candidate.pullChecks.push({
    name: 'Analyze (javascript-typescript)',
    jobId: 8888,
    appId: GITHUB_ACTIONS_APP_ID,
    headSha: CAND_SHA,
    event: 'dynamic',
    status: 'completed',
    conclusion: 'success'
  });
  copilotShortLogin.candidate.pullChecks.push({
    name: 'Analyze (javascript-typescript)',
    jobId: 8886,
    appId: GITHUB_ACTIONS_APP_ID,
    headSha: CAND_SHA,
    event: 'dynamic',
    status: 'completed',
    conclusion: 'success'
  });
  copilotShortLogin.candidate.pullChecks.push({
    name: 'CodeQL',
    jobId: 8887,
    appId: GITHUB_ADVANCED_SECURITY_APP_ID,
    headSha: CAND_SHA,
    event: 'dynamic',
    status: 'completed',
    conclusion: 'success'
  });
  copilotShortLogin.candidate.pullChecks.push({
    name: 'CodeQL',
    jobId: 8885,
    appId: GITHUB_ACTIONS_APP_ID,
    headSha: CAND_SHA,
    event: 'dynamic',
    status: 'completed',
    conclusion: 'success'
  });
  assert.equal(auditProtectedMainAndCandidateGates(copilotShortLogin).eligible, true);

  const untrustedCodeqlApp = cloneJson(copilotShortLogin);
  untrustedCodeqlApp.candidate.pullChecks.find(c => c.name === 'CodeQL').appId = 99999;
  assert.equal(auditProtectedMainAndCandidateGates(untrustedCodeqlApp).reason, 'UNTRUSTED_CHECK_APP');
});

test('fails closed on unhealthy protected main across all active workflows, incomplete runs, untrusted apps, and security alerts', () => {
  const brokenMainWithHealthyCandidate = makeFullHealthyInput();
  brokenMainWithHealthyCandidate.main.workflowRuns[4].conclusion = 'failure';
  brokenMainWithHealthyCandidate.main.workflowRuns[4].jobs.push({
    name: 'Analyze (python)',
    jobId: 1999,
    appId: GITHUB_ACTIONS_APP_ID,
    headSha: MAIN_SHA,
    status: 'completed',
    conclusion: 'failure'
  });
  const blockedByMain = auditProtectedMainAndCandidateGates(brokenMainWithHealthyCandidate);
  assert.equal(blockedByMain.valid, false);
  assert.equal(blockedByMain.eligible, false);
  assert.equal(blockedByMain.mainHealthy, false);
  assert.equal(blockedByMain.candidateHealthy, true);
  assert.equal(blockedByMain.reason, 'MAIN_WORKFLOW_FAILED');

  const notProtected = makeHealthyMainInput();
  notProtected.main.protected = false;
  assert.equal(auditProtectedMainAndCandidateGates(notProtected).reason, 'MAIN_NOT_PROTECTED');

  const secretOpen = makeHealthyMainInput();
  secretOpen.main.security.secretScanningClear = false;
  assert.equal(auditProtectedMainAndCandidateGates(secretOpen).reason, 'MAIN_SECURITY_ALERTS_OPEN');

  const codeAlertOpen = makeHealthyMainInput();
  codeAlertOpen.main.security.openCodeScanningAlerts = 1;
  assert.equal(auditProtectedMainAndCandidateGates(codeAlertOpen).reason, 'MAIN_SECURITY_ALERTS_OPEN');

  const runHeadMismatch = makeHealthyMainInput();
  runHeadMismatch.main.workflowRuns[1].headSha = CAND_SHA;
  assert.equal(auditProtectedMainAndCandidateGates(runHeadMismatch).reason, 'MAIN_HEAD_MISMATCH');

  const jobHeadMismatch = makeHealthyMainInput();
  jobHeadMismatch.main.workflowRuns[1].jobs[0].headSha = CAND_SHA;
  assert.equal(auditProtectedMainAndCandidateGates(jobHeadMismatch).reason, 'MAIN_HEAD_MISMATCH');

  const untrustedApp = makeHealthyMainInput();
  untrustedApp.main.workflowRuns[0].jobs[0].appId = 99999;
  assert.equal(auditProtectedMainAndCandidateGates(untrustedApp).reason, 'UNTRUSTED_CHECK_APP');

  const badEvent = makeHealthyMainInput();
  badEvent.main.workflowRuns[0].event = 'pull_request';
  assert.equal(auditProtectedMainAndCandidateGates(badEvent).reason, 'MAIN_WORKFLOW_METADATA_MISMATCH');

  const badRunName = makeHealthyMainInput();
  badRunName.main.workflowRuns[4].runName = 'Pull request';
  assert.equal(auditProtectedMainAndCandidateGates(badRunName).reason, 'MAIN_WORKFLOW_METADATA_MISMATCH');

  const badYamlRunName = makeHealthyMainInput();
  badYamlRunName.main.workflowRuns[0].runName = 'Other name';
  assert.equal(auditProtectedMainAndCandidateGates(badYamlRunName).reason, 'MAIN_WORKFLOW_METADATA_MISMATCH');

  const badQualityRunName = makeHealthyMainInput();
  badQualityRunName.main.workflowRuns[5].runName = 'Other quality name';
  assert.equal(auditProtectedMainAndCandidateGates(badQualityRunName).reason, 'MAIN_WORKFLOW_METADATA_MISMATCH');

  const inProgressJob = makeHealthyMainInput();
  inProgressJob.main.workflowRuns[2].status = 'in_progress';
  inProgressJob.main.workflowRuns[2].conclusion = null;
  inProgressJob.main.workflowRuns[2].jobs[1].status = 'in_progress';
  inProgressJob.main.workflowRuns[2].jobs[1].conclusion = null;
  const incompleteRes = auditProtectedMainAndCandidateGates(inProgressJob);
  assert.equal(incompleteRes.reason, 'MAIN_WORKFLOW_INCOMPLETE');
  assert.deepEqual(incompleteRes.failedMainWorkflows, ['.NET MAF specialist agents']);
  assert.equal(incompleteRes.failedMainJobs.length, 1);

  const runLevelIncomplete = makeHealthyMainInput();
  runLevelIncomplete.main.workflowRuns[3].status = 'in_progress';
  runLevelIncomplete.main.workflowRuns[3].conclusion = null;
  assert.equal(auditProtectedMainAndCandidateGates(runLevelIncomplete).reason, 'MAIN_WORKFLOW_INCOMPLETE');

  const defaultOffFailed = makeHealthyMainInput();
  defaultOffFailed.main.workflowRuns[6].conclusion = 'failure';
  defaultOffFailed.main.workflowRuns[6].jobs[0].conclusion = 'failure';
  assert.equal(auditProtectedMainAndCandidateGates(defaultOffFailed).reason, 'MAIN_WORKFLOW_FAILED');

  const runFailedWithoutFailedJob = makeHealthyMainInput();
  runFailedWithoutFailedJob.main.workflowRuns[3].conclusion = 'cancelled';
  assert.equal(auditProtectedMainAndCandidateGates(runFailedWithoutFailedJob).reason, 'MAIN_WORKFLOW_FAILED');

  const extraPushOnMainFailed = makeHealthyMainInput();
  extraPushOnMainFailed.main.workflowRuns.push({
    workflow: 'Custom security scan',
    runName: 'Push on main',
    runId: 299,
    event: 'dynamic',
    headSha: MAIN_SHA,
    status: 'completed',
    conclusion: 'failure',
    jobs: [
      {
        name: 'custom-scan-job',
        jobId: 2999,
        appId: GITHUB_ACTIONS_APP_ID,
        headSha: MAIN_SHA,
        status: 'completed',
        conclusion: 'failure'
      }
    ]
  });
  const extraRes = auditProtectedMainAndCandidateGates(extraPushOnMainFailed);
  assert.equal(extraRes.reason, 'MAIN_WORKFLOW_FAILED');
  assert.deepEqual(extraRes.failedMainWorkflows, ['Custom security scan']);

  const extraBadName = makeHealthyMainInput();
  extraBadName.main.workflowRuns.push({
    ...cloneJson(extraPushOnMainFailed.main.workflowRuns[7]),
    runName: 'Unrelated name',
    conclusion: 'success',
    jobs: [{...extraPushOnMainFailed.main.workflowRuns[7].jobs[0], conclusion: 'success'}]
  });
  assert.equal(auditProtectedMainAndCandidateGates(extraBadName).reason, 'MAIN_WORKFLOW_METADATA_MISMATCH');

  const missingJob = makeHealthyMainInput();
  missingJob.main.workflowRuns[0].jobs = missingJob.main.workflowRuns[0].jobs.slice(0, 3);
  assert.equal(auditProtectedMainAndCandidateGates(missingJob).reason, 'MAIN_REQUIRED_JOB_MISSING');

  for (let idx = 0; idx < 5; idx++) {
    const missingWf = makeHealthyMainInput();
    missingWf.main.workflowRuns.splice(idx, 1);
    assert.equal(auditProtectedMainAndCandidateGates(missingWf).reason, 'MAIN_ACTIVE_WORKFLOW_MISSING');
  }

  // Disabled duplicate CodeQL - Code Quality (index 5) is optional on new main pushes, while security CodeQL remains mandatory
  const withoutCodeQuality = makeFullHealthyInput();
  withoutCodeQuality.main.workflowRuns = withoutCodeQuality.main.workflowRuns.filter(
    r => r.workflow !== 'CodeQL - Code Quality'
  );
  delete withoutCodeQuality.candidate.codeScanning.codeQualityStatus;
  delete withoutCodeQuality.candidate.codeScanning.codeQualityConclusion;
  const noCqRes = auditProtectedMainAndCandidateGates(withoutCodeQuality);
  assert.equal(noCqRes.valid, true);
  assert.equal(noCqRes.mainHealthy, true);
  assert.equal(noCqRes.eligible, true);
  assert.equal(noCqRes.reason, 'MAIN_AND_CANDIDATE_HEALTHY');

  // Path-filtered .NET MAF specialist agents on pull_request when C#/Aspire files are unchanged (while remaining mandatory on merge_group & main)
  const jsOnlyCandidate = cloneJson(withoutCodeQuality);
  jsOnlyCandidate.candidate.dotnetPathsChanged = false;
  jsOnlyCandidate.candidate.pullChecks = jsOnlyCandidate.candidate.pullChecks.filter(
    c => !PATH_FILTERED_DOTNET_PULL_CHECKS.includes(c.name)
  );
  delete jsOnlyCandidate.candidate.dotnetCoverage;
  const jsOnlyOk = auditProtectedMainAndCandidateGates(jsOnlyCandidate);
  assert.equal(jsOnlyOk.valid, true);
  assert.equal(jsOnlyOk.eligible, true);
  assert.equal(jsOnlyOk.coverageSummary.candidateDotnet, null);

  // Even when dotnetPathsChanged is false on pull_request, merge_group MUST still execute linux-dotnet-agents & windows-dotnet-agents
  const jsOnlyMissingMgDotnet = cloneJson(jsOnlyCandidate);
  jsOnlyMissingMgDotnet.candidate.mergeGroup.checks = jsOnlyMissingMgDotnet.candidate.mergeGroup.checks.filter(
    c => c.name !== 'windows-dotnet-agents'
  );
  assert.equal(
    auditProtectedMainAndCandidateGates(jsOnlyMissingMgDotnet).reason,
    'MERGE_GROUP_CHECKS_FAILED'
  );

  // Structural guards on half-present codeQuality fields, non-boolean dotnetPathsChanged, or missing dotnetCoverage when dotnetPathsChanged=true
  const halfCodeQuality = cloneJson(withoutCodeQuality);
  halfCodeQuality.candidate.codeScanning.codeQualityStatus = 'completed';
  assert.equal(auditProtectedMainAndCandidateGates(halfCodeQuality).reason, 'INVALID_INPUT');

  const badDotnetPathsFlag = makeFullHealthyInput();
  badDotnetPathsFlag.candidate.dotnetPathsChanged = 'false';
  assert.equal(auditProtectedMainAndCandidateGates(badDotnetPathsFlag).reason, 'INVALID_INPUT');

  const missingCandDotnetWhenChanged = makeFullHealthyInput();
  delete missingCandDotnetWhenChanged.candidate.dotnetCoverage;
  assert.equal(auditProtectedMainAndCandidateGates(missingCandDotnetWhenChanged).reason, 'INVALID_INPUT');
});

test('accepts Factory automode Merge Queue gatekeeper conditional skips and main events while failing closed on actual failures', () => {
  const makeGatekeeperRun = (overrides = {}) => ({
    workflow: 'Factory automode Merge Queue gatekeeper',
    runName: 'Factory automode Merge Queue gatekeeper',
    runId: 310,
    event: 'workflow_run',
    headSha: MAIN_SHA,
    status: 'completed',
    conclusion: 'success',
    jobs: [
      {
        name: 'evaluate',
        jobId: 3101,
        appId: GITHUB_ACTIONS_APP_ID,
        headSha: MAIN_SHA,
        status: 'completed',
        conclusion: 'success'
      },
      {
        name: 'apply-queue-actions',
        jobId: 3102,
        appId: GITHUB_ACTIONS_APP_ID,
        headSha: MAIN_SHA,
        status: 'completed',
        conclusion: 'skipped'
      }
    ],
    ...overrides
  });

  // 1. Complete 2-job no-action receipt across all valid main-executing gatekeeper events
  for (const event of ['workflow_run', 'schedule', 'workflow_dispatch', 'pull_request_target', 'push', 'dynamic']) {
    const noActionTick = makeHealthyMainInput();
    noActionTick.main.workflowRuns.push(makeGatekeeperRun({event}));
    const res = auditProtectedMainAndCandidateGates(noActionTick);
    assert.equal(res.valid, true);
    assert.equal(res.mainHealthy, true);
    assert.equal(res.reason, 'MAIN_HEALTHY');
    assert.deepEqual(res.failedMainWorkflows, []);
    assert.deepEqual(res.failedMainJobs, []);
  }

  // Complete 2-job enqueue-action receipt where both jobs succeed
  const actionTick = makeHealthyMainInput();
  const bothSuccessRun = makeGatekeeperRun({event: 'pull_request_target'});
  bothSuccessRun.jobs[1].conclusion = 'success';
  actionTick.main.workflowRuns.push(bothSuccessRun);
  assert.equal(auditProtectedMainAndCandidateGates(actionTick).mainHealthy, true);

  // 2. All-skipped gatekeeper run (FACTORY_AUTOMODE_ENABLED=false or FACTORY_KILL_SWITCH=true)
  const allSkippedTick = makeHealthyMainInput();
  allSkippedTick.main.workflowRuns.push(
    makeGatekeeperRun({
      event: 'schedule',
      conclusion: 'skipped',
      jobs: [
        {
          name: 'evaluate',
          jobId: 3111,
          appId: GITHUB_ACTIONS_APP_ID,
          headSha: MAIN_SHA,
          status: 'completed',
          conclusion: 'skipped'
        },
        {
          name: 'apply-queue-actions',
          jobId: 3112,
          appId: GITHUB_ACTIONS_APP_ID,
          headSha: MAIN_SHA,
          status: 'completed',
          conclusion: 'skipped'
        }
      ]
    })
  );
  const allSkippedRes = auditProtectedMainAndCandidateGates(allSkippedTick);
  assert.equal(allSkippedRes.valid, true);
  assert.equal(allSkippedRes.mainHealthy, true);
  assert.equal(allSkippedRes.reason, 'MAIN_HEALTHY');
  assert.deepEqual(allSkippedRes.failedMainWorkflows, []);
  assert.deepEqual(allSkippedRes.failedMainJobs, []);

  // 3. Actual job/run failures, contradictory skip states, incomplete runs, and metadata mismatches fail closed
  const applyFailed = makeHealthyMainInput();
  const applyFailedRun = makeGatekeeperRun({conclusion: 'failure'});
  applyFailedRun.jobs[1].conclusion = 'failure';
  applyFailed.main.workflowRuns.push(applyFailedRun);
  const applyFailedRes = auditProtectedMainAndCandidateGates(applyFailed);
  assert.equal(applyFailedRes.mainHealthy, false);
  assert.equal(applyFailedRes.reason, 'MAIN_WORKFLOW_FAILED');
  assert.deepEqual(applyFailedRes.failedMainWorkflows, ['Factory automode Merge Queue gatekeeper']);
  assert.equal(applyFailedRes.failedMainJobs.length, 1);
  assert.equal(applyFailedRes.failedMainJobs[0].jobName, 'apply-queue-actions');

  const evaluateFailed = makeHealthyMainInput();
  const evaluateFailedRun = makeGatekeeperRun({conclusion: 'failure'});
  evaluateFailedRun.jobs[0].conclusion = 'failure';
  evaluateFailed.main.workflowRuns.push(evaluateFailedRun);
  const evaluateFailedRes = auditProtectedMainAndCandidateGates(evaluateFailed);
  assert.equal(evaluateFailedRes.mainHealthy, false);
  assert.equal(evaluateFailedRes.reason, 'MAIN_WORKFLOW_FAILED');
  assert.deepEqual(evaluateFailedRes.failedMainWorkflows, ['Factory automode Merge Queue gatekeeper']);
  assert.equal(evaluateFailedRes.failedMainJobs.length, 1);
  assert.equal(evaluateFailedRes.failedMainJobs[0].jobName, 'evaluate');

  for (const badConclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']) {
    const runFailed = makeHealthyMainInput();
    runFailed.main.workflowRuns.push(makeGatekeeperRun({conclusion: badConclusion}));
    const runFailedRes = auditProtectedMainAndCandidateGates(runFailed);
    assert.equal(runFailedRes.mainHealthy, false);
    assert.equal(runFailedRes.reason, 'MAIN_WORKFLOW_FAILED');
  }

  // Contradictory skip combinations fail closed
  const bypassedEvaluate = makeHealthyMainInput();
  const bypassedRun = makeGatekeeperRun({conclusion: 'success'});
  bypassedRun.jobs[0].conclusion = 'skipped';
  bypassedRun.jobs[1].conclusion = 'success';
  bypassedEvaluate.main.workflowRuns.push(bypassedRun);
  assert.equal(auditProtectedMainAndCandidateGates(bypassedEvaluate).reason, 'MAIN_WORKFLOW_FAILED');

  const allSkippedClaimingSuccess = makeHealthyMainInput();
  const allSkippedSuccessRun = makeGatekeeperRun({conclusion: 'success'});
  allSkippedSuccessRun.jobs[0].conclusion = 'skipped';
  allSkippedSuccessRun.jobs[1].conclusion = 'skipped';
  allSkippedClaimingSuccess.main.workflowRuns.push(allSkippedSuccessRun);
  assert.equal(auditProtectedMainAndCandidateGates(allSkippedClaimingSuccess).reason, 'MAIN_WORKFLOW_FAILED');

  const ranJobClaimingSkipped = makeHealthyMainInput();
  ranJobClaimingSkipped.main.workflowRuns.push(makeGatekeeperRun({conclusion: 'skipped'}));
  assert.equal(auditProtectedMainAndCandidateGates(ranJobClaimingSkipped).reason, 'MAIN_WORKFLOW_FAILED');

  const unexpectedSkippedJob = makeHealthyMainInput();
  const unexpectedSkippedRun = makeGatekeeperRun();
  unexpectedSkippedRun.jobs.push({
    name: 'unexpected-gatekeeper-job',
    jobId: 3120,
    appId: GITHUB_ACTIONS_APP_ID,
    headSha: MAIN_SHA,
    status: 'completed',
    conclusion: 'skipped'
  });
  unexpectedSkippedJob.main.workflowRuns.push(unexpectedSkippedRun);
  assert.equal(auditProtectedMainAndCandidateGates(unexpectedSkippedJob).reason, 'MAIN_WORKFLOW_FAILED');

  const missingEvaluateJob = makeHealthyMainInput();
  missingEvaluateJob.main.workflowRuns.push(
    makeGatekeeperRun({
      conclusion: 'skipped',
      jobs: [
        {
          name: 'apply-queue-actions',
          jobId: 3121,
          appId: GITHUB_ACTIONS_APP_ID,
          headSha: MAIN_SHA,
          status: 'completed',
          conclusion: 'skipped'
        }
      ]
    })
  );
  assert.equal(auditProtectedMainAndCandidateGates(missingEvaluateJob).reason, 'MAIN_REQUIRED_JOB_MISSING');

  const gatekeeperIncomplete = makeHealthyMainInput();
  const incompleteGatekeeperRun = makeGatekeeperRun({status: 'in_progress', conclusion: null});
  incompleteGatekeeperRun.jobs[0].status = 'in_progress';
  incompleteGatekeeperRun.jobs[0].conclusion = null;
  gatekeeperIncomplete.main.workflowRuns.push(incompleteGatekeeperRun);
  assert.equal(auditProtectedMainAndCandidateGates(gatekeeperIncomplete).reason, 'MAIN_WORKFLOW_INCOMPLETE');

  const gatekeeperBadEvent = makeHealthyMainInput();
  gatekeeperBadEvent.main.workflowRuns.push(makeGatekeeperRun({event: 'pull_request'}));
  assert.equal(
    auditProtectedMainAndCandidateGates(gatekeeperBadEvent).reason,
    'MAIN_WORKFLOW_METADATA_MISMATCH'
  );

  const gatekeeperBadRunName = makeHealthyMainInput();
  gatekeeperBadRunName.main.workflowRuns.push(makeGatekeeperRun({runName: 'Push on main'}));
  assert.equal(
    auditProtectedMainAndCandidateGates(gatekeeperBadRunName).reason,
    'MAIN_WORKFLOW_METADATA_MISMATCH'
  );

  // Mandatory active workflows and CodeQL - Code Quality still reject skipped jobs and workflow_run events
  const activeSkippedJob = makeHealthyMainInput();
  activeSkippedJob.main.workflowRuns[0].jobs[0].conclusion = 'skipped';
  assert.equal(auditProtectedMainAndCandidateGates(activeSkippedJob).reason, 'MAIN_WORKFLOW_FAILED');

  const codeQualitySkippedJob = makeHealthyMainInput();
  codeQualitySkippedJob.main.workflowRuns[5].jobs[0].conclusion = 'skipped';
  assert.equal(auditProtectedMainAndCandidateGates(codeQualitySkippedJob).reason, 'MAIN_WORKFLOW_FAILED');

  const activeWorkflowRunEvent = makeHealthyMainInput();
  activeWorkflowRunEvent.main.workflowRuns[0].event = 'workflow_run';
  assert.equal(
    auditProtectedMainAndCandidateGates(activeWorkflowRunEvent).reason,
    'MAIN_WORKFLOW_METADATA_MISMATCH'
  );
});

test('fails closed on fork PR skipped runtime checks, summary-only review findings with 0 inline threads, and merge_group failures or SHA mismatches', () => {
  // Fork PR with skipped runtime checks
  const forkSkipped = makeFullHealthyInput();
  forkSkipped.candidate.isFork = true;
  forkSkipped.candidate.headRepository = 'external-fork/SoftwareFactory';
  forkSkipped.candidate.headRepositoryId = 999999;
  for (const check of forkSkipped.candidate.pullChecks) {
    if (REQUIRED_CANDIDATE_RUNTIME_CHECKS.includes(check.name)) {
      check.conclusion = 'skipped';
    }
  }
  const forkSkippedRes = auditProtectedMainAndCandidateGates(forkSkipped);
  assert.equal(forkSkippedRes.eligible, false);
  assert.equal(forkSkippedRes.reason, 'FORK_PR_RUNTIME_CHECKS_SKIPPED');

  // Fork PR with missing runtime checks
  const forkMissingRuntime = makeFullHealthyInput();
  forkMissingRuntime.candidate.isFork = true;
  forkMissingRuntime.candidate.pullChecks = forkMissingRuntime.candidate.pullChecks.filter(
    c => c.name !== 'windows-aspire-runtime'
  );
  assert.equal(
    auditProtectedMainAndCandidateGates(forkMissingRuntime).reason,
    'FORK_PR_RUNTIME_CHECKS_SKIPPED'
  );

  // Fork PR even if checks all claim success (untrusted repo/id)
  const forkForgedGreen = makeFullHealthyInput();
  forkForgedGreen.candidate.headRepository = 'external-fork/SoftwareFactory';
  assert.equal(auditProtectedMainAndCandidateGates(forkForgedGreen).reason, 'FORK_PR_UNTRUSTED');

  const forkIdMismatch = makeFullHealthyInput();
  forkIdMismatch.candidate.headRepositoryId = 42;
  assert.equal(auditProtectedMainAndCandidateGates(forkIdMismatch).reason, 'FORK_PR_UNTRUSTED');

  // Same-repo PR where a runtime check was skipped
  const sameRepoSkippedRuntime = makeFullHealthyInput();
  sameRepoSkippedRuntime.candidate.pullChecks.find(c => c.name === 'windows-aspire-runtime').conclusion = 'skipped';
  assert.equal(auditProtectedMainAndCandidateGates(sameRepoSkippedRuntime).reason, 'RUNTIME_CHECKS_SKIPPED');

  // Candidate pull check head mismatch, untrusted app, wrong event, failure
  const pullHeadMismatch = makeFullHealthyInput();
  pullHeadMismatch.candidate.pullChecks[0].headSha = MAIN_SHA;
  assert.equal(auditProtectedMainAndCandidateGates(pullHeadMismatch).reason, 'CANDIDATE_PULL_HEAD_MISMATCH');

  const pullUntrustedApp = makeFullHealthyInput();
  pullUntrustedApp.candidate.pullChecks[0].appId = 123;
  assert.equal(auditProtectedMainAndCandidateGates(pullUntrustedApp).reason, 'UNTRUSTED_CHECK_APP');

  const pullWrongEvent = makeFullHealthyInput();
  pullWrongEvent.candidate.pullChecks[0].event = 'push';
  assert.equal(auditProtectedMainAndCandidateGates(pullWrongEvent).reason, 'CANDIDATE_PULL_CHECKS_FAILED');

  const pullExtraWrongEvent = makeFullHealthyInput();
  pullExtraWrongEvent.candidate.pullChecks.push({
    name: 'extra-check',
    jobId: 8889,
    appId: GITHUB_ACTIONS_APP_ID,
    headSha: CAND_SHA,
    event: 'push',
    status: 'completed',
    conclusion: 'success'
  });
  assert.equal(auditProtectedMainAndCandidateGates(pullExtraWrongEvent).reason, 'CANDIDATE_PULL_CHECKS_FAILED');

  const pullInProgress = makeFullHealthyInput();
  pullInProgress.candidate.pullChecks[0].status = 'in_progress';
  pullInProgress.candidate.pullChecks[0].conclusion = null;
  assert.equal(auditProtectedMainAndCandidateGates(pullInProgress).reason, 'CANDIDATE_PULL_CHECKS_FAILED');

  // Candidate base mismatch
  const baseMismatch = makeFullHealthyInput();
  baseMismatch.candidate.base = PEER_SHA;
  assert.equal(auditProtectedMainAndCandidateGates(baseMismatch).reason, 'CANDIDATE_BASE_MISMATCH');

  const sameHeadAsMain = makeFullHealthyInput();
  sameHeadAsMain.candidate.head = MAIN_SHA;
  assert.equal(auditProtectedMainAndCandidateGates(sameHeadAsMain).reason, 'CANDIDATE_BASE_MISMATCH');

  // Candidate security failures
  const csHeadMismatch = makeFullHealthyInput();
  csHeadMismatch.candidate.codeScanning.head = MAIN_SHA;
  assert.equal(auditProtectedMainAndCandidateGates(csHeadMismatch).reason, 'CANDIDATE_SECURITY_HEAD_MISMATCH');

  for (const patch of [
    {codeqlStatus: 'in_progress', codeqlConclusion: null},
    {codeqlConclusion: 'failure'},
    {codeQualityStatus: 'queued', codeQualityConclusion: null},
    {codeQualityConclusion: 'failure'},
    {openAlerts: 1}
  ]) {
    const csFail = makeFullHealthyInput();
    csFail.candidate.codeScanning = {...csFail.candidate.codeScanning, ...patch};
    assert.equal(auditProtectedMainAndCandidateGates(csFail).reason, 'CANDIDATE_SECURITY_FAILED');
  }
  const secretFail = makeFullHealthyInput();
  secretFail.candidate.secretScanningClear = false;
  assert.equal(auditProtectedMainAndCandidateGates(secretFail).reason, 'CANDIDATE_SECURITY_FAILED');

  // Summary-only review findings open despite 0 unresolved inline threads
  const summaryOpenCount = makeFullHealthyInput();
  summaryOpenCount.candidate.unresolvedInlineThreads = 0;
  summaryOpenCount.candidate.review.summaryDisposition = 'actionable';
  summaryOpenCount.candidate.review.unresolvedSummaryFindings = 2;
  assert.equal(auditProtectedMainAndCandidateGates(summaryOpenCount).reason, 'SUMMARY_REVIEW_FINDINGS_OPEN');

  const summaryOpenBodyWithClaimedClear = makeFullHealthyInput();
  summaryOpenBodyWithClaimedClear.candidate.unresolvedInlineThreads = 0;
  summaryOpenBodyWithClaimedClear.candidate.review.summaryBody = ACTIONABLE_COPILOT_SUMMARY;
  assert.equal(
    auditProtectedMainAndCandidateGates(summaryOpenBodyWithClaimedClear).reason,
    'SUMMARY_REVIEW_FINDINGS_OPEN'
  );

  const copilotCommentMissingBody = makeFullHealthyInput();
  delete copilotCommentMissingBody.candidate.review.summaryBody;
  assert.equal(
    auditProtectedMainAndCandidateGates(copilotCommentMissingBody).reason,
    'SUMMARY_REVIEW_FINDINGS_OPEN'
  );

  const summaryUncertain = makeFullHealthyInput();
  summaryUncertain.candidate.unresolvedInlineThreads = 0;
  summaryUncertain.candidate.review.summaryDisposition = 'uncertain';
  assert.equal(auditProtectedMainAndCandidateGates(summaryUncertain).reason, 'SUMMARY_REVIEW_FINDINGS_OPEN');

  const unresolvedCountOnly = makeFullHealthyInput();
  unresolvedCountOnly.candidate.unresolvedInlineThreads = 0;
  unresolvedCountOnly.candidate.review.unresolvedSummaryFindings = 1;
  assert.equal(auditProtectedMainAndCandidateGates(unresolvedCountOnly).reason, 'SUMMARY_REVIEW_FINDINGS_OPEN');

  // Other review negative cases
  const inlineOpen = makeFullHealthyInput();
  inlineOpen.candidate.unresolvedInlineThreads = 1;
  assert.equal(auditProtectedMainAndCandidateGates(inlineOpen).reason, 'INLINE_REVIEW_THREADS_UNRESOLVED');

  const staleReview = makeFullHealthyInput();
  staleReview.candidate.review.head = PEER_SHA;
  assert.equal(auditProtectedMainAndCandidateGates(staleReview).reason, 'STALE_REVIEW_HEAD');

  const selfAuthorReview = makeFullHealthyInput();
  selfAuthorReview.candidate.trustedReviewers.push('cyrusjamula');
  selfAuthorReview.candidate.review.reviewer = 'CyrusJamula';
  selfAuthorReview.candidate.review.state = 'APPROVED';
  delete selfAuthorReview.candidate.review.summaryBody;
  assert.equal(auditProtectedMainAndCandidateGates(selfAuthorReview).reason, 'INDEPENDENT_REVIEW_REQUIRED');

  const selfAgentReview = makeFullHealthyInput();
  selfAgentReview.candidate.trustedReviewers.push('copilot-swe-agent[bot]');
  selfAgentReview.candidate.review.reviewer = 'copilot-swe-agent[bot]';
  selfAgentReview.candidate.review.state = 'APPROVED';
  delete selfAgentReview.candidate.review.summaryBody;
  assert.equal(auditProtectedMainAndCandidateGates(selfAgentReview).reason, 'INDEPENDENT_REVIEW_REQUIRED');

  const notIndependentFlag = makeFullHealthyInput();
  notIndependentFlag.candidate.review.independent = false;
  assert.equal(auditProtectedMainAndCandidateGates(notIndependentFlag).reason, 'INDEPENDENT_REVIEW_REQUIRED');

  const untrustedReviewer = makeFullHealthyInput();
  untrustedReviewer.candidate.review.reviewer = 'stranger';
  untrustedReviewer.candidate.review.state = 'APPROVED';
  delete untrustedReviewer.candidate.review.summaryBody;
  assert.equal(auditProtectedMainAndCandidateGates(untrustedReviewer).reason, 'INDEPENDENT_REVIEW_REQUIRED');

  for (const state of ['CHANGES_REQUESTED', 'DISMISSED', 'PENDING']) {
    const blockedState = makeFullHealthyInput();
    blockedState.candidate.review.state = state;
    assert.equal(auditProtectedMainAndCandidateGates(blockedState).reason, 'BLOCKING_OR_INCOMPLETE_REVIEW');
  }
  const blockingCount = makeFullHealthyInput();
  blockingCount.candidate.review.blockingReviewCount = 1;
  assert.equal(auditProtectedMainAndCandidateGates(blockingCount).reason, 'BLOCKING_OR_INCOMPLETE_REVIEW');

  const humanCommentOnly = makeFullHealthyInput();
  humanCommentOnly.candidate.review.reviewer = 'independent-human';
  humanCommentOnly.candidate.review.state = 'COMMENTED';
  assert.equal(auditProtectedMainAndCandidateGates(humanCommentOnly).reason, 'REVIEW_NOT_APPROVED');

  const approvalCountUnmet = makeFullHealthyInput();
  approvalCountUnmet.ruleset.requiredApprovingReviewCount = 1;
  assert.equal(auditProtectedMainAndCandidateGates(approvalCountUnmet).reason, 'REVIEW_APPROVAL_COUNT_UNMET');

  // requiredApprovingReviewCount >= 2 must reject single approval or duplicate reviewer and accept distinct independent approvals
  const twoApprovalsRequiredOneGiven = makeFullHealthyInput();
  twoApprovalsRequiredOneGiven.ruleset.requiredApprovingReviewCount = 2;
  twoApprovalsRequiredOneGiven.candidate.review = {
    reviewId: 910,
    head: CAND_SHA,
    reviewer: 'independent-human',
    author: 'cyrusjamula',
    agent: 'copilot-swe-agent[bot]',
    state: 'APPROVED',
    independent: true,
    summaryDisposition: 'clear',
    unresolvedSummaryFindings: 0,
    blockingReviewCount: 0
  };
  assert.equal(
    auditProtectedMainAndCandidateGates(twoApprovalsRequiredOneGiven).reason,
    'REVIEW_APPROVAL_COUNT_UNMET'
  );

  const duplicateApprover = cloneJson(twoApprovalsRequiredOneGiven);
  duplicateApprover.candidate.additionalReviews = [
    {
      reviewId: 911,
      head: CAND_SHA,
      reviewer: 'Independent-Human',
      state: 'APPROVED',
      independent: true
    }
  ];
  assert.equal(auditProtectedMainAndCandidateGates(duplicateApprover).reason, 'REVIEW_APPROVAL_COUNT_UNMET');

  const twoDistinctApprovals = cloneJson(twoApprovalsRequiredOneGiven);
  twoDistinctApprovals.candidate.trustedReviewers.push('second-independent');
  twoDistinctApprovals.candidate.additionalReviews = [
    {
      reviewId: 912,
      head: CAND_SHA,
      reviewer: 'second-independent',
      state: 'APPROVED',
      independent: true
    }
  ];
  assert.equal(auditProtectedMainAndCandidateGates(twoDistinctApprovals).eligible, true);

  const extraObjectionCancelsApproval = cloneJson(twoDistinctApprovals);
  extraObjectionCancelsApproval.candidate.additionalReviews.push({
    reviewId: 913,
    head: CAND_SHA,
    reviewer: 'second-independent',
    state: 'CHANGES_REQUESTED',
    independent: true
  });
  const objRes = auditProtectedMainAndCandidateGates(extraObjectionCancelsApproval);
  assert.equal(objRes.reason, 'BLOCKING_OR_INCOMPLETE_REVIEW');
  assert.equal(objRes.failureReasons.includes('REVIEW_APPROVAL_COUNT_UNMET'), true);

  const extraDismissed = cloneJson(twoDistinctApprovals);
  extraDismissed.candidate.additionalReviews[0].state = 'DISMISSED';
  assert.equal(auditProtectedMainAndCandidateGates(extraDismissed).reason, 'BLOCKING_OR_INCOMPLETE_REVIEW');

  const extraPending = cloneJson(twoDistinctApprovals);
  extraPending.candidate.additionalReviews[0].state = 'PENDING';
  assert.equal(auditProtectedMainAndCandidateGates(extraPending).reason, 'BLOCKING_OR_INCOMPLETE_REVIEW');

  const extraStale = cloneJson(twoDistinctApprovals);
  extraStale.candidate.additionalReviews[0].head = PEER_SHA;
  assert.equal(auditProtectedMainAndCandidateGates(extraStale).reason, 'STALE_REVIEW_HEAD');

  const extraUntrusted = cloneJson(twoDistinctApprovals);
  extraUntrusted.candidate.additionalReviews[0].reviewer = 'untrusted-person';
  assert.equal(auditProtectedMainAndCandidateGates(extraUntrusted).reason, 'INDEPENDENT_REVIEW_REQUIRED');

  const extraNotIndependent = cloneJson(twoDistinctApprovals);
  extraNotIndependent.candidate.additionalReviews[0].independent = false;
  assert.equal(auditProtectedMainAndCandidateGates(extraNotIndependent).reason, 'INDEPENDENT_REVIEW_REQUIRED');

  const extraCommentOnly = cloneJson(twoDistinctApprovals);
  extraCommentOnly.candidate.additionalReviews[0].state = 'COMMENTED';
  assert.equal(auditProtectedMainAndCandidateGates(extraCommentOnly).reason, 'REVIEW_NOT_APPROVED');

  // Additional configured ruleset status checks must be enforced with exact integrationId across main, pullChecks, and mergeGroup
  const withExtraStatusRule = makeFullHealthyInput();
  withExtraStatusRule.ruleset.requiredStatusChecks.push({
    context: 'mandatory-security-audit',
    integrationId: 77777
  });
  assert.equal(auditProtectedMainAndCandidateGates(withExtraStatusRule).reason, 'MAIN_REQUIRED_JOB_MISSING');

  // A same-named job from Actions (15368) inside an active workflow must NOT satisfy integrationId 77777
  const spoofedSameNameInActiveWf = cloneJson(withExtraStatusRule);
  spoofedSameNameInActiveWf.main.workflowRuns[0].jobs.push({
    name: 'mandatory-security-audit',
    jobId: 2887,
    appId: GITHUB_ACTIONS_APP_ID,
    headSha: MAIN_SHA,
    status: 'completed',
    conclusion: 'success'
  });
  const spoofRes = auditProtectedMainAndCandidateGates(spoofedSameNameInActiveWf);
  assert.equal(spoofRes.mainHealthy, false);
  assert.equal(spoofRes.dependentWorkAllowed, false);
  assert.equal(spoofRes.reason, 'MAIN_REQUIRED_JOB_MISSING');

  withExtraStatusRule.main.workflowRuns.push({
    workflow: 'Mandatory security audit',
    runName: 'Mandatory security audit',
    runId: 288,
    event: 'push',
    headSha: MAIN_SHA,
    status: 'completed',
    conclusion: 'success',
    jobs: [
      {
        name: 'mandatory-security-audit',
        jobId: 2888,
        appId: 77777,
        headSha: MAIN_SHA,
        status: 'completed',
        conclusion: 'success'
      }
    ]
  });
  assert.equal(
    auditProtectedMainAndCandidateGates(withExtraStatusRule).reason,
    'CANDIDATE_PULL_CHECKS_FAILED'
  );

  withExtraStatusRule.candidate.pullChecks.push({
    name: 'mandatory-security-audit',
    jobId: 6888,
    appId: 77777,
    headSha: CAND_SHA,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success'
  });
  assert.equal(
    auditProtectedMainAndCandidateGates(withExtraStatusRule).reason,
    'MERGE_GROUP_CHECKS_FAILED'
  );

  const wrongExtraAppIdMg = cloneJson(withExtraStatusRule);
  wrongExtraAppIdMg.candidate.mergeGroup.checks.push({
    name: 'mandatory-security-audit',
    jobId: 7888,
    appId: GITHUB_ACTIONS_APP_ID,
    headSha: MG_SHA,
    event: 'merge_group',
    status: 'completed',
    conclusion: 'success'
  });
  assert.equal(auditProtectedMainAndCandidateGates(wrongExtraAppIdMg).reason, 'UNTRUSTED_CHECK_APP');

  withExtraStatusRule.candidate.mergeGroup.checks.push({
    name: 'mandatory-security-audit',
    jobId: 7889,
    appId: 77777,
    headSha: MG_SHA,
    event: 'merge_group',
    status: 'completed',
    conclusion: 'success'
  });
  assert.equal(auditProtectedMainAndCandidateGates(withExtraStatusRule).eligible, true);

  // merge_group SHA mismatches, event mismatches, untrusted apps, and check failures
  for (const mutate of [
    mg => { mg.base = PEER_SHA; },
    mg => { mg.head = MAIN_SHA; },
    mg => { mg.head = CAND_SHA; },
    mg => { mg.headRef = 'refs/heads/wrong-queue'; },
    mg => { mg.headRef = 'gh-readonly-queue/main/pr-145-short'; },
    mg => { mg.headRef = `gh-readonly-queue/main/pr-145-${PEER_SHA}`; },
    mg => { mg.memberHeads = [PEER_SHA]; },
    mg => { mg.memberHeads = [MAIN_SHA, CAND_SHA]; },
    mg => { mg.memberHeads = [MG_SHA, CAND_SHA]; },
    mg => { mg.checks[0].headSha = CAND_SHA; }
  ]) {
    const mgBad = makeFullHealthyInput();
    mutate(mgBad.candidate.mergeGroup);
    assert.equal(auditProtectedMainAndCandidateGates(mgBad).reason, 'MERGE_GROUP_SHA_MISMATCH');
  }

  const mgWrongEvent = makeFullHealthyInput();
  mgWrongEvent.candidate.mergeGroup.checks[0].event = 'pull_request';
  assert.equal(auditProtectedMainAndCandidateGates(mgWrongEvent).reason, 'MERGE_GROUP_EVENT_MISMATCH');

  const mgUntrustedApp = makeFullHealthyInput();
  mgUntrustedApp.candidate.mergeGroup.checks[0].appId = 777;
  assert.equal(auditProtectedMainAndCandidateGates(mgUntrustedApp).reason, 'UNTRUSTED_CHECK_APP');

  const mgFailed = makeFullHealthyInput();
  mgFailed.candidate.mergeGroup.checks[2].conclusion = 'failure';
  assert.equal(auditProtectedMainAndCandidateGates(mgFailed).reason, 'MERGE_GROUP_CHECKS_FAILED');

  const mgInProgress = makeFullHealthyInput();
  mgInProgress.candidate.mergeGroup.checks[2].status = 'queued';
  mgInProgress.candidate.mergeGroup.checks[2].conclusion = null;
  assert.equal(auditProtectedMainAndCandidateGates(mgInProgress).reason, 'MERGE_GROUP_CHECKS_FAILED');

  const mgMissingRequired = makeFullHealthyInput();
  mgMissingRequired.candidate.mergeGroup.checks = mgMissingRequired.candidate.mergeGroup.checks.slice(0, 7);
  assert.equal(auditProtectedMainAndCandidateGates(mgMissingRequired).reason, 'MERGE_GROUP_CHECKS_FAILED');
});

test('enforces >=98% line and >=95% branch coverage on every JS and .NET 10 C# component without rounding up', () => {
  // Exact fractional minimumCoverage (98.07% where 98.07 * 10000 === 980700.0000000001 in IEEE-754 float)
  const exactFractionalTarget = makeHealthyMainInput();
  exactFractionalTarget.ruleset.minimumCoverage = 98.07;
  exactFractionalTarget.main.jsCoverage.components[0] = {
    component: 'engineering-factory.core',
    head: MAIN_SHA,
    lines: 9807,
    lineTotal: 10000,
    branches: 95,
    branchTotal: 100
  };
  exactFractionalTarget.main.dotnetCoverage.components[0] = {
    component: 'SoftwareFactory.Agents',
    head: MAIN_SHA,
    lines: 9807,
    lineTotal: 10000,
    branches: 950,
    branchTotal: 1000
  };
  assert.equal(auditProtectedMainAndCandidateGates(exactFractionalTarget).mainHealthy, true);

  const subFractionalJs = cloneJson(exactFractionalTarget);
  subFractionalJs.main.jsCoverage.components[0].lines = 9806;
  assert.equal(auditProtectedMainAndCandidateGates(subFractionalJs).reason, 'JS_COVERAGE_BELOW_TARGET');

  const subFractionalDotnet = cloneJson(exactFractionalTarget);
  subFractionalDotnet.main.dotnetCoverage.components[0].lines = 9806;
  assert.equal(
    auditProtectedMainAndCandidateGates(subFractionalDotnet).reason,
    'DOTNET_COVERAGE_BELOW_TARGET'
  );

  // Exact boundary 97.999% (97999/100000) would round to 98.00% for display, must still fail closed!
  const jsSub98Main = makeHealthyMainInput();
  jsSub98Main.main.jsCoverage.components[0].lines = 97999;
  jsSub98Main.main.jsCoverage.components[0].lineTotal = 100000;
  assert.equal(auditProtectedMainAndCandidateGates(jsSub98Main).reason, 'JS_COVERAGE_BELOW_TARGET');

  const jsSub95Candidate = makeFullHealthyInput();
  jsSub95Candidate.candidate.jsCoverage.components[0].branches = 9499;
  jsSub95Candidate.candidate.jsCoverage.components[0].branchTotal = 10000;
  assert.equal(auditProtectedMainAndCandidateGates(jsSub95Candidate).reason, 'JS_COVERAGE_BELOW_TARGET');

  const dotnetSub98Main = makeHealthyMainInput();
  dotnetSub98Main.main.dotnetCoverage.components[0].lines = 9799;
  dotnetSub98Main.main.dotnetCoverage.components[0].lineTotal = 10000;
  assert.equal(auditProtectedMainAndCandidateGates(dotnetSub98Main).reason, 'DOTNET_COVERAGE_BELOW_TARGET');

  const dotnetSub95Candidate = makeFullHealthyInput();
  dotnetSub95Candidate.candidate.dotnetCoverage.components[0].branches = 9499;
  dotnetSub95Candidate.candidate.dotnetCoverage.components[0].branchTotal = 10000;
  assert.equal(auditProtectedMainAndCandidateGates(dotnetSub95Candidate).reason, 'DOTNET_COVERAGE_BELOW_TARGET');

  // Branchless JS component justification (including 0 total branches and reviewer trust checks)
  const branchlessOk = makeFullHealthyInput();
  branchlessOk.candidate.jsCoverage = {
    head: CAND_SHA,
    expectedComponents: ['engineering-factory.constants'],
    components: [
      {
        component: 'engineering-factory.constants',
        head: CAND_SHA,
        lines: 50,
        lineTotal: 50,
        branches: 0,
        branchTotal: 0
      }
    ],
    branchless: [
      {
        component: 'engineering-factory.constants',
        head: CAND_SHA,
        reviewedBy: 'independent-human',
        reason: 'pure frozen constant schema module'
      }
    ]
  };
  const branchlessRes = auditProtectedMainAndCandidateGates(branchlessOk);
  assert.equal(branchlessRes.eligible, true);
  assert.equal(branchlessRes.coverageSummary.candidateJs.branches, 0);
  assert.equal(branchlessRes.coverageSummary.candidateJs.branchTotal, 0);
  assert.equal(branchlessRes.coverageSummary.candidateJs.branchPct, null);
  assert.equal(branchlessRes.coverageSummary.candidateJs.branchPercent, 'N/A');

  const branchlessUntrusted = cloneJson(branchlessOk);
  branchlessUntrusted.candidate.jsCoverage.branchless[0].reviewedBy = 'outside-reviewer';
  assert.equal(
    auditProtectedMainAndCandidateGates(branchlessUntrusted).reason,
    'CANDIDATE_JS_COVERAGE_INVALID'
  );

  const branchlessSelfAuthor = cloneJson(branchlessOk);
  branchlessSelfAuthor.candidate.trustedReviewers.push('cyrusjamula');
  branchlessSelfAuthor.candidate.jsCoverage.branchless[0].reviewedBy = 'CyrusJamula';
  assert.equal(
    auditProtectedMainAndCandidateGates(branchlessSelfAuthor).reason,
    'CANDIDATE_JS_COVERAGE_INVALID'
  );

  // Malformed / mismatched JS and C# coverage records
  const badMainJsHead = makeHealthyMainInput();
  badMainJsHead.main.jsCoverage.head = CAND_SHA;
  assert.equal(auditProtectedMainAndCandidateGates(badMainJsHead).reason, 'MAIN_JS_COVERAGE_INVALID');

  const badMainJsShape = makeHealthyMainInput();
  badMainJsShape.main.jsCoverage = {head: 'bad', expectedComponents: [], components: []};
  assert.equal(auditProtectedMainAndCandidateGates(badMainJsShape).reason, 'MAIN_JS_COVERAGE_INVALID');

  const sparseExpectedComponents = makeHealthyMainInput();
  sparseExpectedComponents.main.jsCoverage.expectedComponents = new Array(2);
  assert.equal(
    auditProtectedMainAndCandidateGates(sparseExpectedComponents).reason,
    'MAIN_JS_COVERAGE_INVALID'
  );

  const sparseJsComponents = makeHealthyMainInput();
  sparseJsComponents.main.jsCoverage.components = new Array(2);
  assert.equal(auditProtectedMainAndCandidateGates(sparseJsComponents).reason, 'MAIN_JS_COVERAGE_INVALID');

  const badMainJsInventory = makeHealthyMainInput();
  badMainJsInventory.main.jsCoverage.expectedComponents = ['engineering-factory.core'];
  assert.equal(auditProtectedMainAndCandidateGates(badMainJsInventory).reason, 'MAIN_JS_COVERAGE_INVALID');

  const nonEnumJsCount = makeHealthyMainInput();
  Object.defineProperty(nonEnumJsCount.main.jsCoverage.components[0], 'lines', {
    value: 100,
    enumerable: false
  });
  assert.equal(auditProtectedMainAndCandidateGates(nonEnumJsCount).reason, 'MAIN_JS_COVERAGE_INVALID');

  const badBranchlessArray = cloneJson(branchlessOk);
  badBranchlessArray.candidate.jsCoverage.branchless = 'not-array';
  assert.equal(
    auditProtectedMainAndCandidateGates(badBranchlessArray).reason,
    'CANDIDATE_JS_COVERAGE_INVALID'
  );

  const nonEnumBranchlessEntry = cloneJson(branchlessOk);
  Object.defineProperty(nonEnumBranchlessEntry.candidate.jsCoverage.branchless[0], 'reason', {
    value: 'pure frozen constant schema module',
    enumerable: false
  });
  assert.equal(
    auditProtectedMainAndCandidateGates(nonEnumBranchlessEntry).reason,
    'CANDIDATE_JS_COVERAGE_INVALID'
  );

  for (const mutate of [
    d => { d.head = CAND_SHA; },
    d => { d.sdkVersion = '9.0.100'; },
    d => { d.expectedComponents = []; d.components = []; },
    d => { d.expectedComponents = ['Bad..Path']; },
    d => { d.expectedComponents = ['Bad/./Path']; },
    d => { d.expectedComponents = ['Bad//Path']; },
    d => { d.expectedComponents = ['Dup', 'Dup']; d.components = [d.components[0], d.components[0]]; },
    d => { d.components[0].component = 'Unknown.Assembly'; },
    d => { d.expectedComponents = ['A', 'B']; d.components = [{...d.components[0], component: 'A'}, {...d.components[0], component: 'A'}]; },
    d => { d.components[0].head = CAND_SHA; },
    d => { d.components[0].lines = 2000; },
    d => { d.components[0].branchTotal = 0; }
  ]) {
    const badDotnet = makeHealthyMainInput();
    mutate(badDotnet.main.dotnetCoverage);
    assert.equal(auditProtectedMainAndCandidateGates(badDotnet).reason, 'MAIN_DOTNET_COVERAGE_INVALID');
  }

  const badCandDotnet = makeFullHealthyInput();
  badCandDotnet.candidate.dotnetCoverage = null;
  assert.equal(auditProtectedMainAndCandidateGates(badCandDotnet).reason, 'CANDIDATE_DOTNET_COVERAGE_INVALID');

  // Unrounded coverage drop checks against protected main (maxCoverageDrop: 0)
  const jsLineDrop = makeFullHealthyInput();
  jsLineDrop.candidate.jsCoverage.components[0].lines = 198;
  assert.equal(auditProtectedMainAndCandidateGates(jsLineDrop).reason, 'JS_COVERAGE_REGRESSION');

  const jsBranchDrop = makeFullHealthyInput();
  jsBranchDrop.candidate.jsCoverage.components[0].branches = 192;
  assert.equal(auditProtectedMainAndCandidateGates(jsBranchDrop).reason, 'JS_COVERAGE_REGRESSION');

  const dotnetLineDrop = makeFullHealthyInput();
  dotnetLineDrop.candidate.dotnetCoverage.components[0].lines = 1736;
  assert.equal(auditProtectedMainAndCandidateGates(dotnetLineDrop).reason, 'DOTNET_COVERAGE_REGRESSION');

  const dotnetBranchDrop = makeFullHealthyInput();
  dotnetBranchDrop.candidate.dotnetCoverage.components[0].branches = 785;
  assert.equal(auditProtectedMainAndCandidateGates(dotnetBranchDrop).reason, 'DOTNET_COVERAGE_REGRESSION');

  const unverifiedMainBaseCov = makeFullHealthyInput();
  unverifiedMainBaseCov.main.jsCoverage.head = PEER_SHA;
  unverifiedMainBaseCov.main.dotnetCoverage.head = PEER_SHA;
  const unverifiedRes = auditProtectedMainAndCandidateGates(unverifiedMainBaseCov);
  assert.equal(unverifiedRes.candidateHealthy, false);
  assert.equal(unverifiedRes.failureReasons.includes('MAIN_BASE_COVERAGE_UNVERIFIED'), true);
});

test('enforces ruleset completeness, scope matching, and strict types.isProxy / plain-object own-data-descriptor validation without invoking traps or getters', () => {
  // Scope mismatches
  assert.equal(
    auditProtectedMainAndCandidateGates({...makeHealthyMainInput(), repository: 'other/repo'}).reason,
    'SCOPE_MISMATCH'
  );
  assert.equal(
    auditProtectedMainAndCandidateGates({...makeHealthyMainInput(), repositoryId: 1}).reason,
    'SCOPE_MISMATCH'
  );
  assert.equal(
    auditProtectedMainAndCandidateGates({...makeHealthyMainInput(), branch: 'develop'}).reason,
    'SCOPE_MISMATCH'
  );

  // Incomplete rulesets
  for (const patch of [
    {minimumCoverage: 97},
    {minimumCoverage: 101},
    {minimumCoverage: Number.NaN},
    {maxCoverageDrop: 1},
    {strictRequiredStatusChecks: false},
    {requiredReviewThreadResolution: false},
    {secretScanningRequired: false},
    {bypassActorsCount: 1},
    {requiredApprovingReviewCount: -1},
    {requiredApprovingReviewCount: 0, copilotCodeReviewOnPush: false},
    {allowedMergeMethods: ['merge']},
    {allowedMergeMethods: ['squash', 'merge']},
    {mergeQueueMergeMethod: 'MERGE'},
    {mergeQueueGrouping: 'SOLO'},
    {requiredStatusChecks: [{context: 'build-test', integrationId: GITHUB_ACTIONS_APP_ID}]},
    {
      requiredStatusChecks: [
        ...REQUIRED_STATUS_CHECK_CONTEXTS.map(context => ({
          context,
          integrationId: GITHUB_ACTIONS_APP_ID
        })),
        {context: 'linux-aspire-runtime', integrationId: 99999}
      ]
    },
    {
      requiredStatusChecks: [
        ...REQUIRED_STATUS_CHECK_CONTEXTS.map(context => ({
          context,
          integrationId: GITHUB_ACTIONS_APP_ID
        })),
        {context: 'CodeQL', integrationId: 99999}
      ]
    },
    {codeScanningTools: []},
    {
      codeScanningTools: [
        {
          tool: 'CodeQL',
          securityAlertsThreshold: 'medium_or_higher',
          alertsThreshold: 'errors_and_warnings'
        },
        {
          tool: 'DependencyGraph',
          securityAlertsThreshold: 'high_or_higher',
          alertsThreshold: 'errors'
        }
      ]
    },
    {
      codeScanningTools: [
        {
          tool: 'OtherScanner',
          securityAlertsThreshold: 'medium_or_higher',
          alertsThreshold: 'errors_and_warnings'
        }
      ]
    },
    {
      codeScanningTools: [
        {
          tool: 'CodeQL',
          securityAlertsThreshold: 'high_or_higher',
          alertsThreshold: 'errors_and_warnings'
        }
      ]
    },
    {
      codeScanningTools: [
        {
          tool: 'CodeQL',
          securityAlertsThreshold: 'medium_or_higher',
          alertsThreshold: 'errors'
        }
      ]
    }
  ]) {
    const weakRules = makeHealthyMainInput();
    weakRules.ruleset = {...weakRules.ruleset, ...patch};
    const res = auditProtectedMainAndCandidateGates(weakRules);
    assert.equal(res.valid, false);
    assert.equal(res.mainHealthy, false);
    assert.equal(res.reason, 'RULESET_INCOMPLETE');
  }

  // Stricter ruleset floors remain active even when another ruleset rule is incomplete
  const strictFloorWithIncompleteRuleset = makeFullHealthyInput();
  strictFloorWithIncompleteRuleset.ruleset.minimumCoverage = 99.95;
  strictFloorWithIncompleteRuleset.ruleset.requiredApprovingReviewCount = 2;
  strictFloorWithIncompleteRuleset.ruleset.codeScanningTools = [];
  const strictFloorRes = auditProtectedMainAndCandidateGates(strictFloorWithIncompleteRuleset);
  assert.equal(strictFloorRes.valid, false);
  assert.equal(strictFloorRes.failureReasons.includes('DOTNET_COVERAGE_BELOW_TARGET'), true);
  assert.equal(strictFloorRes.failureReasons.includes('REVIEW_APPROVAL_COUNT_UNMET'), true);
  assert.equal(strictFloorRes.failureReasons.includes('RULESET_INCOMPLETE'), true);

  // Structural invalid inputs across top-level, ruleset, main, and candidate
  for (const bad of [
    null,
    undefined,
    [],
    'string',
    {...makeHealthyMainInput(), repository: 'bad..slug/x'},
    {...makeHealthyMainInput(), repository: './repo'},
    {...makeHealthyMainInput(), repository: 'owner/.'},
    {...makeHealthyMainInput(), repositoryId: 0},
    {...makeHealthyMainInput(), branch: ''},
    {...makeHealthyMainInput(), extra: 1},
    {...makeHealthyMainInput(), [Symbol('extra')]: 1},
    {...makeHealthyMainInput(), ruleset: null},
    {...makeHealthyMainInput(), ruleset: {...makeHealthyMainInput().ruleset, requiredStatusChecks: [null]}},
    {
      ...makeHealthyMainInput(),
      ruleset: {
        ...makeHealthyMainInput().ruleset,
        requiredStatusChecks: [
          {context: 'build-test', integrationId: 15368},
          {context: 'build-test', integrationId: 15368}
        ]
      }
    },
    {...makeHealthyMainInput(), ruleset: {...makeHealthyMainInput().ruleset, allowedMergeMethods: ['']}},
    {...makeHealthyMainInput(), ruleset: {...makeHealthyMainInput().ruleset, codeScanningTools: 'bad'}},
    {...makeHealthyMainInput(), ruleset: {...makeHealthyMainInput().ruleset, codeScanningTools: [null]}},
    {
      ...makeHealthyMainInput(),
      ruleset: {
        ...makeHealthyMainInput().ruleset,
        codeScanningTools: [
          {tool: 'CodeQL', securityAlertsThreshold: 'medium_or_higher', alertsThreshold: 'errors_and_warnings'},
          {tool: 'CodeQL', securityAlertsThreshold: 'medium_or_higher', alertsThreshold: 'errors_and_warnings'}
        ]
      }
    },
    {...makeHealthyMainInput(), main: null},
    {...makeHealthyMainInput(), main: {...makeHealthyMainInput().main, workflowRuns: []}},
    (() => {
      const m = makeHealthyMainInput();
      m.main.workflowRuns[0].defaultOff = true;
      return m;
    })(),
    (() => {
      const m = makeHealthyMainInput();
      m.main.workflowRuns[6].defaultOff = 'yes';
      return m;
    })(),
    (() => {
      const m = makeHealthyMainInput();
      m.main.workflowRuns.push({...cloneJson(m.main.workflowRuns[1]), runId: 999});
      return m;
    })(),
    (() => {
      const m = makeHealthyMainInput();
      m.main.workflowRuns[1].jobs.push({...m.main.workflowRuns[1].jobs[0], jobId: 9999});
      return m;
    })(),
    (() => {
      const m = makeHealthyMainInput();
      m.main.workflowRuns[0].status = 'unknown_status';
      return m;
    })(),
    {...makeHealthyMainInput(), candidate: null},
    (() => {
      const c = makeFullHealthyInput();
      c.candidate.trustedReviewers = ['reviewer-a', 'Reviewer-A'];
      return c;
    })(),
    (() => {
      const c = makeFullHealthyInput();
      c.candidate.trustedReviewers = [' invalid'];
      return c;
    })(),
    (() => {
      const c = makeFullHealthyInput();
      c.candidate.pullChecks = [null];
      return c;
    })(),
    (() => {
      const c = makeFullHealthyInput();
      c.candidate.codeScanning = null;
      return c;
    })(),
    (() => {
      const c = makeFullHealthyInput();
      c.candidate.review = {...c.candidate.review, summaryBody: 123};
      return c;
    })(),
    (() => {
      const c = makeFullHealthyInput();
      c.candidate.review = {...c.candidate.review, summaryBody: 'bad\u0000null'};
      return c;
    })(),
    (() => {
      const c = makeFullHealthyInput();
      c.candidate.review = {...c.candidate.review, summaryBody: 'x'.repeat(65537)};
      return c;
    })(),
    (() => {
      const c = makeFullHealthyInput();
      c.candidate.review = null;
      return c;
    })(),
    (() => {
      const c = makeFullHealthyInput();
      c.candidate.mergeGroup = null;
      return c;
    })(),
    (() => {
      const c = makeFullHealthyInput();
      c.candidate.mergeGroup.memberHeads = [CAND_SHA, CAND_SHA];
      return c;
    })(),
    (() => {
      const c = makeFullHealthyInput();
      c.candidate.mergeGroup.checks = new Array(2);
      return c;
    })(),
    (() => {
      const c = makeFullHealthyInput();
      c.candidate.additionalReviews = 'bad';
      return c;
    })(),
    (() => {
      const c = makeFullHealthyInput();
      c.candidate.additionalReviews = [
        {
          reviewId: c.candidate.review.reviewId,
          head: CAND_SHA,
          reviewer: 'independent-human',
          state: 'APPROVED',
          independent: true
        }
      ];
      return c;
    })()
  ]) {
    assert.equal(auditProtectedMainAndCandidateGates(bad).reason, 'INVALID_INPUT');
  }

  // Zero proxy traps or getter invocations, including revoked proxies, sparse/custom arrays, and Object.prototype pollution
  let traps = 0;
  const boom = () => {
    traps++;
    throw new Error('unexpected proxy trap or getter invocation');
  };
  const proxyHandler = {
    get: boom,
    has: boom,
    ownKeys: boom,
    getOwnPropertyDescriptor: boom,
    getPrototypeOf: boom
  };

  assert.equal(
    auditProtectedMainAndCandidateGates(new Proxy(makeHealthyMainInput(), proxyHandler)).reason,
    'INVALID_INPUT'
  );
  const revoked = Proxy.revocable(makeHealthyMainInput(), proxyHandler);
  revoked.revoke();
  assert.equal(auditProtectedMainAndCandidateGates(revoked.proxy).reason, 'INVALID_INPUT');

  const withProxyRuns = makeHealthyMainInput();
  withProxyRuns.main.workflowRuns = new Proxy(withProxyRuns.main.workflowRuns, proxyHandler);
  assert.equal(auditProtectedMainAndCandidateGates(withProxyRuns).reason, 'INVALID_INPUT');

  const withGetterField = makeHealthyMainInput();
  Object.defineProperty(withGetterField.main, 'protected', {get: boom, enumerable: true});
  assert.equal(auditProtectedMainAndCandidateGates(withGetterField).reason, 'INVALID_INPUT');

  const nonEnumField = makeHealthyMainInput();
  Object.defineProperty(nonEnumField, 'branch', {value: 'main', enumerable: false});
  assert.equal(auditProtectedMainAndCandidateGates(nonEnumField).reason, 'INVALID_INPUT');

  const withGetterArrayElement = makeHealthyMainInput();
  Object.defineProperty(withGetterArrayElement.main.workflowRuns, 0, {get: boom, enumerable: true});
  assert.equal(auditProtectedMainAndCandidateGates(withGetterArrayElement).reason, 'INVALID_INPUT');

  const customProtoArray = makeHealthyMainInput();
  Object.setPrototypeOf(customProtoArray.main.workflowRuns, Object.create(Array.prototype));
  assert.equal(auditProtectedMainAndCandidateGates(customProtoArray).reason, 'INVALID_INPUT');

  const oversizedArray = makeHealthyMainInput();
  oversizedArray.main.workflowRuns = Array.from({length: 65}, (_, idx) => ({
    ...makeHealthyMainInput().main.workflowRuns[0],
    runId: 9000 + idx
  }));
  assert.equal(auditProtectedMainAndCandidateGates(oversizedArray).reason, 'INVALID_INPUT');

  try {
    Object.defineProperty(Object.prototype, 'candidate', {
      get: boom,
      configurable: true
    });
    assert.equal(auditProtectedMainAndCandidateGates(makeHealthyMainInput()).reason, 'INVALID_INPUT');
  } finally {
    delete Object.prototype.candidate;
  }

  assert.equal(traps, 0);
});
