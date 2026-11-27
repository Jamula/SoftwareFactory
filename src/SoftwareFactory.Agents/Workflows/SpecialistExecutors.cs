using System.Text.Json;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;
using SoftwareFactory.Agents.Adapters;
using SoftwareFactory.Agents.Contracts;
using SoftwareFactory.Agents.Telemetry;

namespace SoftwareFactory.Agents.Workflows;

public static class SpecialistPromptHelper
{
    public static async ValueTask<SpecialistAgentPayload> InvokeSpecialistAsync(
        AIAgent agent,
        string stage,
        WorkItemContract contract,
        int iteration,
        CancellationToken cancellationToken)
    {
        var prompt = new SpecialistPromptRequest
        {
            Stage = stage,
            RepositoryId = contract.RepositoryId,
            Iteration = iteration,
            OwnedPaths = contract.OwnedPaths
        };

        string requestJson = JsonSerializer.Serialize(prompt);
        AgentResponse response = await agent.RunAsync(requestJson, session: null, options: null, cancellationToken).ConfigureAwait(false);
        return JsonSerializer.Deserialize<SpecialistAgentPayload>(response.Text)
            ?? throw new InvalidOperationException("INVALID_SPECIALIST_RESPONSE");
    }
}

public sealed class PlannerExecutor : Executor<WorkItemEnvelope, CoderWorkOrder>
{
    private readonly AIAgent _agent;
    private readonly ExecutorInvocationCounts _counts;

    public PlannerExecutor(AIAgent agent, ExecutorInvocationCounts counts)
        : base("planner")
    {
        _agent = agent;
        _counts = counts;
    }

    public override async ValueTask<CoderWorkOrder> HandleAsync(
        WorkItemEnvelope message,
        IWorkflowContext context,
        CancellationToken cancellationToken = default)
    {
        _counts.PlannerInvocations++;
        WorkItemContract? contract = message.Contract;
        string lane = contract?.LaneId ?? "invalid-lane";
        string? traceParent = contract?.TraceParent;

        using var activity = SoftwareFactoryTelemetry.StartStageActivity("planner", lane, 0, "eligible", "PLANNING", traceParent);
        ContractValidationResult contractCheck = PathOwnershipGuard.ValidateContract(contract, message.TrustedRepositoryId);
        if (!contractCheck.IsValid)
        {
            SoftwareFactoryTelemetry.SetStageResult(activity, "blocked", contractCheck.ReasonCode);
            return new CoderWorkOrder
            {
                Contract = CreateFallbackContract(contract),
                TrustedRepositoryId = message.TrustedRepositoryId,
                Iteration = 0,
                PlannedPaths = [],
                IsBlocked = true,
                BlockReason = contractCheck.ReasonCode
            };
        }

        SpecialistAgentPayload plan = await SpecialistPromptHelper.InvokeSpecialistAsync(
            _agent,
            "planner",
            contract!,
            iteration: 0,
            cancellationToken).ConfigureAwait(false);

        ContractValidationResult pathCheck = PathOwnershipGuard.ValidateCandidatePaths(
            contract!,
            plan.CandidateRepositoryId,
            plan.ProposedPaths);

        if (!pathCheck.IsValid)
        {
            SoftwareFactoryTelemetry.SetStageResult(activity, "blocked", pathCheck.ReasonCode);
            return new CoderWorkOrder
            {
                Contract = contract!,
                TrustedRepositoryId = message.TrustedRepositoryId,
                Iteration = 0,
                PlannedPaths = [],
                IsBlocked = true,
                BlockReason = pathCheck.ReasonCode
            };
        }

        SoftwareFactoryTelemetry.SetStageResult(activity, "eligible", "CONTRACT_PLANNED");
        return new CoderWorkOrder
        {
            Contract = contract!,
            TrustedRepositoryId = message.TrustedRepositoryId,
            Iteration = 0,
            PlannedPaths = plan.ProposedPaths,
            IsBlocked = false,
            BlockReason = "NONE"
        };
    }

    private static WorkItemContract CreateFallbackContract(WorkItemContract? contract) =>
        contract ?? new WorkItemContract
        {
            RepositoryId = 0,
            RepositorySlug = "invalid/invalid",
            HeadSha = new string('0', 40),
            IssueNumber = 0,
            LaneId = "invalid-lane",
            SpecialistRole = "coordinator",
            OwnedPaths = [],
            LineCoverageMin = 98.0,
            BranchCoverageMin = 95.0,
            MaxRepairIterations = 0,
            TraceParent = string.Empty
        };
}

