using System.Text.Json;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Extensions.AI;
using SoftwareFactory.Agents.Adapters;
using SoftwareFactory.Agents.Checkpointing;
using SoftwareFactory.Agents.Telemetry;

namespace SoftwareFactory.Agents.Workflows;

public static class SpecialistWorkflowEngine
{
    public static (Workflow Workflow, ExecutorInvocationCounts Counts) BuildSpecialistWorkflow(
        IChatClient chatClient,
        CopilotAdapterOptions? adapterOptions = null)
    {
        var counts = new ExecutorInvocationCounts();

        AIAgent plannerAgent = CopilotSpecialistAgentFactory.CreateSpecialistAgent("planner", chatClient, adapterOptions);
        AIAgent coderAgent = CopilotSpecialistAgentFactory.CreateSpecialistAgent("coder", chatClient, adapterOptions);
        AIAgent testAgent = CopilotSpecialistAgentFactory.CreateSpecialistAgent("test-and-coverage", chatClient, adapterOptions);
        AIAgent securityAgent = CopilotSpecialistAgentFactory.CreateSpecialistAgent("security-and-review", chatClient, adapterOptions);

        var planner = new PlannerExecutor(plannerAgent, counts);
        var blockedPlanRouter = new BlockedOrderToDecisionExecutor();
        var coder = new CoderExecutor(coderAgent, counts);
        var testAndCoverage = new TestAndCoverageExecutor(testAgent, counts);
        var securityAndReview = new SecurityAndReviewExecutor(securityAgent, counts);
        var gateAggregator = new GateAggregatorExecutor(counts);
        var repairLoopBridge = new RepairLoopBridgeExecutor();
        var decisionOutput = new DecisionOutputExecutor();

        Workflow workflow = new WorkflowBuilder(planner)
            .WithName("softwarefactory-specialist-graph")
            .WithDescription("Contract-first M02 specialist workflow with fan-out/fan-in barrier verification and bounded repair loop")
            .AddEdge<CoderWorkOrder>(planner, coder, IsExecutableWorkOrder)
            .AddEdge<CoderWorkOrder>(planner, blockedPlanRouter, IsBlockedWorkOrder)
            .AddEdge(blockedPlanRouter, decisionOutput)
            .AddFanOutEdge(coder, [testAndCoverage, securityAndReview])
            .AddFanInBarrierEdge([testAndCoverage, securityAndReview], gateAggregator)
            .AddEdge<GateEvaluationOutcome>(gateAggregator, repairLoopBridge, ShouldRepairOutcome)
            .AddEdge(repairLoopBridge, coder)
            .AddEdge<GateEvaluationOutcome>(gateAggregator, decisionOutput, IsTerminalOutcome)
            .WithOutputFrom(decisionOutput)
            .WithOpenTelemetry(activitySource: SoftwareFactoryTelemetry.WorkflowsActivitySource)
            .Build();

        return (workflow, counts);
    }

    public static bool IsExecutableWorkOrder(CoderWorkOrder? order) =>
        order is not null && !order.IsBlocked;

    public static bool IsBlockedWorkOrder(CoderWorkOrder? order) =>
        order is not null && order.IsBlocked;

    public static bool ShouldRepairOutcome(GateEvaluationOutcome? outcome) =>
        outcome is not null && outcome.NeedsRepair;

    public static bool IsTerminalOutcome(GateEvaluationOutcome? outcome) =>
        outcome is not null && !outcome.NeedsRepair;

