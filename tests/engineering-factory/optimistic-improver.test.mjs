import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildAiCreditAndAutonomyScorecard} from '../../tools/engineering-factory/ai-credit-scorecard.mjs';
import {
  GOVERNED_CONTRACT_DOMAINS,
  KAIZEN_EVIDENCE_MODES,
  KNOWN_ROLLBACK_REASONS,
  MIN_COHORT_ACCEPTED_OUTCOMES,
  PROPOSAL_SCOPES,
  REQUIRED_GATE_PIPELINE,
  buildAutomaticRevertCandidateSpec,
  evaluateKaizenCohortReadout,
  proposeOptimisticImprovements,
  queryCausalAuditTrail,
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

  // Proposal targeting security-named path or optimistic-improver.mjs itself also sets requiresHumanApproval: true
  const improverSelfProposal = proposeOptimisticImprovements({
    scorecard: {...scorecard, bottlenecks: []},
    knowledgeLanes: [
      {
        laneId: 'sf-improver-self',
        repositoryId: SF_REPO_ID,
        scope: 'factory-velocity',
        ownedPaths: ['tools/engineering-factory/optimistic-improver.mjs']
      }
    ],
    failureTaxonomy: [],
    feedbackItems: [
      {
        id: 'improver-tune',
        repositoryId: SF_REPO_ID,
        laneId: 'sf-improver-self',
        source: 'operator',
        metricName: 'proposalEvalMs',
        baselineValue: 20,
        targetValue: 10,
        targetPaths: ['tools/engineering-factory/optimistic-improver.mjs']
      }
    ]
  });
  assert.equal(improverSelfProposal.proposals[0].requiresHumanApproval, true);

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
      after: buildCandidateCohort({reworkRateBps: 12_000}), // >100% repair-iterations-per-superstep triggers rollback, not INVALID_COHORT_EVIDENCE
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

  // Absolute human-intervention increase (1/5 -> 2/10, equal 0.2 rate) AND per-outcome rate increase (2/10 -> 2/5, equal count) both trigger rollback
  const absInterventionIncrease = verifyCohortImprovementOrRollback({
    beforeCohort: buildBaselineCohort({acceptedOutcomes: 5, routineHumanInterventions: 1}),
    afterCohort: buildCandidateCohort({acceptedOutcomes: 10, routineHumanInterventions: 2, medianCycleTimeMs: 300_000})
  });
  assert.equal(absInterventionIncrease.status, 'ROLLBACK_REQUIRED');
  assert.equal(absInterventionIncrease.rollbackRequired, true);
  assert.equal(absInterventionIncrease.rollbackReasons.includes('HUMAN_INTERVENTION_REGRESSED'), true);

  const rateInterventionIncrease = verifyCohortImprovementOrRollback({
    beforeCohort: buildBaselineCohort({acceptedOutcomes: 10, routineHumanInterventions: 2}),
    afterCohort: buildCandidateCohort({acceptedOutcomes: 5, routineHumanInterventions: 2, medianCycleTimeMs: 300_000})
  });
  assert.equal(rateInterventionIncrease.status, 'ROLLBACK_REQUIRED');
  assert.equal(rateInterventionIncrease.rollbackRequired, true);
  assert.equal(rateInterventionIncrease.rollbackReasons.includes('HUMAN_INTERVENTION_REGRESSED'), true);

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

function spanHex(index) {
  return index.toString(16).padStart(16, '0');
}

function buildAuditChain({
  traceSeed = 'a',
  commitSeed = '1',
  squashSeed = '2',
  deliveryId = 'delivery-100',
  repositoryId = SF_REPO_ID,
  startedAtMs = 1_000,
  completedAtMs = 1_900,
  consumerPolicy = false,
  extra = {}
} = {}) {
  const traceId = traceSeed.repeat(32).slice(0, 32);
  const commitSha = commitSeed.repeat(40).slice(0, 40);
  const squashCommitSha = squashSeed.repeat(40).slice(0, 40);
  const lockSha256 = 'f'.repeat(64);
  const isConsumer = repositoryId !== SF_REPO_ID || consumerPolicy;

  return {
    stages: {
      eventDelivery: {
        traceparent: `00-${traceId}-${spanHex(1)}-01`,
        parentSpanId: null,
        deliveryId,
        repositoryId,
        observedMs: startedAtMs
      },
      ghAwLock: {
        traceparent: `00-${traceId}-${spanHex(2)}-01`,
        parentSpanId: spanHex(1),
        lockSha256,
        observedMs: startedAtMs + 10
      },
      casLease: {
        traceparent: `00-${traceId}-${spanHex(3)}-01`,
        parentSpanId: spanHex(2),
        leaseGeneration: 2,
        laneId: isConsumer ? 'ft-product-lane' : 'sf-velocity-lane',
        ownedPaths: isConsumer
          ? ['src/tree/pedigree.ts']
          : ['tools/engineering-factory/stage-latency.mjs'],
        observedMs: startedAtMs + 20
      },
      missionControlTask: {
        traceparent: `00-${traceId}-${spanHex(4)}-01`,
        parentSpanId: spanHex(3),
        taskId: '550e8400-e29b-41d4-a716-446655440000',
        sessionId: 'mc-session-137',
        observedMs: startedAtMs + 30
      },
      candidateCommit: {
        traceparent: `00-${traceId}-${spanHex(5)}-01`,
        parentSpanId: spanHex(4),
        commitSha,
        signed: true,
        touchedPaths: isConsumer
          ? ['src/tree/pedigree.ts']
          : ['tools/engineering-factory/stage-latency.mjs'],
        observedMs: startedAtMs + 40
      },
      exactHeadValidation: {
        traceparent: `00-${traceId}-${spanHex(6)}-01`,
        parentSpanId: spanHex(5),
        headSha: commitSha,
        ciReceiptId: 'ci-rcpt-137',
        codeqlReceiptId: 'codeql-rcpt-137',
        coverageReceiptId: 'cov-rcpt-137',
        expectedComponents: [isConsumer ? 'consumer.pedigree' : 'engineering-factory.stage-latency'],
        coverageReports: [
          {
            component: isConsumer ? 'consumer.pedigree' : 'engineering-factory.stage-latency',
            head: commitSha,
            lines: isConsumer ? 97 : 99,
            lineTotal: 100,
            branches: isConsumer ? 92 : 96,
            branchTotal: 100
          }
        ],
        lines: isConsumer ? 97 : 99,
        lineTotal: 100,
        branches: isConsumer ? 92 : 96,
        branchTotal: 100,
        observedMs: startedAtMs + 50
      },
      independentReview: {
        traceparent: `00-${traceId}-${spanHex(7)}-01`,
        parentSpanId: spanHex(6),
        reviewId: 'review-137',
        reviewedHeadSha: commitSha,
        reviewerIdentity: isConsumer ? 'senior-maintainer' : 'copilot-pull-request-reviewer[bot]',
        authorIdentity: 'cyrusjamula',
        implementationAgentIdentity: 'copilot-swe-agent[bot]',
        authorizedReviewers: ['copilot-pull-request-reviewer[bot]', 'senior-maintainer'],
        reviewState: isConsumer ? 'APPROVED' : 'COMMENTED',
        reviewHistoryComplete: true,
        outstandingChangesRequested: 0,
        unresolvedThreads: 0,
        summaryFindingsResolved: true,
        observedMs: startedAtMs + 60
      },
      mergeQueueSquash: {
        traceparent: `00-${traceId}-${spanHex(8)}-01`,
        parentSpanId: spanHex(7),
        expectedHeadSha: commitSha,
        squashCommitSha,
        observedMs: startedAtMs + 70
      },
      verifiedMain: {
        traceparent: `00-${traceId}-${spanHex(9)}-01`,
        parentSpanId: spanHex(8),
        mainCommitSha: squashCommitSha,
        mainHealthy: true,
        receiptId: 'main-rcpt-137',
        observedMs: completedAtMs
      }
    },
    ...(isConsumer
      ? {coveragePolicy: {profile: 'consumer', minLinePercent: 97, minBranchPercent: 92}}
      : {}),
    ...extra
  };
}

function buildSampleCircuitBreaker(repositoryId = SF_REPO_ID, overrides = {}) {
  return {
    repositoryId,
    ownedPaths: ['tools/engineering-factory/stage-latency.mjs'],
    touchedPaths: ['tools/engineering-factory/stage-latency.mjs'],
    attempt: 1,
    maxRetries: 2,
    runAiCredits: 10,
    maxRunAiCredits: 50,
    burnRateBps: 500,
    maxBurnSpikeBps: 2500,
    incrementalBilledUsdCents: 0,
    safeOutputsThreatDetected: false,
    accountingVerified: true,
    ...overrides
  };
}

test('queryCausalAuditTrail enforces repository isolation, deterministic ordering, 9-link lineage verification, and all filter keys', () => {
  const sfChainLate = buildAuditChain({
    traceSeed: 'c',
    commitSeed: '5',
    squashSeed: '6',
    deliveryId: 'delivery-batch-1',
    startedAtMs: 2_000,
    completedAtMs: 3_000,
    extra: {
      issueNumber: 137,
      pullNumber: 142,
      violations: ['AI_CREDIT_ANOMALY'],
      circuitBreaker: buildSampleCircuitBreaker(SF_REPO_ID, {runAiCredits: 75})
    }
  });
  const sfChainEarlyB = buildAuditChain({
    traceSeed: 'b',
    commitSeed: '3',
    squashSeed: '4',
    deliveryId: 'delivery-batch-1',
    startedAtMs: 1_000,
    completedAtMs: 2_000,
    extra: {
      issueNumber: 137,
      pullNumber: 141
    }
  });
  const sfChainEarlyTieStart = buildAuditChain({
    traceSeed: 'a',
    commitSeed: '7',
    squashSeed: '8',
    deliveryId: 'delivery-solo',
    startedAtMs: 1_000,
    completedAtMs: 2_000,
    extra: {
      circuitBreaker: buildSampleCircuitBreaker(SF_REPO_ID, {attempt: 4, maxRetries: 2})
    }
  });
  const sfChainLaterStartSameComplete = buildAuditChain({
    traceSeed: 'd',
    commitSeed: '9',
    squashSeed: 'a',
    deliveryId: 'delivery-solo-2',
    startedAtMs: 1_100,
    completedAtMs: 2_000
  });
  // Consumer repository shares issueNumber: 137 and pullNumber: 141 — must remain strictly isolated!
  const ftChain = buildAuditChain({
    traceSeed: 'e',
    commitSeed: 'b',
    squashSeed: 'c',
    deliveryId: 'delivery-batch-1',
    repositoryId: FAMILYTREE_REPO_ID,
    startedAtMs: 1_200,
    completedAtMs: 1_800,
    extra: {
      issueNumber: 137,
      pullNumber: 141,
      violations: ['AI_CREDIT_ANOMALY']
    }
  });

  const index = [sfChainLate, ftChain, sfChainLaterStartSameComplete, sfChainEarlyB, sfChainEarlyTieStart];

  // Repository-wide query isolates SF_REPO_ID and sorts deterministically by completedAtMs, startedAtMs, traceId
  const allSf = queryCausalAuditTrail(index, {repositoryId: SF_REPO_ID});
  assert.equal(allSf.valid, true);
  assert.equal(allSf.shadow, true);
  assert.equal(allSf.liveMutation, false);
  assert.equal(allSf.readOnly, true);
  assert.equal(allSf.repositoryId, SF_REPO_ID);
  assert.equal(allSf.totalRepositoryChains, 4);
  assert.equal(allSf.isolatedOutCount, 1);
  assert.equal(allSf.matchCount, 4);
  assert.deepEqual(
    allSf.records.map(r => r.traceId),
    ['a'.repeat(32), 'b'.repeat(32), 'd'.repeat(32), 'c'.repeat(32)]
  );
  for (const rec of allSf.records) {
    assert.equal(rec.repositoryId, SF_REPO_ID);
    assert.equal(rec.lineageVerified, true);
    assert.equal(rec.verifiedStageCount, 9);
    assert.equal(rec.provenanceCode, 'PROVENANCE_CHAIN_VERIFIED');
    assert.equal(Object.isFrozen(rec), true);
    assert.equal(Object.isFrozen(rec.ownedPaths), true);
    assert.equal(Object.isFrozen(rec.touchedPaths), true);
    if (rec.violations !== null) {
      assert.equal(Object.isFrozen(rec.violations), true);
    }
  }

  // Consumer repo query isolates FAMILYTREE_REPO_ID only (and forked/shared commitSha or JSON-safe semantic errors in other repos cannot DoS consumer query)
  const sfForkSharingCommit = buildAuditChain({
    traceSeed: '9',
    commitSeed: 'b',
    squashSeed: 'd',
    repositoryId: SF_REPO_ID,
    extra: {
      issueNumber: 0,
      violations: ['UNKNOWN_FOREIGN_CODE']
    }
  });
  const allFt = queryCausalAuditTrail([...index, sfForkSharingCommit], {repositoryId: FAMILYTREE_REPO_ID});
  assert.equal(allFt.valid, true);
  assert.equal(allFt.totalRepositoryChains, 1);
  assert.equal(allFt.isolatedOutCount, 5);
  assert.equal(allFt.matchCount, 1);
  assert.equal(allFt.records[0].repositoryId, FAMILYTREE_REPO_ID);
  assert.equal(allFt.records[0].pullNumber, 141);

  // Individual lookups across every supported filter field
  const byTrace = queryCausalAuditTrail(index, {
    repositoryId: SF_REPO_ID,
    traceId: 'b'.repeat(32)
  });
  assert.equal(byTrace.matchCount, 1);
  assert.equal(byTrace.records[0].pullNumber, 141);

  const byDelivery = queryCausalAuditTrail(index, {
    repositoryId: SF_REPO_ID,
    deliveryId: 'delivery-batch-1'
  });
  assert.equal(byDelivery.matchCount, 2);
  assert.deepEqual(byDelivery.records.map(r => r.pullNumber), [141, 142]);

  const byIssue = queryCausalAuditTrail(index, {
    repositoryId: SF_REPO_ID,
    issueNumber: 137
  });
  assert.equal(byIssue.matchCount, 2);

  const byPull = queryCausalAuditTrail(index, {
    repositoryId: SF_REPO_ID,
    pullNumber: 142
  });
  assert.equal(byPull.matchCount, 1);
  assert.equal(byPull.records[0].commitSha, '5'.repeat(40));

  const byCommit = queryCausalAuditTrail(index, {
    repositoryId: SF_REPO_ID,
    commitSha: '7'.repeat(40)
  });
  assert.equal(byCommit.matchCount, 1);
  assert.deepEqual(byCommit.records[0].violations, ['RETRY_CAP_EXCEEDED']);
  assert.equal(byCommit.records[0].killSwitchTripped, true);

  // Missing breaker/violations evidence stays null (unknown), while explicit empty violations: [] reports false
  const bySquash = queryCausalAuditTrail(index, {
    repositoryId: SF_REPO_ID,
    squashCommitSha: 'a'.repeat(40)
  });
  assert.equal(bySquash.matchCount, 1);
  assert.equal(bySquash.records[0].violations, null);
  assert.equal(bySquash.records[0].killSwitchTripped, null);

  const cleanConfirmed = buildAuditChain({
    traceSeed: '8',
    commitSeed: 'd',
    squashSeed: 'e',
    extra: {
      violations: [],
      circuitBreaker: buildSampleCircuitBreaker(SF_REPO_ID, {
        authorIdentity: 'cyrusjamula',
        implementationAgentIdentity: 'copilot-swe-agent[bot]',
        reviewerIdentity: 'copilot-pull-request-reviewer[bot]',
        mainHealthy: true
      })
    }
  });
  const cleanRes = queryCausalAuditTrail([cleanConfirmed], {repositoryId: SF_REPO_ID});
  assert.equal(cleanRes.valid, true);
  assert.deepEqual(cleanRes.records[0].violations, []);
  assert.equal(cleanRes.records[0].killSwitchTripped, false);

  const byViolation = queryCausalAuditTrail(index, {
    repositoryId: SF_REPO_ID,
    violationCode: 'AI_CREDIT_ANOMALY'
  });
  assert.equal(byViolation.matchCount, 1);
  assert.equal(byViolation.records[0].pullNumber, 142);

  // Combined multi-key filter and clean empty match
  const combinedMatch = queryCausalAuditTrail(index, {
    repositoryId: SF_REPO_ID,
    traceId: 'c'.repeat(32),
    deliveryId: 'delivery-batch-1',
    issueNumber: 137,
    pullNumber: 142,
    commitSha: '5'.repeat(40),
    squashCommitSha: '6'.repeat(40),
    violationCode: 'AI_CREDIT_ANOMALY'
  });
  assert.equal(combinedMatch.matchCount, 1);

  const noMatch = queryCausalAuditTrail(index, {
    repositoryId: SF_REPO_ID,
    issueNumber: 999
  });
  assert.equal(noMatch.valid, true);
  assert.equal(noMatch.matchCount, 0);
  assert.deepEqual(noMatch.records, []);
});

test('queryCausalAuditTrail fails closed on missing repositoryId, proxies, incomplete/broken chains, duplicates, and inconsistent circuit-breaker evidence', () => {
  const validChain = buildAuditChain();

  // Missing repositoryId & invalid filter envelopes (including explicit null/undefined filter values!)
  assert.equal(queryCausalAuditTrail([validChain], {}).reason, 'MISSING_REPOSITORY_ID');
  for (const badFilter of [
    null,
    new Proxy({repositoryId: SF_REPO_ID}, {}),
    {repositoryId: 0},
    {repositoryId: SF_REPO_ID, unknownKey: 1},
    {repositoryId: SF_REPO_ID, traceId: null},
    {repositoryId: SF_REPO_ID, traceId: undefined},
    {repositoryId: SF_REPO_ID, traceId: '0'.repeat(32)},
    {repositoryId: SF_REPO_ID, deliveryId: null},
    {repositoryId: SF_REPO_ID, deliveryId: 'bad delivery!'},
    {repositoryId: SF_REPO_ID, issueNumber: null},
    {repositoryId: SF_REPO_ID, issueNumber: 0},
    {repositoryId: SF_REPO_ID, pullNumber: null},
    {repositoryId: SF_REPO_ID, pullNumber: -1},
    {repositoryId: SF_REPO_ID, commitSha: null},
    {repositoryId: SF_REPO_ID, commitSha: 'short'},
    {repositoryId: SF_REPO_ID, squashCommitSha: null},
    {repositoryId: SF_REPO_ID, squashCommitSha: 'Z'.repeat(40)},
    {repositoryId: SF_REPO_ID, violationCode: null},
    {repositoryId: SF_REPO_ID, violationCode: 'UNKNOWN_VIOLATION'}
  ]) {
    const res = queryCausalAuditTrail([validChain], badFilter);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'INVALID_AUDIT_FILTER');
  }

  // Non-enumerable or getter property on filter fails closed
  const getterFilter = {repositoryId: SF_REPO_ID};
  Object.defineProperty(getterFilter, 'issueNumber', {get: () => 137, enumerable: true});
  assert.equal(queryCausalAuditTrail([validChain], getterFilter).reason, 'INVALID_AUDIT_FILTER');

  // Invalid chains array or entry envelopes (including nested proxy inside an isolated-out repository!)
  for (const badChains of [
    null,
    new Proxy([validChain], {}),
    new Array(1)
  ]) {
    assert.equal(queryCausalAuditTrail(badChains, {repositoryId: SF_REPO_ID}).reason, 'INVALID_AUDIT_CHAINS');
  }

  const otherRepoNestedProxy = buildAuditChain({repositoryId: FAMILYTREE_REPO_ID});
  otherRepoNestedProxy.stages.casLease.ownedPaths = new Proxy(['src/tree/pedigree.ts'], {});
  const otherRepoCallableProxy = buildAuditChain({repositoryId: FAMILYTREE_REPO_ID});
  otherRepoCallableProxy.stages.callableHook = new Proxy(() => 42, {});
  const otherRepoNonFinite = buildAuditChain({repositoryId: FAMILYTREE_REPO_ID});
  otherRepoNonFinite.stages.badNumber = Number.NaN;
  const otherRepoSymbolVal = buildAuditChain({repositoryId: FAMILYTREE_REPO_ID});
  otherRepoSymbolVal.stages.badPrimitive = Symbol('secret');
  const otherRepoTooManyKeys = buildAuditChain({repositoryId: FAMILYTREE_REPO_ID});
  otherRepoTooManyKeys.stages.wideObject = Object.fromEntries(
    Array.from({length: 130}, (_, idx) => [`k${idx}`, idx])
  );
  const otherRepoDiamondDag = buildAuditChain({repositoryId: FAMILYTREE_REPO_ID});
  let dagNode = {leaf: 1};
  for (let i = 0; i < 12; i++) {
    dagNode = {a: dagNode, b: dagNode};
  }
  otherRepoDiamondDag.stages.dag = dagNode;
  const otherRepoDeepNest = buildAuditChain({repositoryId: FAMILYTREE_REPO_ID});
  let deepCursor = {};
  const deepRoot = deepCursor;
  for (let i = 0; i < 14; i++) {
    deepCursor.next = {};
    deepCursor = deepCursor.next;
  }
  otherRepoDeepNest.stages.extraNested = deepRoot;

  for (const badEntry of [
    null,
    new Proxy(validChain, {}),
    {stages: null},
    {stages: {eventDelivery: {repositoryId: 0}}},
    {...validChain, extraKey: true},
    {...validChain, issueNumber: null},
    {...validChain, issueNumber: 0},
    {...validChain, pullNumber: null},
    {...validChain, pullNumber: 0},
    {...validChain, violations: null},
    {...validChain, violations: ['BOGUS']},
    {...validChain, violations: ['AI_CREDIT_ANOMALY', 'AI_CREDIT_ANOMALY']},
    {...validChain, violations: new Proxy(['AI_CREDIT_ANOMALY'], {})},
    {...validChain, circuitBreaker: {}},
    {...validChain, circuitBreaker: buildSampleCircuitBreaker(SF_REPO_ID, {touchedPaths: ['../escape.mjs']})},
    otherRepoNestedProxy,
    otherRepoCallableProxy,
    otherRepoNonFinite,
    otherRepoSymbolVal,
    otherRepoTooManyKeys,
    otherRepoDiamondDag,
    otherRepoDeepNest
  ]) {
    assert.equal(
      queryCausalAuditTrail([badEntry], {repositoryId: SF_REPO_ID}).reason,
      'INVALID_AUDIT_CHAIN_ENTRY'
    );
  }

  // Circuit-breaker lineage mismatches (repo, ownedPaths, touchedPaths, author, agent, reviewer, mainHealthy) fail closed
  for (const badCb of [
    buildSampleCircuitBreaker(FAMILYTREE_REPO_ID),
    buildSampleCircuitBreaker(SF_REPO_ID, {ownedPaths: ['docs/other.md'], touchedPaths: ['docs/other.md']}),
    buildSampleCircuitBreaker(SF_REPO_ID, {
      ownedPaths: ['tools/engineering-factory/stage-latency.mjs'],
      touchedPaths: []
    }),
    buildSampleCircuitBreaker(SF_REPO_ID, {
      authorIdentity: 'someone-else',
      reviewerIdentity: 'copilot-pull-request-reviewer[bot]'
    }),
    buildSampleCircuitBreaker(SF_REPO_ID, {
      authorIdentity: 'cyrusjamula',
      implementationAgentIdentity: 'other-agent[bot]',
      reviewerIdentity: 'copilot-pull-request-reviewer[bot]'
    }),
    buildSampleCircuitBreaker(SF_REPO_ID, {
      authorIdentity: 'cyrusjamula',
      reviewerIdentity: 'senior-maintainer'
    }),
    buildSampleCircuitBreaker(SF_REPO_ID, {
      authorIdentity: null,
      reviewerIdentity: null
    }),
    buildSampleCircuitBreaker(SF_REPO_ID, {
      authorIdentity: 'cyrusjamula',
      implementationAgentIdentity: null,
      reviewerIdentity: 'copilot-pull-request-reviewer[bot]'
    }),
    buildSampleCircuitBreaker(SF_REPO_ID, {
      authorIdentity: undefined,
      reviewerIdentity: undefined
    }),
    buildSampleCircuitBreaker(SF_REPO_ID, {reviewerIdentity: null}),
    buildSampleCircuitBreaker(SF_REPO_ID, {mainHealthy: null}),
    buildSampleCircuitBreaker(SF_REPO_ID, {mainHealthy: false})
  ]) {
    assert.equal(
      queryCausalAuditTrail([{...validChain, circuitBreaker: badCb}], {repositoryId: SF_REPO_ID}).reason,
      'INCONSISTENT_CIRCUIT_BREAKER_LINEAGE'
    );
  }

  // Broken 9-link chain (unsigned commit) fails closed via verifyCausalProvenanceChain
  const unsignedChain = buildAuditChain();
  unsignedChain.stages.candidateCommit.signed = false;
  assert.equal(
    queryCausalAuditTrail([unsignedChain], {repositoryId: SF_REPO_ID}).reason,
    'UNVERIFIED_PROVENANCE_CHAIN'
  );

  // Partial in-flight chain (<9 links) fails closed even though verifyCausalProvenanceChain marks prefix valid
  const inFlightChain = {
    allowInFlightUpToStage: 'candidateCommit',
    stages: {
      eventDelivery: validChain.stages.eventDelivery,
      ghAwLock: validChain.stages.ghAwLock,
      casLease: validChain.stages.casLease,
      missionControlTask: validChain.stages.missionControlTask,
      candidateCommit: validChain.stages.candidateCommit
    }
  };
  assert.equal(
    queryCausalAuditTrail([inFlightChain], {repositoryId: SF_REPO_ID}).reason,
    'INCOMPLETE_PROVENANCE_CHAIN'
  );

  // Duplicate traceId, commitSha, squashCommitSha, and per-repo pullNumber fail closed
  const dupTrace = buildAuditChain({traceSeed: 'a', commitSeed: '3', squashSeed: '4'});
  assert.equal(
    queryCausalAuditTrail([validChain, dupTrace], {repositoryId: SF_REPO_ID}).reason,
    'DUPLICATE_TRACE_ID'
  );

  const dupCommit = buildAuditChain({traceSeed: 'b', commitSeed: '1', squashSeed: '4'});
  assert.equal(
    queryCausalAuditTrail([validChain, dupCommit], {repositoryId: SF_REPO_ID}).reason,
    'DUPLICATE_COMMIT_SHA'
  );

  const dupSquash = buildAuditChain({traceSeed: 'b', commitSeed: '3', squashSeed: '2'});
  assert.equal(
    queryCausalAuditTrail([validChain, dupSquash], {repositoryId: SF_REPO_ID}).reason,
    'DUPLICATE_SQUASH_COMMIT_SHA'
  );

  const pullA = buildAuditChain({traceSeed: 'a', commitSeed: '1', squashSeed: '2', extra: {pullNumber: 150}});
  const pullB = buildAuditChain({traceSeed: 'b', commitSeed: '3', squashSeed: '4', extra: {pullNumber: 150}});
  assert.equal(
    queryCausalAuditTrail([pullA, pullB], {repositoryId: SF_REPO_ID}).reason,
    'DUPLICATE_PULL_NUMBER'
  );

  // Disagreement between declared violations and circuitBreaker fails closed (both length mismatch and code mismatch)
  const mismatchLen = buildAuditChain({
    extra: {
      violations: [],
      circuitBreaker: buildSampleCircuitBreaker(SF_REPO_ID, {runAiCredits: 99})
    }
  });
  assert.equal(
    queryCausalAuditTrail([mismatchLen], {repositoryId: SF_REPO_ID}).reason,
    'INCONSISTENT_AUDIT_VIOLATIONS'
  );

  const mismatchCode = buildAuditChain({
    extra: {
      violations: ['RETRY_CAP_EXCEEDED'],
      circuitBreaker: buildSampleCircuitBreaker(SF_REPO_ID, {runAiCredits: 99})
    }
  });
  assert.equal(
    queryCausalAuditTrail([mismatchCode], {repositoryId: SF_REPO_ID}).reason,
    'INCONSISTENT_AUDIT_VIOLATIONS'
  );
});