public sealed class BlockedOrderToDecisionExecutor : Executor<CoderWorkOrder, GateEvaluationOutcome>
{
    public BlockedOrderToDecisionExecutor()
        : base("blocked-plan-router")
    {
    }

    public override ValueTask<GateEvaluationOutcome> HandleAsync(
        CoderWorkOrder message,
        IWorkflowContext context,
        CancellationToken cancellationToken = default)
    {
        var decision = new WorkflowGateDecision
        {
            Outcome = "blocked",
            ReasonCode = message.BlockReason,
            RepositoryId = message.Contract.RepositoryId,
            IssueNumber = message.Contract.IssueNumber,
            LaneId = message.Contract.LaneId,
            HeadSha = message.Contract.HeadSha,
            IterationsCompleted = 0,
            RepairIterationsUsed = 0,
            LineCoveragePct = 0.0,
            BranchCoveragePct = 0.0,
            SecurityClear = false,
            ReviewClear = false,
            VerifiedPaths = []
        };

        return ValueTask.FromResult(new GateEvaluationOutcome
        {
            NeedsRepair = false,
            FinalDecision = decision
        });
    }
}

public sealed class CoderExecutor : Executor<CoderWorkOrder, CandidatePatch>
{
    private readonly AIAgent _agent;
    private readonly ExecutorInvocationCounts _counts;

    public CoderExecutor(AIAgent agent, ExecutorInvocationCounts counts)
        : base("coder")
    {
        _agent = agent;
        _counts = counts;
    }

    public override async ValueTask<CandidatePatch> HandleAsync(
        CoderWorkOrder message,
        IWorkflowContext context,
        CancellationToken cancellationToken = default)
    {
        _counts.CoderInvocations++;
        using var activity = SoftwareFactoryTelemetry.StartStageActivity(
            "coder",
            message.Contract.LaneId,
            message.Iteration + 1,
            "eligible",
            "CODING",
            message.Contract.TraceParent);

        SpecialistAgentPayload patch = await SpecialistPromptHelper.InvokeSpecialistAsync(
            _agent,
            "coder",
            message.Contract,
            message.Iteration,
            cancellationToken).ConfigureAwait(false);

        ContractValidationResult pathCheck = PathOwnershipGuard.ValidateCandidatePaths(
            message.Contract,
            patch.CandidateRepositoryId,
            patch.ProposedPaths);

        SoftwareFactoryTelemetry.SetStageResult(
            activity,
            pathCheck.IsValid ? "eligible" : "blocked",
            pathCheck.IsValid ? "CANDIDATE_PATCH_READY" : pathCheck.ReasonCode);

        return new CandidatePatch
        {
            Contract = message.Contract,
            TrustedRepositoryId = message.TrustedRepositoryId,
            Iteration = message.Iteration,
            TouchedPaths = pathCheck.IsValid ? patch.ProposedPaths : [],
            IsIsolated = pathCheck.IsValid,
            IsolationReason = pathCheck.ReasonCode
        };
    }
}

public sealed class TestAndCoverageExecutor : Executor<CandidatePatch, VerificationReport>
{
    private readonly AIAgent _agent;
    private readonly ExecutorInvocationCounts _counts;

    public TestAndCoverageExecutor(AIAgent agent, ExecutorInvocationCounts counts)
        : base("test-and-coverage")
    {
        _agent = agent;
        _counts = counts;
    }

    public override async ValueTask<VerificationReport> HandleAsync(
        CandidatePatch message,
        IWorkflowContext context,
        CancellationToken cancellationToken = default)
    {
        _counts.TestAndCoverageInvocations++;
        using var activity = SoftwareFactoryTelemetry.StartStageActivity(
            "test-and-coverage",
            message.Contract.LaneId,
            message.Iteration + 2,
            "eligible",
            "VERIFYING_TESTS",
            message.Contract.TraceParent);

        if (!message.IsIsolated)
        {
            SoftwareFactoryTelemetry.SetStageResult(activity, "blocked", message.IsolationReason);
            return new VerificationReport
            {
                Kind = VerificationKind.TestAndCoverage,
                Contract = message.Contract,
                TrustedRepositoryId = message.TrustedRepositoryId,
                Iteration = message.Iteration,
                TouchedPaths = [],
                Passed = false,
                Repairable = false,
                ReasonCode = message.IsolationReason,
                LineCoveragePct = 0.0,
                BranchCoveragePct = 0.0,
                SecurityClear = false,
                ReviewClear = false
            };
        }

        SpecialistAgentPayload result = await SpecialistPromptHelper.InvokeSpecialistAsync(
            _agent,
            "test-and-coverage",
            message.Contract,
            message.Iteration,
            cancellationToken).ConfigureAwait(false);

        bool coverageMet = result.TestsPassed
            && result.LineCoveragePct >= message.Contract.LineCoverageMin
            && result.BranchCoveragePct >= message.Contract.BranchCoverageMin;

        string reason = coverageMet ? "COVERAGE_VERIFIED" : "COVERAGE_INCOMPLETE";
        SoftwareFactoryTelemetry.SetStageResult(activity, coverageMet ? "eligible" : "blocked", reason);

        return new VerificationReport
        {
            Kind = VerificationKind.TestAndCoverage,
            Contract = message.Contract,
            TrustedRepositoryId = message.TrustedRepositoryId,
            Iteration = message.Iteration,
            TouchedPaths = message.TouchedPaths,
            Passed = coverageMet,
            Repairable = !coverageMet && result.Repairable,
            ReasonCode = reason,
            LineCoveragePct = result.LineCoveragePct,
            BranchCoveragePct = result.BranchCoveragePct,
            SecurityClear = true,
            ReviewClear = true
        };
    }
}

