using System.Diagnostics;
using SoftwareFactory.Agents.Adapters;
using SoftwareFactory.Agents.Contracts;
using SoftwareFactory.Agents.Telemetry;
using SoftwareFactory.Agents.Workflows;

namespace SoftwareFactory.Agents.Benchmarks;

public static class ThroughputBenchmarkRunner
{
    public static readonly IReadOnlyList<int> StandardLogicalLaneScales = [12, 50, 100];
    public static readonly IReadOnlyList<int> StandardCohortMultipliers = [2, 5, 10, 15, 20, 25];

    public static async Task<BenchmarkSuiteReport> RunStandardBenchmarkAsync(
        IReadOnlyList<CohortSampleInput>? measuredCohortInputs = null,
        CancellationToken cancellationToken = default)
    {
        using var activity = SoftwareFactoryTelemetry.StartStageActivity(
            "benchmark",
            "dotnet-agents",
            0,
            "verified",
            "BENCHMARK_STARTED");

        var laneResults = new List<LogicalLaneSimulationResult>(StandardLogicalLaneScales.Count);
        foreach (int laneScale in StandardLogicalLaneScales)
        {
            LogicalLaneSimulationResult result = await SimulateLogicalLanesAsync(
                logicalLanes: laneScale,
                maxActiveWorkers: 12,
                cancellationToken: cancellationToken).ConfigureAwait(false);
            laneResults.Add(result);
        }

        var cohortResults = new List<CohortComparisonResult>(StandardCohortMultipliers.Count);
        if (measuredCohortInputs is null)
        {
            foreach (int multiplier in StandardCohortMultipliers)
            {
                cohortResults.Add(CreateUnmeasuredCohortPlaceholder(multiplier));
            }
        }
        else
        {
            foreach (CohortSampleInput sample in measuredCohortInputs)
            {
                cohortResults.Add(EvaluateCohortComparison(sample));
            }
        }

        SoftwareFactoryTelemetry.SetStageResult(activity, "verified", "BENCHMARK_COMPLETED");

        return new BenchmarkSuiteReport
        {
            LogicalLaneSimulations = laneResults,
            MatchedCohorts = cohortResults
        };
    }

    public static async Task<LogicalLaneSimulationResult> SimulateLogicalLanesAsync(
        int logicalLanes,
        int maxActiveWorkers,
        CancellationToken cancellationToken = default)
    {
        if (logicalLanes <= 0 || logicalLanes > 500 || maxActiveWorkers <= 0 || maxActiveWorkers > 12)
        {
            throw new ArgumentOutOfRangeException(nameof(logicalLanes), "Logical lanes must be 1..500 and active workers 1..12.");
        }

        var stopwatch = Stopwatch.StartNew();
        using var chatClient = new DeterministicSyntheticChatClient(SyntheticScenario.CleanPassOnFirstIteration);

        var assignedPaths = new List<string>(logicalLanes);
        int duplicatePathLeases = 0;
        for (int index = 0; index < logicalLanes; index++)
        {
            string lanePath = $"src/lane-{index:D3}";
            duplicatePathLeases += assignedPaths.Count(existing => PathOwnershipGuard.PathsOverlap(existing, lanePath));
            assignedPaths.Add(lanePath);
        }

        var concurrencySync = new Lock();
        int activeNow = 0;
        int observedPeakConcurrency = 0;
        int executedBatches = 0;
        int totalSupersteps = 0;
        int acceptedUnits = 0;

        for (int batchStart = 0; batchStart < logicalLanes; batchStart += maxActiveWorkers)
        {
            executedBatches++;
            int batchSize = Math.Min(maxActiveWorkers, logicalLanes - batchStart);
            var batchTasks = new Task<WorkflowExecutionReceipt>[batchSize];

            for (int offset = 0; offset < batchSize; offset++)
            {
                int laneIndex = batchStart + offset;
                string lanePath = assignedPaths[laneIndex];
                batchTasks[offset] = Task.Run(async () =>
                {
                    lock (concurrencySync)
                    {
                        activeNow++;
                        if (activeNow > observedPeakConcurrency)
                        {
                            observedPeakConcurrency = activeNow;
                        }
                    }

                    try
                    {
                        var contract = new WorkItemContract
                        {
                            RepositoryId = WorkItemContract.SoftwareFactoryRepositoryId,
                            RepositorySlug = WorkItemContract.SoftwareFactoryRepositorySlug,
                            HeadSha = "a77612ec77612ec77612ec77612ec77612ec7761",
                            IssueNumber = 1000 + laneIndex,
                            LaneId = $"lane-{laneIndex:D3}",
                            SpecialistRole = "api",
                            OwnedPaths = [lanePath],
                            LineCoverageMin = 98.0,
                            BranchCoverageMin = 95.0,
                            MaxRepairIterations = 1,
                            TraceParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
                        };

                        return await SpecialistWorkflowEngine.ExecuteAsync(
                            new WorkItemEnvelope
                            {
                                Contract = contract,
                                TrustedRepositoryId = WorkItemContract.SoftwareFactoryRepositoryId
                            },
                            chatClient,
                            checkpointStore: null,
                            sessionId: $"bench-{logicalLanes}-{laneIndex:D3}",
                            cancellationToken: cancellationToken).ConfigureAwait(false);
                    }
                    finally
                    {
                        lock (concurrencySync)
                        {
                            activeNow--;
                        }
                    }
                }, cancellationToken);
            }

            WorkflowExecutionReceipt[] batchReceipts = await Task.WhenAll(batchTasks).ConfigureAwait(false);
            totalSupersteps += batchReceipts.Sum(static receipt => receipt.SuperstepsCompleted);
            acceptedUnits += batchReceipts.Count(static receipt => receipt.Decision.Outcome == "eligible");
        }

        stopwatch.Stop();

        return new LogicalLaneSimulationResult
        {
            LogicalLanes = logicalLanes,
            ConfiguredWorkerCap = Math.Min(logicalLanes, maxActiveWorkers),
            ObservedPeakConcurrency = observedPeakConcurrency,
            ExecutedBatches = executedBatches,
            TotalSupersteps = totalSupersteps,
            AcceptedLogicalUnits = acceptedUnits,
            DuplicatePathLeases = duplicatePathLeases,
            CrossRepoLeaks = 0,
            ElapsedMs = Math.Round(stopwatch.Elapsed.TotalMilliseconds, 3)
        };
    }

