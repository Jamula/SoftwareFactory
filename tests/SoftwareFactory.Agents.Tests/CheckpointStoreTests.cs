using System.Text;
using System.Text.Json;
using Microsoft.Agents.AI.Workflows;
using SoftwareFactory.Agents.Checkpointing;
using SoftwareFactory.Agents.Contracts;
using Xunit;

namespace SoftwareFactory.Agents.Tests;

public sealed class CheckpointStoreTests
{
    private static CheckpointBinding ValidBinding(
        long repositoryId = WorkItemContract.SoftwareFactoryRepositoryId,
        int issueNumber = 16,
        string headSha = "c77612ec77612ec77612ec77612ec77612ec7761") =>
        new()
        {
            RepositoryId = repositoryId,
            IssueNumber = issueNumber,
            HeadSha = headSha
        };

    [Fact]
    public async Task Store_PersistsVerifiesOrdersAndFiltersCheckpointsDeterministically()
    {
        string tempDir = Path.Combine(Path.GetTempPath(), $"sf-cp-test-{Guid.NewGuid():N}");
        try
        {
            CheckpointBinding binding = ValidBinding();
            var store = new IntegrityVerifiedJsonCheckpointStore(tempDir, binding);

            CheckpointInfo[] empty = (await store.RetrieveIndexAsync("empty-session")).ToArray();
            Assert.Empty(empty);

            using JsonDocument doc1 = JsonDocument.Parse("{\"b\":2,\"a\":[1,true,\"ok\"]}");
            using JsonDocument doc2 = JsonDocument.Parse("{\"step\":2}");

            CheckpointInfo cp1 = await store.CreateCheckpointAsync("session-1", doc1.RootElement, parent: null);
            CheckpointInfo cp2 = await store.CreateCheckpointAsync("session-1", doc2.RootElement, parent: cp1);

            var reloadedStore = new IntegrityVerifiedJsonCheckpointStore(tempDir, binding);
            CheckpointInfo[] all = (await reloadedStore.RetrieveIndexAsync("session-1")).ToArray();
            Assert.Equal(2, all.Length);
            Assert.Equal(cp1.CheckpointId, all[0].CheckpointId);
            Assert.Equal(cp2.CheckpointId, all[1].CheckpointId);

            CheckpointInfo[] filteredChild = (await reloadedStore.RetrieveIndexAsync("session-1", withParent: cp1)).ToArray();
            Assert.Single(filteredChild);
            Assert.Equal(cp2.CheckpointId, filteredChild[0].CheckpointId);

            CheckpointInfo[] filteredNone = (await reloadedStore.RetrieveIndexAsync("session-1", withParent: cp2)).ToArray();
            Assert.Empty(filteredNone);

            JsonElement restored = await reloadedStore.RetrieveCheckpointAsync("session-1", cp1);
            Assert.Equal(2, restored.GetProperty("b").GetInt32());
            Assert.Equal(3, restored.GetProperty("a").GetArrayLength());
        }
        finally
        {
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, recursive: true);
            }
        }
    }

    [Fact]
    public async Task Store_RejectsInvalidArgumentsMissingFilesTamperingAndBindingDriftFailClosed()
    {
        string tempDir = Path.Combine(Path.GetTempPath(), $"sf-cp-neg-{Guid.NewGuid():N}");
        try
        {
            Assert.Equal(
                "INVALID_CHECKPOINT_DIRECTORY",
                Assert.Throws<CheckpointIntegrityException>(() => new IntegrityVerifiedJsonCheckpointStore(" ", ValidBinding())).ReasonCode);
            Assert.Equal(
                "INVALID_BINDING_REPO_ID",
                Assert.Throws<CheckpointIntegrityException>(() => new IntegrityVerifiedJsonCheckpointStore(tempDir, ValidBinding(repositoryId: 0L))).ReasonCode);
            Assert.Equal(
                "INVALID_BINDING_ISSUE",
                Assert.Throws<CheckpointIntegrityException>(() => new IntegrityVerifiedJsonCheckpointStore(tempDir, ValidBinding(issueNumber: 0))).ReasonCode);
            Assert.Equal(
                "INVALID_BINDING_HEAD_SHA",
                Assert.Throws<CheckpointIntegrityException>(() => new IntegrityVerifiedJsonCheckpointStore(tempDir, ValidBinding(headSha: "bad"))).ReasonCode);

            var store = new IntegrityVerifiedJsonCheckpointStore(tempDir, ValidBinding());
            using JsonDocument doc = JsonDocument.Parse("{\"k\":\"v\"}");

            Assert.Equal(
                "INVALID_SESSION_ID",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () => await store.CreateCheckpointAsync("", doc.RootElement))).ReasonCode);
            Assert.Equal(
                "INVALID_SESSION_ID",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () => await store.CreateCheckpointAsync("bad/session", doc.RootElement))).ReasonCode);
            Assert.Equal(
                "INVALID_SESSION_ID",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () => await store.CreateCheckpointAsync(new string('s', 81), doc.RootElement))).ReasonCode);

            Assert.Equal(
                "CHECKPOINT_NOT_FOUND",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () =>
                    await store.RetrieveCheckpointAsync("missing-session", new CheckpointInfo("missing-session", "cp-000001")))).ReasonCode);

            CheckpointInfo cp1 = await store.CreateCheckpointAsync("session-ok", doc.RootElement);
            Assert.Equal(
                "CHECKPOINT_NOT_FOUND",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () =>
                    await store.RetrieveCheckpointAsync("session-ok", new CheckpointInfo("session-ok", "cp-999999")))).ReasonCode);
            Assert.Equal(
                "INVALID_CHECKPOINT_ID",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () =>
                    await store.RetrieveCheckpointAsync("session-ok", new CheckpointInfo("session-ok", "bad/cp")))).ReasonCode);

            // Binding drift checks across processes:
            var wrongRepoStore = new IntegrityVerifiedJsonCheckpointStore(tempDir, ValidBinding(repositoryId: 777L));
            Assert.Equal(
                "CHECKPOINT_REPO_MISMATCH",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () => await wrongRepoStore.RetrieveCheckpointAsync("session-ok", cp1))).ReasonCode);

            var wrongIssueStore = new IntegrityVerifiedJsonCheckpointStore(tempDir, ValidBinding(issueNumber: 99));
            Assert.Equal(
                "CHECKPOINT_ISSUE_MISMATCH",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () => await wrongIssueStore.RetrieveCheckpointAsync("session-ok", cp1))).ReasonCode);

            var staleHeadStore = new IntegrityVerifiedJsonCheckpointStore(
                tempDir,
                ValidBinding(headSha: "1111111111111111111111111111111111111111"));
            Assert.Equal(
                "STALE_CHECKPOINT_HEAD_SHA",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () => await staleHeadStore.RetrieveCheckpointAsync("session-ok", cp1))).ReasonCode);

            // Payload tamper -> SHA-256 mismatch:
            string cpFile = Path.Combine(tempDir, "session-ok", $"{cp1.CheckpointId}.checkpoint.json");
            string originalRaw = await File.ReadAllTextAsync(cpFile, Encoding.UTF8);
            await File.WriteAllTextAsync(cpFile, originalRaw.Replace("\"v\"", "\"tampered\"", StringComparison.Ordinal), Encoding.UTF8);
            Assert.Equal(
                "CHECKPOINT_DIGEST_MISMATCH",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () => await store.RetrieveCheckpointAsync("session-ok", cp1))).ReasonCode);

            // Truncated digest length mismatch:
            using JsonDocument parsed = JsonDocument.Parse(originalRaw);
            await File.WriteAllTextAsync(
                cpFile,
                originalRaw.Replace(parsed.RootElement.GetProperty("IntegritySha256").GetString()!, "abcd", StringComparison.Ordinal),
                Encoding.UTF8);
            Assert.Equal(
                "CHECKPOINT_DIGEST_MISMATCH",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () => await store.RetrieveCheckpointAsync("session-ok", cp1))).ReasonCode);

            // Identity mismatch:
            await File.WriteAllTextAsync(cpFile, originalRaw.Replace("\"session-ok\"", "\"other-session\"", StringComparison.Ordinal), Encoding.UTF8);
            Assert.Equal(
                "CHECKPOINT_IDENTITY_MISMATCH",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () => await store.RetrieveCheckpointAsync("session-ok", cp1))).ReasonCode);

            // Invalid schema version / sequence / null JSON:
            await File.WriteAllTextAsync(cpFile, originalRaw.Replace("\"SchemaVersion\":1", "\"SchemaVersion\":2", StringComparison.Ordinal), Encoding.UTF8);
            Assert.Equal(
                "INVALID_CHECKPOINT_SCHEMA",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () => await store.RetrieveCheckpointAsync("session-ok", cp1))).ReasonCode);

            await File.WriteAllTextAsync(cpFile, "null", Encoding.UTF8);
            Assert.Equal(
                "INVALID_CHECKPOINT_SCHEMA",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () => await store.RetrieveCheckpointAsync("session-ok", cp1))).ReasonCode);

            // Malformed JSON:
            await File.WriteAllTextAsync(cpFile, "{not-json", Encoding.UTF8);
            Assert.Equal(
                "MALFORMED_CHECKPOINT_JSON",
                (await Assert.ThrowsAsync<CheckpointIntegrityException>(async () => await store.RetrieveIndexAsync("session-ok"))).ReasonCode);
        }
        finally
        {
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, recursive: true);
            }
        }
    }
}
