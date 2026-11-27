using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Agents.AI.Workflows.Checkpointing;
using SoftwareFactory.Agents.Contracts;
using SoftwareFactory.Agents.Telemetry;

namespace SoftwareFactory.Agents.Checkpointing;

public sealed class CheckpointBinding
{
    public required long RepositoryId { get; init; }
    public required int IssueNumber { get; init; }
    public required string HeadSha { get; init; }

    public void Validate()
    {
        if (RepositoryId <= 0)
        {
            throw new CheckpointIntegrityException("INVALID_BINDING_REPO_ID", "RepositoryId must be positive.");
        }

        if (IssueNumber <= 0)
        {
            throw new CheckpointIntegrityException("INVALID_BINDING_ISSUE", "IssueNumber must be positive.");
        }

        if (!PathOwnershipGuard.IsValidCommitSha(HeadSha))
        {
            throw new CheckpointIntegrityException("INVALID_BINDING_HEAD_SHA", "HeadSha must be a 40-char lowercase hex SHA.");
        }
    }
}

public sealed class CheckpointIntegrityException : Exception
{
    public CheckpointIntegrityException(string reasonCode, string message)
        : base(message)
    {
        ReasonCode = reasonCode;
    }

    public string ReasonCode { get; }
}

internal sealed class StoredCheckpointEnvelope
{
    public required int SchemaVersion { get; init; }
    public required long Sequence { get; init; }
    public required string SessionId { get; init; }
    public required string CheckpointId { get; init; }
    public string? ParentSessionId { get; init; }
    public string? ParentCheckpointId { get; init; }
    public required long RepositoryId { get; init; }
    public required int IssueNumber { get; init; }
    public required string HeadSha { get; init; }
    public required string IntegritySha256 { get; init; }
    public required JsonElement Payload { get; init; }
}

public sealed class IntegrityVerifiedJsonCheckpointStore : ICheckpointStore<JsonElement>
{
    private readonly string _rootDirectory;
    private readonly CheckpointBinding _expectedBinding;
    private readonly string _laneId;
    private readonly Lock _sync = new();

    public IntegrityVerifiedJsonCheckpointStore(string rootDirectory, CheckpointBinding expectedBinding, string laneId = "dotnet-agents")
    {
        if (string.IsNullOrWhiteSpace(rootDirectory))
        {
            throw new CheckpointIntegrityException("INVALID_CHECKPOINT_DIRECTORY", "Checkpoint directory cannot be empty.");
        }

        ArgumentNullException.ThrowIfNull(expectedBinding);
        expectedBinding.Validate();

        _rootDirectory = Path.GetFullPath(rootDirectory);
        _expectedBinding = expectedBinding;
        _laneId = laneId;
        Directory.CreateDirectory(_rootDirectory);
    }

    public CheckpointBinding ExpectedBinding => _expectedBinding;

    public ValueTask<CheckpointInfo> CreateCheckpointAsync(string sessionId, JsonElement value, CheckpointInfo? parent = null)
    {
        ValidateToken(sessionId, "INVALID_SESSION_ID");
        VerifyEmbeddedContractsMatchBinding(value, _expectedBinding);

        lock (_sync)
        {
            string sessionDir = GetVerifiedSessionDirectory(sessionId, createIfMissing: true);
            long nextSequence = GetMaxExistingSequence(sessionDir) + 1L;
            string checkpointId = $"cp-{nextSequence:D6}";
            var info = new CheckpointInfo(sessionId, checkpointId);

            string canonicalPayload = CanonicalizeJson(value);
            string digest = ComputeEnvelopeDigest(
                schemaVersion: 1,
                sequence: nextSequence,
                sessionId: sessionId,
                checkpointId: checkpointId,
                parentSessionId: parent?.SessionId,
                parentCheckpointId: parent?.CheckpointId,
                binding: _expectedBinding,
                canonicalPayload: canonicalPayload);

            var envelope = new StoredCheckpointEnvelope
            {
                SchemaVersion = 1,
                Sequence = nextSequence,
                SessionId = sessionId,
                CheckpointId = checkpointId,
                ParentSessionId = parent?.SessionId,
                ParentCheckpointId = parent?.CheckpointId,
                RepositoryId = _expectedBinding.RepositoryId,
                IssueNumber = _expectedBinding.IssueNumber,
                HeadSha = _expectedBinding.HeadSha,
                IntegritySha256 = digest,
                Payload = value.Clone()
            };

            string targetFile = ResolveSafeFilePath(sessionDir, $"{checkpointId}.checkpoint.json");
            string tempFile = ResolveSafeFilePath(sessionDir, $"{checkpointId}.{Guid.NewGuid():N}.tmp");
            string serialized = JsonSerializer.Serialize(envelope);
            File.WriteAllText(tempFile, serialized, Encoding.UTF8);
            CommitCheckpointAtomicallyWithoutOverwrite(tempFile, targetFile);

            using var activity = SoftwareFactoryTelemetry.StartStageActivity(
                stage: "checkpoint",
                lane: _laneId,
                superstep: (int)nextSequence,
                outcome: "checkpointed",
                reason: "CHECKPOINT_COMMITTED");

            return ValueTask.FromResult(info);
        }
    }

