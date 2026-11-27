import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOMER_ONE_EVIDENCE_CLASSES,
  CUSTOMER_ONE_METRIC_KEYS,
  CUSTOMER_ONE_SCHEMA_VERSION,
  CUSTOMER_ONE_USABILITY_SLOS,
  ONBOARDING_SCENARIO_KINDS,
  PORTFOLIO_MILESTONES,
  evaluateCustomerOneUsabilityAndPortfolio
} from '../../tools/engineering-factory/customer-one-usability-scorecard.mjs';

const FACTORY_REPO_ID = 1471342715;
const FAMILY_TREE_REPO_ID = 2000000001;
const SPELLBOOK_REPO_ID = 2000000002;
const FAMILY_HUB_REPO_ID = 2000000003;
const AUTHORIZED_REPOS = [
  SPELLBOOK_REPO_ID,
  FACTORY_REPO_ID,
  FAMILY_HUB_REPO_ID,
  FAMILY_TREE_REPO_ID
];

function makeMetrics(overrides = {}) {
  return {
    initialPlanMs: 180_000,
    basicIntegrationMs: 600_000,
    mandatoryUserSettingsCount: 4,
    generatedFilesCount: 2,
    manualInterventionsCount: 0,
    additionalMandatoryServicesCount: 0,
    localSoftwareRequiredCount: 0,
    providerCapacityBlocksCount: 0,
    attributableSpendUsdCents: 0,
    ...overrides
  };
}

function makeObservation(index, overrides = {}) {
  const {metrics: metricOverrides, ...rest} = overrides;
  return {
    id: `obs-${index}`,
    repositoryId: FACTORY_REPO_ID,
    evidenceClass: 'verified-live',
    observedAtMs: 40_000 + index * 1_000,
    milestone: 'M01',
    lane: 'onboarding',
    metrics: makeMetrics(metricOverrides),
    ...rest
  };
}

function makeInput(observations, overrides = {}) {
  return {
    authorizedRepositoryIds: AUTHORIZED_REPOS,
    evidenceClass: 'verified-live',
    fromMs: 10_000,
    toMs: 50_000,
    nowMs: 55_000,
    maxAgeMs: 20_000,
    sourceComplete: true,
    observations,
    ...overrides
  };
}

