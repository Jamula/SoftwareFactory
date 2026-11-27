using System.Text.Json;
using Microsoft.Agents.AI.Workflows;
using SoftwareFactory.Agents.Adapters;
using SoftwareFactory.Agents.Benchmarks;
using SoftwareFactory.Agents.Checkpointing;
using SoftwareFactory.Agents.Contracts;
using SoftwareFactory.Agents.Telemetry;
using SoftwareFactory.Agents.Workflows;

namespace SoftwareFactory.Agents;

public sealed class SmokeReceipt
{
    public string Mode { get; init; } = "maf-synthetic";
    public string Framework { get; init; } = "Microsoft.Agents.AI.Workflows";
    public string Version { get; init; } = "1.28.0";
    public bool Shadow { get; init; } = true;
    public bool LiveDispatch { get; init; }
    public bool LiveMerge { get; init; }
    public required string Outcome { get; init; }
    public required string Reason { get; init; }
    public required int SuperstepsCompleted { get; init; }
    public required int RepairIterationsUsed { get; init; }
    public required bool CheckpointSaved { get; init; }
    public required bool CheckpointResumed { get; init; }
    public required int PriorSuperstepsRepeated { get; init; }
    public required double LineCoveragePct { get; init; }
    public required double BranchCoveragePct { get; init; }
    public double IncrementalSpendUsd { get; init; }
}

public static class MafCli
{
    private static readonly JsonSerializerOptions OutputJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    };

    public static Task<int> RunAsync(
        string[]? args,
        TextWriter stdout,
        TextWriter stderr,
        CancellationToken cancellationToken = default) =>
        RunAsync(args, stdout, stderr, environment: null, cancellationToken);

    public static async Task<int> RunAsync(
        string[]? args,
        TextWriter stdout,
        TextWriter stderr,
        IReadOnlyDictionary<string, string?>? environment,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(stdout);
        ArgumentNullException.ThrowIfNull(stderr);

        if (args is null || args.Length != 1)
        {
            await stderr.WriteLineAsync("{\"error\":\"INVALID_CLI_ARGS\",\"expected\":\"--smoke|--benchmark\"}").ConfigureAwait(false);
            return 2;
        }

        bool isSmoke = string.Equals(args[0], "--smoke", StringComparison.Ordinal);
        bool isBenchmark = string.Equals(args[0], "--benchmark", StringComparison.Ordinal);
        if (!isSmoke && !isBenchmark)
        {
            await stderr.WriteLineAsync("{\"error\":\"UNKNOWN_CLI_FLAG\",\"expected\":\"--smoke|--benchmark\"}").ConfigureAwait(false);
            return 2;
        }

        LocalOtlpRuntime telemetry;
        try
        {
            telemetry = LocalOtlpBootstrap.StartFromEnvironment(environment);
        }
        catch (LocalOtlpConfigurationException ex)
        {
            await stderr.WriteLineAsync($"{{\"error\":\"INVALID_LOCAL_OTLP_CONFIG\",\"reason\":\"{ex.ReasonCode}\"}}").ConfigureAwait(false);
            return 2;
        }

        using (telemetry)
        {
            if (isSmoke)
            {
                SmokeReceipt receipt = await ExecuteSyntheticSmokeAsync(cancellationToken).ConfigureAwait(false);
                await stdout.WriteLineAsync(JsonSerializer.Serialize(receipt, OutputJsonOptions)).ConfigureAwait(false);
                return 0;
            }

            BenchmarkSuiteReport report = await ThroughputBenchmarkRunner.RunStandardBenchmarkAsync(
                measuredCohortInputs: null,
                cancellationToken: cancellationToken).ConfigureAwait(false);
            await stdout.WriteLineAsync(JsonSerializer.Serialize(report, OutputJsonOptions)).ConfigureAwait(false);
            return 0;
        }
    }

    public static async Task<SmokeReceipt> ExecuteSyntheticSmokeAsync(CancellationToken cancellationToken = default)
    {
        string checkpointDir = Path.Combine(Path.GetTempPath(), $"sf-maf-smoke-{Guid.NewGuid():N}");
        try
        {
            const string headSha = "c77612ec77612ec77612ec77612ec77612ec7761";
            const string sessionId = "sf-smoke-session";

            var binding = new CheckpointBinding
            {
                RepositoryId = WorkItemContract.SoftwareFactoryRepositoryId,
                IssueNumber = 14,
                HeadSha = headSha
            };

            var contract = new WorkItemContract
            {
                RepositoryId = WorkItemContract.SoftwareFactoryRepositoryId,
                RepositorySlug = WorkItemContract.SoftwareFactoryRepositorySlug,
                HeadSha = headSha,
                IssueNumber = 14,
                LaneId = "dotnet-agents",
                SpecialistRole = "api",
                OwnedPaths = ["src/SoftwareFactory.Agents"],
                LineCoverageMin = 98.0,
                BranchCoverageMin = 95.0,
                MaxRepairIterations = 2,
                TraceParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
            };

            var storeWrite = new IntegrityVerifiedJsonCheckpointStore(checkpointDir, binding, contract.LaneId);
            using var chatClient = new DeterministicSyntheticChatClient(SyntheticScenario.RepairableCoverageDeficit);

            WorkflowExecutionReceipt initialReceipt = await SpecialistWorkflowEngine.ExecuteAsync(
                new WorkItemEnvelope
                {
                    Contract = contract,
                    TrustedRepositoryId = WorkItemContract.SoftwareFactoryRepositoryId
                },
                chatClient,
                storeWrite,
                sessionId,
                cancellationToken: cancellationToken).ConfigureAwait(false);

            var storeRead = new IntegrityVerifiedJsonCheckpointStore(checkpointDir, binding, contract.LaneId);
            CheckpointInfo[] checkpoints = (await storeRead.RetrieveIndexAsync(sessionId).ConfigureAwait(false)).ToArray();

            // Resume from checkpoint[1] (after Planner + Coder supersteps completed) in a fresh workflow instance
            // to verify cross-process JSON checkpoint restoration without repeating Planner or iteration-0 Coder!
            CheckpointInfo midRunCheckpoint = checkpoints[1];
            using var resumeChatClient = new DeterministicSyntheticChatClient(SyntheticScenario.RepairableCoverageDeficit);
            WorkflowExecutionReceipt resumedReceipt = await SpecialistWorkflowEngine.ResumeFromCheckpointAsync(
                midRunCheckpoint,
                resumeChatClient,
                storeRead,
                cancellationToken: cancellationToken).ConfigureAwait(false);

            return new SmokeReceipt
            {
                Outcome = resumedReceipt.Decision.Outcome,
                Reason = resumedReceipt.Decision.ReasonCode,
                SuperstepsCompleted = initialReceipt.SuperstepsCompleted,
                RepairIterationsUsed = resumedReceipt.Decision.RepairIterationsUsed,
                CheckpointSaved = checkpoints.Length > 1,
                CheckpointResumed = resumedReceipt.Decision.Outcome == "eligible",
                PriorSuperstepsRepeated = resumedReceipt.Invocations.PlannerInvocations,
                LineCoveragePct = resumedReceipt.Decision.LineCoveragePct,
                BranchCoveragePct = resumedReceipt.Decision.BranchCoveragePct,
                IncrementalSpendUsd = 0.0
            };
        }
        finally
        {
            if (Directory.Exists(checkpointDir))
            {
                Directory.Delete(checkpointDir, recursive: true);
            }
        }
    }
}