    public static CohortComparisonResult EvaluateCohortComparison(CohortSampleInput? input)
    {
        if (!HasValidFiniteNumbers(input))
        {
            return DenyCohort(input?.TargetMultiplier ?? 0, "INVALID_COHORT_INPUT", 0.0, 0);
        }

        double rawRatio = input!.CandidateAcceptedPerDay / input.BaselineAcceptedPerDay;
        if (!double.IsFinite(rawRatio))
        {
            return DenyCohort(input.TargetMultiplier, "INVALID_COHORT_INPUT", 0.0, 0);
        }

        int comparableUnits = Math.Min(input.BaselineComparableUnits, input.CandidateComparableUnits);
        double displayRatio = Math.Round(rawRatio, 4);

        if (comparableUnits < 5)
        {
            return DenyCohort(input.TargetMultiplier, "MIN_COMPARABLE_UNITS_REQUIRED", displayRatio, comparableUnits);
        }

        if (input.IncrementalUnapprovedSpendUsd > 0.0 || input.CandidateCostCreditsPerUnit > input.BaselineCostCreditsPerUnit)
        {
            return DenyCohort(input.TargetMultiplier, "COST_REGRESSION_REJECTED", displayRatio, comparableUnits);
        }

        if (input.CandidateLineCoveragePct < 98.0 || input.CandidateLineCoveragePct < input.BaselineLineCoveragePct)
        {
            return DenyCohort(input.TargetMultiplier, "LINE_COVERAGE_REGRESSION_REJECTED", displayRatio, comparableUnits);
        }

        if (input.CandidateBranchCoveragePct < 95.0 || input.CandidateBranchCoveragePct < input.BaselineBranchCoveragePct)
        {
            return DenyCohort(input.TargetMultiplier, "BRANCH_COVERAGE_REGRESSION_REJECTED", displayRatio, comparableUnits);
        }

        if (input.CandidateUnresolvedFindings > 0
            || input.CandidateReworkRate > input.BaselineReworkRate
            || input.CandidateInterventionsPerUnit > input.BaselineInterventionsPerUnit)
        {
            return DenyCohort(input.TargetMultiplier, "QUALITY_OR_REVIEW_REGRESSION_REJECTED", displayRatio, comparableUnits);
        }

        bool achieved = rawRatio >= input.TargetMultiplier;
        if (!input.ProvenanceVerified || !input.CostAccountingVerified)
        {
            return new CohortComparisonResult
            {
                TargetMultiplier = input.TargetMultiplier,
                Eligible = false,
                TargetAchieved = achieved,
                Verified = false,
                SyntheticIllustrativeOnly = true,
                Status = "UNVERIFIED_PROVENANCE_OR_COST",
                ReasonCode = "UNVERIFIED_PROVENANCE_OR_COST",
                MeasuredSpeedupRatio = displayRatio,
                ComparableAcceptedUnits = comparableUnits
            };
        }

        return new CohortComparisonResult
        {
            TargetMultiplier = input.TargetMultiplier,
            Eligible = true,
            TargetAchieved = achieved,
            Verified = achieved,
            SyntheticIllustrativeOnly = false,
            Status = achieved ? "measured-cohort-verified" : "measured-cohort-below-stretch",
            ReasonCode = achieved ? "COHORT_IMPROVEMENT_VERIFIED" : "TARGET_MULTIPLIER_NOT_REACHED",
            MeasuredSpeedupRatio = displayRatio,
            ComparableAcceptedUnits = comparableUnits
        };
    }

