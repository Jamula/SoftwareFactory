using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Extensions.AI;
using SoftwareFactory.Agents.Adapters;
using SoftwareFactory.Agents.Benchmarks;
using SoftwareFactory.Agents.Checkpointing;
using SoftwareFactory.Agents.Contracts;
using SoftwareFactory.Agents.Workflows;
using Xunit;

namespace SoftwareFactory.Agents.Tests;

public sealed class SpecialistWorkflowAndCliTests
{
    [Fact]
    public async Task Workflow_HandlesCleanPassBoundedRepairAndExhaustedRepairFailClosed()
    {
        WorkItemContract contract = ContractAndOwnershipTests.ValidFactoryContract(maxRepairIterations: 2);

        using var cleanClient = new DeterministicSyntheticChatClient(SyntheticScenario.CleanPassOnFirstIteration);
        WorkflowExecutionReceipt clean = await SpecialistWorkflowEngine.ExecuteAsync(
            new WorkItemEnvelope { Contract = contract, TrustedRepositoryId = contract.RepositoryId },
            cleanClient);
        Assert.Equal("eligible", clean.Decision.Outcome);
        Assert.Equal("SHADOW_ELIGIBLE", clean.Decision.ReasonCode);
        Assert.Equal(0, clean.Decision.RepairIterationsUsed);
        Assert.True(clean.Decision.Shadow);
        Assert.False(clean.Decision.LiveDispatch);
        Assert.False(clean.Decision.LiveMerge);

        using var repairClient = new DeterministicSyntheticChatClient(SyntheticScenario.RepairableCoverageDeficit);
        WorkflowExecutionReceipt repaired = await SpecialistWorkflowEngine.ExecuteAsync(
            new WorkItemEnvelope { Contract = contract, TrustedRepositoryId = contract.RepositoryId },
            repairClient);
        Assert.Equal("eligible", repaired.Decision.Outcome);
        Assert.Equal(1, repaired.Decision.RepairIterationsUsed);
        Assert.Equal(2, repaired.Invocations.CoderInvocations);
        Assert.Equal(2, repaired.Invocations.GateAggregatorInvocations);

        using var persistentClient = new DeterministicSyntheticChatClient(SyntheticScenario.PersistentCoverageFailure);
        WorkflowExecutionReceipt exhausted = await SpecialistWorkflowEngine.ExecuteAsync(
            new WorkItemEnvelope { Contract = contract, TrustedRepositoryId = contract.RepositoryId },
            persistentClient);
        Assert.Equal("blocked", exhausted.Decision.Outcome);
        Assert.Equal("REPAIR_BUDGET_EXHAUSTED", exhausted.Decision.ReasonCode);
        Assert.Equal(2, exhausted.Decision.RepairIterationsUsed);
        Assert.Equal(3, exhausted.Invocations.CoderInvocations);

        WorkItemContract zeroRepairContract = ContractAndOwnershipTests.ValidFactoryContract(maxRepairIterations: 0);
        WorkflowExecutionReceipt zeroRepair = await SpecialistWorkflowEngine.ExecuteAsync(
            new WorkItemEnvelope { Contract = zeroRepairContract, TrustedRepositoryId = zeroRepairContract.RepositoryId },
            persistentClient);
        Assert.Equal("blocked", zeroRepair.Decision.Outcome);
        Assert.Equal("COVERAGE_INCOMPLETE", zeroRepair.Decision.ReasonCode);
        Assert.Equal(0, zeroRepair.Decision.RepairIterationsUsed);
        Assert.False(SpecialistWorkflowEngine.IsExecutableWorkOrder(null));
        Assert.False(SpecialistWorkflowEngine.IsBlockedWorkOrder(null));
        Assert.False(SpecialistWorkflowEngine.ShouldRepairOutcome(null));
        Assert.False(SpecialistWorkflowEngine.IsTerminalOutcome(null));
    }