    public ValueTask<JsonElement> RetrieveCheckpointAsync(string sessionId, CheckpointInfo key)
    {
        ValidateToken(sessionId, "INVALID_SESSION_ID");
        ArgumentNullException.ThrowIfNull(key);
        ValidateToken(key.CheckpointId, "INVALID_CHECKPOINT_ID");

        lock (_sync)
        {
            string sessionDir = GetVerifiedSessionDirectory(sessionId, createIfMissing: false);
            if (!Directory.Exists(sessionDir))
            {
                throw new CheckpointIntegrityException("CHECKPOINT_NOT_FOUND", "Session checkpoint directory does not exist.");
            }

            string targetFile = ResolveSafeFilePath(sessionDir, $"{key.CheckpointId}.checkpoint.json");
            if (!File.Exists(targetFile))
            {
                throw new CheckpointIntegrityException("CHECKPOINT_NOT_FOUND", "Checkpoint file does not exist.");
            }

            StoredCheckpointEnvelope envelope = ReadAndVerifyEnvelope(targetFile, sessionId, key.CheckpointId);
            using var activity = SoftwareFactoryTelemetry.StartStageActivity(
                stage: "checkpoint",
                lane: _laneId,
                superstep: (int)envelope.Sequence,
                outcome: "resumed",
                reason: "CHECKPOINT_VERIFIED");

            return ValueTask.FromResult(envelope.Payload);
        }
    }

    public ValueTask<IEnumerable<CheckpointInfo>> RetrieveIndexAsync(string sessionId, CheckpointInfo? withParent = null)
    {
        ValidateToken(sessionId, "INVALID_SESSION_ID");

        lock (_sync)
        {
            string sessionDir = GetVerifiedSessionDirectory(sessionId, createIfMissing: false);
            if (!Directory.Exists(sessionDir))
            {
                return ValueTask.FromResult<IEnumerable<CheckpointInfo>>([]);
            }

            string[] files = Directory.GetFiles(sessionDir, "*.checkpoint.json");
            List<StoredCheckpointEnvelope> envelopes = files
                .Select(file => ReadAndVerifyEnvelope(
                    file,
                    sessionId,
                    Path.GetFileName(file)[..^".checkpoint.json".Length]))
                .ToList();

            envelopes.Sort(static (left, right) => left.Sequence.CompareTo(right.Sequence));

            IEnumerable<StoredCheckpointEnvelope> matching = withParent is null
                ? envelopes
                : envelopes.Where(envelope =>
                    string.Equals(envelope.ParentSessionId, withParent.SessionId, StringComparison.Ordinal)
                    && string.Equals(envelope.ParentCheckpointId, withParent.CheckpointId, StringComparison.Ordinal));

            List<CheckpointInfo> results = matching
                .Select(static envelope => new CheckpointInfo(envelope.SessionId, envelope.CheckpointId))
                .ToList();

            return ValueTask.FromResult<IEnumerable<CheckpointInfo>>(results);
        }
    }

