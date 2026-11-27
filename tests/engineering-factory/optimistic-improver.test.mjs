import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildAiCreditAndAutonomyScorecard} from '../../tools/engineering-factory/ai-credit-scorecard.mjs';
import {
  GOVERNED_CONTRACT_DOMAINS,
  MIN_COHORT_ACCEPTED_OUTCOMES,
  PROPOSAL_SCOPES,
  REQUIRED_GATE_PIPELINE,
  proposeOptimisticImprovements,
  verifyCohortImprovementOrRollback
} from '../../tools/engineering-factory/optimistic-improver.mjs';

const SF_REPO_ID = 1471342715;
const FAMILYTREE_REPO_ID = 3333333333;

function buildSampleScorecard() {
  return buildAiCreditAndAutonomyScorecard({
    repositoryId: SF_REPO_ID,
    authorizedRepositoryIds: [SF_REPO_ID, FAMILYTREE_REPO_ID],
    cohort: 'm02-kaizen',
    sourceKind: 'verified-autonomous',
    fromMs: 1_000,
    toMs: 20_000,
    observedMs: 22_000,
    nowMs: 25_000,
    maxAgeMs: 10_000,
    records: [
      {
        id: 'act-1',
        issueNumber: 18,
        repositoryId: SF_REPO_ID,
        cohort: 'm02-kaizen',
        sourceKind: 'verified-autonomous',
        observedMs: 5_000,
        accepted: true,
        accounting: {
          status: 'verified',
          aiCredits: 80,
          incrementalBilledUsdCents: 0,
          cloudSandboxMinutes: 8,
          actionsRunnerMinutes: 5
        },
        ghAwQueueLatencyMs: 150_000,
        maf: {supersteps: 10, checkpointResumes: 1, innerRepairIterations: 3},
        audit: {fullProvenance: false, killSwitchTripped: false, violations: []}
      }
    ]
  });
}

function buildKnowledgeLanes() {
  return [
    {
      laneId: 'sf-velocity-lane',
      repositoryId: SF_REPO_ID,
      scope: 'factory-velocity',
      ownedPaths: ['tools/engineering-factory/stage-latency.mjs']
    },
    {
      laneId: 'sf-knowledge-lane',
      repositoryId: SF_REPO_ID,
      scope: 'knowledge-map',
      ownedPaths: ['tools/engineering-factory/ONBOARDING.txt']
    },
    {
      laneId: 'sf-governance-lane',
      repositoryId: SF_REPO_ID,
      scope: 'factory-velocity',
      contractDomain: 'workflow',
      ownedPaths: ['.github/workflows/ci.yml']
    },
    {
      laneId: 'sf-budget-lane',
      repositoryId: SF_REPO_ID,
      scope: 'factory-velocity',
      ownedPaths: ['tools/engineering-factory/budget.mjs']
    },
    {
      laneId: 'ft-product-lane',
      repositoryId: FAMILYTREE_REPO_ID,
      scope: 'enrolled-product',
      ownedPaths: ['src/tree/pedigree.ts', 'tests/tree/pedigree.test.ts']
    }
  ];
}

function buildBaselineCohort(overrides = {}) {
  return {
    repositoryId: SF_REPO_ID,
    cohortId: 'm02-small-comparable',
    sourceKind: 'verified-autonomous',
    complete: true,
    windowStartMs: 100_000,
    windowEndMs: 200_000,
    acceptedOutcomes: 6,
    coveredLines: 990,
    totalLines: 1000,
    coveredBranches: 485,
    totalBranches: 500,
    securityFindings: 0,
    mainFailures: 0,
    routineHumanInterventions: 0,
    reworkRateBps: 1400,
    aiCreditsTotal: 180,
    incrementalBilledUsdCents: 0,
    medianCycleTimeMs: 480_000,
    ...overrides
  };
}

function buildCandidateCohort(overrides = {}) {
  return buildBaselineCohort({
    windowStartMs: 200_000,
    windowEndMs: 300_000,
    ...overrides
  });
}