test('evaluates Customer One provisional usability SLOs and distinguishes verified-live vs synthetic', () => {
  assert.equal(CUSTOMER_ONE_SCHEMA_VERSION, 1);
  assert.deepEqual(CUSTOMER_ONE_EVIDENCE_CLASSES, ['synthetic', 'historical-proxy', 'verified-live']);
  assert.deepEqual(PORTFOLIO_MILESTONES, ['M01', 'M02', 'M03', 'M04', 'M05']);
  assert.deepEqual(ONBOARDING_SCENARIO_KINDS, [
    'blank-repository',
    'existing-repository',
    'customer-one-adoption'
  ]);
  assert.equal(CUSTOMER_ONE_METRIC_KEYS.length, 9);
  assert.deepEqual(CUSTOMER_ONE_USABILITY_SLOS, {
    initialPlanMaxMs: 300_000,
    basicIntegrationMaxMs: 900_000,
    maxMandatoryUserSettingsCount: 5,
    maxManualInterventionsCount: 0,
    maxAdditionalMandatoryServicesCount: 0,
    maxLocalSoftwareRequiredCount: 0,
    maxAttributableSpendUsdCents: 0
  });

  // Exact SLO boundary pass, with explicit credential entries excluded from mandatoryUserSettingsCount <= 5
  const liveObservations = [
    makeObservation(1, {
      scenarioKind: 'customer-one-adoption',
      metrics: {
        initialPlanMs: 300_000,
        basicIntegrationMs: 900_000,
        mandatoryUserSettingsCount: 5,
        explicitCredentialEntryCount: 3,
        generatedFilesCount: 2,
        manualInterventionsCount: 0,
        additionalMandatoryServicesCount: 0,
        localSoftwareRequiredCount: 0,
        providerCapacityBlocksCount: 1,
        attributableSpendUsdCents: 0
      }
    }),
    makeObservation(2, {
      metrics: {
        initialPlanMs: 120_000,
        basicIntegrationMs: 450_000,
        mandatoryUserSettingsCount: 2,
        explicitCredentialEntryCount: 1,
        generatedFilesCount: 3,
        manualInterventionsCount: 0,
        additionalMandatoryServicesCount: 0,
        localSoftwareRequiredCount: 0,
        providerCapacityBlocksCount: 0,
        attributableSpendUsdCents: 0
      }
    })
  ];

  const live = evaluateCustomerOneUsabilityAndPortfolio(makeInput(liveObservations));
  assert.equal(Object.isFrozen(live), true);
  assert.equal(Object.isFrozen(live.usability), true);
  assert.equal(Object.isFrozen(live.perRepository), true);
  assert.equal(live.valid, true);
  assert.equal(live.shadow, true);
  assert.equal(live.readOnly, true);
  assert.equal(live.reason, 'MEASURED_VERIFIED_LIVE');
  assert.equal(live.evidenceClass, 'verified-live');
  assert.equal(live.historicalProxyOnly, false);
  assert.equal(live.provisionalTargetsOnly, false);
  assert.equal(live.liveClaimEligible, true);
  assert.equal(live.observationCount, 2);
  assert.equal(live.lastObservedAtMs, 42_000);
  assert.equal(live.freshnessStatus, 'fresh');
  assert.equal(live.stale, false);
  assert.equal(live.dataCompletenessPct, 100);
  assert.equal(live.usability.overallSloStatus, 'passed');
  assert.equal(live.usability.allSlosMet, true);
  assert.deepEqual(live.usability.explicitCredentialEntries, {
    excludedFromMandatorySettings: true,
    knownCount: 2,
    missingCount: 0,
    total: 4,
    max: 3
  });
  assert.deepEqual(live.usability.byScenario, {
    'blank-repository': 0,
    'existing-repository': 0,
    'customer-one-adoption': 1,
    unspecified: 1
  });
  assert.equal(live.usability.metrics.initialPlanMs.p50, 120_000);
  assert.equal(live.usability.metrics.initialPlanMs.p95, 300_000);
  assert.equal(live.usability.metrics.mandatoryUserSettingsCount.max, 5);
  assert.equal(live.usability.metrics.mandatoryUserSettingsCount.sloStatus, 'passed');
  assert.equal(live.usability.metrics.generatedFilesCount.total, 5);
  assert.equal(live.usability.metrics.generatedFilesCount.sloStatus, 'informational');
  assert.equal(live.usability.metrics.providerCapacityBlocksCount.total, 1);
  assert.equal(live.usability.metrics.providerCapacityBlocksCount.sloStatus, 'informational');
  assert.equal(live.usability.metrics.attributableSpendUsdCents.total, 0);
  assert.equal(live.usability.metrics.attributableSpendUsdCents.sloStatus, 'passed');

  // Synthetic rehearsal with passing SLOs remains provisionalTargetsOnly=true and liveClaimEligible=false
  const syntheticObs = [
    makeObservation(1, {evidenceClass: 'synthetic', scenarioKind: 'blank-repository'}),
    makeObservation(2, {evidenceClass: 'synthetic', scenarioKind: 'existing-repository'})
  ];
  const synthetic = evaluateCustomerOneUsabilityAndPortfolio(
    makeInput(syntheticObs, {evidenceClass: 'synthetic'})
  );
  assert.equal(synthetic.valid, true);
  assert.equal(synthetic.reason, 'MEASURED_SYNTHETIC');
  assert.equal(synthetic.provisionalTargetsOnly, true);
  assert.equal(synthetic.liveClaimEligible, false);
  assert.equal(synthetic.usability.overallSloStatus, 'passed');

  // Every individual Customer One SLO breach fails overallSloStatus and denies liveClaimEligible
  for (const [field, badValue] of [
    ['initialPlanMs', 300_001],
    ['basicIntegrationMs', 900_001],
    ['mandatoryUserSettingsCount', 6],
    ['manualInterventionsCount', 1],
    ['additionalMandatoryServicesCount', 1],
    ['localSoftwareRequiredCount', 1],
    ['attributableSpendUsdCents', 1]
  ]) {
    const failed = evaluateCustomerOneUsabilityAndPortfolio(
      makeInput([makeObservation(1, {metrics: {[field]: badValue}})])
    );
    assert.equal(failed.valid, true);
    assert.equal(failed.usability.metrics[field].sloStatus, 'failed');
    assert.equal(failed.usability.metrics[field].sloMet, false);
    assert.equal(failed.usability.metrics[field].violationCount, 1);
    assert.equal(failed.usability.overallSloStatus, 'failed');
    assert.equal(failed.usability.allSlosMet, false);
    assert.equal(failed.liveClaimEligible, false);
  }
});