    public static async Task<WorkflowExecutionReceipt> ExecuteAsync(
        WorkItemEnvelope envelope,
        IChatClient chatClient,
        IntegrityVerifiedJsonCheckpointStore? checkpointStore = null,
        string sessionId = "sf-default-session",
        CopilotAdapterOptions? adapterOptions = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        ArgumentNullException.ThrowIfNull(chatClient);

        if (checkpointStore is not null)
        {
            IntegrityVerifiedJsonCheckpointStore.VerifyContractMatchesBinding(
                envelope.Contract,
                envelope.TrustedRepositoryId,
                checkpointStore.ExpectedBinding);
        }

        (Workflow workflow, ExecutorInvocationCounts counts) = BuildSpecialistWorkflow(chatClient, adapterOptions);
        JsonSerializerOptions serializerOptions = CopilotSpecialistAgentFactory.CreateCheckpointSerializerOptions();

        StreamingRun run = checkpointStore is null
            ? await InProcessExecution.RunStreamingAsync(workflow, envelope, sessionId, cancellationToken).ConfigureAwait(false)
            : await InProcessExecution.RunStreamingAsync(
                workflow,
                envelope,
                CheckpointManager.CreateJson(checkpointStore, serializerOptions),
                sessionId,
                cancellationToken).ConfigureAwait(false);

        await using (run.ConfigureAwait(false))
        {
            return await ConsumeRunAsync(run, counts, cancellationToken).ConfigureAwait(false);
        }
    }

    public static async Task<WorkflowExecutionReceipt> ResumeFromCheckpointAsync(
        CheckpointInfo checkpoint,
        IChatClient chatClient,
        IntegrityVerifiedJsonCheckpointStore checkpointStore,
        CopilotAdapterOptions? adapterOptions = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(checkpoint);
        ArgumentNullException.ThrowIfNull(chatClient);
        ArgumentNullException.ThrowIfNull(checkpointStore);

        (Workflow workflow, ExecutorInvocationCounts counts) = BuildSpecialistWorkflow(chatClient, adapterOptions);
        JsonSerializerOptions serializerOptions = CopilotSpecialistAgentFactory.CreateCheckpointSerializerOptions();
        CheckpointManager checkpointManager = CheckpointManager.CreateJson(checkpointStore, serializerOptions);

        await using StreamingRun run = await InProcessExecution.ResumeStreamingAsync(
            workflow,
            checkpoint,
            checkpointManager,
            cancellationToken).ConfigureAwait(false);

        WorkflowExecutionReceipt receipt = await ConsumeRunAsync(run, counts, cancellationToken).ConfigureAwait(false);
        VerifyDecisionMatchesBinding(receipt.Decision, checkpointStore.ExpectedBinding);
        return receipt;
    }

    public static void VerifyDecisionMatchesBinding(WorkflowGateDecision decision, CheckpointBinding expectedBinding)
    {
        if (decision.RepositoryId != expectedBinding.RepositoryId
            || decision.IssueNumber != expectedBinding.IssueNumber
            || !string.Equals(decision.HeadSha, expectedBinding.HeadSha, StringComparison.Ordinal))
        {
            throw new CheckpointIntegrityException(
                "CHECKPOINT_CONTRACT_BINDING_MISMATCH",
                "Resumed workflow decision identity does not match checkpoint binding.");
        }
    }

    private static async Task<WorkflowExecutionReceipt> ConsumeRunAsync(
        StreamingRun run,
        ExecutorInvocationCounts counts,
        CancellationToken cancellationToken)
    {
        int supersteps = 0;
        WorkflowGateDecision? finalDecision = null;

        await foreach (WorkflowEvent evt in run.WatchStreamAsync(cancellationToken).ConfigureAwait(false))
        {
            if (evt is SuperStepCompletedEvent)
            {
                supersteps++;
            }
            else if (evt is WorkflowOutputEvent outputEvent && outputEvent.Is<WorkflowGateDecision>(out WorkflowGateDecision? typed))
            {
                finalDecision = typed;
            }
        }

        if (finalDecision is null)
        {
            throw new InvalidOperationException("WORKFLOW_DID_NOT_YIELD_GATE_DECISION");
        }

        return new WorkflowExecutionReceipt
        {
            Decision = finalDecision,
            SuperstepsCompleted = supersteps,
            Invocations = counts
        };
    }
}