test('proposeOptimisticImprovements generates isolated non-overlapping proposals across SoftwareFactory and enrolled products with human-approval gating', () => {
  assert.deepEqual(REQUIRED_GATE_PIPELINE, [
    'ci-98-95',
    'codeql',
    'independent-review',
    'squash-merge-queue'
  ]);
  assert.deepEqual(PROPOSAL_SCOPES, ['factory-velocity', 'knowledge-map', 'enrolled-product']);
  assert.equal(GOVERNED_CONTRACT_DOMAINS.includes('budget'), true);
  assert.equal(MIN_COHORT_ACCEPTED_OUTCOMES, 5);

  const scorecard = buildSampleScorecard();
  const result = proposeOptimisticImprovements({
    scorecard,
    knowledgeLanes: buildKnowledgeLanes(),
    failureTaxonomy: [
      {
        id: 'noise-singleton',
        repositoryId: FAMILYTREE_REPO_ID,
        laneId: 'ft-product-lane',
        failureClass: 'minor-lint',
        occurrences: 1,
        baselineRateBps: 500,
        targetRateBps: 100,
        targetPaths: ['src/tree/pedigree.ts']
      },
      {
        id: 'workflow-lock-drift',
        repositoryId: SF_REPO_ID,
        laneId: 'sf-governance-lane',
        failureClass: 'workflow-lock',
        occurrences: 4,
        baselineRateBps: 1200,
        targetRateBps: 0,
        targetPaths: ['.github/workflows/ci.yml']
      },
      {
        id: 'overlapping-velocity-failure',
        repositoryId: SF_REPO_ID,
        laneId: 'sf-velocity-lane',
        failureClass: 'queue-stall',
        occurrences: 3,
        baselineRateBps: 900,
        targetRateBps: 200,
        targetPaths: ['tools/engineering-factory/stage-latency.mjs']
      }
    ],
    feedbackItems: [
      {
        id: 'ft-ux-latency',
        repositoryId: FAMILYTREE_REPO_ID,
        laneId: 'ft-product-lane',
        source: 'product',
        metricName: 'pedigreeRenderP95Ms',
        baselineValue: 220,
        targetValue: 90,
        targetPaths: ['src/tree/pedigree.ts']
      },
      {
        id: 'sf-budget-guard',
        repositoryId: SF_REPO_ID,
        laneId: 'sf-budget-lane',
        source: 'operator',
        metricName: 'admissionCheckCoveragePct',
        baselineValue: 95,
        targetValue: 100,
        targetPaths: ['tools/engineering-factory/budget.mjs']
      }
    ],
    maxProposals: 4
  });

  assert.equal(result.valid, true);
  assert.equal(result.shadow, true);
  assert.equal(result.directMainMutation, false);
  assert.equal(result.autoPolicyMutation, false);
  assert.deepEqual(result.gatePipelineRequired, REQUIRED_GATE_PIPELINE);
  assert.equal(result.proposals.length, 4);

  // Check scopes span factory-velocity, knowledge-map, and enrolled-product (or budget cap deferred if >4)
  for (const p of result.proposals) {
    assert.equal(p.directMainMutation, false);
    assert.equal(p.autoPolicyMutation, false);
    assert.deepEqual(p.gatePipelineRequired, REQUIRED_GATE_PIPELINE);
    assert.equal(p.targetHypothesis.minComparableOutcomes, 5);
  }

  // Budget and workflow proposals require human approval; standard lanes do not
  const budgetProposal = result.proposals.find(p => p.laneId === 'sf-budget-lane');
  assert.equal(budgetProposal.requiresHumanApproval, true);
  assert.equal(budgetProposal.targetHypothesis.expectedDirection, 'increase');

  const workflowProposal = result.proposals.find(p => p.laneId === 'sf-governance-lane');
  assert.equal(workflowProposal.requiresHumanApproval, true);

  const standardVelocity = result.proposals.find(p => p.laneId === 'sf-velocity-lane');
  assert.equal(standardVelocity.requiresHumanApproval, false);
  assert.equal(standardVelocity.targetHypothesis.expectedDirection, 'increase'); // provenanceCompletenessPct 0 -> 100

  // Overlapping proposals on sf-velocity-lane and sf-knowledge-lane were deferred, plus maxProposals cap
  assert.equal(
    result.deferredByOverlap.some(d => d.reason === 'NON_OVERLAPPING_LANE_CONFLICT'),
    true
  );
  assert.equal(
    result.deferredByOverlap.some(d => d.reason === 'PROPOSAL_BUDGET_REACHED'),
    true
  );

  // Without maxProposals cap, enrolled-product proposal is included cleanly with requiresHumanApproval: false
  const uncapped = proposeOptimisticImprovements({
    scorecard,
    knowledgeLanes: buildKnowledgeLanes(),
    failureTaxonomy: [],
    feedbackItems: [
      {
        id: 'ft-ux-latency',
        repositoryId: FAMILYTREE_REPO_ID,
        laneId: 'ft-product-lane',
        source: 'product',
        metricName: 'pedigreeRenderP95Ms',
        baselineValue: 220,
        targetValue: 90,
        targetPaths: ['src/tree/pedigree.ts']
      }
    ]
  });
  const enrolled = uncapped.proposals.find(p => p.scope === 'enrolled-product');
  assert.ok(enrolled);
  assert.equal(enrolled.requiresHumanApproval, false);
  assert.equal(enrolled.targetHypothesis.expectedDirection, 'decrease');

  // Directory-level lane containing governed/protected descendants (e.g. tools/engineering-factory) requires human approval
  const broadDirectoryProposal = proposeOptimisticImprovements({
    scorecard,
    knowledgeLanes: [
      {
        laneId: 'broad-factory-dir',
        repositoryId: SF_REPO_ID,
        scope: 'factory-velocity',
        ownedPaths: ['tools/engineering-factory']
      }
    ],
    failureTaxonomy: [],
    feedbackItems: []
  });
  assert.equal(broadDirectoryProposal.valid, true);
  assert.equal(broadDirectoryProposal.proposals[0].requiresHumanApproval, true);

  // Proposal targeting security-named path also sets requiresHumanApproval: true
  const secPathProposal = proposeOptimisticImprovements({
    scorecard: {...scorecard, bottlenecks: []},
    knowledgeLanes: [
      {
        laneId: 'consumer-sec',
        repositoryId: FAMILYTREE_REPO_ID,
        scope: 'enrolled-product',
        ownedPaths: ['src/security/auth.ts']
      }
    ],
    failureTaxonomy: [],
    feedbackItems: [
      {
        id: 'sec-tighten',
        repositoryId: FAMILYTREE_REPO_ID,
        laneId: 'consumer-sec',
        source: 'operator',
        metricName: 'authCheckMs',
        baselineValue: 50,
        targetValue: 25,
        targetPaths: ['src/security/auth.ts']
      }
    ]
  });
  assert.equal(secPathProposal.proposals[0].requiresHumanApproval, true);
});