test('never substitutes 0 for missing, incomplete, or empty observations and surfaces stale state explicitly', () => {
  // Empty observation window -> null timestamps, completeness, and metric aggregates (never 0)
  const empty = evaluateCustomerOneUsabilityAndPortfolio(makeInput([]));
  assert.equal(empty.valid, true);
  assert.equal(empty.reason, 'PARTIAL_OR_EMPTY_EVIDENCE');
  assert.equal(empty.observationCount, 0);
  assert.equal(empty.lastObservedAtMs, null);
  assert.equal(empty.freshnessStatus, 'unknown');
  assert.equal(empty.stale, null);
  assert.equal(empty.dataCompletenessPct, null);
  assert.equal(empty.usability.overallSloStatus, 'unknown');
  assert.equal(empty.usability.allSlosMet, null);
  assert.equal(empty.usability.explicitCredentialEntries.total, null);
  assert.equal(empty.usability.explicitCredentialEntries.max, null);
  for (const key of CUSTOMER_ONE_METRIC_KEYS) {
    const m = empty.usability.metrics[key];
    assert.equal(m.status, 'unknown');
    assert.equal(m.min, null);
    assert.equal(m.p50, null);
    assert.equal(m.p95, null);
    assert.equal(m.max, null);
    assert.equal(m.total, null);
    assert.equal(m.confirmedTotal, null);
    assert.equal(m.violationCount, null);
    assert.equal(m.sloMet, null);
  }

  // Partial observations: 1 complete (9/9) + 1 missing 3 fields (6/9) => 15/18 = 83.333...% completeness
  const partial = evaluateCustomerOneUsabilityAndPortfolio(makeInput([
    makeObservation(1),
    makeObservation(2, {
      metrics: {
        initialPlanMs: null,
        manualInterventionsCount: null,
        attributableSpendUsdCents: null
      }
    })
  ]));
  assert.equal(partial.valid, true);
  assert.equal(partial.reason, 'PARTIAL_OR_EMPTY_EVIDENCE');
  assert.equal(partial.observationCount, 2);
  assert.equal(partial.dataCompletenessPct, (15 * 100) / 18);
  assert.equal(partial.usability.metrics.initialPlanMs.status, 'partial');
  assert.equal(partial.usability.metrics.initialPlanMs.sloStatus, 'unknown');
  assert.equal(partial.usability.metrics.initialPlanMs.violationCount, null);
  assert.equal(partial.usability.metrics.manualInterventionsCount.total, null);
  assert.equal(partial.usability.metrics.manualInterventionsCount.confirmedTotal, 0);
  assert.equal(partial.usability.metrics.attributableSpendUsdCents.total, null);
  assert.equal(partial.usability.overallSloStatus, 'unknown');
  assert.equal(partial.liveClaimEligible, false);

  // Partial observations where known sample already breached SLO -> sloStatus is 'failed', not masked as 'unknown'
  const partialFailed = evaluateCustomerOneUsabilityAndPortfolio(makeInput([
    makeObservation(1, {metrics: {attributableSpendUsdCents: 25}}),
    makeObservation(2, {metrics: {attributableSpendUsdCents: null}})
  ]));
  assert.equal(partialFailed.usability.metrics.attributableSpendUsdCents.status, 'partial');
  assert.equal(partialFailed.usability.metrics.attributableSpendUsdCents.total, null);
  assert.equal(partialFailed.usability.metrics.attributableSpendUsdCents.confirmedTotal, 25);
  assert.equal(partialFailed.usability.metrics.attributableSpendUsdCents.sloStatus, 'failed');
  assert.equal(partialFailed.usability.metrics.attributableSpendUsdCents.violationCount, 1);
  assert.equal(partialFailed.usability.overallSloStatus, 'failed');

  // Incomplete source inventory (sourceComplete: false) keeps dataCompletenessPct and totals null
  const incompleteSource = evaluateCustomerOneUsabilityAndPortfolio(
    makeInput([makeObservation(1)], {sourceComplete: false})
  );
  assert.equal(incompleteSource.dataCompletenessPct, null);
  assert.equal(incompleteSource.usability.metrics.attributableSpendUsdCents.total, null);
  assert.equal(incompleteSource.usability.overallSloStatus, 'unknown');
  assert.equal(incompleteSource.liveClaimEligible, false);

  // Stale observations (nowMs - lastObservedAtMs > maxAgeMs) report explicit stale state and block live claims
  const staleSc = evaluateCustomerOneUsabilityAndPortfolio(
    makeInput([makeObservation(1, {observedAtMs: 15_000})], {nowMs: 80_000, maxAgeMs: 10_000})
  );
  assert.equal(staleSc.valid, true);
  assert.equal(staleSc.reason, 'STALE_OBSERVATIONS');
  assert.equal(staleSc.freshnessStatus, 'stale');
  assert.equal(staleSc.stale, true);
  assert.equal(staleSc.usability.overallSloStatus, 'stale');
  assert.equal(staleSc.usability.allSlosMet, null);
  assert.equal(staleSc.liveClaimEligible, false);
});

