using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.GitHub.Copilot;
using Microsoft.Extensions.AI;

namespace SoftwareFactory.Agents.Adapters;

public enum SyntheticScenario
{
    CleanPassOnFirstIteration = 0,
    RepairableCoverageDeficit = 1,
    PersistentCoverageFailure = 2,
    OutOfLanePathAttempt = 3,
    SecurityOrReviewBlockingFinding = 4,
    CrossRepositoryLeakAttempt = 5,
    ProtectedControlPlaneAttempt = 6
}

public sealed class SpecialistAgentPayload
{
    public required string Role { get; init; }
    public required long CandidateRepositoryId { get; init; }
    public required IReadOnlyList<string> ProposedPaths { get; init; }
    public required double LineCoveragePct { get; init; }
    public required double BranchCoveragePct { get; init; }
    public required bool TestsPassed { get; init; }
    public required bool SecurityClear { get; init; }
    public required bool ReviewClear { get; init; }
    public required bool Repairable { get; init; }
    public required string ReasonCode { get; init; }
}

public sealed class SpecialistPromptRequest
{
    public required string Stage { get; init; }
    public required long RepositoryId { get; init; }
    public required int Iteration { get; init; }
    public required IReadOnlyList<string> OwnedPaths { get; init; }
}

public interface IOfflineSyntheticChatClient : IChatClient
{
}

public sealed class CopilotAdapterOptions
{
    public bool LiveExecutionAuthorized { get; init; }
    public string ProviderName { get; init; } = "github-copilot-sdk-shadow";
}

public static class CopilotSpecialistAgentFactory
{
    public static string GetCopilotAdapterContractId() =>
        $"{typeof(GitHubCopilotAgent).FullName}@{typeof(GitHubCopilotAgent).Assembly.GetName().Version?.ToString(3)}";

    public static JsonSerializerOptions CreateCheckpointSerializerOptions() =>
        new(AgentAbstractionsJsonUtilities.DefaultOptions);

    public static AIAgent CreateSpecialistAgent(
        string specialistName,
        IChatClient? syntheticChatClient,
        CopilotAdapterOptions? options = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(specialistName);
        CopilotAdapterOptions effective = options ?? new CopilotAdapterOptions();

        if (effective.LiveExecutionAuthorized)
        {
            throw new InvalidOperationException("LIVE_PROVIDER_DISPATCH_DISABLED");
        }

        if (syntheticChatClient is null)
        {
            throw new InvalidOperationException("SYNTHETIC_CHAT_CLIENT_REQUIRED");
        }

        if (syntheticChatClient is not IOfflineSyntheticChatClient)
        {
            throw new InvalidOperationException("LIVE_PROVIDER_CLIENT_FORBIDDEN_IN_SHADOW");
        }

        return new ChatClientAgent(
            syntheticChatClient,
            instructions: $"SoftwareFactory shadow specialist: {specialistName}",
            name: specialistName,
            description: $"Deterministic offline specialist ({effective.ProviderName})");
    }
}

public sealed class DeterministicSyntheticChatClient : IOfflineSyntheticChatClient
{
    private readonly SyntheticScenario _scenario;
    private readonly ChatClientMetadata _metadata;
    private int _invocationCount;

    public DeterministicSyntheticChatClient(SyntheticScenario scenario = SyntheticScenario.CleanPassOnFirstIteration)
    {
        _scenario = scenario;
        _metadata = new ChatClientMetadata("softwarefactory-deterministic-synthetic", null, "synthetic-maf-1.28.0");
    }

    public int InvocationCount => Volatile.Read(ref _invocationCount);

    public Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Interlocked.Increment(ref _invocationCount);

        SpecialistPromptRequest request = ParseLastUserPrompt(messages);
        SpecialistAgentPayload payload = EvaluateDeterministic(request);
        string json = JsonSerializer.Serialize(payload);
        var reply = new ChatMessage(ChatRole.Assistant, json);
        return Task.FromResult(new ChatResponse(reply));
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ChatResponse response = await GetResponseAsync(messages, options, cancellationToken).ConfigureAwait(false);
        yield return new ChatResponseUpdate(ChatRole.Assistant, response.Text);
    }

    public object? GetService(Type serviceType, object? serviceKey = null) =>
        serviceKey is null && serviceType == typeof(ChatClientMetadata) ? _metadata : null;

    public void Dispose()
    {
    }

    private static SpecialistPromptRequest ParseLastUserPrompt(IEnumerable<ChatMessage> messages)
    {
        ChatMessage? lastUser = null;
        foreach (ChatMessage message in messages)
        {
            if (message.Role == ChatRole.User)
            {
                lastUser = message;
            }
        }

        if (lastUser is null || string.IsNullOrWhiteSpace(lastUser.Text))
        {
            throw new InvalidOperationException("MISSING_SPECIALIST_PROMPT");
        }

        return JsonSerializer.Deserialize<SpecialistPromptRequest>(lastUser.Text)
            ?? throw new InvalidOperationException("MALFORMED_SPECIALIST_PROMPT");
    }

    private SpecialistAgentPayload EvaluateDeterministic(SpecialistPromptRequest request)
    {
        string primaryRoot = request.OwnedPaths[0];
        string ownedTarget = $"{primaryRoot}/deterministic-unit.cs";

        long candidateRepoId = _scenario == SyntheticScenario.CrossRepositoryLeakAttempt && request.Stage == "coder"
            ? request.RepositoryId + 999L
            : request.RepositoryId;

        IReadOnlyList<string> proposedPaths = _scenario switch
        {
            SyntheticScenario.OutOfLanePathAttempt when request.Stage == "coder" => ["unowned-surface/rogue.cs"],
            SyntheticScenario.ProtectedControlPlaneAttempt when request.Stage == "coder" => [".github/workflows/validate.yml"],
            _ => [ownedTarget]
        };

        bool deficitOnThisTurn = (_scenario == SyntheticScenario.RepairableCoverageDeficit && request.Iteration == 0)
            || _scenario == SyntheticScenario.PersistentCoverageFailure;

        double linePct = deficitOnThisTurn ? 96.2 : 99.4;
        double branchPct = deficitOnThisTurn ? 92.0 : 97.8;

        bool securityAndReviewClean = _scenario != SyntheticScenario.SecurityOrReviewBlockingFinding;
        bool repairable = _scenario is SyntheticScenario.RepairableCoverageDeficit or SyntheticScenario.PersistentCoverageFailure;

        string reasonCode = !securityAndReviewClean && request.Stage == "security-and-review"
            ? "SECURITY_OR_REVIEW_BLOCKED"
            : deficitOnThisTurn && request.Stage == "test-and-coverage"
                ? "COVERAGE_INCOMPLETE"
                : "STAGE_OK";

        return new SpecialistAgentPayload
        {
            Role = request.Stage,
            CandidateRepositoryId = candidateRepoId,
            ProposedPaths = proposedPaths,
            LineCoveragePct = linePct,
            BranchCoveragePct = branchPct,
            TestsPassed = true,
            SecurityClear = securityAndReviewClean,
            ReviewClear = securityAndReviewClean,
            Repairable = repairable,
            ReasonCode = reasonCode
        };
    }
}
