using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Text;
using Microsoft.Extensions.AI;
using OpenTelemetry.Exporter;
using SoftwareFactory.Agents.Adapters;
using SoftwareFactory.Agents.Contracts;
using SoftwareFactory.Agents.Telemetry;
using SoftwareFactory.Agents.Workflows;
using Xunit;

namespace SoftwareFactory.Agents.Tests;

[CollectionDefinition("NonParallelTelemetry", DisableParallelization = true)]
public sealed class NonParallelTelemetryCollectionDefinition
{
}

[Collection("NonParallelTelemetry")]
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
    public async Task LocalOtlpBootstrap_ValidatesLoopbackExportsSignalsAndFlushesBeforeExit()
    {
        using (LocalOtlpRuntime disabled = LocalOtlpBootstrap.StartFromEnvironment(new Dictionary<string, string?>()))
        {
            Assert.False(disabled.IsEnabled);
            disabled.Dispose();
        }

        ValidatedLocalOtlpConfig? grpcCfg = LocalOtlpBootstrap.ValidateEnvironment(new Dictionary<string, string?>
        {
            ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "https://localhost:21031",
            ["OTEL_EXPORTER_OTLP_PROTOCOL"] = "grpc",
            ["OTEL_EXPORTER_OTLP_HEADERS"] = "x-otlp-api-key=ephemeral-key-123",
            ["OTEL_SERVICE_NAME"] = "bad service name!"
        });
        Assert.NotNull(grpcCfg);
        Assert.Equal(OtlpExportProtocol.Grpc, grpcCfg!.Protocol);
        Assert.Equal("maf-specialist-shadow", grpcCfg.ServiceName);

        using (LocalOtlpRuntime grpcRuntime = LocalOtlpBootstrap.StartFromEnvironment(new Dictionary<string, string?>
               {
                   ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://localhost:21031",
                   ["OTEL_EXPORTER_OTLP_PROTOCOL"] = "grpc",
                   ["OTEL_EXPORTER_OTLP_HEADERS"] = "x-otlp-api-key=ephemeral-key-123",
                   ["EMPTY_IGNORED"] = ""
               }))
        {
            Assert.True(grpcRuntime.IsEnabled);
        }

        (Dictionary<string, string?> Env, string Reason)[] badConfigs =
        [
            (new Dictionary<string, string?> { ["HTTP_PROXY"] = "http://127.0.0.1:8080" }, "FORBIDDEN_OTLP_ENV_OVERRIDE"),
            (new Dictionary<string, string?>
            {
                ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://127.0.0.1:18890",
                ["OTEL_EXPORTER_OTLP_HEADERS"] = "x-otlp-api-key=abc",
                ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] = "http://127.0.0.1:18890/v1/traces"
            }, "FORBIDDEN_OTLP_ENV_OVERRIDE"),
            (new Dictionary<string, string?>
            {
                ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://127.0.0.1:18890",
                ["OTEL_EXPORTER_OTLP_HEADERS"] = "x-otlp-api-key=abc",
                ["OTEL_SDK_DISABLED"] = "true"
            }, "OTLP_SDK_DISABLED"),
            (new Dictionary<string, string?>
            {
                ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "https://collector.example.com:4318",
                ["OTEL_EXPORTER_OTLP_HEADERS"] = "x-otlp-api-key=abc"
            }, "NON_LOOPBACK_OR_INVALID_OTLP_ENDPOINT"),
            (new Dictionary<string, string?>
            {
                ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://127.0.0.1",
                ["OTEL_EXPORTER_OTLP_HEADERS"] = "x-otlp-api-key=abc"
            }, "NON_LOOPBACK_OR_INVALID_OTLP_ENDPOINT"),
            (new Dictionary<string, string?>
            {
                ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://127.0.0.1:18890/custom",
                ["OTEL_EXPORTER_OTLP_HEADERS"] = "x-otlp-api-key=abc"
            }, "NON_LOOPBACK_OR_INVALID_OTLP_ENDPOINT"),
            (new Dictionary<string, string?>
            {
                ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://127.0.0.1:18890",
                ["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/json",
                ["OTEL_EXPORTER_OTLP_HEADERS"] = "x-otlp-api-key=abc"
            }, "UNSUPPORTED_OTLP_PROTOCOL"),
            (new Dictionary<string, string?>
            {
                ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://127.0.0.1:18890"
            }, "MISSING_OR_OVERSIZED_OTLP_HEADERS"),
            (new Dictionary<string, string?>
            {
                ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://127.0.0.1:18890",
                ["OTEL_EXPORTER_OTLP_HEADERS"] = "x-otlp-api-key=abc\nsmuggled:1"
            }, "INVALID_OTLP_HEADER_CHARS"),
            (new Dictionary<string, string?>
            {
                ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://127.0.0.1:18890",
                ["OTEL_EXPORTER_OTLP_HEADERS"] = "missing-equals"
            }, "MALFORMED_OTLP_HEADERS")
        ];

        foreach ((Dictionary<string, string?> env, string expectedReason) in badConfigs)
        {
            Assert.Equal(
                expectedReason,
                Assert.Throws<LocalOtlpConfigurationException>(() => LocalOtlpBootstrap.ValidateEnvironment(env)).ReasonCode);
        }

        var receivedPaths = new ConcurrentBag<string>();
        var receivedApiKeys = new ConcurrentBag<string>();
        using var tcpListener = new TcpListener(IPAddress.Loopback, 0);
        tcpListener.Start();
        int port = ((IPEndPoint)tcpListener.LocalEndpoint).Port;
        using var cts = new CancellationTokenSource();

        Task serverTask = AcceptLoopbackOtlpRequestsAsync(tcpListener, receivedPaths, receivedApiKeys, cts.Token);
        try
        {
            var validEnv = new Dictionary<string, string?>
            {
                ["OTEL_EXPORTER_OTLP_ENDPOINT"] = $"http://127.0.0.1:{port}",
                ["OTEL_EXPORTER_OTLP_PROTOCOL"] = "http/protobuf",
                ["OTEL_EXPORTER_OTLP_HEADERS"] = "x-otlp-api-key=loopback-test-token",
                ["OTEL_SERVICE_NAME"] = "maf-specialist-shadow"
            };

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            int exitCode = await MafCli.RunAsync(["--smoke"], stdout, stderr, validEnv);
            Assert.Equal(0, exitCode);

            Assert.Contains("/v1/traces", receivedPaths);
            Assert.Contains("/v1/metrics", receivedPaths);
            Assert.Contains("/v1/logs", receivedPaths);
            Assert.All(receivedApiKeys, static k => Assert.Equal("loopback-test-token", k));

            using var badOut = new StringWriter();
            using var badErr = new StringWriter();
            int badExit = await MafCli.RunAsync(
                ["--smoke"],
                badOut,
                badErr,
                new Dictionary<string, string?>
                {
                    ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "https://remote.example.com:4318",
                    ["OTEL_EXPORTER_OTLP_HEADERS"] = "x-otlp-api-key=token"
                });
            Assert.Equal(2, badExit);
            Assert.Contains("NON_LOOPBACK_OR_INVALID_OTLP_ENDPOINT", badErr.ToString(), StringComparison.Ordinal);
        }
        finally
        {
            await cts.CancelAsync();
            tcpListener.Stop();
            await serverTask;
        }
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

        using var unverifiedLiveClient = new NonOfflineChatClientStub();
        Assert.Equal(
            "LIVE_PROVIDER_CLIENT_FORBIDDEN_IN_SHADOW",
            Assert.Throws<InvalidOperationException>(() =>
                CopilotSpecialistAgentFactory.CreateSpecialistAgent("planner", unverifiedLiveClient)).Message);

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

    private static async Task AcceptLoopbackOtlpRequestsAsync(
        TcpListener listener,
        ConcurrentBag<string> paths,
        ConcurrentBag<string> apiKeys,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                using TcpClient client = await listener.AcceptTcpClientAsync(cancellationToken).ConfigureAwait(false);
                await using NetworkStream stream = client.GetStream();

                var headerBuilder = new StringBuilder();
                var oneByte = new byte[1];
                while (headerBuilder.Length < 16384)
                {
                    int read = await stream.ReadAsync(oneByte, CancellationToken.None).ConfigureAwait(false);
                    if (read == 0)
                    {
                        break;
                    }

                    headerBuilder.Append((char)oneByte[0]);
                    int len = headerBuilder.Length;
                    if (len >= 4
                        && headerBuilder[len - 4] == '\r'
                        && headerBuilder[len - 3] == '\n'
                        && headerBuilder[len - 2] == '\r'
                        && headerBuilder[len - 1] == '\n')
                    {
                        break;
                    }
                }

                string[] headerLines = headerBuilder.ToString().Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
                if (headerLines.Length > 0)
                {
                    string[] requestParts = headerLines[0].Split(' ');
                    if (requestParts.Length >= 2)
                    {
                        paths.Add(requestParts[1]);
                    }
                }

                int contentLength = 0;
                foreach (string line in headerLines)
                {
                    if (line.StartsWith("x-otlp-api-key:", StringComparison.OrdinalIgnoreCase))
                    {
                        apiKeys.Add(line["x-otlp-api-key:".Length..].Trim());
                    }
                    else if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                    {
                        _ = int.TryParse(line["Content-Length:".Length..].Trim(), out contentLength);
                    }
                }

                int remaining = contentLength;
                var drain = new byte[4096];
                while (remaining > 0)
                {
                    int read = await stream.ReadAsync(drain.AsMemory(0, Math.Min(drain.Length, remaining)), CancellationToken.None).ConfigureAwait(false);
                    if (read == 0)
                    {
                        break;
                    }

                    remaining -= read;
                }

                byte[] response = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(response, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (SocketException)
            {
                break;
            }
        }
    }

    private sealed class NonOfflineChatClientStub : IChatClient
    {
        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.CompletedTask;
            yield break;
        }

        public object? GetService(Type serviceType, object? serviceKey = null) => null;

        public void Dispose()
        {
        }
    }
}