test('supports date-range, milestone (M01-M05), lane, and isolated per-repository portfolio filtering', () => {
  const observations = [
    // Out of window before fromMs (9_999 < 10_000) and at toMs (50_000 >= 50_000)
    makeObservation(0, {id: 'before-window', observedAtMs: 9_999}),
    makeObservation(99, {id: 'at-window-end', observedAtMs: 50_000}),
    // Filtered out by milestone (M02) or lane (docs)
    makeObservation(1, {id: 'm02-row', milestone: 'M02', lane: 'onboarding', observedAtMs: 20_000}),
    makeObservation(2, {id: 'docs-lane', milestone: 'M01', lane: 'docs', observedAtMs: 21_000}),
    // Matching SoftwareFactory M01 onboarding
    makeObservation(3, {
      id: 'sf-m01',
      repositoryId: FACTORY_REPO_ID,
      milestone: 'M01',
      lane: 'onboarding',
      observedAtMs: 25_000
    }),
    // Matching FamilyTree M03 onboarding with an SLO breach (isolated to FamilyTree in perRepository!)
    makeObservation(4, {
      id: 'ft-m03',
      repositoryId: FAMILY_TREE_REPO_ID,
      milestone: 'M03',
      lane: 'onboarding',
      observedAtMs: 35_000,
      metrics: {initialPlanMs: 420_000}
    })
  ];

  const filtered = evaluateCustomerOneUsabilityAndPortfolio(makeInput(observations, {
    filters: {
      repositoryIds: [SPELLBOOK_REPO_ID, FACTORY_REPO_ID, FAMILY_TREE_REPO_ID],
      milestones: ['M03', 'M01'],
      lanes: ['ci-fast', 'onboarding']
    }
  }));

  assert.equal(filtered.valid, true);
  assert.equal(filtered.observationCount, 2);
  assert.equal(filtered.outOfWindowCount, 2);
  assert.equal(filtered.filteredOutCount, 2);
  assert.equal(filtered.lastObservedAtMs, 35_000);
  assert.equal(filtered.dataCompletenessPct, 100);
  assert.deepEqual(filtered.filters, {
    repositoryIds: [FACTORY_REPO_ID, FAMILY_TREE_REPO_ID, SPELLBOOK_REPO_ID],
    milestones: ['M01', 'M03'],
    lanes: ['ci-fast', 'onboarding']
  });

  // Portfolio milestone and lane breakdowns preserve canonical order and report null for empty lanes
  assert.equal(filtered.portfolio.authorizedRepositoryCount, 3);
  assert.equal(filtered.portfolio.observedRepositoryCount, 2);
  assert.deepEqual(filtered.portfolio.byMilestone, [
    {
      milestone: 'M01',
      observationCount: 1,
      lastObservedAtMs: 25_000,
      freshnessStatus: 'stale',
      stale: true,
      dataCompletenessPct: 100
    },
    {
      milestone: 'M03',
      observationCount: 1,
      lastObservedAtMs: 35_000,
      freshnessStatus: 'fresh',
      stale: false,
      dataCompletenessPct: 100
    }
  ]);
  assert.deepEqual(filtered.portfolio.byLane, [
    {
      lane: 'ci-fast',
      observationCount: 0,
      lastObservedAtMs: null,
      freshnessStatus: 'unknown',
      stale: null,
      dataCompletenessPct: null
    },
    {
      lane: 'onboarding',
      observationCount: 2,
      lastObservedAtMs: 35_000,
      freshnessStatus: 'fresh',
      stale: false,
      dataCompletenessPct: 100
    }
  ]);

  // Independent repository isolation: SoftwareFactory passed SLOs, FamilyTree failed, Spellbook is unknown (null)
  const [sfView, ftView, sbView] = filtered.perRepository;
  assert.equal(sfView.repositoryId, FACTORY_REPO_ID);
  assert.equal(sfView.usability.overallSloStatus, 'stale');
  assert.equal(sfView.usability.metrics.initialPlanMs.sloStatus, 'passed');

  assert.equal(ftView.repositoryId, FAMILY_TREE_REPO_ID);
  assert.equal(ftView.usability.overallSloStatus, 'failed');
  assert.equal(ftView.usability.metrics.initialPlanMs.sloStatus, 'failed');

  assert.equal(sbView.repositoryId, SPELLBOOK_REPO_ID);
  assert.equal(sbView.observationCount, 0);
  assert.equal(sbView.lastObservedAtMs, null);
  assert.equal(sbView.dataCompletenessPct, null);
  assert.equal(sbView.usability.overallSloStatus, 'unknown');

  // Unfiltered lanes discover observed lanes deterministically, and explicit undefined filter keys default cleanly
  const openLanes = evaluateCustomerOneUsabilityAndPortfolio(makeInput([
    makeObservation(1, {lane: 'zeta'}),
    makeObservation(2, {lane: 'alpha'})
  ], {
    filters: {repositoryIds: undefined, milestones: undefined, lanes: undefined}
  }));
  assert.deepEqual(openLanes.portfolio.byLane.map(l => l.lane), ['alpha', 'zeta']);
});