test('proposeOptimisticImprovements rejects historical-proxy scorecards, out-of-lane targets, proxies, and malformed inputs', () => {
  const validScorecard = buildSampleScorecard();
  const lanes = buildKnowledgeLanes();

  assert.equal(proposeOptimisticImprovements(null).reason, 'INVALID_IMPROVEMENT_INPUT');
  assert.equal(
    proposeOptimisticImprovements(new Proxy({
      scorecard: validScorecard,
      failureTaxonomy: [],
      feedbackItems: [],
      knowledgeLanes: lanes
    }, {})).reason,
    'INVALID_IMPROVEMENT_INPUT'
  );
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validScorecard,
      failureTaxonomy: [],
      feedbackItems: [],
      knowledgeLanes: lanes,
      maxProposals: 0
    }).reason,
    'INVALID_IMPROVEMENT_INPUT'
  );

  // Historical-proxy scorecard cannot drive autonomous improvement proposals
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: {valid: true, sourceKind: 'historical-proxy', repositoryId: SF_REPO_ID, bottlenecks: []},
      failureTaxonomy: [],
      feedbackItems: [],
      knowledgeLanes: lanes
    }).reason,
    'UNVERIFIED_SCORECARD_SOURCE'
  );
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: {},
      failureTaxonomy: [],
      feedbackItems: [],
      knowledgeLanes: lanes
    }).reason,
    'INVALID_SCORECARD'
  );
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: {valid: true, sourceKind: 'verified-autonomous', repositoryId: 0, bottlenecks: []},
      failureTaxonomy: [],
      feedbackItems: [],
      knowledgeLanes: lanes
    }).reason,
    'INVALID_SCORECARD'
  );
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: {valid: true, sourceKind: 'verified-autonomous', repositoryId: SF_REPO_ID, bottlenecks: [{}]},
      failureTaxonomy: [],
      feedbackItems: [],
      knowledgeLanes: lanes
    }).reason,
    'INVALID_SCORECARD_BOTTLENECK'
  );

  // Tie-breaking by proposalId and cross-lane parent/child path overlap detection
  const overlapCheck = proposeOptimisticImprovements({
    scorecard: {...validScorecard, bottlenecks: []},
    failureTaxonomy: [],
    feedbackItems: [
      {
        id: 'b-item',
        repositoryId: FAMILYTREE_REPO_ID,
        laneId: 'parent-lane',
        source: 'product',
        metricName: 'm1',
        baselineValue: 20,
        targetValue: 10,
        targetPaths: ['src/tree']
      },
      {
        id: 'a-item',
        repositoryId: FAMILYTREE_REPO_ID,
        laneId: 'child-lane',
        source: 'product',
        metricName: 'm2',
        baselineValue: 20,
        targetValue: 10,
        targetPaths: ['src/tree/pedigree.ts']
      }
    ],
    knowledgeLanes: [
      {laneId: 'parent-lane', repositoryId: FAMILYTREE_REPO_ID, scope: 'enrolled-product', ownedPaths: ['src/tree']},
      {laneId: 'child-lane', repositoryId: FAMILYTREE_REPO_ID, scope: 'enrolled-product', ownedPaths: ['src/tree/pedigree.ts']}
    ]
  });
  assert.equal(overlapCheck.proposals.length, 1);
  assert.equal(overlapCheck.proposals[0].proposalId, `feedback:${FAMILYTREE_REPO_ID}:a-item`);
  assert.equal(overlapCheck.deferredByOverlap[0].proposalId, `feedback:${FAMILYTREE_REPO_ID}:b-item`);
  assert.equal(overlapCheck.deferredByOverlap[0].reason, 'NON_OVERLAPPING_LANE_CONFLICT');

  // Invalid / duplicate knowledge lanes
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validScorecard,
      failureTaxonomy: [],
      feedbackItems: [],
      knowledgeLanes: [{laneId: 'bad', repositoryId: SF_REPO_ID, scope: 'factory-velocity', ownedPaths: ['../bad']}]
    }).reason,
    'INVALID_KNOWLEDGE_LANE'
  );
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validScorecard,
      failureTaxonomy: [],
      feedbackItems: [],
      knowledgeLanes: [{...lanes[0], contractDomain: 'bogus'}]
    }).reason,
    'INVALID_KNOWLEDGE_LANE'
  );
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validScorecard,
      failureTaxonomy: [],
      feedbackItems: [],
      knowledgeLanes: [lanes[0], lanes[0]]
    }).reason,
    'DUPLICATE_KNOWLEDGE_LANE'
  );

  // Failure taxonomy validation: invalid item, duplicate, unknown lane, out-of-lane target
  const validFailure = {
    id: 'f-1',
    repositoryId: SF_REPO_ID,
    laneId: 'sf-velocity-lane',
    failureClass: 'ci-timeout',
    occurrences: 2,
    baselineRateBps: 500,
    targetRateBps: 100,
    targetPaths: ['tools/engineering-factory/stage-latency.mjs']
  };
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validScorecard,
      failureTaxonomy: [{...validFailure, targetRateBps: 600}],
      feedbackItems: [],
      knowledgeLanes: lanes
    }).reason,
    'INVALID_FAILURE_TAXONOMY_ITEM'
  );
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validScorecard,
      failureTaxonomy: [validFailure, validFailure],
      feedbackItems: [],
      knowledgeLanes: lanes
    }).reason,
    'DUPLICATE_FAILURE_ITEM'
  );
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validScorecard,
      failureTaxonomy: [{...validFailure, laneId: 'missing-lane'}],
      feedbackItems: [],
      knowledgeLanes: lanes
    }).reason,
    'UNKNOWN_PROPOSAL_LANE'
  );
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validScorecard,
      failureTaxonomy: [{...validFailure, targetPaths: ['tools/engineering-factory/unowned.mjs']}],
      feedbackItems: [],
      knowledgeLanes: lanes
    }).reason,
    'OUT_OF_LANE_PROPOSAL_TARGET'
  );

  // Feedback validation: invalid item, duplicate, unknown lane, out-of-lane target, missing matching lane for bottleneck
  const validFeedback = {
    id: 'fb-1',
    repositoryId: FAMILYTREE_REPO_ID,
    laneId: 'ft-product-lane',
    source: 'operator',
    metricName: 'renderMs',
    baselineValue: 100,
    targetValue: 50,
    targetPaths: ['src/tree/pedigree.ts'],
    touchesContract: true
  };
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validScorecard,
      failureTaxonomy: [],
      feedbackItems: [{...validFeedback, targetValue: 100}],
      knowledgeLanes: lanes
    }).reason,
    'INVALID_FEEDBACK_ITEM'
  );
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validScorecard,
      failureTaxonomy: [],
      feedbackItems: [validFeedback, validFeedback],
      knowledgeLanes: lanes
    }).reason,
    'DUPLICATE_FEEDBACK_ITEM'
  );
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validScorecard,
      failureTaxonomy: [],
      feedbackItems: [{...validFeedback, laneId: 'missing'}],
      knowledgeLanes: lanes
    }).reason,
    'UNKNOWN_PROPOSAL_LANE'
  );
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validScorecard,
      failureTaxonomy: [],
      feedbackItems: [{...validFeedback, targetPaths: ['src/other.ts']}],
      knowledgeLanes: lanes
    }).reason,
    'OUT_OF_LANE_PROPOSAL_TARGET'
  );

  // Bottleneck with no matching repo lane is safely skipped while feedback with touchesContract sets requiresHumanApproval
  const consumerOnlyLanes = [lanes[4]];
  const fbRes = proposeOptimisticImprovements({
    scorecard: validScorecard,
    failureTaxonomy: [],
    feedbackItems: [validFeedback],
    knowledgeLanes: consumerOnlyLanes
  });
  assert.equal(fbRes.valid, true);
  assert.equal(fbRes.proposals.length, 1);
  assert.equal(fbRes.proposals[0].requiresHumanApproval, true);
});

