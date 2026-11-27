using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.Extensions.AI;
using SoftwareFactory.Agents.Adapters;
using SoftwareFactory.Agents.Contracts;
using SoftwareFactory.Agents.Telemetry;
using SoftwareFactory.Agents.Workflows;
using Xunit;

namespace SoftwareFactory.Agents.Tests;

public sealed class TelemetryAndAdapterTests
{
    [Fact]
    public async Task Telemetry_EmitsSanitizedSpansOnBothWorkflowsAndAgentsActivitySources()
    {
        var workflowsActivities = new ConcurrentBag<Activity>();
        var agentsActivities = new ConcurrentBag<Activity>();

        using var listener = new ActivityListener
        {
            ShouldListenTo = static source =>
                source.Name is SoftwareFactoryTelemetry.WorkflowsSourceName or SoftwareFactoryTelemetry.AgentsSourceName,
            Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
            ActivityStopped = activity =>
            {
                if (activity.Source.Name == SoftwareFactoryTelemetry.WorkflowsSourceName)
                {
                    workflowsActivities.Add(activity);
                }
                else if (activity.Source.Name == SoftwareFactoryTelemetry.AgentsSourceName)
                {
                    agentsActivities.Add(activity);
                }
            }
        };
        ActivitySource.AddActivityListener(listener);

        using var chatClient = new DeterministicSyntheticChatClient(SyntheticScenario.CleanPassOnFirstIteration);
        WorkItemContract contract = ContractAndOwnershipTests.ValidFactoryContract(
            traceParent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");

        WorkflowExecutionReceipt receipt = await SpecialistWorkflowEngine.ExecuteAsync(
            new WorkItemEnvelope
            {
                Contract = contract,
                TrustedRepositoryId = WorkItemContract.SoftwareFactoryRepositoryId
            },
            chatClient);

        Assert.Equal("eligible", receipt.Decision.Outcome);
        Assert.NotEmpty(workflowsActivities);
        Assert.NotEmpty(agentsActivities);

        foreach (Activity span in agentsActivities)
        {
            Assert.Equal("4bf92f3577b34da6a3ce929d0e0e4736", span.TraceId.ToHexString());
            string[] tagKeys = span.TagObjects.Select(static t => t.Key).ToArray();
            Assert.Contains("sf.stage", tagKeys);
            Assert.Contains("sf.lane", tagKeys);
            Assert.Contains("sf.superstep", tagKeys);
            Assert.Contains("sf.outcome", tagKeys);
            Assert.Contains("sf.reason", tagKeys);
            Assert.All(tagKeys, static k => Assert.StartsWith("sf.", k, StringComparison.Ordinal));
        }

        // Sanitization fallbacks when unsafe/raw strings are passed:
        using (Activity? unsafeActivity = SoftwareFactoryTelemetry.StartStageActivity(
                   stage: "raw prompt text",
                   lane: "Bad Lane With PII!",
                   superstep: -7,
                   outcome: "secret-token",
                   reason: "raw exception message with token=ghp_12345",
                   traceParent: "invalid-traceparent"))
        {
            Assert.NotNull(unsafeActivity);
            Assert.Equal("unknown", unsafeActivity!.GetTagItem("sf.stage"));
            Assert.Equal("invalid-lane", unsafeActivity.GetTagItem("sf.lane"));
            Assert.Equal(0, unsafeActivity.GetTagItem("sf.superstep"));
            Assert.Equal("blocked", unsafeActivity.GetTagItem("sf.outcome"));
            Assert.Equal("UNCLASSIFIED_REASON", unsafeActivity.GetTagItem("sf.reason"));
            SoftwareFactoryTelemetry.SetStageResult(unsafeActivity, "blocked", new string('A', 65));
            Assert.Equal(ActivityStatusCode.Error, unsafeActivity.Status);
            Assert.Equal("UNCLASSIFIED_REASON", unsafeActivity.GetTagItem("sf.reason"));
        }

        SoftwareFactoryTelemetry.SetStageResult(null, "eligible", "OK");
        Assert.Equal("unknown", SoftwareFactoryTelemetry.SanitizeStage(null));
        Assert.Equal("blocked", SoftwareFactoryTelemetry.SanitizeOutcome(null));
        Assert.Equal("UNCLASSIFIED_REASON", SoftwareFactoryTelemetry.SanitizeReasonCode(""));
    }

    [Fact]
    public async Task Adapters_EnforceFailClosedLiveGuardAndDeterministicClientContracts()
    {
        string contractId = CopilotSpecialistAgentFactory.GetCopilotAdapterContractId();
        Assert.StartsWith("Microsoft.Agents.AI.GitHub.Copilot.GitHubCopilotAgent@1.28.0", contractId, StringComparison.Ordinal);

        using var synthetic = new DeterministicSyntheticChatClient();
        Assert.NotNull(synthetic.GetService(typeof(ChatClientMetadata)));
        Assert.Null(synthetic.GetService(typeof(string)));
        Assert.Null(synthetic.GetService(typeof(ChatClientMetadata), serviceKey: "custom"));

        Assert.Equal(
            "LIVE_PROVIDER_DISPATCH_DISABLED",
            Assert.Throws<InvalidOperationException>(() =>
                CopilotSpecialistAgentFactory.CreateSpecialistAgent(
                    "planner",
                    synthetic,
                    new CopilotAdapterOptions { LiveExecutionAuthorized = true })).Message);

        Assert.Equal(
            "SYNTHETIC_CHAT_CLIENT_REQUIRED",
            Assert.Throws<InvalidOperationException>(() =>
                CopilotSpecialistAgentFactory.CreateSpecialistAgent("planner", syntheticChatClient: null)).Message);

        // Streaming response and prompt validation errors:
        string validPrompt = "{\"Stage\":\"planner\",\"RepositoryId\":1471342715,\"Iteration\":0,\"OwnedPaths\":[\"src/SoftwareFactory.Agents\"]}";
        var chunks = new List<string>();
        await foreach (ChatResponseUpdate update in synthetic.GetStreamingResponseAsync([
                           new ChatMessage(ChatRole.System, "sys"),
                           new ChatMessage(ChatRole.User, validPrompt)
                       ]))
        {
            chunks.Add(update.Text);
        }
        Assert.Single(chunks);
        Assert.Contains("\"Role\":\"planner\"", chunks[0], StringComparison.Ordinal);
        Assert.Equal(1, synthetic.InvocationCount);

        Assert.Equal(
            "MISSING_SPECIALIST_PROMPT",
            (await Assert.ThrowsAsync<InvalidOperationException>(async () =>
                await synthetic.GetResponseAsync([new ChatMessage(ChatRole.System, "only-system")]))).Message);

        Assert.Equal(
            "MALFORMED_SPECIALIST_PROMPT",
            (await Assert.ThrowsAsync<InvalidOperationException>(async () =>
                await synthetic.GetResponseAsync([new ChatMessage(ChatRole.User, "null")]))).Message);
    }
}