test('quarantines historical-proxy evidenceClass and forbids any cross-class or unauthorized mixing', () => {
  const proxyObservations = [
    {
      id: 'proxy-1',
      repositoryId: FACTORY_REPO_ID,
      evidenceClass: 'historical-proxy',
      observedAtMs: 20_000,
      milestone: 'M01',
      lane: 'legacy-history',
      proxyMetrics: {
        issueCreatedToCloseMs: 7_200_000,
        prCreatedToMergeMs: 1_800_000
      }
    },
    {
      id: 'proxy-2',
      repositoryId: FACTORY_REPO_ID,
      evidenceClass: 'historical-proxy',
      observedAtMs: 38_000,
      milestone: 'M02',
      lane: 'legacy-history',
      proxyMetrics: {
        issueCreatedToCloseMs: 3_600_000,
        prCreatedToMergeMs: null
      }
    }
  ];

  const proxySc = evaluateCustomerOneUsabilityAndPortfolio(makeInput(proxyObservations, {
    evidenceClass: 'historical-proxy'
  }));
  assert.equal(proxySc.valid, true);
  assert.equal(proxySc.reason, 'HISTORICAL_PROXY_QUARANTINED');
  assert.equal(proxySc.historicalProxyOnly, true);
  assert.equal(proxySc.provisionalTargetsOnly, true);
  assert.equal(proxySc.liveClaimEligible, false);
  assert.equal(proxySc.usability, null);
  assert.equal(proxySc.observationCount, 2);
  assert.equal(proxySc.lastObservedAtMs, 38_000);
  assert.equal(proxySc.dataCompletenessPct, 75);
  assert.deepEqual(proxySc.historicalProxySummary, {
    nonAutonomousProxyOnly: true,
    issueCreatedToCloseMs: {
      status: 'measured',
      knownCount: 2,
      missingCount: 0,
      p50: 3_600_000,
      p95: 7_200_000
    },
    prCreatedToMergeMs: {
      status: 'partial',
      knownCount: 1,
      missingCount: 1,
      p50: 1_800_000,
      p95: 1_800_000
    }
  });
  // Unobserved repositories in historical-proxy report status: 'unknown' and null percentiles
  const emptyRepoProxy = proxySc.perRepository.find(r => r.repositoryId === FAMILY_TREE_REPO_ID);
  assert.equal(emptyRepoProxy.historicalProxySummary.issueCreatedToCloseMs.status, 'unknown');
  assert.equal(emptyRepoProxy.historicalProxySummary.issueCreatedToCloseMs.p50, null);

  // Mixing evidence classes fails closed even when the intruder is outside the window
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([
      makeObservation(1),
      {...proxyObservations[0], observedAtMs: 1_000}
    ])).reason,
    'EVIDENCE_CLASS_MIXING_FORBIDDEN'
  );
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([
      makeObservation(1, {evidenceClass: 'synthetic'})
    ])).reason,
    'EVIDENCE_CLASS_MIXING_FORBIDDEN'
  );

  // Attaching Customer One usability metrics to historical-proxy or proxyMetrics to verified-live is forbidden
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([
      {...proxyObservations[0], metrics: makeMetrics()}
    ], {evidenceClass: 'historical-proxy'})).reason,
    'EVIDENCE_CLASS_MIXING_FORBIDDEN'
  );
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([
      {...makeObservation(1), proxyMetrics: {issueCreatedToCloseMs: 100, prCreatedToMergeMs: 100}}
    ])).reason,
    'EVIDENCE_CLASS_MIXING_FORBIDDEN'
  );

  // Unauthorized repository in observations or filters fails closed immediately
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([
      makeObservation(1, {repositoryId: 9999999, observedAtMs: 500})
    ])).reason,
    'UNAUTHORIZED_REPOSITORY'
  );
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([], {
      filters: {repositoryIds: [FACTORY_REPO_ID, 9999999]}
    })).reason,
    'UNAUTHORIZED_REPOSITORY'
  );
});