test('buildAutomaticRevertCandidateSpec emits bounded revert PR specs on rollbackRequired === true with governed-path human approval', () => {
  assert.equal(KNOWN_ROLLBACK_REASONS.length, 7);
  const before = buildBaselineCohort();
  const rollbackVerdict = verifyCohortImprovementOrRollback({
    beforeCohort: before,
    afterCohort: buildCandidateCohort({
      coveredLines: 965,
      aiCreditsTotal: 240
    })
  });
  assert.equal(rollbackVerdict.rollbackRequired, true);

  const revertSha = '2'.repeat(40);
  const verifiedCandidateChain = buildAuditChain({squashSeed: '2'});
  const standardSpec = buildAutomaticRevertCandidateSpec(rollbackVerdict, {
    proposalId: 'bottleneck:1471342715:gh-aw-queue-latency-p95',
    repositoryId: SF_REPO_ID,
    laneId: 'sf-velocity-lane',
    ownedPaths: ['tools/engineering-factory/stage-latency.mjs'],
    touchedPaths: ['tools/engineering-factory/stage-latency.mjs'],
    targetPaths: ['tools/engineering-factory/stage-latency.mjs'],
    provenanceChain: verifiedCandidateChain,
    targetRevertCommitSha: revertSha,
    squashCommitSha: revertSha,
    cohortId: 'm02-small-comparable',
    pullNumber: 145,
    issueNumber: 137
  });

  assert.equal(standardSpec.valid, true);
  assert.equal(standardSpec.shadow, true);
  assert.equal(standardSpec.liveMutation, false);
  assert.equal(standardSpec.revertRequired, true);
  assert.equal(standardSpec.provenanceVerified, true);
  assert.equal(standardSpec.directMainMutation, false);
  assert.equal(standardSpec.autoPolicyMutation, false);
  assert.equal(standardSpec.requiresHumanApproval, false);
  assert.equal(standardSpec.deliveryKind, 'candidate-revert-pr');
  assert.deepEqual(standardSpec.gatePipelineRequired, REQUIRED_GATE_PIPELINE);
  assert.deepEqual(standardSpec.rollbackReasons, rollbackVerdict.rollbackReasons);
  assert.equal(standardSpec.targetRevertCommitSha, revertSha);
  assert.equal(standardSpec.scope, 'factory-velocity');
  assert.equal(standardSpec.cohortId, 'm02-small-comparable');
  assert.equal(standardSpec.sourcePullNumber, 145);
  assert.equal(standardSpec.sourceIssueNumber, 137);
  assert.deepEqual(standardSpec.metricsDelta, rollbackVerdict.metricsDelta);

  // Consumer product lane defaults scope to enrolled-product and accepts squashCommitSha + concise verdict without metricsDelta
  const conciseVerdict = {
    valid: true,
    status: 'ROLLBACK_REQUIRED',
    cohortComplete: true,
    verifiedImprovement: false,
    rollbackRequired: true,
    rollbackReasons: ['REWORK_RATE_REGRESSED']
  };
  const consumerSpec = buildAutomaticRevertCandidateSpec(conciseVerdict, {
    proposalId: 'feedback:3333333333:ft-ux-latency',
    repositoryId: FAMILYTREE_REPO_ID,
    laneId: 'ft-product-lane',
    targetPaths: ['src/tree/pedigree.ts'],
    squashCommitSha: revertSha
  });
  assert.equal(consumerSpec.valid, true);
  assert.equal(consumerSpec.provenanceVerified, false);
  assert.equal(consumerSpec.scope, 'enrolled-product');
  assert.equal(consumerSpec.requiresHumanApproval, false);
  assert.equal(consumerSpec.targetRevertCommitSha, revertSha);
  assert.equal(consumerSpec.cohortId, null);
  assert.equal(consumerSpec.sourcePullNumber, null);
  assert.equal(consumerSpec.sourceIssueNumber, null);
  assert.equal(consumerSpec.metricsDelta, null);

  // Governed paths, ancestor directories, governed contractDomain, touchesContract, or explicit requiresHumanApproval enforce requiresHumanApproval: true
  const consumerRollbackVerdict = verifyCohortImprovementOrRollback({
    beforeCohort: buildBaselineCohort({repositoryId: FAMILYTREE_REPO_ID}),
    afterCohort: buildCandidateCohort({repositoryId: FAMILYTREE_REPO_ID, securityFindings: 1})
  });
  for (const [verdict, governedMeta] of [
    [rollbackVerdict, {
      proposalId: 'gov-workflow',
      repositoryId: SF_REPO_ID,
      laneId: 'sf-gov',
      targetPaths: ['.github/workflows/ci.yml'],
      targetRevertCommitSha: revertSha,
      requiresHumanApproval: false // cannot downgrade governed path!
    }],
    [rollbackVerdict, {
      proposalId: 'gov-budget',
      repositoryId: SF_REPO_ID,
      laneId: 'sf-budget',
      targetPaths: ['tools/engineering-factory/budget.mjs'],
      targetRevertCommitSha: revertSha
    }],
    [rollbackVerdict, {
      proposalId: 'gov-optimistic-improver',
      repositoryId: SF_REPO_ID,
      laneId: 'sf-improver',
      ownedPaths: ['tools/engineering-factory/optimistic-improver.mjs'],
      targetPaths: ['tools/engineering-factory/optimistic-improver.mjs'],
      targetRevertCommitSha: revertSha,
      requiresHumanApproval: false
    }],
    [rollbackVerdict, {
      proposalId: 'gov-scorecard',
      repositoryId: SF_REPO_ID,
      laneId: 'sf-scorecard',
      ownedPaths: ['tools/engineering-factory/ai-credit-scorecard.mjs'],
      targetPaths: ['tools/engineering-factory/ai-credit-scorecard.mjs'],
      targetRevertCommitSha: revertSha
    }],
    ...[
      'CODEOWNERS',
      '.github/CODEOWNERS',
      'docs/CODEOWNERS',
      'package.json',
      'package-lock.json',
      'tests/engineering-factory/coverage-reporter.mjs',
      'tools/engineering-factory/review-history.mjs',
      'tools/engineering-factory/review-batch.mjs',
      'tools/engineering-coordinator'
    ].map((govPath, idx) => [rollbackVerdict, {
      proposalId: `gov-review-owners-${idx}`,
      repositoryId: SF_REPO_ID,
      laneId: `sf-review-owners-${idx}`,
      ownedPaths: [govPath],
      targetPaths: [govPath],
      targetRevertCommitSha: revertSha
    }]),
    [rollbackVerdict, {
      proposalId: 'gov-broad-owned-dir',
      repositoryId: SF_REPO_ID,
      laneId: 'sf-broad',
      ownedPaths: ['tools/engineering-factory'],
      targetPaths: ['tools/engineering-factory/stage-latency.mjs'],
      targetRevertCommitSha: revertSha
    }],
    [consumerRollbackVerdict, {
      proposalId: 'gov-domain',
      repositoryId: FAMILYTREE_REPO_ID,
      laneId: 'ft-policy',
      scope: 'enrolled-product',
      contractDomain: 'policy',
      targetPaths: ['src/tree/pedigree.ts'],
      targetRevertCommitSha: revertSha
    }],
    [consumerRollbackVerdict, {
      proposalId: 'gov-contract-flag',
      repositoryId: FAMILYTREE_REPO_ID,
      laneId: 'ft-contract',
      touchesContract: true,
      targetPaths: ['src/tree/pedigree.ts'],
      targetRevertCommitSha: revertSha
    }],
    [consumerRollbackVerdict, {
      proposalId: 'gov-explicit-flag',
      repositoryId: FAMILYTREE_REPO_ID,
      laneId: 'ft-explicit',
      requiresHumanApproval: true,
      targetPaths: ['src/tree/pedigree.ts'],
      targetRevertCommitSha: revertSha
    }]
  ]) {
    const spec = buildAutomaticRevertCandidateSpec(verdict, governedMeta);
    assert.equal(spec.valid, true, governedMeta.proposalId);
    assert.equal(spec.requiresHumanApproval, true, governedMeta.proposalId);
    assert.equal(spec.deliveryKind, 'human-approved-revert-pr', governedMeta.proposalId);
    assert.equal(spec.directMainMutation, false);
    assert.equal(spec.autoPolicyMutation, false);
  }
});