    private StoredCheckpointEnvelope ReadAndVerifyEnvelope(string filePath, string expectedSessionId, string expectedCheckpointId)
    {
        StoredCheckpointEnvelope? envelope;
        try
        {
            string raw = File.ReadAllText(filePath, Encoding.UTF8);
            envelope = JsonSerializer.Deserialize<StoredCheckpointEnvelope>(raw);
        }
        catch (JsonException)
        {
            throw new CheckpointIntegrityException("MALFORMED_CHECKPOINT_JSON", "Checkpoint JSON could not be parsed.");
        }

        if (envelope is null || envelope.SchemaVersion != 1 || envelope.Sequence <= 0)
        {
            throw new CheckpointIntegrityException("INVALID_CHECKPOINT_SCHEMA", "Checkpoint envelope schema is invalid.");
        }

        if (!string.Equals(envelope.SessionId, expectedSessionId, StringComparison.Ordinal)
            || !string.Equals(envelope.CheckpointId, expectedCheckpointId, StringComparison.Ordinal))
        {
            throw new CheckpointIntegrityException("CHECKPOINT_IDENTITY_MISMATCH", "Checkpoint session or key identity does not match.");
        }

        if (envelope.RepositoryId != _expectedBinding.RepositoryId)
        {
            throw new CheckpointIntegrityException("CHECKPOINT_REPO_MISMATCH", "Checkpoint RepositoryId does not match expected repository.");
        }

        if (envelope.IssueNumber != _expectedBinding.IssueNumber)
        {
            throw new CheckpointIntegrityException("CHECKPOINT_ISSUE_MISMATCH", "Checkpoint IssueNumber does not match expected issue.");
        }

        if (!string.Equals(envelope.HeadSha, _expectedBinding.HeadSha, StringComparison.Ordinal))
        {
            throw new CheckpointIntegrityException("STALE_CHECKPOINT_HEAD_SHA", "Checkpoint HeadSha is stale or mismatched.");
        }

        string canonicalPayload = CanonicalizeJson(envelope.Payload);
        string expectedDigest = ComputeEnvelopeDigest(
            schemaVersion: envelope.SchemaVersion,
            sequence: envelope.Sequence,
            sessionId: envelope.SessionId,
            checkpointId: envelope.CheckpointId,
            parentSessionId: envelope.ParentSessionId,
            parentCheckpointId: envelope.ParentCheckpointId,
            binding: _expectedBinding,
            canonicalPayload: canonicalPayload);

        byte[] actualBytes = Encoding.ASCII.GetBytes(envelope.IntegritySha256);
        byte[] expectedBytes = Encoding.ASCII.GetBytes(expectedDigest);
        if (actualBytes.Length != expectedBytes.Length
            || !CryptographicOperations.FixedTimeEquals(actualBytes, expectedBytes))
        {
            throw new CheckpointIntegrityException("CHECKPOINT_DIGEST_MISMATCH", "Checkpoint SHA-256 integrity verification failed.");
        }

        VerifyEmbeddedContractsMatchBinding(envelope.Payload, _expectedBinding);
        return envelope;
    }

    public static void VerifyContractMatchesBinding(
        WorkItemContract? contract,
        long trustedRepositoryId,
        CheckpointBinding expectedBinding)
    {
        ArgumentNullException.ThrowIfNull(expectedBinding);
        if (contract is null
            || trustedRepositoryId != expectedBinding.RepositoryId
            || contract.RepositoryId != expectedBinding.RepositoryId
            || contract.IssueNumber != expectedBinding.IssueNumber
            || !string.Equals(contract.HeadSha, expectedBinding.HeadSha, StringComparison.Ordinal))
        {
            throw new CheckpointIntegrityException(
                "CHECKPOINT_CONTRACT_BINDING_MISMATCH",
                "WorkItemContract identity does not match checkpoint store binding.");
        }
    }

    public static void CommitCheckpointAtomicallyWithoutOverwrite(string tempFile, string targetFile)
    {
        try
        {
            File.Move(tempFile, targetFile, overwrite: false);
        }
        catch (IOException)
        {
            if (File.Exists(tempFile))
            {
                File.Delete(tempFile);
            }

            throw new CheckpointIntegrityException(
                "CHECKPOINT_COLLISION_DETECTED",
                "Committed checkpoint file already exists and is immutable.");
        }
    }

    private static long GetMaxExistingSequence(string sessionDir) =>
        Directory.GetFiles(sessionDir, "*.checkpoint.json")
            .Select(ParseSequenceFromFilePath)
            .DefaultIfEmpty(0L)
            .Max();

    private static long ParseSequenceFromFilePath(string filePath)
    {
        string stem = Path.GetFileName(filePath)[..^".checkpoint.json".Length];
        if (!stem.StartsWith("cp-", StringComparison.Ordinal)
            || !long.TryParse(stem.AsSpan(3), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out long parsed)
            || parsed <= 0L)
        {
            throw new CheckpointIntegrityException("MALFORMED_CHECKPOINT_FILENAME", "Existing checkpoint file name is invalid.");
        }

        return parsed;
    }