test('compares matched baseline windows and blocks cross-class, mismatched, stale, or incomplete baselines', () => {
  const baseline = evaluateCustomerOneUsabilityAndPortfolio(makeInput([
    makeObservation(1, {
      observedAtMs: 15_000,
      metrics: {
        initialPlanMs: 240_000,
        basicIntegrationMs: 750_000,
        mandatoryUserSettingsCount: 5,
        generatedFilesCount: 3,
        manualInterventionsCount: 0,
        providerCapacityBlocksCount: 2,
        attributableSpendUsdCents: 0
      }
    })
  ], {
    fromMs: 10_000,
    toMs: 30_000,
    nowMs: 32_000,
    maxAgeMs: 20_000
  }));

  const improved = evaluateCustomerOneUsabilityAndPortfolio(makeInput([
    makeObservation(2, {
      observedAtMs: 45_000,
      metrics: {
        initialPlanMs: 120_000,
        basicIntegrationMs: 450_000,
        mandatoryUserSettingsCount: 3,
        generatedFilesCount: 2,
        manualInterventionsCount: 0,
        providerCapacityBlocksCount: 0,
        attributableSpendUsdCents: 0
      }
    })
  ], {
    fromMs: 30_000,
    toMs: 50_000,
    nowMs: 52_000,
    maxAgeMs: 20_000,
    baseline
  }));

  assert.equal(improved.valid, true);
  assert.deepEqual(improved.baselineComparison, {
    comparable: true,
    reason: 'COMPARABLE_WINDOWS',
    evidenceClass: 'verified-live',
    cohortKey: `${FACTORY_REPO_ID}:M01:onboarding:unspecified`,
    sloRegressed: false,
    deltas: {
      initialPlanP50DeltaMs: -120_000,
      basicIntegrationP50DeltaMs: -300_000,
      mandatoryUserSettingsMaxDelta: -2,
      generatedFilesP50Delta: -1,
      manualInterventionsTotalDelta: 0,
      additionalMandatoryServicesTotalDelta: 0,
      localSoftwareRequiredTotalDelta: 0,
      providerCapacityBlocksTotalDelta: -2,
      attributableSpendTotalDeltaUsdCents: 0
    }
  });

  // Unmatched observed cohorts (different repo, milestone, lane, scenario, or heterogeneous multi-cohort mix)
  // return COHORT_MISMATCH even when filter allowlists match
  for (const mismatchCandidateObs of [
    [makeObservation(2, {observedAtMs: 45_000, repositoryId: FAMILY_TREE_REPO_ID})],
    [makeObservation(2, {observedAtMs: 45_000, milestone: 'M03'})],
    [makeObservation(2, {observedAtMs: 45_000, lane: 'migration'})],
    [makeObservation(2, {observedAtMs: 45_000, scenarioKind: 'existing-repository'})],
    [
      makeObservation(2, {id: 'mix-1', observedAtMs: 44_000, repositoryId: FACTORY_REPO_ID}),
      makeObservation(3, {id: 'mix-2', observedAtMs: 45_000, repositoryId: FAMILY_TREE_REPO_ID})
    ]
  ]) {
    const mismatch = evaluateCustomerOneUsabilityAndPortfolio(makeInput(mismatchCandidateObs, {
      fromMs: 30_000,
      toMs: 50_000,
      nowMs: 52_000,
      maxAgeMs: 20_000,
      baseline
    }));
    assert.equal(mismatch.baselineComparison.comparable, false);
    assert.equal(mismatch.baselineComparison.reason, 'COHORT_MISMATCH');
    assert.equal(mismatch.baselineComparison.cohortKey, null);
  }

  // Regression detection when SLO fails or manual interventions / spend increase
  const regressed = evaluateCustomerOneUsabilityAndPortfolio(makeInput([
    makeObservation(2, {
      observedAtMs: 45_000,
      metrics: {attributableSpendUsdCents: 10}
    })
  ], {
    fromMs: 30_000,
    toMs: 50_000,
    nowMs: 52_000,
    maxAgeMs: 20_000,
    baseline
  }));
  assert.equal(regressed.baselineComparison.comparable, true);
  assert.equal(regressed.baselineComparison.sloRegressed, true);

  // Regression detection when spend worsens even if baseline already failed that metric
  const failedBaseline = evaluateCustomerOneUsabilityAndPortfolio(makeInput([
    makeObservation(1, {observedAtMs: 15_000, metrics: {attributableSpendUsdCents: 10}})
  ], {
    fromMs: 10_000,
    toMs: 30_000,
    nowMs: 32_000,
    maxAgeMs: 20_000
  }));
  const worsened = evaluateCustomerOneUsabilityAndPortfolio(makeInput([
    makeObservation(2, {observedAtMs: 45_000, metrics: {attributableSpendUsdCents: 20}})
  ], {
    fromMs: 30_000,
    toMs: 50_000,
    nowMs: 52_000,
    maxAgeMs: 20_000,
    baseline: failedBaseline
  }));
  assert.equal(worsened.baselineComparison.sloRegressed, true);

  // Explicit null baseline leaves baselineComparison null
  const nullBaseline = evaluateCustomerOneUsabilityAndPortfolio(makeInput([makeObservation(1)], {baseline: null}));
  assert.equal(nullBaseline.baselineComparison, null);

  // Cross-class baseline fails closed
  const syntheticBaseline = evaluateCustomerOneUsabilityAndPortfolio(makeInput([
    makeObservation(1, {evidenceClass: 'synthetic', observedAtMs: 15_000})
  ], {
    evidenceClass: 'synthetic',
    fromMs: 10_000,
    toMs: 30_000,
    nowMs: 32_000
  }));
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([makeObservation(2, {observedAtMs: 45_000})], {
      fromMs: 30_000,
      toMs: 50_000,
      nowMs: 52_000,
      baseline: syntheticBaseline
    })).reason,
    'EVIDENCE_CLASS_MIXING_FORBIDDEN'
  );

  // Scope mismatch (lane filter differs, or both non-null lanes differ)
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([makeObservation(2, {observedAtMs: 45_000})], {
      fromMs: 30_000,
      toMs: 50_000,
      nowMs: 52_000,
      filters: {lanes: ['onboarding']},
      baseline
    })).baselineComparison.reason,
    'SCOPE_MISMATCH'
  );
  const laneFilteredBaseline = evaluateCustomerOneUsabilityAndPortfolio(makeInput([
    makeObservation(1, {observedAtMs: 15_000, lane: 'alpha'})
  ], {
    fromMs: 10_000,
    toMs: 30_000,
    nowMs: 32_000,
    filters: {lanes: ['alpha']}
  }));
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([
      makeObservation(2, {observedAtMs: 45_000, lane: 'beta'})
    ], {
      fromMs: 30_000,
      toMs: 50_000,
      nowMs: 52_000,
      filters: {lanes: ['beta']},
      baseline: laneFilteredBaseline
    })).baselineComparison.reason,
    'SCOPE_MISMATCH'
  );

  // Overlapping or unequal windows
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([makeObservation(2, {observedAtMs: 35_000})], {
      fromMs: 25_000,
      toMs: 45_000,
      nowMs: 50_000,
      baseline
    })).baselineComparison.reason,
    'WINDOWS_NOT_COMPARABLE'
  );

  // Historical-proxy baselines are never comparable for usability claims
  const proxyBase = evaluateCustomerOneUsabilityAndPortfolio(makeInput([], {
    evidenceClass: 'historical-proxy',
    fromMs: 10_000,
    toMs: 30_000,
    nowMs: 32_000
  }));
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([], {
      evidenceClass: 'historical-proxy',
      fromMs: 30_000,
      toMs: 50_000,
      nowMs: 52_000,
      baseline: proxyBase
    })).baselineComparison.reason,
    'HISTORICAL_PROXY_NOT_COMPARABLE'
  );

  // Incomplete or genuinely stale baseline or candidate returns INCOMPLETE_OR_STALE_EVIDENCE
  const emptyBaseline = evaluateCustomerOneUsabilityAndPortfolio(makeInput([], {
    fromMs: 10_000,
    toMs: 30_000,
    nowMs: 32_000
  }));
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([makeObservation(2, {observedAtMs: 45_000})], {
      fromMs: 30_000,
      toMs: 50_000,
      nowMs: 52_000,
      baseline: emptyBaseline
    })).baselineComparison.reason,
    'INCOMPLETE_OR_STALE_EVIDENCE'
  );
  const staleBaseline = evaluateCustomerOneUsabilityAndPortfolio(makeInput([
    makeObservation(1, {observedAtMs: 15_000})
  ], {
    fromMs: 10_000,
    toMs: 30_000,
    nowMs: 32_000,
    maxAgeMs: 10_000
  }));
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([makeObservation(2, {observedAtMs: 45_000})], {
      fromMs: 30_000,
      toMs: 50_000,
      nowMs: 52_000,
      baseline: staleBaseline
    })).baselineComparison.reason,
    'INCOMPLETE_OR_STALE_EVIDENCE'
  );
  const incompleteSourceBaseline = evaluateCustomerOneUsabilityAndPortfolio(makeInput([
    makeObservation(1, {observedAtMs: 15_000})
  ], {
    fromMs: 10_000,
    toMs: 30_000,
    nowMs: 32_000,
    maxAgeMs: 20_000,
    sourceComplete: false
  }));
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([makeObservation(2, {observedAtMs: 45_000})], {
      fromMs: 30_000,
      toMs: 50_000,
      nowMs: 52_000,
      baseline: incompleteSourceBaseline
    })).baselineComparison.reason,
    'INCOMPLETE_OR_STALE_EVIDENCE'
  );

  // Invalid / forged baselines (including tampered freshnessStatus/stale/timestamps) fail closed with INVALID_BASELINE
  for (const badBaseline of [
    'not-an-object',
    {},
    {...baseline, evidenceClass: 'unknown-class'},
    {...baseline, valid: false},
    {...baseline, window: {...baseline.window, nowMs: 10_000}},
    {...staleBaseline, freshnessStatus: 'fresh'},
    {
      ...staleBaseline,
      freshnessStatus: 'fresh',
      stale: false,
      portfolio: {...staleBaseline.portfolio, freshnessStatus: 'fresh', stale: false}
    },
    {
      ...baseline,
      lastObservedAtMs: 5_000,
      portfolio: {...baseline.portfolio, lastObservedAtMs: 5_000}
    },
    {...baseline, portfolio: {...baseline.portfolio, observedCohortKeys: []}},
    {...baseline, portfolio: {...baseline.portfolio, observedCohortKeys: ['bad-cohort']}},
    {...baseline, historicalProxySummary: {nonAutonomousProxyOnly: true}},
    {...baseline, usability: null},
    {...baseline, usability: {...baseline.usability, overallSloStatus: 'failed'}},
    {
      ...baseline,
      usability: {
        ...baseline.usability,
        overallSloStatus: 'failed',
        allSlosMet: false,
        metrics: {
          ...baseline.usability.metrics,
          initialPlanMs: {
            ...baseline.usability.metrics.initialPlanMs,
            sloStatus: 'failed',
            sloMet: false,
            violationCount: 1
          }
        }
      }
    },
    {
      ...failedBaseline,
      usability: {
        ...failedBaseline.usability,
        metrics: {
          ...failedBaseline.usability.metrics,
          attributableSpendUsdCents: {
            ...failedBaseline.usability.metrics.attributableSpendUsdCents,
            total: 20
          }
        }
      }
    },
    {
      ...failedBaseline,
      usability: {
        ...failedBaseline.usability,
        metrics: {
          ...failedBaseline.usability.metrics,
          attributableSpendUsdCents: {
            ...failedBaseline.usability.metrics.attributableSpendUsdCents,
            total: 20,
            confirmedTotal: 20
          }
        }
      }
    },
    {
      ...baseline,
      usability: {
        ...baseline.usability,
        metrics: {
          ...baseline.usability.metrics,
          initialPlanMs: {...baseline.usability.metrics.initialPlanMs, total: 100}
        }
      }
    },
    {
      ...baseline,
      usability: {
        ...baseline.usability,
        metrics: {
          ...baseline.usability.metrics,
          generatedFilesCount: {...baseline.usability.metrics.generatedFilesCount, sloStatus: 'passed'}
        }
      }
    },
    {
      ...baseline,
      usability: {
        ...baseline.usability,
        metrics: {
          ...baseline.usability.metrics,
          initialPlanMs: {...baseline.usability.metrics.initialPlanMs, p50: null}
        }
      }
    }
  ]) {
    assert.equal(
      evaluateCustomerOneUsabilityAndPortfolio(makeInput([makeObservation(2, {observedAtMs: 45_000})], {
        fromMs: 30_000,
        toMs: 50_000,
        nowMs: 52_000,
        baseline: badBaseline
      })).reason,
      'INVALID_BASELINE'
    );
  }
});