test('buildAutomaticRevertCandidateSpec refuses non-rollback verdicts and fails closed on proxies, out-of-lane targets, and malformed SHAs', () => {
  const before = buildBaselineCohort();
  const rollbackVerdict = verifyCohortImprovementOrRollback({
    beforeCohort: before,
    afterCohort: buildCandidateCohort({securityFindings: 1})
  });
  const baseMeta = {
    proposalId: 'prop-137',
    repositoryId: SF_REPO_ID,
    laneId: 'sf-velocity-lane',
    targetPaths: ['tools/engineering-factory/stage-latency.mjs'],
    targetRevertCommitSha: 'a'.repeat(40)
  };

  // Valid non-rollback verdicts (VERIFIED_IMPROVEMENT, NO_MATERIAL_GAIN, INSUFFICIENT_COHORT) return ROLLBACK_NOT_REQUIRED
  for (const nonRollback of [
    verifyCohortImprovementOrRollback({
      beforeCohort: before,
      afterCohort: buildCandidateCohort({medianCycleTimeMs: 300_000})
    }),
    verifyCohortImprovementOrRollback({
      beforeCohort: before,
      afterCohort: buildCandidateCohort()
    }),
    verifyCohortImprovementOrRollback({
      beforeCohort: buildBaselineCohort({acceptedOutcomes: 4}),
      afterCohort: buildCandidateCohort()
    })
  ]) {
    const res = buildAutomaticRevertCandidateSpec(nonRollback, baseMeta);
    assert.equal(res.valid, false);
    assert.equal(res.revertRequired, false);
    assert.equal(res.reason, 'ROLLBACK_NOT_REQUIRED');
    assert.equal(res.targetRevertCommitSha, null);
    assert.equal(res.directMainMutation, false);
    assert.equal(res.autoPolicyMutation, false);
    assert.deepEqual(res.gatePipelineRequired, REQUIRED_GATE_PIPELINE);
  }

  // Invalid or tampered cohortVerdict payloads fail closed
  for (const badVerdict of [
    null,
    new Proxy(rollbackVerdict, {}),
    verifyCohortImprovementOrRollback(null),
    {...rollbackVerdict, shadow: false},
    {...rollbackVerdict, repositoryId: 0},
    {...rollbackVerdict, cohortId: 'BAD COHORT'},
    {...rollbackVerdict, minimumRequiredOutcomes: 5},
    {...rollbackVerdict, rollbackReasons: []},
    {...rollbackVerdict, rollbackReasons: ['UNKNOWN_REASON']},
    {...rollbackVerdict, rollbackReasons: ['MAIN_HEALTH_FAILURE', 'MAIN_HEALTH_FAILURE']},
    {...rollbackVerdict, metricsDelta: {medianCycleTimeDeltaMs: Number.NaN, reworkRateDeltaBps: 0, aiCreditsPerOutcomeDelta: 0}},
    {...rollbackVerdict, status: 'VERIFIED_IMPROVEMENT'},
    {...rollbackVerdict, cohortComplete: false},
    {...rollbackVerdict, verifiedImprovement: true},
    {
      valid: true,
      status: 'VERIFIED_IMPROVEMENT',
      cohortComplete: true,
      verifiedImprovement: false,
      rollbackRequired: false,
      rollbackReasons: []
    },
    {
      valid: true,
      status: 'VERIFIED_IMPROVEMENT',
      cohortComplete: true,
      verifiedImprovement: true,
      rollbackRequired: false,
      rollbackReasons: ['MAIN_HEALTH_FAILURE']
    },
    {
      valid: true,
      status: 'INSUFFICIENT_COHORT',
      cohortComplete: false,
      verifiedImprovement: false,
      rollbackRequired: false,
      minimumRequiredOutcomes: 5,
      beforeAcceptedOutcomes: 5,
      afterAcceptedOutcomes: 5,
      rollbackReasons: []
    },
    {
      valid: true,
      status: 'INSUFFICIENT_COHORT',
      cohortComplete: true,
      verifiedImprovement: false,
      rollbackRequired: false,
      minimumRequiredOutcomes: 5,
      beforeAcceptedOutcomes: 3,
      afterAcceptedOutcomes: 5,
      rollbackReasons: []
    },
    {
      valid: true,
      status: 'UNKNOWN_STATUS',
      cohortComplete: true,
      verifiedImprovement: false,
      rollbackRequired: false,
      rollbackReasons: []
    }
  ]) {
    assert.equal(
      buildAutomaticRevertCandidateSpec(badVerdict, baseMeta).reason,
      'INVALID_COHORT_VERDICT'
    );
  }

  // Cross-repository and cross-cohort verdict/meta mismatches fail closed
  assert.equal(
    buildAutomaticRevertCandidateSpec(rollbackVerdict, {
      ...baseMeta,
      repositoryId: FAMILYTREE_REPO_ID
    }).reason,
    'COHORT_REPOSITORY_MISMATCH'
  );
  assert.equal(
    buildAutomaticRevertCandidateSpec(rollbackVerdict, {
      ...baseMeta,
      cohortId: 'different-cohort'
    }).reason,
    'COHORT_ID_MISMATCH'
  );

  // Omitting touchedPaths or provenanceChain paths from targetPaths (e.g. hiding governed paths) fails closed
  assert.equal(
    buildAutomaticRevertCandidateSpec(rollbackVerdict, {
      ...baseMeta,
      touchedPaths: ['tools/engineering-factory/stage-latency.mjs', '.github/workflows/ci.yml']
    }).reason,
    'INCOMPLETE_REVERT_TARGET_PATHS'
  );
  assert.equal(
    buildAutomaticRevertCandidateSpec(rollbackVerdict, {
      ...baseMeta,
      provenanceChain: {allowInFlightUpToStage: 'eventDelivery', stages: {eventDelivery: buildAuditChain().stages.eventDelivery}}
    }).reason,
    'UNVERIFIED_CANDIDATE_PROVENANCE'
  );
  for (const mismatchMeta of [
    {...baseMeta, provenanceChain: buildAuditChain({squashSeed: '3'})}, // wrong squashCommitSha
    {...baseMeta, laneId: 'other-lane', targetRevertCommitSha: '2'.repeat(40), provenanceChain: buildAuditChain({squashSeed: '2'})},
    {
      ...baseMeta,
      targetRevertCommitSha: '2'.repeat(40),
      ownedPaths: ['tools/engineering-factory'],
      provenanceChain: buildAuditChain({squashSeed: '2'})
    },
    {
      ...baseMeta,
      targetRevertCommitSha: '2'.repeat(40),
      targetPaths: ['tools/engineering-factory/stage-latency.mjs', 'src/unowned-other-lane/file.ts'],
      provenanceChain: buildAuditChain({squashSeed: '2'})
    },
    {
      ...baseMeta,
      targetRevertCommitSha: '2'.repeat(40),
      targetPaths: ['docs/extra.md'],
      provenanceChain: buildAuditChain({squashSeed: '2'})
    }
  ]) {
    assert.equal(
      buildAutomaticRevertCandidateSpec(rollbackVerdict, mismatchMeta).reason,
      'CANDIDATE_PROVENANCE_MISMATCH'
    );
  }

  // Invalid candidateMeta, malformed/mismatched SHAs, and out-of-lane target paths fail closed
  const missingSha = {...baseMeta};
  delete missingSha.targetRevertCommitSha;
  assert.equal(
    buildAutomaticRevertCandidateSpec(rollbackVerdict, missingSha).reason,
    'INVALID_CANDIDATE_META'
  );

  for (const badShaMeta of [
    {...baseMeta, targetRevertCommitSha: 'not-40-hex'},
    {...missingSha, squashCommitSha: 'A'.repeat(40)}
  ]) {
    assert.equal(
      buildAutomaticRevertCandidateSpec(rollbackVerdict, badShaMeta).reason,
      'INVALID_REVERT_COMMIT_SHA'
    );
  }

  assert.equal(
    buildAutomaticRevertCandidateSpec(rollbackVerdict, {
      ...baseMeta,
      squashCommitSha: 'b'.repeat(40)
    }).reason,
    'REVERT_COMMIT_SHA_MISMATCH'
  );

  assert.equal(
    buildAutomaticRevertCandidateSpec(rollbackVerdict, {
      ...baseMeta,
      ownedPaths: ['docs/guides'],
      targetPaths: ['tools/engineering-factory/stage-latency.mjs']
    }).reason,
    'OUT_OF_LANE_REVERT_TARGET'
  );

  for (const badMeta of [
    null,
    new Proxy(baseMeta, {}),
    {...baseMeta, proposalId: ''},
    {...baseMeta, repositoryId: 0},
    {...baseMeta, laneId: 'bad lane!'},
    {...baseMeta, targetPaths: ['../escape.mjs']},
    {...baseMeta, ownedPaths: ['../escape.mjs']},
    {...baseMeta, touchedPaths: ['../escape.mjs']},
    {...baseMeta, scope: 'invalid-scope'},
    {...baseMeta, contractDomain: 'invalid-domain'},
    {...baseMeta, touchesContract: 'yes'},
    {...baseMeta, requiresHumanApproval: 'yes'},
    {...baseMeta, cohortId: 'BAD COHORT'},
    {...baseMeta, pullNumber: 0},
    {...baseMeta, issueNumber: 0}
  ]) {
    assert.equal(
      buildAutomaticRevertCandidateSpec(rollbackVerdict, badMeta).reason,
      'INVALID_CANDIDATE_META'
    );
  }
});