    private static bool HasValidFiniteNumbers(CohortSampleInput? input) =>
        input is not null
        && input.RepositoryId > 0
        && double.IsFinite(input.ObservationWindowHours)
        && input.ObservationWindowHours > 0.0
        && input.TargetMultiplier > 0
        && input.BaselineComparableUnits >= 0
        && input.CandidateComparableUnits >= 0
        && double.IsFinite(input.BaselineAcceptedPerDay)
        && input.BaselineAcceptedPerDay > 0.0
        && double.IsFinite(input.CandidateAcceptedPerDay)
        && input.CandidateAcceptedPerDay >= 0.0
        && IsValidPercentage(input.BaselineLineCoveragePct)
        && IsValidPercentage(input.CandidateLineCoveragePct)
        && IsValidPercentage(input.BaselineBranchCoveragePct)
        && IsValidPercentage(input.CandidateBranchCoveragePct)
        && double.IsFinite(input.BaselineCostCreditsPerUnit)
        && input.BaselineCostCreditsPerUnit >= 0.0
        && double.IsFinite(input.CandidateCostCreditsPerUnit)
        && input.CandidateCostCreditsPerUnit >= 0.0
        && double.IsFinite(input.BaselineReworkRate)
        && input.BaselineReworkRate is >= 0.0 and <= 1.0
        && double.IsFinite(input.CandidateReworkRate)
        && input.CandidateReworkRate is >= 0.0 and <= 1.0
        && double.IsFinite(input.BaselineInterventionsPerUnit)
        && input.BaselineInterventionsPerUnit >= 0.0
        && double.IsFinite(input.CandidateInterventionsPerUnit)
        && input.CandidateInterventionsPerUnit >= 0.0
        && double.IsFinite(input.IncrementalUnapprovedSpendUsd)
        && input.IncrementalUnapprovedSpendUsd >= 0.0
        && input.CandidateUnresolvedFindings >= 0;

    private static bool IsValidPercentage(double value) =>
        double.IsFinite(value) && value is >= 0.0 and <= 100.0;

    private static CohortComparisonResult CreateUnmeasuredCohortPlaceholder(int multiplier) =>
        new()
        {
            TargetMultiplier = multiplier,
            Eligible = false,
            TargetAchieved = false,
            Verified = false,
            SyntheticIllustrativeOnly = true,
            Status = "UNMEASURED_BASELINE_REQUIRED",
            ReasonCode = "UNMEASURED_BASELINE_REQUIRED",
            MeasuredSpeedupRatio = 0.0,
            ComparableAcceptedUnits = 0
        };

    private static CohortComparisonResult DenyCohort(int multiplier, string reason, double ratio, int comparableUnits) =>
        new()
        {
            TargetMultiplier = multiplier,
            Eligible = false,
            TargetAchieved = false,
            Verified = false,
            SyntheticIllustrativeOnly = false,
            Status = "blocked",
            ReasonCode = reason,
            MeasuredSpeedupRatio = ratio,
            ComparableAcceptedUnits = comparableUnits
        };
}
