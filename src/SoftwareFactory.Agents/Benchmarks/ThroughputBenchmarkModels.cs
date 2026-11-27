using System.Diagnostics;
using SoftwareFactory.Agents.Adapters;
using SoftwareFactory.Agents.Contracts;
using SoftwareFactory.Agents.Telemetry;
using SoftwareFactory.Agents.Workflows;

namespace SoftwareFactory.Agents.Benchmarks;

public sealed class LogicalLaneSimulationResult
{
    public required int LogicalLanes { get; init; }
    public required int ConfiguredWorkerCap { get; init; }
    public required int ObservedPeakConcurrency { get; init; }
    public required int ExecutedBatches { get; init; }
    public required int TotalSupersteps { get; init; }
    public required int AcceptedLogicalUnits { get; init; }
    public required int DuplicatePathLeases { get; init; }
    public required int CrossRepoLeaks { get; init; }
    public required double ElapsedMs { get; init; }
}

public sealed class CohortSampleInput
{
    public required int TargetMultiplier { get; init; }
    public required int BaselineComparableUnits { get; init; }
    public required int CandidateComparableUnits { get; init; }
    public required double BaselineAcceptedPerDay { get; init; }
    public required double CandidateAcceptedPerDay { get; init; }
    public required double BaselineLineCoveragePct { get; init; }
    public required double CandidateLineCoveragePct { get; init; }
    public required double BaselineBranchCoveragePct { get; init; }
    public required double CandidateBranchCoveragePct { get; init; }
    public required double BaselineCostCreditsPerUnit { get; init; }
    public required double CandidateCostCreditsPerUnit { get; init; }
    public required int CandidateUnresolvedFindings { get; init; }
    public required double IncrementalUnapprovedSpendUsd { get; init; }
}

public sealed class CohortComparisonResult
{
    public required int TargetMultiplier { get; init; }
    public required bool Eligible { get; init; }
    public required bool TargetAchieved { get; init; }
    public required bool Verified { get; init; }
    public required bool SyntheticIllustrativeOnly { get; init; }
    public required string Status { get; init; }
    public required string ReasonCode { get; init; }
    public required double MeasuredSpeedupRatio { get; init; }
    public required int ComparableAcceptedUnits { get; init; }
}

public sealed class BenchmarkSuiteReport
{
    public string Mode { get; init; } = "maf-benchmark";
    public string Framework { get; init; } = "Microsoft.Agents.AI.Workflows";
    public string Version { get; init; } = "1.28.0";
    public bool Shadow { get; init; } = true;
    public bool LiveDispatch { get; init; }
    public bool LiveMerge { get; init; }
    public required IReadOnlyList<LogicalLaneSimulationResult> LogicalLaneSimulations { get; init; }
    public required IReadOnlyList<CohortComparisonResult> MatchedCohorts { get; init; }
}