function buildBoundAuditChain({
  traceSeed = 'a',
  commitSeed = '1',
  squashSeed = '2',
  deliveryId = 'delivery-bound-1',
  repositoryId = SF_REPO_ID,
  startedAtMs = 210_000,
  completedAtMs = 220_000,
  laneId = null,
  ownedPaths = null,
  touchedPaths = null,
  agentIdentity = 'copilot-swe-agent[bot]',
  issueNumber = 137,
  pullNumber = 141,
  cbOverrides = {}
} = {}) {
  const isConsumer = repositoryId !== SF_REPO_ID;
  const effectiveLane = laneId ?? (isConsumer ? 'ft-product-lane' : 'sf-velocity-lane');
  const effectiveOwned = ownedPaths ?? (
    isConsumer ? ['src/tree/pedigree.ts'] : ['tools/engineering-factory/stage-latency.mjs']
  );
  const effectiveTouched = touchedPaths ?? effectiveOwned;
  const reviewer = isConsumer ? 'senior-maintainer' : 'copilot-pull-request-reviewer[bot]';
  const base = buildAuditChain({
    traceSeed,
    commitSeed,
    squashSeed,
    deliveryId,
    repositoryId,
    startedAtMs,
    completedAtMs
  });
  base.stages.casLease.laneId = effectiveLane;
  base.stages.casLease.ownedPaths = effectiveOwned;
  base.stages.candidateCommit.touchedPaths = effectiveTouched;
  base.stages.independentReview.implementationAgentIdentity = agentIdentity;
  return {
    ...base,
    ...(issueNumber !== null ? {issueNumber} : {}),
    ...(pullNumber !== null ? {pullNumber} : {}),
    violations: [],
    circuitBreaker: {
      repositoryId,
      ownedPaths: effectiveOwned,
      touchedPaths: effectiveTouched,
      attempt: 1,
      maxRetries: 2,
      runAiCredits: 18,
      maxRunAiCredits: 50,
      burnRateBps: 500,
      maxBurnSpikeBps: 2500,
      incrementalBilledUsdCents: 0,
      safeOutputsThreatDetected: false,
      humanOwnerSignOffVerified: false,
      authorIdentity: 'cyrusjamula',
      implementationAgentIdentity: agentIdentity,
      reviewerIdentity: reviewer,
      mainHealthy: true,
      accountingVerified: true,
      isEstimated: false,
      ...cbOverrides
    }
  };
}

