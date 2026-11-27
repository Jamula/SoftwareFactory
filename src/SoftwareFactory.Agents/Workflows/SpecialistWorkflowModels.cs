using SoftwareFactory.Agents.Contracts;

namespace SoftwareFactory.Agents.Workflows;

public sealed class WorkItemEnvelope
{
    public required WorkItemContract Contract { get; init; }
    public required long TrustedRepositoryId { get; init; }
}

public sealed class CoderWorkOrder
{
    public required WorkItemContract Contract { get; init; }
    public required long TrustedRepositoryId { get; init; }
    public required int Iteration { get; init; }
    public required IReadOnlyList<string> PlannedPaths { get; init; }
    public required bool IsBlocked { get; init; }
    public required string BlockReason { get; init; }
}

public sealed class CandidatePatch
{
    public required WorkItemContract Contract { get; init; }
    public required long TrustedRepositoryId { get; init; }
    public required int Iteration { get; init; }
    public required IReadOnlyList<string> TouchedPaths { get; init; }
    public required bool IsIsolated { get; init; }
    public required string IsolationReason { get; init; }
}

public enum VerificationKind
{
    TestAndCoverage = 0,
    SecurityAndReview = 1
}

public sealed class VerificationReport
{
    public required VerificationKind Kind { get; init; }
    public required WorkItemContract Contract { get; init; }
    public required long TrustedRepositoryId { get; init; }
    public required int Iteration { get; init; }
    public required IReadOnlyList<string> TouchedPaths { get; init; }
    public required bool Passed { get; init; }
    public required bool Repairable { get; init; }
    public required string ReasonCode { get; init; }
    public required double LineCoveragePct { get; init; }
    public required double BranchCoveragePct { get; init; }
    public required bool SecurityClear { get; init; }
    public required bool ReviewClear { get; init; }
}

public sealed class AggregatorState
{
    public VerificationReport? PendingTestReport { get; set; }
    public VerificationReport? PendingSecurityReport { get; set; }
}

public sealed class GateEvaluationOutcome
{
    public required bool NeedsRepair { get; init; }
    public CoderWorkOrder? NextWorkOrder { get; init; }
    public WorkflowGateDecision? FinalDecision { get; init; }
}

public sealed class WorkflowGateDecision
{
    public required string Outcome { get; init; }
    public required string ReasonCode { get; init; }
    public required long RepositoryId { get; init; }
    public required int IssueNumber { get; init; }
    public required string LaneId { get; init; }
    public required string HeadSha { get; init; }
    public required int IterationsCompleted { get; init; }
    public required int RepairIterationsUsed { get; init; }
    public required double LineCoveragePct { get; init; }
    public required double BranchCoveragePct { get; init; }
    public required bool SecurityClear { get; init; }
    public required bool ReviewClear { get; init; }
    public required IReadOnlyList<string> VerifiedPaths { get; init; }
    public bool Shadow { get; init; } = true;
    public bool LiveDispatch { get; init; }
    public bool LiveMerge { get; init; }
}

public sealed class ExecutorInvocationCounts
{
    public int PlannerInvocations { get; set; }
    public int CoderInvocations { get; set; }
    public int TestAndCoverageInvocations { get; set; }
    public int SecurityAndReviewInvocations { get; set; }
    public int GateAggregatorInvocations { get; set; }
}

public sealed class WorkflowExecutionReceipt
{
    public required WorkflowGateDecision Decision { get; init; }
    public required int SuperstepsCompleted { get; init; }
    public required ExecutorInvocationCounts Invocations { get; init; }
}