    [Theory]
    [InlineData(SyntheticScenario.OutOfLanePathAttempt, "OUT_OF_LANE_PATH_REJECTED")]
    [InlineData(SyntheticScenario.ProtectedControlPlaneAttempt, "PROTECTED_CONTROL_PLANE_PATH_REJECTED")]
    [InlineData(SyntheticScenario.CrossRepositoryLeakAttempt, "CROSS_REPO_ISOLATION_VIOLATION")]
    [InlineData(SyntheticScenario.SecurityOrReviewBlockingFinding, "SECURITY_OR_REVIEW_BLOCKED")]
    public async Task Workflow_BlocksIsolationControlPlaneCrossRepoAndReviewViolationsWithoutRepair(
        SyntheticScenario scenario,
        string expectedReason)
    {
        WorkItemContract contract = ContractAndOwnershipTests.ValidFactoryContract(maxRepairIterations: 2);
        using var client = new DeterministicSyntheticChatClient(scenario);
        WorkflowExecutionReceipt receipt = await SpecialistWorkflowEngine.ExecuteAsync(
            new WorkItemEnvelope { Contract = contract, TrustedRepositoryId = contract.RepositoryId },
            client);

        Assert.Equal("blocked", receipt.Decision.Outcome);
        Assert.Equal(expectedReason, receipt.Decision.ReasonCode);
        Assert.Equal(1, receipt.Invocations.CoderInvocations);
        Assert.Empty(receipt.Decision.VerifiedPaths);
    }