    private static void VerifyEmbeddedContractsMatchBinding(JsonElement element, CheckpointBinding expected)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            if (element.TryGetProperty("RepositoryId", out JsonElement repoProp)
                && element.TryGetProperty("IssueNumber", out JsonElement issueProp)
                && element.TryGetProperty("HeadSha", out JsonElement headProp)
                && repoProp.ValueKind == JsonValueKind.Number
                && issueProp.ValueKind == JsonValueKind.Number
                && headProp.ValueKind == JsonValueKind.String)
            {
                long repoId = repoProp.GetInt64();
                int issueNumber = issueProp.GetInt32();
                string? headSha = headProp.GetString();
                if (repoId != expected.RepositoryId
                    || issueNumber != expected.IssueNumber
                    || !string.Equals(headSha, expected.HeadSha, StringComparison.Ordinal))
                {
                    throw new CheckpointIntegrityException(
                        "CHECKPOINT_CONTRACT_BINDING_MISMATCH",
                        "Serialized payload contract identity does not match checkpoint binding.");
                }
            }

            foreach (JsonElement propValue in element.EnumerateObject().Select(static prop => prop.Value))
            {
                VerifyEmbeddedContractsMatchBinding(propValue, expected);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                VerifyEmbeddedContractsMatchBinding(item, expected);
            }
        }
    }

    private string GetVerifiedSessionDirectory(string sessionId, bool createIfMissing)
    {
        string sessionDir = ResolveSafeFilePath(_rootDirectory, sessionId);
        if (createIfMissing)
        {
            Directory.CreateDirectory(sessionDir);
        }

        return sessionDir;
    }

    private static string ResolveSafeFilePath(string baseDirectory, string childName)
    {
        string fullBase = Path.GetFullPath(baseDirectory);
        string prefix = fullBase.EndsWith(Path.DirectorySeparatorChar)
            ? fullBase
            : fullBase + Path.DirectorySeparatorChar;
        string combined = Path.GetFullPath(Path.Join(fullBase, childName));
        if (!combined.StartsWith(prefix, StringComparison.Ordinal))
        {
            throw new CheckpointIntegrityException("UNSAFE_CHECKPOINT_PATH", "Checkpoint path escaped root directory.");
        }

        return combined;
    }

    private static void ValidateToken(string? value, string reasonCode)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 80)
        {
            throw new CheckpointIntegrityException(reasonCode, "Identifier must be 1..80 safe characters.");
        }

        foreach (char c in value)
        {
            bool safe = (c >= 'a' && c <= 'z')
                || (c >= 'A' && c <= 'Z')
                || (c >= '0' && c <= '9')
                || c is '-' or '_';
            if (!safe)
            {
                throw new CheckpointIntegrityException(reasonCode, "Identifier contains unsafe characters.");
            }
        }
    }

    private static string CanonicalizeJson(JsonElement element)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = false }))
        {
            WriteCanonicalElement(writer, element);
        }

        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteCanonicalElement(Utf8JsonWriter writer, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                List<JsonProperty> props = [.. element.EnumerateObject()];

                props.Sort(static (a, b) => string.CompareOrdinal(a.Name, b.Name));
                foreach (JsonProperty prop in props)
                {
                    writer.WritePropertyName(prop.Name);
                    WriteCanonicalElement(writer, prop.Value);
                }

                writer.WriteEndObject();
                break;

            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (JsonElement item in element.EnumerateArray())
                {
                    WriteCanonicalElement(writer, item);
                }

                writer.WriteEndArray();
                break;

            default:
                element.WriteTo(writer);
                break;
        }
    }

    private static string ComputeEnvelopeDigest(
        int schemaVersion,
        long sequence,
        string sessionId,
        string checkpointId,
        string? parentSessionId,
        string? parentCheckpointId,
        CheckpointBinding binding,
        string canonicalPayload)
    {
        string material = string.Create(
            System.Globalization.CultureInfo.InvariantCulture,
            $"v{schemaVersion}|seq={sequence}|session={sessionId}|cp={checkpointId}|ps={parentSessionId ?? ""}|pcp={parentCheckpointId ?? ""}|repo={binding.RepositoryId}|issue={binding.IssueNumber}|head={binding.HeadSha}|payload={canonicalPayload}");
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(material));
        return Convert.ToHexStringLower(hash);
    }
}