function buildValidReadoutInput(overrides = {}) {
  const chain1 = buildBoundAuditChain({
    traceSeed: 'a',
    commitSeed: '1',
    squashSeed: '2',
    deliveryId: 'del-1',
    startedAtMs: 210_000,
    completedAtMs: 220_000,
    pullNumber: 141
  });
  return {
    repositoryId: SF_REPO_ID,
    evaluatedHeadSha: '2'.repeat(40),
    evidenceMode: 'pre-cohort-synthetic',
    liveAutonomousOutcomesCount: 0,
    auditChains: [chain1],
    proposalInput: {
      scorecard: buildSampleScorecard(),
      knowledgeLanes: buildKnowledgeLanes(),
      failureTaxonomy: [
        {
          id: 'wf-drift',
          repositoryId: SF_REPO_ID,
          laneId: 'sf-governance-lane',
          failureClass: 'workflow-lock',
          occurrences: 3,
          baselineRateBps: 1000,
          targetRateBps: 0,
          targetPaths: ['.github/workflows/ci.yml'],
          touchesContract: true
        }
      ],
      feedbackItems: []
    },
    cohortInput: {
      beforeCohort: buildBaselineCohort(),
      afterCohort: buildCandidateCohort({
        medianCycleTimeMs: 320_000,
        reworkRateBps: 900,
        aiCreditsTotal: 150
      })
    },
    ...overrides
  };
}