test('verifyCohortImprovementOrRollback enforces >=5 comparable outcomes and triggers deterministic rollback on any regression', () => {
  const before = buildBaselineCohort();

  // < 5 outcomes in beforeCohort or afterCohort -> INSUFFICIENT_COHORT, cohortComplete: false
  const shortBefore = verifyCohortImprovementOrRollback({
    beforeCohort: buildBaselineCohort({acceptedOutcomes: 4}),
    afterCohort: buildCandidateCohort({acceptedOutcomes: 6, medianCycleTimeMs: 300_000})
  });
  assert.equal(shortBefore.status, 'INSUFFICIENT_COHORT');
  assert.equal(shortBefore.cohortComplete, false);
  assert.equal(shortBefore.verifiedImprovement, false);
  assert.equal(shortBefore.rollbackRequired, false);

  const shortAfter = verifyCohortImprovementOrRollback({
    beforeCohort: before,
    afterCohort: buildCandidateCohort({acceptedOutcomes: 3, medianCycleTimeMs: 300_000})
  });
  assert.equal(shortAfter.status, 'INSUFFICIENT_COHORT');
  assert.equal(shortAfter.cohortComplete, false);

  // Verified improvement when >= 5 outcomes and cycle time / rework / AI credits improve without regressions
  const improved = verifyCohortImprovementOrRollback({
    beforeCohort: before,
    afterCohort: buildCandidateCohort({
      acceptedOutcomes: 6,
      medianCycleTimeMs: 320_000,
      reworkRateBps: 900,
      aiCreditsTotal: 150
    })
  });
  assert.equal(improved.status, 'VERIFIED_IMPROVEMENT');
  assert.equal(improved.cohortComplete, true);
  assert.equal(improved.verifiedImprovement, true);
  assert.equal(improved.rollbackRequired, false);
  assert.deepEqual(improved.rollbackReasons, []);

  // Improvement by AI credits alone when cycle time and rework are flat
  const creditOnlyImproved = verifyCohortImprovementOrRollback({
    beforeCohort: before,
    afterCohort: buildCandidateCohort({aiCreditsTotal: 150})
  });
  assert.equal(creditOnlyImproved.status, 'VERIFIED_IMPROVEMENT');

  // Improvement by rework alone when cycle time is flat
  const reworkOnlyImproved = verifyCohortImprovementOrRollback({
    beforeCohort: before,
    afterCohort: buildCandidateCohort({reworkRateBps: 1000})
  });
  assert.equal(reworkOnlyImproved.status, 'VERIFIED_IMPROVEMENT');

  // Neutral / identical cohorts -> NO_MATERIAL_GAIN (no premature claim, no rollback)
  const neutral = verifyCohortImprovementOrRollback({
    beforeCohort: before,
    afterCohort: buildCandidateCohort()
  });
  assert.equal(neutral.status, 'NO_MATERIAL_GAIN');
  assert.equal(neutral.verifiedImprovement, false);
  assert.equal(neutral.rollbackRequired, false);

  // Deterministic rollback checks across floor violations, relative coverage regressions (e.g. 99% -> 98.5%), and safety/cost/rework
  const rollbackCases = [
    {
      after: buildCandidateCohort({coveredLines: 970}), // 97% < 98% SoftwareFactory floor
      reason: 'COVERAGE_BELOW_THRESHOLD'
    },
    {
      after: buildCandidateCohort({coveredBranches: 470}), // 94% < 95% SoftwareFactory floor
      reason: 'COVERAGE_BELOW_THRESHOLD'
    },
    {
      after: buildCandidateCohort({coveredLines: 985, medianCycleTimeMs: 300_000}), // 98.5% >= 98% floor, but regressed from 99.0%!
      reason: 'COVERAGE_REGRESSED'
    },
    {
      after: buildCandidateCohort({coveredBranches: 480, medianCycleTimeMs: 300_000}), // 96.0% >= 95% floor, but regressed from 97.0%!
      reason: 'COVERAGE_REGRESSED'
    },
    {
      after: buildCandidateCohort({securityFindings: 1}),
      reason: 'SECURITY_FINDINGS_DETECTED'
    },
    {
      after: buildCandidateCohort({mainFailures: 1}),
      reason: 'MAIN_HEALTH_FAILURE'
    },
    {
      after: buildCandidateCohort({routineHumanInterventions: 1}),
      reason: 'HUMAN_INTERVENTION_REGRESSED'
    },
    {
      after: buildCandidateCohort({reworkRateBps: 1650}),
      policy: {maxReworkRegressionBps: 200},
      reason: 'REWORK_RATE_REGRESSED'
    },
    {
      after: buildCandidateCohort({aiCreditsTotal: 210}),
      reason: 'AI_CREDIT_COST_REGRESSION'
    },
    {
      after: buildCandidateCohort({incrementalBilledUsdCents: 1}),
      reason: 'AI_CREDIT_COST_REGRESSION'
    }
  ];

  for (const rc of rollbackCases) {
    const res = verifyCohortImprovementOrRollback({
      beforeCohort: before,
      afterCohort: rc.after,
      ...(rc.policy ? {policy: rc.policy} : {})
    });
    assert.equal(res.status, 'ROLLBACK_REQUIRED');
    assert.equal(res.rollbackRequired, true);
    assert.equal(res.verifiedImprovement, false);
    assert.equal(res.rollbackReasons.includes(rc.reason), true);
  }

  // Stricter consumer policy (e.g. Spellbook 97% line / 92% branch) preserved and enforced without regression
  const consumerPass = verifyCohortImprovementOrRollback({
    beforeCohort: buildBaselineCohort({repositoryId: FAMILYTREE_REPO_ID, coveredLines: 975, coveredBranches: 465}),
    afterCohort: buildCandidateCohort({
      repositoryId: FAMILYTREE_REPO_ID,
      coveredLines: 980,
      coveredBranches: 468,
      medianCycleTimeMs: 400_000
    }),
    policy: {profile: 'consumer', minLinePercent: 97, minBranchPercent: 92}
  });
  assert.equal(consumerPass.status, 'VERIFIED_IMPROVEMENT');

  const consumerDrop = verifyCohortImprovementOrRollback({
    beforeCohort: buildBaselineCohort({repositoryId: FAMILYTREE_REPO_ID, coveredLines: 975, coveredBranches: 465}),
    afterCohort: buildCandidateCohort({repositoryId: FAMILYTREE_REPO_ID, coveredLines: 965, coveredBranches: 465}),
    policy: {profile: 'consumer', minLinePercent: 97, minBranchPercent: 92}
  });
  assert.equal(consumerDrop.status, 'ROLLBACK_REQUIRED');
  assert.deepEqual(consumerDrop.rollbackReasons, ['COVERAGE_BELOW_THRESHOLD', 'COVERAGE_REGRESSED']);

  // Consumer default floors (95/90) when minLinePercent / minBranchPercent omitted and coverage does not regress
  const consumerDefaults = verifyCohortImprovementOrRollback({
    beforeCohort: buildBaselineCohort({repositoryId: FAMILYTREE_REPO_ID, coveredLines: 955, coveredBranches: 455}),
    afterCohort: buildCandidateCohort({
      repositoryId: FAMILYTREE_REPO_ID,
      coveredLines: 960,
      coveredBranches: 460,
      medianCycleTimeMs: 420_000
    }),
    policy: {profile: 'consumer'}
  });
  assert.equal(consumerDefaults.status, 'VERIFIED_IMPROVEMENT');

  // Invalid inputs, proxies, mismatched repos/cohorts, overlapping/unequal windows, incomplete or weakened SF policy fail closed
  const candidate = buildCandidateCohort();
  for (const invalid of [
    null,
    new Proxy({beforeCohort: before, afterCohort: candidate}, {}),
    {beforeCohort: before, afterCohort: {...candidate, repositoryId: FAMILYTREE_REPO_ID}},
    {beforeCohort: before, afterCohort: {...candidate, cohortId: 'different-cohort'}},
    {beforeCohort: before, afterCohort: {...candidate, sourceKind: 'historical-proxy'}},
    {beforeCohort: before, afterCohort: {...candidate, complete: false}},
    {beforeCohort: before, afterCohort: {...candidate, windowStartMs: 150_000, windowEndMs: 250_000}}, // overlapping window
    {beforeCohort: before, afterCohort: {...candidate, windowStartMs: 200_000, windowEndMs: 350_000}}, // unequal duration
    {beforeCohort: buildBaselineCohort({coveredLines: 960}), afterCohort: candidate}, // baseline below threshold
    {beforeCohort: before, afterCohort: candidate, policy: null},
    {beforeCohort: before, afterCohort: candidate, policy: {profile: 'invalid'}},
    {beforeCohort: before, afterCohort: candidate, policy: {profile: 'consumer', minLinePercent: 97, minBranchPercent: 92}}, // SF repo cannot use consumer profile
    {beforeCohort: before, afterCohort: candidate, policy: {minLinePercent: 90}}
  ]) {
    const res = verifyCohortImprovementOrRollback(invalid);
    assert.equal(res.valid, false);
    assert.equal(res.status, 'INVALID_COHORT_EVIDENCE');
  }

  // Non-enumerable and sparse/proxy inner checks
  const nonEnumCohort = {...before};
  Object.defineProperty(nonEnumCohort, 'acceptedOutcomes', {value: 6, enumerable: false});
  assert.equal(
    verifyCohortImprovementOrRollback({beforeCohort: nonEnumCohort, afterCohort: before}).status,
    'INVALID_COHORT_EVIDENCE'
  );

  const validSc = buildSampleScorecard();
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validSc,
      failureTaxonomy: new Proxy([], {}),
      feedbackItems: [],
      knowledgeLanes: buildKnowledgeLanes()
    }).valid,
    false
  );
  const sparseFeedback = new Array(1);
  assert.equal(
    proposeOptimisticImprovements({
      scorecard: validSc,
      failureTaxonomy: [],
      feedbackItems: sparseFeedback,
      knowledgeLanes: buildKnowledgeLanes()
    }).valid,
    false
  );
});