public sealed class SecurityAndReviewExecutor : Executor<CandidatePatch, VerificationReport>
{
    private readonly AIAgent _agent;
    private readonly ExecutorInvocationCounts _counts;

    public SecurityAndReviewExecutor(AIAgent agent, ExecutorInvocationCounts counts)
        : base("security-and-review")
    {
        _agent = agent;
        _counts = counts;
    }

    public override async ValueTask<VerificationReport> HandleAsync(
        CandidatePatch message,
        IWorkflowContext context,
        CancellationToken cancellationToken = default)
    {
        _counts.SecurityAndReviewInvocations++;
        using var activity = SoftwareFactoryTelemetry.StartStageActivity(
            "security-and-review",
            message.Contract.LaneId,
            message.Iteration + 2,
            "eligible",
            "VERIFYING_SECURITY",
            message.Contract.TraceParent);

        if (!message.IsIsolated)
        {
            SoftwareFactoryTelemetry.SetStageResult(activity, "blocked", message.IsolationReason);
            return new VerificationReport
            {
                Kind = VerificationKind.SecurityAndReview,
                Contract = message.Contract,
                TrustedRepositoryId = message.TrustedRepositoryId,
                Iteration = message.Iteration,
                TouchedPaths = [],
                Passed = false,
                Repairable = false,
                ReasonCode = message.IsolationReason,
                LineCoveragePct = 0.0,
                BranchCoveragePct = 0.0,
                SecurityClear = false,
                ReviewClear = false
            };
        }

        SpecialistAgentPayload result = await SpecialistPromptHelper.InvokeSpecialistAsync(
            _agent,
            "security-and-review",
            message.Contract,
            message.Iteration,
            cancellationToken).ConfigureAwait(false);

        bool passed = result.SecurityClear && result.ReviewClear;
        string reason = passed ? "SECURITY_AND_REVIEW_CLEAR" : "SECURITY_OR_REVIEW_BLOCKED";
        SoftwareFactoryTelemetry.SetStageResult(activity, passed ? "eligible" : "blocked", reason);

        return new VerificationReport
        {
            Kind = VerificationKind.SecurityAndReview,
            Contract = message.Contract,
            TrustedRepositoryId = message.TrustedRepositoryId,
            Iteration = message.Iteration,
            TouchedPaths = message.TouchedPaths,
            Passed = passed,
            Repairable = false,
            ReasonCode = reason,
            LineCoveragePct = 0.0,
            BranchCoveragePct = 0.0,
            SecurityClear = result.SecurityClear,
            ReviewClear = result.ReviewClear
        };
    }
}

public sealed class GateAggregatorExecutor : StatefulExecutor<AggregatorState, VerificationReport>
{
    private readonly ExecutorInvocationCounts _counts;

    public GateAggregatorExecutor(ExecutorInvocationCounts counts)
        : base(
            id: "gate-aggregator",
            initialStateFactory: static () => new AggregatorState(),
            sentMessageTypes: [typeof(GateEvaluationOutcome)])
    {
        _counts = counts;
    }