test('evaluateKaizenCohortReadout binds 100% 9-link provenance, human-approved proposals, >=5 cohort verification, live mode, and automatic revert specs', () => {
  assert.deepEqual(KAIZEN_EVIDENCE_MODES, ['pre-cohort-synthetic', 'live-autonomous-cohort']);

  // Pre-cohort synthetic improvement readout never asserts liveCohortVerified or issue137ReadyToClose
  const preInput = buildValidReadoutInput();
  const preRes = evaluateKaizenCohortReadout(preInput);
  assert.equal(preRes.valid, true);
  assert.equal(preRes.shadow, true);
  assert.equal(preRes.readOnly, true);
  assert.equal(preRes.liveMutation, false);
  assert.equal(preRes.directMainMutation, false);
  assert.equal(preRes.autoPolicyMutation, false);
  assert.equal(preRes.evidenceMode, 'pre-cohort-synthetic');
  assert.equal(preRes.syntheticReplayOnly, true);
  assert.equal(preRes.liveCohortVerified, false);
  assert.equal(preRes.issue137ReadyToClose, false);
  assert.equal(preRes.readoutStatus, 'VERIFIED_IMPROVEMENT');
  assert.equal(preRes.revertCandidateSpec, null);
  assert.equal(preRes.provenanceSummary.provenanceCompletenessPct, 100);
  assert.equal(preRes.provenanceSummary.protectedSelfModifications, 0);
  assert.equal(preRes.provenanceSummary.zeroUnapprovedSpend, true);
  assert.equal(Object.isFrozen(preRes), true);
  assert.equal(Object.isFrozen(preRes.provenanceSummary), true);
  assert.equal(Object.isFrozen(preRes.proposalSummary), true);

  // Pre-cohort INSUFFICIENT_COHORT is reported honestly without claiming improvement or rollback
  const insufficientPre = evaluateKaizenCohortReadout(buildValidReadoutInput({
    cohortInput: {
      beforeCohort: buildBaselineCohort({acceptedOutcomes: 3}),
      afterCohort: buildCandidateCohort({acceptedOutcomes: 4})
    }
  }));
  assert.equal(insufficientPre.valid, true);
  assert.equal(insufficientPre.readoutStatus, 'INSUFFICIENT_COHORT');
  assert.equal(insufficientPre.liveCohortVerified, false);

  // Live autonomous cohort mode succeeds ONLY when shippedCandidate rolled out at/before afterCohort.windowStartMs and >=5 verified copilot-swe-agent[bot] chains completed inside afterCohort window
  const rolloutChain = buildBoundAuditChain({
    traceSeed: 'e',
    commitSeed: 'a',
    squashSeed: '4',
    deliveryId: 'live-rollout-0',
    startedAtMs: 195_000,
    completedAtMs: 200_000,
    pullNumber: 199,
    issueNumber: 137
  });
  const liveSeeds = ['1', '2', '3', '4', '5'];
  const livePostRolloutChains = liveSeeds.map((seed, idx) => buildBoundAuditChain({
    traceSeed: seed,
    commitSeed: seed,
    squashSeed: (idx + 5).toString(16),
    deliveryId: `live-del-${idx + 1}`,
    startedAtMs: 205_000 + idx * 10_000,
    completedAtMs: 210_000 + idx * 10_000,
    pullNumber: 200 + idx
  }));
  const liveChains = [rolloutChain, ...livePostRolloutChains];
  const liveBottleneckId = preInput.proposalInput.scorecard.bottlenecks[0].id;
  const liveShippedMeta = {
    proposalId: `bottleneck:${SF_REPO_ID}:${liveBottleneckId}`,
    repositoryId: SF_REPO_ID,
    laneId: 'sf-velocity-lane',
    scope: 'factory-velocity',
    ownedPaths: ['tools/engineering-factory/stage-latency.mjs'],
    touchedPaths: ['tools/engineering-factory/stage-latency.mjs'],
    targetPaths: ['tools/engineering-factory/stage-latency.mjs'],
    squashCommitSha: '4'.repeat(40),
    pullNumber: 199,
    issueNumber: 137
  };
  const liveImproved = evaluateKaizenCohortReadout(buildValidReadoutInput({
    evaluatedHeadSha: '9'.repeat(40),
    evidenceMode: 'live-autonomous-cohort',
    liveAutonomousOutcomesCount: 5,
    auditChains: liveChains,
    cohortInput: {
      beforeCohort: buildBaselineCohort({acceptedOutcomes: 5}),
      afterCohort: buildCandidateCohort({
        acceptedOutcomes: 5,
        medianCycleTimeMs: 310_000,
        reworkRateBps: 900,
        aiCreditsTotal: 140
      })
    },
    shippedCandidate: liveShippedMeta
  }));
  assert.equal(liveImproved.valid, true);
  assert.equal(liveImproved.syntheticReplayOnly, false);
  assert.equal(liveImproved.liveCohortVerified, true);
  assert.equal(liveImproved.issue137ReadyToClose, true);
  assert.equal(liveImproved.revertCandidateSpec, null);

  // Live NO_MATERIAL_GAIN keeps liveCohortVerified: false and issue137ReadyToClose: false
  const liveNeutral = evaluateKaizenCohortReadout(buildValidReadoutInput({
    evaluatedHeadSha: '9'.repeat(40),
    evidenceMode: 'live-autonomous-cohort',
    liveAutonomousOutcomesCount: 5,
    auditChains: liveChains,
    cohortInput: {
      beforeCohort: buildBaselineCohort({acceptedOutcomes: 5, aiCreditsTotal: 150}),
      afterCohort: buildCandidateCohort({acceptedOutcomes: 5, aiCreditsTotal: 150})
    },
    shippedCandidate: liveShippedMeta
  }));
  assert.equal(liveNeutral.valid, true);
  assert.equal(liveNeutral.readoutStatus, 'NO_MATERIAL_GAIN');
  assert.equal(liveNeutral.liveCohortVerified, false);
  assert.equal(liveNeutral.issue137ReadyToClose, false);

  // Live mode missing shippedCandidate or with rollout after afterCohort.windowStartMs fails closed
  const liveWithoutShipped = buildValidReadoutInput({
    evaluatedHeadSha: '9'.repeat(40),
    evidenceMode: 'live-autonomous-cohort',
    liveAutonomousOutcomesCount: 5,
    auditChains: liveChains,
    cohortInput: {
      beforeCohort: buildBaselineCohort({acceptedOutcomes: 5}),
      afterCohort: buildCandidateCohort({acceptedOutcomes: 5, medianCycleTimeMs: 310_000})
    }
  });
  assert.equal(
    evaluateKaizenCohortReadout(liveWithoutShipped).reason,
    'MISSING_SHIPPED_CANDIDATE_META'
  );
  assert.equal(
    evaluateKaizenCohortReadout({
      ...liveWithoutShipped,
      shippedCandidate: {
        ...liveShippedMeta,
        squashCommitSha: '9'.repeat(40),
        pullNumber: 204
      }
    }).reason,
    'CANDIDATE_NOT_SHIPPED_BEFORE_COHORT'
  );

  // Regression with inline provenanceChain, billed-spend regression, and contract-touching proposal propagates requiresHumanApproval: true
  const rawInlineChain = {stages: livePostRolloutChains[4].stages};
  const contractRollout = evaluateKaizenCohortReadout(buildValidReadoutInput({
    evaluatedHeadSha: '9'.repeat(40),
    auditChains: liveChains,
    proposalInput: {
      scorecard: {...buildSampleScorecard(), bottlenecks: []},
      knowledgeLanes: buildKnowledgeLanes(),
      failureTaxonomy: [],
      feedbackItems: [
        {
          id: 'vel-contract-touch',
          repositoryId: SF_REPO_ID,
          laneId: 'sf-velocity-lane',
          source: 'operator',
          metricName: 'stageMs',
          baselineValue: 100,
          targetValue: 50,
          targetPaths: ['tools/engineering-factory/stage-latency.mjs'],
          touchesContract: true
        }
      ]
    },
    cohortInput: {
      beforeCohort: buildBaselineCohort(),
      afterCohort: buildCandidateCohort({incrementalBilledUsdCents: 7})
    },
    shippedCandidate: {
      proposalId: `feedback:${SF_REPO_ID}:vel-contract-touch`,
      repositoryId: SF_REPO_ID,
      laneId: 'sf-velocity-lane',
      targetPaths: ['tools/engineering-factory/stage-latency.mjs'],
      targetRevertCommitSha: '9'.repeat(40),
      provenanceChain: rawInlineChain
    }
  }));
  assert.equal(contractRollout.valid, true);
  assert.equal(contractRollout.readoutStatus, 'ROLLBACK_REQUIRED');
  assert.equal(contractRollout.provenanceSummary.unapprovedSpendUsdCents, 7);
  assert.equal(contractRollout.provenanceSummary.zeroUnapprovedSpend, false);
  assert.equal(contractRollout.revertCandidateSpec.valid, true);
  assert.equal(contractRollout.revertCandidateSpec.provenanceVerified, true);
  assert.equal(contractRollout.revertCandidateSpec.requiresHumanApproval, true);
  assert.equal(contractRollout.revertCandidateSpec.deliveryKind, 'human-approved-revert-pr');

  // Consumer repository rollback synthesizes coveragePolicy from auditChains when inline provenanceChain is omitted
  const consumerChain = buildBoundAuditChain({
    traceSeed: 'f',
    commitSeed: 'b',
    squashSeed: 'c',
    repositoryId: FAMILYTREE_REPO_ID,
    agentIdentity: 'custom-specialist-runner',
    issueNumber: null,
    pullNumber: null
  });
  const consumerScorecard = buildAiCreditAndAutonomyScorecard({
    repositoryId: FAMILYTREE_REPO_ID,
    authorizedRepositoryIds: [FAMILYTREE_REPO_ID],
    cohort: 'ft-cohort',
    sourceKind: 'verified-autonomous',
    fromMs: 1_000,
    toMs: 20_000,
    observedMs: 22_000,
    nowMs: 25_000,
    maxAgeMs: 10_000,
    records: [
      {
        id: 'ft-act-1',
        issueNumber: 12,
        repositoryId: FAMILYTREE_REPO_ID,
        cohort: 'ft-cohort',
        sourceKind: 'verified-autonomous',
        observedMs: 5_000,
        accepted: true,
        accounting: {
          status: 'verified',
          aiCredits: 20,
          incrementalBilledUsdCents: 0,
          cloudSandboxMinutes: 3,
          actionsRunnerMinutes: 2
        },
        ghAwQueueLatencyMs: 20_000,
        maf: {supersteps: 4, checkpointResumes: 0, innerRepairIterations: 0},
        audit: {fullProvenance: true, killSwitchTripped: false, violations: []}
      }
    ]
  });
  const consumerRollback = evaluateKaizenCohortReadout({
    repositoryId: FAMILYTREE_REPO_ID,
    evaluatedHeadSha: 'c'.repeat(40),
    evidenceMode: 'pre-cohort-synthetic',
    liveAutonomousOutcomesCount: 0,
    auditChains: [consumerChain],
    proposalInput: {
      scorecard: consumerScorecard,
      knowledgeLanes: [buildKnowledgeLanes()[4]],
      failureTaxonomy: [],
      feedbackItems: [
        {
          id: 'ft-perf',
          repositoryId: FAMILYTREE_REPO_ID,
          laneId: 'ft-product-lane',
          source: 'product',
          metricName: 'renderMs',
          baselineValue: 120,
          targetValue: 60,
          targetPaths: ['src/tree/pedigree.ts']
        }
      ]
    },
    cohortInput: {
      beforeCohort: buildBaselineCohort({repositoryId: FAMILYTREE_REPO_ID, coveredLines: 975, coveredBranches: 465}),
      afterCohort: buildCandidateCohort({repositoryId: FAMILYTREE_REPO_ID, coveredLines: 965, coveredBranches: 465}),
      policy: {profile: 'consumer', minLinePercent: 97, minBranchPercent: 92}
    },
    shippedCandidate: {
      proposalId: `feedback:${FAMILYTREE_REPO_ID}:ft-perf`,
      repositoryId: FAMILYTREE_REPO_ID,
      laneId: 'ft-product-lane',
      targetPaths: ['src/tree/pedigree.ts'],
      squashCommitSha: 'c'.repeat(40)
    }
  });
  assert.equal(consumerRollback.valid, true);
  assert.equal(consumerRollback.readoutStatus, 'ROLLBACK_REQUIRED');
  assert.equal(consumerRollback.provenanceSummary.copilotAgentChainsCount, 0);
  assert.equal(consumerRollback.revertCandidateSpec.provenanceVerified, true);
  assert.equal(consumerRollback.revertCandidateSpec.requiresHumanApproval, false);
  assert.equal(consumerRollback.revertCandidateSpec.deliveryKind, 'candidate-revert-pr');

  // Unrecognized proposalId on shippedCandidate fails closed without bypassing proposal approval checks
  assert.equal(
    evaluateKaizenCohortReadout({
      repositoryId: FAMILYTREE_REPO_ID,
      evaluatedHeadSha: 'c'.repeat(40),
      evidenceMode: 'pre-cohort-synthetic',
      liveAutonomousOutcomesCount: 0,
      auditChains: [consumerChain],
      proposalInput: {
        scorecard: consumerScorecard,
        knowledgeLanes: [buildKnowledgeLanes()[4]],
        failureTaxonomy: [],
        feedbackItems: [
          {
            id: 'ft-perf',
            repositoryId: FAMILYTREE_REPO_ID,
            laneId: 'ft-product-lane',
            source: 'product',
            metricName: 'renderMs',
            baselineValue: 120,
            targetValue: 60,
            targetPaths: ['src/tree/pedigree.ts'],
            touchesContract: true
          }
        ]
      },
      cohortInput: {
        beforeCohort: buildBaselineCohort({repositoryId: FAMILYTREE_REPO_ID, coveredLines: 975, coveredBranches: 465}),
        afterCohort: buildCandidateCohort({repositoryId: FAMILYTREE_REPO_ID, coveredLines: 965, coveredBranches: 465}),
        policy: {profile: 'consumer', minLinePercent: 97, minBranchPercent: 92}
      },
      shippedCandidate: {
        proposalId: 'unrecognized-proposal',
        repositoryId: FAMILYTREE_REPO_ID,
        laneId: 'ft-product-lane',
        targetPaths: ['src/tree/pedigree.ts'],
        squashCommitSha: 'c'.repeat(40)
      }
    }).reason,
    'UNKNOWN_CANDIDATE_PROPOSAL'
  );

  // Claiming pullNumber when verified audit chain had pullNumber: null fails closed
  assert.equal(
    evaluateKaizenCohortReadout({
      repositoryId: FAMILYTREE_REPO_ID,
      evaluatedHeadSha: 'c'.repeat(40),
      evidenceMode: 'pre-cohort-synthetic',
      liveAutonomousOutcomesCount: 0,
      auditChains: [consumerChain],
      proposalInput: {
        scorecard: consumerScorecard,
        knowledgeLanes: [buildKnowledgeLanes()[4]],
        failureTaxonomy: [],
        feedbackItems: [
          {
            id: 'ft-perf',
            repositoryId: FAMILYTREE_REPO_ID,
            laneId: 'ft-product-lane',
            source: 'product',
            metricName: 'renderMs',
            baselineValue: 120,
            targetValue: 60,
            targetPaths: ['src/tree/pedigree.ts']
          }
        ]
      },
      cohortInput: {
        beforeCohort: buildBaselineCohort({repositoryId: FAMILYTREE_REPO_ID, coveredLines: 975, coveredBranches: 465}),
        afterCohort: buildCandidateCohort({repositoryId: FAMILYTREE_REPO_ID, coveredLines: 965, coveredBranches: 465}),
        policy: {profile: 'consumer', minLinePercent: 97, minBranchPercent: 92}
      },
      shippedCandidate: {
        proposalId: `feedback:${FAMILYTREE_REPO_ID}:ft-perf`,
        repositoryId: FAMILYTREE_REPO_ID,
        laneId: 'ft-product-lane',
        targetPaths: ['src/tree/pedigree.ts'],
        squashCommitSha: 'c'.repeat(40),
        pullNumber: 88
      }
    }).reason,
    'CANDIDATE_PROVENANCE_MISMATCH'
  );
});

