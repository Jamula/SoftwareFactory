using System.Diagnostics;
using SoftwareFactory.Agents.Contracts;

namespace SoftwareFactory.Agents.Telemetry;

public static class SoftwareFactoryTelemetry
{
    public const string WorkflowsSourceName = "Microsoft.Agents.AI.Workflows";
    public const string AgentsSourceName = "SoftwareFactory.Agents";
    public const string TelemetryVersion = "1.28.0";

    public static readonly ActivitySource WorkflowsActivitySource = new(WorkflowsSourceName, TelemetryVersion);
    public static readonly ActivitySource AgentsActivitySource = new(AgentsSourceName, TelemetryVersion);

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
        if (activity is null)
        {
            return;
        }

        string sanitizedOutcome = SanitizeOutcome(outcome);
        activity.SetTag("sf.outcome", sanitizedOutcome);
        activity.SetTag("sf.reason", SanitizeReasonCode(reason));
        activity.SetStatus(sanitizedOutcome == "blocked" ? ActivityStatusCode.Error : ActivityStatusCode.Ok);
    }

    public static string SanitizeStage(string? stage) =>
        stage is not null && AllowedStages.Contains(stage) ? stage : "unknown";

    public static string SanitizeLane(string? lane) =>
        PathOwnershipGuard.IsValidIdentifier(lane) ? lane! : "invalid-lane";

    public static string SanitizeOutcome(string? outcome) =>
        outcome is not null && AllowedOutcomes.Contains(outcome) ? outcome : "blocked";

    public static string SanitizeReasonCode(string? reason)
    {
        if (string.IsNullOrEmpty(reason) || reason.Length > 64)
        {
            return "UNCLASSIFIED_REASON";
        }

        foreach (char c in reason)
        {
            bool valid = (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
            if (!valid)
            {
                return "UNCLASSIFIED_REASON";
            }
        }

        return reason;
    }

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