test('enforces strict Proxy, getter, plain-object, deduplication, timestamp, and safe-integer bounds', () => {
  // Top-level Proxy, null, getter, and extra-key rejections without invoking accessors
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(new Proxy(makeInput([]), {})).reason,
    'INVALID_INPUT'
  );
  assert.equal(evaluateCustomerOneUsabilityAndPortfolio(null).reason, 'INVALID_INPUT');
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio({...makeInput([]), rawPrompt: 'forbidden'}).reason,
    'INVALID_INPUT'
  );

  let getterInvoked = false;
  const inputWithGetter = makeInput([]);
  Object.defineProperty(inputWithGetter, 'evidenceClass', {
    enumerable: true,
    get() {
      getterInvoked = true;
      return 'verified-live';
    }
  });
  assert.equal(evaluateCustomerOneUsabilityAndPortfolio(inputWithGetter).reason, 'INVALID_INPUT');
  assert.equal(getterInvoked, false);

  const obsWithMetricGetter = makeObservation(1);
  Object.defineProperty(obsWithMetricGetter.metrics, 'initialPlanMs', {
    enumerable: true,
    get() {
      getterInvoked = true;
      return 1_000;
    }
  });
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([obsWithMetricGetter])).reason,
    'INVALID_OBSERVATION'
  );
  assert.equal(getterInvoked, false);

  // Sparse arrays, Array proxies, and custom prototypes
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput(new Proxy([], {}))).reason,
    'INVALID_OBSERVATIONS'
  );
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput(new Array(1))).reason,
    'INVALID_OBSERVATIONS'
  );
  const extraPropArray = [];
  extraPropArray.extra = 1;
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput(extraPropArray)).reason,
    'INVALID_OBSERVATIONS'
  );

  // Authorized repository list, evidenceClass, window, and filter validation
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([], {authorizedRepositoryIds: []})).reason,
    'INVALID_AUTHORIZED_REPOSITORIES'
  );
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([], {
      authorizedRepositoryIds: [FACTORY_REPO_ID, FACTORY_REPO_ID]
    })).reason,
    'INVALID_AUTHORIZED_REPOSITORIES'
  );
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([], {evidenceClass: 'bogus'})).reason,
    'INVALID_EVIDENCE_CLASS'
  );
  for (const badWindow of [
    {fromMs: 50_000, toMs: 10_000},
    {nowMs: 40_000},
    {maxAgeMs: 0},
    {sourceComplete: 'yes'}
  ]) {
    assert.equal(
      evaluateCustomerOneUsabilityAndPortfolio(makeInput([], badWindow)).reason,
      'INVALID_WINDOW'
    );
  }
  for (const badFilters of [
    null,
    {unknownFilter: []},
    {repositoryIds: []},
    {milestones: ['M06']},
    {lanes: ['BAD LANE']}
  ]) {
    assert.equal(
      evaluateCustomerOneUsabilityAndPortfolio(makeInput([], {filters: badFilters})).reason,
      'INVALID_FILTERS'
    );
  }

  // Invalid observations, duplicate IDs, future timestamps, and overflow protection
  for (const badObs of [
    null,
    new Proxy(makeObservation(1), {}),
    makeObservation(1, {evidenceClass: 'bogus'}),
    makeObservation(1, {id: 'bad id!'}),
    makeObservation(1, {milestone: 'M06'}),
    makeObservation(1, {lane: 'BadLane'}),
    makeObservation(1, {scenarioKind: 'unknown-scenario'}),
    makeObservation(1, {metrics: {initialPlanMs: -1}}),
    makeObservation(1, {metrics: {explicitCredentialEntryCount: -1}}),
    {...makeObservation(1), actorToken: 'ghp_secret'}
  ]) {
    assert.equal(
      evaluateCustomerOneUsabilityAndPortfolio(makeInput([badObs])).reason,
      'INVALID_OBSERVATION'
    );
  }
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([
      {
        id: 'p1',
        repositoryId: FACTORY_REPO_ID,
        evidenceClass: 'historical-proxy',
        observedAtMs: 20_000,
        milestone: 'M01',
        lane: 'history',
        proxyMetrics: {issueCreatedToCloseMs: -5, prCreatedToMergeMs: 10}
      }
    ], {evidenceClass: 'historical-proxy'})).reason,
    'INVALID_OBSERVATION'
  );

  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([
      makeObservation(1, {id: 'dup-1'}),
      makeObservation(2, {id: 'dup-1'})
    ])).reason,
    'DUPLICATE_OBSERVATION_ID'
  );
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([
      makeObservation(1, {observedAtMs: 99_999})
    ])).reason,
    'FUTURE_OBSERVATION_TIMESTAMP'
  );

  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([
      makeObservation(1, {metrics: {generatedFilesCount: Number.MAX_SAFE_INTEGER}}),
      makeObservation(2, {metrics: {generatedFilesCount: 1}})
    ])).reason,
    'UNSAFE_AGGREGATE_TOTAL'
  );
  assert.equal(
    evaluateCustomerOneUsabilityAndPortfolio(makeInput([
      makeObservation(1, {metrics: {explicitCredentialEntryCount: Number.MAX_SAFE_INTEGER}}),
      makeObservation(2, {metrics: {explicitCredentialEntryCount: 1}})
    ])).reason,
    'UNSAFE_AGGREGATE_TOTAL'
  );
});