test('evaluateKaizenCohortReadout fails closed across malformed inputs, anti-rogue violations, unverified heads, live-claim spoofing, and candidate mismatches', () => {
  const validInput = buildValidReadoutInput();

  // Envelope, proxy, non-enumerable, and primitive rejections
  for (const bad of [
    null,
    new Proxy(validInput, {}),
    {...validInput, extraField: 1},
    {...validInput, repositoryId: 0},
    {...validInput, liveAutonomousOutcomesCount: -1}
  ]) {
    const res = evaluateKaizenCohortReadout(bad);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'INVALID_KAIZEN_READOUT_INPUT');
    assert.equal(res.readoutStatus, 'BLOCKED');
  }

  assert.equal(
    evaluateKaizenCohortReadout({...validInput, evaluatedHeadSha: 'bad-sha'}).reason,
    'INVALID_EVALUATED_HEAD_SHA'
  );
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, evaluatedHeadSha: '0'.repeat(40)}).reason,
    'INVALID_EVALUATED_HEAD_SHA'
  );
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, evidenceMode: 'bogus'}).reason,
    'INVALID_EVIDENCE_MODE'
  );
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, liveAutonomousOutcomesCount: 5}).reason,
    'INCONSISTENT_EVIDENCE_MODE'
  );
  assert.equal(
    evaluateKaizenCohortReadout({
      ...validInput,
      evidenceMode: 'live-autonomous-cohort',
      liveAutonomousOutcomesCount: 4
    }).reason,
    'UNVERIFIED_LIVE_COHORT_CLAIM'
  );

  // Audit trail failures: broken array, empty repo chains, missing/incomplete circuitBreaker, protected self-mod, spend, other violations
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, auditChains: null}).reason,
    'INVALID_AUDIT_CHAINS'
  );
  const onlyForeign = buildBoundAuditChain({repositoryId: FAMILYTREE_REPO_ID});
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, auditChains: [onlyForeign]}).reason,
    'EMPTY_PROVENANCE_AUDIT_TRAIL'
  );

  const withoutCb = {...validInput.auditChains[0]};
  delete withoutCb.circuitBreaker;
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, auditChains: [withoutCb]}).reason,
    'MISSING_CIRCUIT_BREAKER_EVIDENCE'
  );

  const missingMainBinding = {
    ...validInput.auditChains[0],
    circuitBreaker: {...validInput.auditChains[0].circuitBreaker}
  };
  delete missingMainBinding.circuitBreaker.mainHealthy;
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, auditChains: [missingMainBinding]}).reason,
    'INCOMPLETE_CIRCUIT_BREAKER_BINDING'
  );

  const protectedSelfMod = buildBoundAuditChain({
    laneId: 'sf-governance-lane',
    ownedPaths: ['.github/workflows/ci.yml'],
    cbOverrides: {humanOwnerSignOffVerified: false}
  });
  delete protectedSelfMod.violations;
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, auditChains: [protectedSelfMod]}).reason,
    'PROTECTED_FILE_SELF_MODIFICATION_DETECTED'
  );

  const creditAnomaly = buildBoundAuditChain({
    cbOverrides: {incrementalBilledUsdCents: 10}
  });
  delete creditAnomaly.violations;
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, auditChains: [creditAnomaly]}).reason,
    'UNAPPROVED_SPEND_OR_CREDIT_ANOMALY'
  );

  const retryViolation = buildBoundAuditChain({
    cbOverrides: {attempt: 5, maxRetries: 2}
  });
  delete retryViolation.violations;
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, auditChains: [retryViolation]}).reason,
    'ANTI_ROGUE_VIOLATION_DETECTED'
  );

  // Unverified or stale evaluatedHeadSha and insufficient agent provenance
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, evaluatedHeadSha: 'f'.repeat(40)}).reason,
    'UNVERIFIED_EVALUATED_HEAD_SHA'
  );
  const newerChain = buildBoundAuditChain({
    traceSeed: 'b',
    commitSeed: '3',
    squashSeed: '4',
    deliveryId: 'del-2',
    startedAtMs: 250_000,
    completedAtMs: 260_000,
    pullNumber: 142
  });
  assert.equal(
    evaluateKaizenCohortReadout({
      ...validInput,
      evaluatedHeadSha: '2'.repeat(40),
      auditChains: [validInput.auditChains[0], newerChain]
    }).reason,
    'STALE_EVALUATED_HEAD_SHA'
  );
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, liveAutonomousOutcomesCount: 2}).reason,
    'INSUFFICIENT_VERIFIED_AGENT_PROVENANCE'
  );

  // Proposal and scorecard rejections
  assert.equal(
    evaluateKaizenCohortReadout({
      ...validInput,
      proposalInput: {...validInput.proposalInput, scorecard: null}
    }).reason,
    'INVALID_SCORECARD'
  );
  assert.equal(
    evaluateKaizenCohortReadout({
      ...validInput,
      proposalInput: {
        ...validInput.proposalInput,
        scorecard: {
          valid: true,
          sourceKind: 'verified-autonomous',
          repositoryId: FAMILYTREE_REPO_ID,
          bottlenecks: []
        }
      }
    }).reason,
    'SCORECARD_REPOSITORY_MISMATCH'
  );
  assert.equal(
    evaluateKaizenCohortReadout({
      ...validInput,
      proposalInput: {
        scorecard: {...buildSampleScorecard(), bottlenecks: []},
        knowledgeLanes: buildKnowledgeLanes(),
        failureTaxonomy: [],
        feedbackItems: [
          {
            id: 'only-consumer-prop',
            repositoryId: FAMILYTREE_REPO_ID,
            laneId: 'ft-product-lane',
            source: 'product',
            metricName: 'm',
            baselineValue: 20,
            targetValue: 10,
            targetPaths: ['src/tree/pedigree.ts']
          }
        ]
      }
    }).reason,
    'NO_CANDIDATE_PROPOSALS'
  );

  // Cohort & live-window rejections
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, cohortInput: null}).reason,
    'INVALID_INPUT'
  );
  assert.equal(
    evaluateKaizenCohortReadout({
      ...validInput,
      cohortInput: {
        beforeCohort: buildBaselineCohort({repositoryId: FAMILYTREE_REPO_ID}),
        afterCohort: buildCandidateCohort({repositoryId: FAMILYTREE_REPO_ID})
      }
    }).reason,
    'COHORT_REPOSITORY_MISMATCH'
  );
  assert.equal(
    evaluateKaizenCohortReadout({
      ...validInput,
      cohortInput: {
        beforeCohort: buildBaselineCohort({incrementalBilledUsdCents: 1}),
        afterCohort: buildCandidateCohort()
      }
    }).reason,
    'UNAPPROVED_SPEND_OR_CREDIT_ANOMALY'
  );

  const sixWindowEdgeChains = ['1', '2', '3', '4', '5', '6'].map((seed, idx) => {
    let startedAtMs = 110_000;
    let completedAtMs = 120_000;
    if (idx === 3 || idx === 4) {
      startedAtMs = 210_000 + idx * 1_000;
      completedAtMs = 220_000 + idx * 1_000;
    } else if (idx === 5) {
      startedAtMs = 310_000;
      completedAtMs = 320_000;
    }
    return buildBoundAuditChain({
      traceSeed: seed,
      commitSeed: seed,
      squashSeed: (idx + 5).toString(16),
      deliveryId: `out-del-${idx}`,
      startedAtMs,
      completedAtMs,
      agentIdentity: idx === 3 ? 'manual-helper-agent' : 'copilot-swe-agent[bot]',
      pullNumber: 300 + idx
    });
  });
  assert.equal(
    evaluateKaizenCohortReadout({
      ...validInput,
      evaluatedHeadSha: 'a'.repeat(40),
      evidenceMode: 'live-autonomous-cohort',
      liveAutonomousOutcomesCount: 5,
      auditChains: sixWindowEdgeChains,
      cohortInput: {
        beforeCohort: buildBaselineCohort({acceptedOutcomes: 4}),
        afterCohort: buildCandidateCohort({acceptedOutcomes: 5})
      }
    }).reason,
    'INSUFFICIENT_LIVE_COHORT_OUTCOMES'
  );
  assert.equal(
    evaluateKaizenCohortReadout({
      ...validInput,
      evaluatedHeadSha: 'a'.repeat(40),
      evidenceMode: 'live-autonomous-cohort',
      liveAutonomousOutcomesCount: 5,
      auditChains: sixWindowEdgeChains,
      cohortInput: {
        beforeCohort: buildBaselineCohort({acceptedOutcomes: 5}),
        afterCohort: buildCandidateCohort({acceptedOutcomes: 6})
      }
    }).reason,
    'LIVE_OUTCOME_COUNT_MISMATCH'
  );
  assert.equal(
    evaluateKaizenCohortReadout({
      ...validInput,
      evaluatedHeadSha: 'a'.repeat(40),
      evidenceMode: 'live-autonomous-cohort',
      liveAutonomousOutcomesCount: 5,
      auditChains: sixWindowEdgeChains,
      cohortInput: {
        beforeCohort: buildBaselineCohort({acceptedOutcomes: 5}),
        afterCohort: buildCandidateCohort({acceptedOutcomes: 5, medianCycleTimeMs: 300_000})
      }
    }).reason,
    'INSUFFICIENT_VERIFIED_AGENT_PROVENANCE'
  );

  // Regression missing shippedCandidate and candidate validation on both rollback and non-rollback paths
  const regressCohort = {
    beforeCohort: buildBaselineCohort(),
    afterCohort: buildCandidateCohort({reworkRateBps: 2000})
  };
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, cohortInput: regressCohort}).reason,
    'MISSING_REVERT_CANDIDATE_META'
  );
  assert.equal(
    evaluateKaizenCohortReadout({
      ...validInput,
      cohortInput: regressCohort,
      shippedCandidate: null
    }).reason,
    'INVALID_CANDIDATE_META'
  );
  assert.equal(
    evaluateKaizenCohortReadout({...validInput, shippedCandidate: undefined}).reason,
    'INVALID_CANDIDATE_META'
  );

  const scBottleneckId = validInput.proposalInput.scorecard.bottlenecks[0].id;
  const validShipped = {
    proposalId: `bottleneck:${SF_REPO_ID}:${scBottleneckId}`,
    repositoryId: SF_REPO_ID,
    laneId: 'sf-velocity-lane',
    targetPaths: ['tools/engineering-factory/stage-latency.mjs'],
    targetRevertCommitSha: '2'.repeat(40)
  };
  assert.equal(
    evaluateKaizenCohortReadout({
      ...validInput,
      shippedCandidate: {...validShipped, targetRevertCommitSha: 'e'.repeat(40)}
    }).reason,
    'UNVERIFIED_CANDIDATE_PROVENANCE'
  );

  // Provenance mismatches against auditTrail record (laneId, targetPaths, ownedPaths, pullNumber, issueNumber, inline provenance)
  const twoChains = [
    buildBoundAuditChain({
      traceSeed: 'a',
      commitSeed: '1',
      squashSeed: '2',
      laneId: 'sf-velocity-lane',
      ownedPaths: ['tools/engineering-factory'],
      touchedPaths: ['tools/engineering-factory/stage-latency.mjs'],
      startedAtMs: 210_000,
      completedAtMs: 220_000,
      pullNumber: 141,
      issueNumber: 137,
      cbOverrides: {humanOwnerSignOffVerified: true}
    })
  ];
  for (const badCandidate of [
    {...validShipped, laneId: 'other-lane'},
    {...validShipped, targetPaths: ['docs/other.md']},
    {...validShipped, ownedPaths: ['tools/engineering-factory/stage-latency.mjs']},
    {...validShipped, pullNumber: 999},
    {...validShipped, issueNumber: 999},
    {
      ...validShipped,
      ownedPaths: ['tools/engineering-factory'],
      provenanceChain: {
        stages: {
          ...twoChains[0].stages,
          eventDelivery: {...twoChains[0].stages.eventDelivery, deliveryId: 'different-delivery'}
        }
      }
    }
  ]) {
    assert.equal(
      evaluateKaizenCohortReadout({
        ...validInput,
        auditChains: twoChains,
        shippedCandidate: badCandidate
      }).reason,
      'CANDIDATE_PROVENANCE_MISMATCH'
    );
  }

  // Proposal mismatches (laneId, targetPaths, scope, or downgrading requiresHumanApproval on governed proposal)
  const govChain = buildBoundAuditChain({
    traceSeed: 'd',
    commitSeed: '7',
    squashSeed: '8',
    laneId: 'sf-governance-lane',
    ownedPaths: ['.github/workflows/ci.yml'],
    cbOverrides: {humanOwnerSignOffVerified: true}
  });
  for (const [chainsToUse, headSha, badPropCandidate] of [
    [
      [validInput.auditChains[0]],
      '2'.repeat(40),
      {...validShipped, proposalId: `failure:${SF_REPO_ID}:wf-drift`}
    ],
    [
      [
        buildBoundAuditChain({
          laneId: 'sf-governance-lane',
          ownedPaths: ['.github/workflows/ci.yml', '.github/workflows/extra.yml'],
          touchedPaths: ['.github/workflows/ci.yml', '.github/workflows/extra.yml'],
          cbOverrides: {humanOwnerSignOffVerified: true}
        })
      ],
      '2'.repeat(40),
      {
        proposalId: `failure:${SF_REPO_ID}:wf-drift`,
        repositoryId: SF_REPO_ID,
        laneId: 'sf-governance-lane',
        targetPaths: ['.github/workflows/ci.yml', '.github/workflows/extra.yml'],
        targetRevertCommitSha: '2'.repeat(40)
      }
    ],
    [
      [validInput.auditChains[0]],
      '2'.repeat(40),
      {...validShipped, scope: 'knowledge-map'}
    ],
    [
      [govChain],
      '8'.repeat(40),
      {
        proposalId: `failure:${SF_REPO_ID}:wf-drift`,
        repositoryId: SF_REPO_ID,
        laneId: 'sf-governance-lane',
        targetPaths: ['.github/workflows/ci.yml'],
        targetRevertCommitSha: '8'.repeat(40),
        requiresHumanApproval: false
      }
    ]
  ]) {
    assert.equal(
      evaluateKaizenCohortReadout({
        ...validInput,
        evaluatedHeadSha: headSha,
        auditChains: chainsToUse,
        shippedCandidate: badPropCandidate
      }).reason,
      'CANDIDATE_PROPOSAL_MISMATCH'
    );
  }
});