    [Fact]
    public async Task Workflow_ShortCircuitsAtPlannerWhenContractOrPlannedPathIsInvalid()
    {
        using var cleanClient = new DeterministicSyntheticChatClient();

        // Null contract inside envelope:
        WorkflowExecutionReceipt nullContractReceipt = await SpecialistWorkflowEngine.ExecuteAsync(
            new WorkItemEnvelope { Contract = null!, TrustedRepositoryId = WorkItemContract.SoftwareFactoryRepositoryId },
            cleanClient);
        Assert.Equal("blocked", nullContractReceipt.Decision.Outcome);
        Assert.Equal("CONTRACT_NULL", nullContractReceipt.Decision.ReasonCode);
        Assert.Equal(0, nullContractReceipt.Invocations.CoderInvocations);

        // Planner returns an out-of-lane path:
        using var roguePlannerClient = new CustomOfflineStubChatClient("{\"Role\":\"planner\",\"CandidateRepositoryId\":1471342715,\"ProposedPaths\":[\"docs/escape.md\"],\"LineCoveragePct\":99,\"BranchCoveragePct\":98,\"TestsPassed\":true,\"SecurityClear\":true,\"ReviewClear\":true,\"Repairable\":false,\"ReasonCode\":\"STAGE_OK\"}");
        WorkItemContract contract = ContractAndOwnershipTests.ValidFactoryContract();
        WorkflowExecutionReceipt roguePlan = await SpecialistWorkflowEngine.ExecuteAsync(
            new WorkItemEnvelope { Contract = contract, TrustedRepositoryId = contract.RepositoryId },
            roguePlannerClient);
        Assert.Equal("blocked", roguePlan.Decision.Outcome);
        Assert.Equal("OUT_OF_LANE_PATH_REJECTED", roguePlan.Decision.ReasonCode);
        Assert.Equal(0, roguePlan.Invocations.CoderInvocations);

        // Null literal specialist JSON fails closed:
        using var nullReplyClient = new CustomOfflineStubChatClient("null");
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await SpecialistWorkflowEngine.ExecuteAsync(
                new WorkItemEnvelope { Contract = contract, TrustedRepositoryId = contract.RepositoryId },
                nullReplyClient));
    }

    [Fact]
    public async Task Workflow_SupportsCrashSafeCheckpointResumptionWithoutRepeatingPriorSupersteps()
    {
        string checkpointDir = Path.Combine(Path.GetTempPath(), $"sf-wf-resume-{Guid.NewGuid():N}");
        try
        {
            WorkItemContract contract = ContractAndOwnershipTests.ValidFactoryContract(maxRepairIterations: 2);
            var binding = new CheckpointBinding
            {
                RepositoryId = contract.RepositoryId,
                IssueNumber = contract.IssueNumber,
                HeadSha = contract.HeadSha
            };

            var writeStore = new IntegrityVerifiedJsonCheckpointStore(checkpointDir, binding, contract.LaneId);
            using var initialClient = new DeterministicSyntheticChatClient(SyntheticScenario.CleanPassOnFirstIteration);

            WorkItemContract staleContract = ContractAndOwnershipTests.ValidFactoryContract(
                headSha: "1111111111111111111111111111111111111111");
            Assert.Equal(
                "CHECKPOINT_CONTRACT_BINDING_MISMATCH",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () =>
                    await SpecialistWorkflowEngine.ExecuteAsync(
                        new WorkItemEnvelope { Contract = staleContract, TrustedRepositoryId = staleContract.RepositoryId },
                        initialClient,
                        writeStore,
                        sessionId: "stale-attempt"))).ReasonCode);

            WorkflowExecutionReceipt fullReceipt = await SpecialistWorkflowEngine.ExecuteAsync(
                new WorkItemEnvelope { Contract = contract, TrustedRepositoryId = contract.RepositoryId },
                initialClient,
                writeStore,
                sessionId: "resume-session");
            Assert.Equal("eligible", fullReceipt.Decision.Outcome);

            var readStore = new IntegrityVerifiedJsonCheckpointStore(checkpointDir, binding, contract.LaneId);
            CheckpointInfo[] checkpoints = (await readStore.RetrieveIndexAsync("resume-session")).ToArray();
            Assert.True(checkpoints.Length >= 3);

            using var resumeClient = new DeterministicSyntheticChatClient(SyntheticScenario.CleanPassOnFirstIteration);
            WorkflowExecutionReceipt resumed = await SpecialistWorkflowEngine.ResumeFromCheckpointAsync(
                checkpoints[1],
                resumeClient,
                readStore);

            Assert.Equal("eligible", resumed.Decision.Outcome);
            Assert.Equal(0, resumed.Invocations.PlannerInvocations);
            Assert.Equal(0, resumed.Invocations.CoderInvocations);
            Assert.Equal(1, resumed.Invocations.TestAndCoverageInvocations);
            Assert.Equal(1, resumed.Invocations.SecurityAndReviewInvocations);

            Assert.Equal(
                "CHECKPOINT_CONTRACT_BINDING_MISMATCH",
                Assert.Throws<CheckpointIntegrityException>(() =>
                    SpecialistWorkflowEngine.VerifyDecisionMatchesBinding(
                        resumed.Decision,
                        new CheckpointBinding
                        {
                            RepositoryId = contract.RepositoryId,
                            IssueNumber = 999,
                            HeadSha = contract.HeadSha
                        })).ReasonCode);

            string cpFile = Path.Combine(checkpointDir, "resume-session", $"{checkpoints[1].CheckpointId}.checkpoint.json");
            string raw = await File.ReadAllTextAsync(cpFile, Encoding.UTF8);
            await File.WriteAllTextAsync(cpFile, raw.Replace("\"Sequence\":2", "\"Sequence\":99", StringComparison.Ordinal), Encoding.UTF8);
            await Assert.ThrowsAsync<CheckpointIntegrityException>(async () =>
                await SpecialistWorkflowEngine.ResumeFromCheckpointAsync(checkpoints[1], resumeClient, readStore));
        }
        finally
        {
            if (Directory.Exists(checkpointDir))
            {
                Directory.Delete(checkpointDir, recursive: true);
            }
        }
    }

    [Fact]
    public async Task Benchmarks_ValidateLogicalLaneBoundsAndCohortRegressionGates()
    {
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(async () =>
            await ThroughputBenchmarkRunner.SimulateLogicalLanesAsync(0, 12));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(async () =>
            await ThroughputBenchmarkRunner.SimulateLogicalLanesAsync(501, 12));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(async () =>
            await ThroughputBenchmarkRunner.SimulateLogicalLanesAsync(12, 0));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(async () =>
            await ThroughputBenchmarkRunner.SimulateLogicalLanesAsync(12, 13));

        LogicalLaneSimulationResult sim25 = await ThroughputBenchmarkRunner.SimulateLogicalLanesAsync(25, 8);
        Assert.Equal(25, sim25.LogicalLanes);
        Assert.Equal(8, sim25.ConfiguredWorkerCap);
        Assert.InRange(sim25.ObservedPeakConcurrency, 1, 8);
        Assert.Equal(4, sim25.ExecutedBatches);
        Assert.Equal(25, sim25.AcceptedLogicalUnits);

        var validCohort = new CohortSampleInput
        {
            TargetMultiplier = 10,
            BaselineComparableUnits = 6,
            CandidateComparableUnits = 7,
            BaselineAcceptedPerDay = 2.0,
            CandidateAcceptedPerDay = 20.0,
            BaselineLineCoveragePct = 98.5,
            CandidateLineCoveragePct = 99.0,
            BaselineBranchCoveragePct = 96.0,
            CandidateBranchCoveragePct = 96.5,
            BaselineCostCreditsPerUnit = 5.0,
            CandidateCostCreditsPerUnit = 4.5,
            CandidateUnresolvedFindings = 0,
            IncrementalUnapprovedSpendUsd = 0.0
        };

        BenchmarkSuiteReport measuredReport = await ThroughputBenchmarkRunner.RunStandardBenchmarkAsync([validCohort]);
        Assert.Single(measuredReport.MatchedCohorts);
        Assert.True(measuredReport.MatchedCohorts[0].Verified);
        Assert.False(measuredReport.MatchedCohorts[0].SyntheticIllustrativeOnly);
        Assert.Equal("COHORT_IMPROVEMENT_VERIFIED", measuredReport.MatchedCohorts[0].ReasonCode);

        Assert.Equal("INVALID_COHORT_INPUT", ThroughputBenchmarkRunner.EvaluateCohortComparison(null).ReasonCode);
        Assert.Equal(
            "INVALID_COHORT_INPUT",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(validCohort, targetMultiplier: 0)).ReasonCode);
        Assert.Equal(
            "INVALID_COHORT_INPUT",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(validCohort, baselineAcceptedPerDay: 0.0)).ReasonCode);
        Assert.Equal(
            "INVALID_COHORT_INPUT",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(validCohort, candidateAcceptedPerDay: -1.0)).ReasonCode);
        Assert.Equal(
            "INVALID_COHORT_INPUT",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(validCohort, candidateLinePct: double.NaN)).ReasonCode);
        Assert.Equal(
            "INVALID_COHORT_INPUT",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(validCohort, incrementalSpendUsd: double.NaN)).ReasonCode);
        Assert.Equal(
            "INVALID_COHORT_INPUT",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(
                validCohort,
                baselineAcceptedPerDay: double.Epsilon,
                candidateAcceptedPerDay: double.MaxValue)).ReasonCode);
        Assert.Equal(
            "MIN_COMPARABLE_UNITS_REQUIRED",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(validCohort, candidateComparableUnits: 4)).ReasonCode);
        Assert.Equal(
            "COST_REGRESSION_REJECTED",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(validCohort, incrementalSpendUsd: 0.01)).ReasonCode);
        Assert.Equal(
            "COST_REGRESSION_REJECTED",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(validCohort, candidateCostCredits: 5.5)).ReasonCode);
        Assert.Equal(
            "LINE_COVERAGE_REGRESSION_REJECTED",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(validCohort, baselineLinePct: 97.5, candidateLinePct: 97.9)).ReasonCode);
        Assert.Equal(
            "LINE_COVERAGE_REGRESSION_REJECTED",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(validCohort, baselineLinePct: 99.2, candidateLinePct: 98.8)).ReasonCode);
        Assert.Equal(
            "BRANCH_COVERAGE_REGRESSION_REJECTED",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(validCohort, baselineBranchPct: 94.0, candidateBranchPct: 94.9)).ReasonCode);
        Assert.Equal(
            "BRANCH_COVERAGE_REGRESSION_REJECTED",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(validCohort, baselineBranchPct: 97.0, candidateBranchPct: 96.0)).ReasonCode);
        Assert.Equal(
            "QUALITY_OR_REVIEW_REGRESSION_REJECTED",
            ThroughputBenchmarkRunner.EvaluateCohortComparison(CloneCohort(validCohort, unresolvedFindings: 1)).ReasonCode);

        CohortComparisonResult belowStretch = ThroughputBenchmarkRunner.EvaluateCohortComparison(
            CloneCohort(validCohort, candidateAcceptedPerDay: 10.0));
        Assert.True(belowStretch.Eligible);
        Assert.False(belowStretch.TargetAchieved);
        Assert.False(belowStretch.Verified);
        Assert.Equal("TARGET_MULTIPLIER_NOT_REACHED", belowStretch.ReasonCode);
    }

    [Fact]
    public async Task CliAndProgramEntryPoint_ExecuteSmokeBenchmarkAndRejectInvalidFlags()
    {
        using var smokeOut = new StringWriter();
        using var smokeErr = new StringWriter();
        int smokeExit = await MafCli.RunAsync(["--smoke"], smokeOut, smokeErr);
        Assert.Equal(0, smokeExit);
        using JsonDocument smokeJson = JsonDocument.Parse(smokeOut.ToString());
        Assert.Equal("maf-synthetic", smokeJson.RootElement.GetProperty("mode").GetString());
        Assert.Equal("eligible", smokeJson.RootElement.GetProperty("outcome").GetString());
        Assert.Equal(0, smokeJson.RootElement.GetProperty("priorSuperstepsRepeated").GetInt32());

        using var benchOut = new StringWriter();
        using var benchErr = new StringWriter();
        int benchExit = await MafCli.RunAsync(["--benchmark"], benchOut, benchErr);
        Assert.Equal(0, benchExit);
        using JsonDocument benchJson = JsonDocument.Parse(benchOut.ToString());
        Assert.Equal(3, benchJson.RootElement.GetProperty("logicalLaneSimulations").GetArrayLength());
        JsonElement cohorts = benchJson.RootElement.GetProperty("matchedCohorts");
        Assert.Equal(6, cohorts.GetArrayLength());
        foreach (JsonElement cohort in cohorts.EnumerateArray())
        {
            Assert.Equal("UNMEASURED_BASELINE_REQUIRED", cohort.GetProperty("reasonCode").GetString());
            Assert.False(cohort.GetProperty("verified").GetBoolean());
            Assert.True(cohort.GetProperty("syntheticIllustrativeOnly").GetBoolean());
        }

        Assert.Equal(2, await RunCliCaptureExitAsync(null));
        Assert.Equal(2, await RunCliCaptureExitAsync([]));
        Assert.Equal(2, await RunCliCaptureExitAsync(["--smoke", "--benchmark"]));
        Assert.Equal(2, await RunCliCaptureExitAsync(["--invalid"]));

        var entryPoint = typeof(MafCli).Assembly.EntryPoint!;
        TextWriter originalErr = Console.Error;
        try
        {
            Console.SetError(TextWriter.Null);
            int mainExit = (int)entryPoint.Invoke(null, [new[] { "--invalid" }])!;
            Assert.Equal(2, mainExit);
        }
        finally
        {
            Console.SetError(originalErr);
        }
    }

    private static async Task<int> RunCliCaptureExitAsync(string[]? args)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        return await MafCli.RunAsync(args, stdout, stderr);
    }

    private static CohortSampleInput CloneCohort(
        CohortSampleInput source,
        int? targetMultiplier = null,
        int? candidateComparableUnits = null,
        double? baselineAcceptedPerDay = null,
        double? candidateAcceptedPerDay = null,
        double? baselineLinePct = null,
        double? candidateLinePct = null,
        double? baselineBranchPct = null,
        double? candidateBranchPct = null,
        double? candidateCostCredits = null,
        int? unresolvedFindings = null,
        double? incrementalSpendUsd = null) =>
        new()
        {
            TargetMultiplier = targetMultiplier ?? source.TargetMultiplier,
            BaselineComparableUnits = source.BaselineComparableUnits,
            CandidateComparableUnits = candidateComparableUnits ?? source.CandidateComparableUnits,
            BaselineAcceptedPerDay = baselineAcceptedPerDay ?? source.BaselineAcceptedPerDay,
            CandidateAcceptedPerDay = candidateAcceptedPerDay ?? source.CandidateAcceptedPerDay,
            BaselineLineCoveragePct = baselineLinePct ?? source.BaselineLineCoveragePct,
            CandidateLineCoveragePct = candidateLinePct ?? source.CandidateLineCoveragePct,
            BaselineBranchCoveragePct = baselineBranchPct ?? source.BaselineBranchCoveragePct,
            CandidateBranchCoveragePct = candidateBranchPct ?? source.CandidateBranchCoveragePct,
            BaselineCostCreditsPerUnit = source.BaselineCostCreditsPerUnit,
            CandidateCostCreditsPerUnit = candidateCostCredits ?? source.CandidateCostCreditsPerUnit,
            CandidateUnresolvedFindings = unresolvedFindings ?? source.CandidateUnresolvedFindings,
            IncrementalUnapprovedSpendUsd = incrementalSpendUsd ?? source.IncrementalUnapprovedSpendUsd
        };

    private sealed class CustomOfflineStubChatClient(string responseText) : IOfflineSyntheticChatClient
    {
        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(new ChatResponse(new ChatMessage(ChatRole.Assistant, responseText)));

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask;
            yield return new ChatResponseUpdate(ChatRole.Assistant, responseText);
        }

        public object? GetService(Type serviceType, object? serviceKey = null) => null;

        public void Dispose()
        {
        }
    }
}
