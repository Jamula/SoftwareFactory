using System.Diagnostics;
using System.Diagnostics.Metrics;
using Microsoft.Extensions.Logging;
using SoftwareFactory.Agents.Contracts;

namespace SoftwareFactory.Agents.Telemetry;

public static class SoftwareFactoryTelemetry
{
    public const string WorkflowsSourceName = "Microsoft.Agents.AI.Workflows";
    public const string AgentsSourceName = "SoftwareFactory.Agents";
    public const string TelemetryVersion = "1.28.0";

    public static readonly ActivitySource WorkflowsActivitySource = new(WorkflowsSourceName, TelemetryVersion);
    public static readonly ActivitySource AgentsActivitySource = new(AgentsSourceName, TelemetryVersion);
    public static readonly Meter AgentsMeter = new(AgentsSourceName, TelemetryVersion);

    private static readonly Counter<long> StageCounter = AgentsMeter.CreateCounter<long>("sf.agent.stage.count");
    private static readonly Histogram<double> StageDurationHistogram = AgentsMeter.CreateHistogram<double>("sf.agent.stage.duration", unit: "ms");
    private static readonly EventId StageCompletedEventId = new(1001, "sf.agent.stage.completed");
    private static ILogger? s_stageLogger;

    internal static void AttachStageLogger(ILogger? logger) =>
        Volatile.Write(ref s_stageLogger, logger);

    private static readonly HashSet<string> AllowedStages = new(StringComparer.Ordinal)
    {
        "planner",
        "coder",
        "test-and-coverage",
        "security-and-review",
        "gate-aggregator",
        "checkpoint",
        "workflow",
        "benchmark"
    };

    private static readonly HashSet<string> AllowedOutcomes = new(StringComparer.Ordinal)
    {
        "eligible",
        "blocked",
        "repair",
        "checkpointed",
        "resumed",
        "verified"
    };

    private static readonly HashSet<string> AllowedReasonCodes = new(StringComparer.Ordinal)
    {
        "PLANNING",
        "CONTRACT_PLANNED",
        "CODING",
        "CANDIDATE_PATCH_READY",
        "VERIFYING_TESTS",
        "COVERAGE_VERIFIED",
        "COVERAGE_INCOMPLETE",
        "VERIFYING_SECURITY",
        "SECURITY_AND_REVIEW_CLEAR",
        "SECURITY_OR_REVIEW_BLOCKED",
        "AGGREGATING",
        "SHADOW_ELIGIBLE",
        "REPAIR_ITERATION_SCHEDULED",
        "REPAIR_BUDGET_EXHAUSTED",
        "CHECKPOINT_COMMITTED",
        "CHECKPOINT_VERIFIED",
        "BENCHMARK_STARTED",
        "BENCHMARK_COMPLETED",
        "CONTRACT_VALID",
        "CONTRACT_NULL",
        "CROSS_REPO_ISOLATION_VIOLATION",
        "INVALID_REPOSITORY_SLUG",
        "INVALID_HEAD_SHA",
        "INVALID_ISSUE_NUMBER",
        "INVALID_LANE_ID",
        "UNKNOWN_SPECIALIST_ROLE",
        "INVALID_OWNED_PATHS",
        "UNSAFE_OR_DUPLICATE_OWNED_PATH",
        "COVERAGE_THRESHOLD_BELOW_FLOOR",
        "INVALID_REPAIR_BUDGET",
        "INVALID_TRACEPARENT",
        "EMPTY_OR_EXCESSIVE_CANDIDATE_PATHS",
        "UNSAFE_PATH_REJECTED",
        "DUPLICATE_CANDIDATE_PATH",
        "PROTECTED_CONTROL_PLANE_PATH_REJECTED",
        "OUT_OF_LANE_PATH_REJECTED",
        "SPECIALIST_RESPONSE_MISMATCH",
        "INVALID_COVERAGE_EVIDENCE"
    };

    public static Activity? StartStageActivity(
        string stage,
        string lane,
        int superstep,
        string outcome,
        string reason,
        string? traceParent = null)
    {
        string sanitizedStage = SanitizeStage(stage);
        string sanitizedLane = SanitizeLane(lane);
        int sanitizedSuperstep = superstep < 0 ? 0 : superstep;
        string sanitizedOutcome = SanitizeOutcome(outcome);
        string sanitizedReason = SanitizeReasonCode(reason);

        Activity? activity = TryCreateActivity(sanitizedStage, traceParent);
        if (activity is not null)
        {
            activity.SetTag("sf.stage", sanitizedStage);
            activity.SetTag("sf.lane", sanitizedLane);
            activity.SetTag("sf.superstep", sanitizedSuperstep);
            activity.SetTag("sf.outcome", sanitizedOutcome);
            activity.SetTag("sf.reason", sanitizedReason);
        }

        return activity;
    }

    public static void SetStageResult(Activity? activity, string outcome, string reason)
    {
        string sanitizedOutcome = SanitizeOutcome(outcome);
        string sanitizedReason = SanitizeReasonCode(reason);
        string stage = activity?.GetTagItem("sf.stage") as string ?? "unknown";

        var metricTags = new TagList
        {
            { "stage", stage },
            { "outcome", sanitizedOutcome },
            { "reason", sanitizedReason }
        };
        StageCounter.Add(1L, metricTags);

        if (activity is null)
        {
            return;
        }

        activity.SetTag("sf.outcome", sanitizedOutcome);
        activity.SetTag("sf.reason", sanitizedReason);
        activity.SetStatus(sanitizedOutcome == "blocked" ? ActivityStatusCode.Error : ActivityStatusCode.Ok);

        ILogger? logger = Volatile.Read(ref s_stageLogger);
        if (logger is not null)
        {
            var structuredState = new KeyValuePair<string, object?>[]
            {
                new("stage", stage),
                new("outcome", sanitizedOutcome),
                new("reason", sanitizedReason)
            };
            logger.Log(
                LogLevel.Information,
                StageCompletedEventId,
                structuredState,
                exception: null,
                static (_, _) => "sf.agent.stage.completed");
        }

        activity.Stop();
        StageDurationHistogram.Record(Math.Max(0.0, activity.Duration.TotalMilliseconds), metricTags);
    }

    public static string SanitizeStage(string? stage) =>
        stage is not null && AllowedStages.Contains(stage) ? stage : "unknown";

    public static string SanitizeLane(string? lane) =>
        PathOwnershipGuard.IsValidIdentifier(lane) ? lane! : "invalid-lane";

    public static string SanitizeOutcome(string? outcome) =>
        outcome is not null && AllowedOutcomes.Contains(outcome) ? outcome : "blocked";

    public static string SanitizeReasonCode(string? reason) =>
        reason is not null && AllowedReasonCodes.Contains(reason) ? reason : "UNCLASSIFIED_REASON";

    private static Activity? TryCreateActivity(string sanitizedStage, string? traceParent)
    {
        string operationName = $"sf.{sanitizedStage}";
        if (PathOwnershipGuard.IsValidTraceParent(traceParent)
            && ActivityContext.TryParse(traceParent, null, isRemote: true, out ActivityContext parentContext))
        {
            return AgentsActivitySource.StartActivity(operationName, ActivityKind.Internal, parentContext);
        }

        return AgentsActivitySource.StartActivity(operationName, ActivityKind.Internal);
    }
}