    public override async ValueTask HandleAsync(
        VerificationReport message,
        IWorkflowContext context,
        CancellationToken cancellationToken = default)
    {
        AggregatorState state = await ReadStateAsync(context, cancellationToken: cancellationToken).ConfigureAwait(false);
        if (message.Kind == VerificationKind.TestAndCoverage)
        {
            state.PendingTestReport = message;
        }
        else
        {
            state.PendingSecurityReport = message;
        }

        if (state.PendingTestReport is null || state.PendingSecurityReport is null)
        {
            await QueueStateUpdateAsync(state, context, cancellationToken).ConfigureAwait(false);
            return;
        }

        _counts.GateAggregatorInvocations++;
        VerificationReport testReport = state.PendingTestReport;
        VerificationReport securityReport = state.PendingSecurityReport;
        state.PendingTestReport = null;
        state.PendingSecurityReport = null;
        await QueueStateUpdateAsync(state, context, cancellationToken).ConfigureAwait(false);

        GateEvaluationOutcome evaluation = EvaluateBarrierPair(testReport, securityReport);
        await context.SendMessageAsync(evaluation, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    public static GateEvaluationOutcome EvaluateBarrierPair(VerificationReport testReport, VerificationReport securityReport)
    {
        WorkItemContract contract = testReport.Contract;
        using var activity = SoftwareFactoryTelemetry.StartStageActivity(
            "gate-aggregator",
            contract.LaneId,
            testReport.Iteration + 3,
            "eligible",
            "AGGREGATING",
            contract.TraceParent);

        if (testReport.Passed && securityReport.Passed)
        {
            SoftwareFactoryTelemetry.SetStageResult(activity, "eligible", "SHADOW_ELIGIBLE");
            return new GateEvaluationOutcome
            {
                NeedsRepair = false,
                FinalDecision = new WorkflowGateDecision
                {
                    Outcome = "eligible",
                    ReasonCode = "SHADOW_ELIGIBLE",
                    RepositoryId = contract.RepositoryId,
                    IssueNumber = contract.IssueNumber,
                    LaneId = contract.LaneId,
                    HeadSha = contract.HeadSha,
                    IterationsCompleted = testReport.Iteration + 1,
                    RepairIterationsUsed = testReport.Iteration,
                    LineCoveragePct = testReport.LineCoveragePct,
                    BranchCoveragePct = testReport.BranchCoveragePct,
                    SecurityClear = true,
                    ReviewClear = true,
                    VerifiedPaths = testReport.TouchedPaths
                }
            };
        }

        bool canRepair = securityReport.Passed
            && testReport.Repairable
            && testReport.Iteration < contract.MaxRepairIterations;

        if (canRepair)
        {
            SoftwareFactoryTelemetry.SetStageResult(activity, "repair", "REPAIR_ITERATION_SCHEDULED");
            return new GateEvaluationOutcome
            {
                NeedsRepair = true,
                NextWorkOrder = new CoderWorkOrder
                {
                    Contract = contract,
                    TrustedRepositoryId = testReport.TrustedRepositoryId,
                    Iteration = testReport.Iteration + 1,
                    PlannedPaths = testReport.TouchedPaths,
                    IsBlocked = false,
                    BlockReason = "NONE"
                }
            };
        }

        string failureReason = !securityReport.Passed
            ? securityReport.ReasonCode
            : testReport.Repairable && contract.MaxRepairIterations > 0
                ? "REPAIR_BUDGET_EXHAUSTED"
                : testReport.ReasonCode;

        SoftwareFactoryTelemetry.SetStageResult(activity, "blocked", failureReason);
        return new GateEvaluationOutcome
        {
            NeedsRepair = false,
            FinalDecision = new WorkflowGateDecision
            {
                Outcome = "blocked",
                ReasonCode = failureReason,
                RepositoryId = contract.RepositoryId,
                IssueNumber = contract.IssueNumber,
                LaneId = contract.LaneId,
                HeadSha = contract.HeadSha,
                IterationsCompleted = testReport.Iteration + 1,
                RepairIterationsUsed = testReport.Iteration,
                LineCoveragePct = testReport.LineCoveragePct,
                BranchCoveragePct = testReport.BranchCoveragePct,
                SecurityClear = securityReport.SecurityClear,
                ReviewClear = securityReport.ReviewClear,
                VerifiedPaths = []
            }
        };
    }
}

public sealed class RepairLoopBridgeExecutor : Executor<GateEvaluationOutcome, CoderWorkOrder>
{
    public RepairLoopBridgeExecutor()
        : base("repair-loop-bridge")
    {
    }

    public override ValueTask<CoderWorkOrder> HandleAsync(
        GateEvaluationOutcome message,
        IWorkflowContext context,
        CancellationToken cancellationToken = default) =>
        ValueTask.FromResult(message.NextWorkOrder!);
}

public sealed class DecisionOutputExecutor : Executor<GateEvaluationOutcome, WorkflowGateDecision>
{
    public DecisionOutputExecutor()
        : base("decision-output")
    {
    }

    public override ValueTask<WorkflowGateDecision> HandleAsync(
        GateEvaluationOutcome message,
        IWorkflowContext context,
        CancellationToken cancellationToken = default) =>
        ValueTask.FromResult(message.FinalDecision!);
}