test('docs/evidence/m02-07-kaizen-audit-cohort.json deterministically replays Waves 3-4 signals on main @ ec438f54 without live-cohort overclaim', () => {
  const receiptUrl = new URL('../../docs/evidence/m02-07-kaizen-audit-cohort.json', import.meta.url);
  const rawReceipt = readFileSync(receiptUrl, 'utf8');
  const receipt = JSON.parse(rawReceipt);

  assert.equal(receipt.milestone, 'M02.07');
  assert.equal(receipt.issueNumber, 137);
  assert.equal(receipt.repository, 'Jamula/SoftwareFactory');
  assert.equal(receipt.repositoryId, SF_REPO_ID);
  assert.equal(receipt.evaluatedMainHead, 'ec438f54088f30856c2df6ff626e894dde2a0100');
  assert.equal(receipt.liveExecutionDisclosure.evidenceMode, 'pre-cohort-synthetic');
  assert.equal(receipt.liveExecutionDisclosure.syntheticReplayOnly, true);
  assert.equal(receipt.liveExecutionDisclosure.liveAutonomousOutcomesCount, 0);
  assert.equal(receipt.liveExecutionDisclosure.liveCohortVerified, false);
  assert.equal(receipt.liveExecutionDisclosure.issue137ReadyToClose, false);
  assert.equal(receipt.observedWaves3To4Signals.length, 3);

  const pr168Chain = receipt.readoutInput.auditChains.find(c => c.pullNumber === 168 && c.stages.eventDelivery.repositoryId === SF_REPO_ID);
  assert.equal(pr168Chain.stages.exactHeadValidation.ciReceiptId, 'job-140876091369');
  assert.equal(pr168Chain.stages.exactHeadValidation.codeqlReceiptId, 'run-46111508430');
  assert.equal(pr168Chain.stages.exactHeadValidation.coverageReceiptId, 'job-140876259372');
  assert.equal(pr168Chain.stages.verifiedMain.receiptId, 'run-46112285635');

  // Direct replay across queryCausalAuditTrail, proposeOptimisticImprovements, and verifyCohortImprovementOrRollback
  const auditRes = queryCausalAuditTrail(receipt.readoutInput.auditChains, {repositoryId: SF_REPO_ID});
  assert.equal(auditRes.valid, true);
  assert.equal(auditRes.totalRepositoryChains, 5);
  assert.equal(auditRes.isolatedOutCount, 1);

  const propRes = proposeOptimisticImprovements(receipt.readoutInput.proposalInput);
  assert.equal(propRes.valid, true);
  assert.deepEqual(
    propRes.proposals.map(p => p.proposalId),
    receipt.expectedReadoutSummary.proposalCounts.proposalIds
  );
  assert.deepEqual(
    propRes.proposals.filter(p => p.requiresHumanApproval).map(p => p.proposalId),
    receipt.expectedReadoutSummary.proposalCounts.humanApprovalProposalIds
  );
  assert.deepEqual(
    propRes.deferredByOverlap.map(d => d.proposalId),
    receipt.expectedReadoutSummary.proposalCounts.deferredProposalIds
  );

  const cohortRes = verifyCohortImprovementOrRollback(receipt.readoutInput.cohortInput);
  assert.deepEqual(cohortRes, receipt.expectedReadoutSummary.cohortVerdict);

  // Full bound readout replay on ec438f54088f30856c2df6ff626e894dde2a0100
  const readout = evaluateKaizenCohortReadout(receipt.readoutInput);
  assert.equal(readout.valid, receipt.expectedReadoutSummary.valid);
  assert.equal(readout.shadow, receipt.expectedReadoutSummary.shadow);
  assert.equal(readout.readOnly, receipt.expectedReadoutSummary.readOnly);
  assert.equal(readout.liveMutation, receipt.expectedReadoutSummary.liveMutation);
  assert.equal(readout.directMainMutation, receipt.expectedReadoutSummary.directMainMutation);
  assert.equal(readout.autoPolicyMutation, receipt.expectedReadoutSummary.autoPolicyMutation);
  assert.equal(readout.reason, receipt.expectedReadoutSummary.reason);
  assert.equal(readout.repositoryId, receipt.expectedReadoutSummary.repositoryId);
  assert.equal(readout.evaluatedHeadSha, receipt.expectedReadoutSummary.evaluatedHeadSha);
  assert.equal(readout.evidenceMode, receipt.expectedReadoutSummary.evidenceMode);
  assert.equal(readout.syntheticReplayOnly, receipt.expectedReadoutSummary.syntheticReplayOnly);
  assert.equal(readout.liveAutonomousOutcomesCount, receipt.expectedReadoutSummary.liveAutonomousOutcomesCount);
  assert.equal(readout.liveCohortVerified, receipt.expectedReadoutSummary.liveCohortVerified);
  assert.equal(readout.issue137ReadyToClose, receipt.expectedReadoutSummary.issue137ReadyToClose);
  assert.equal(readout.readoutStatus, receipt.expectedReadoutSummary.readoutStatus);
  assert.deepEqual(readout.gatePipelineRequired, receipt.expectedReadoutSummary.gatePipelineRequired);
  assert.equal(readout.revertCandidateSpec, null);

  const {records: _omittedRecords, ...actualProvenanceCounts} = readout.provenanceSummary;
  assert.deepEqual(actualProvenanceCounts, receipt.expectedReadoutSummary.provenanceCounts);
  assert.equal(readout.proposalSummary.totalProposals, receipt.expectedReadoutSummary.proposalCounts.totalProposals);
  assert.equal(
    readout.proposalSummary.repositoryProposalsCount,
    receipt.expectedReadoutSummary.proposalCounts.repositoryProposalsCount
  );
  assert.equal(
    readout.proposalSummary.humanApprovalRequiredCount,
    receipt.expectedReadoutSummary.proposalCounts.humanApprovalRequiredCount
  );
  assert.equal(
    readout.proposalSummary.standardCandidateCount,
    receipt.expectedReadoutSummary.proposalCounts.standardCandidateCount
  );
  assert.equal(readout.proposalSummary.deferredCount, receipt.expectedReadoutSummary.proposalCounts.deferredCount);

  // Regression drills: governed #168 revert spec AND standard #161 revert spec
  const governedRegression = evaluateKaizenCohortReadout({
    ...receipt.readoutInput,
    cohortInput: {
      beforeCohort: receipt.readoutInput.cohortInput.beforeCohort,
      afterCohort: receipt.regressionDrill.regressionAfterCohort
    }
  });
  assert.equal(governedRegression.valid, true);
  assert.equal(governedRegression.readoutStatus, receipt.expectedRegressionDrillSummary.readoutStatus);
  assert.equal(governedRegression.cohortVerdict.rollbackRequired, true);
  assert.deepEqual(
    governedRegression.cohortVerdict.rollbackReasons,
    receipt.expectedRegressionDrillSummary.rollbackReasons
  );
  assert.equal(governedRegression.liveCohortVerified, false);
  assert.equal(governedRegression.issue137ReadyToClose, false);
  for (const [key, expectedVal] of Object.entries(receipt.expectedRegressionDrillSummary.governedRevertSpec)) {
    assert.deepEqual(governedRegression.revertCandidateSpec[key], expectedVal, `governedRevertSpec.${key}`);
  }

  const standardRegression = evaluateKaizenCohortReadout({
    ...receipt.readoutInput,
    cohortInput: {
      beforeCohort: receipt.readoutInput.cohortInput.beforeCohort,
      afterCohort: receipt.regressionDrill.regressionAfterCohort
    },
    shippedCandidate: receipt.regressionDrill.standardShippedCandidate
  });
  assert.equal(standardRegression.valid, true);
  assert.equal(standardRegression.readoutStatus, 'ROLLBACK_REQUIRED');
  for (const [key, expectedVal] of Object.entries(receipt.expectedRegressionDrillSummary.standardRevertSpec)) {
    assert.deepEqual(standardRegression.revertCandidateSpec[key], expectedVal, `standardRevertSpec.${key}`);
  }
});

