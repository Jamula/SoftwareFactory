using SoftwareFactory.Agents.Contracts;
using Xunit;

namespace SoftwareFactory.Agents.Tests;

public sealed class ContractAndOwnershipTests
{
    public static WorkItemContract ValidFactoryContract(
        long repositoryId = WorkItemContract.SoftwareFactoryRepositoryId,
        string repositorySlug = WorkItemContract.SoftwareFactoryRepositorySlug,
        string headSha = "c77612ec77612ec77612ec77612ec77612ec7761",
        int issueNumber = 14,
        string laneId = "dotnet-agents",
        string specialistRole = "api",
        IReadOnlyList<string>? ownedPaths = null,
        double lineCoverageMin = 98.0,
        double branchCoverageMin = 95.0,
        int maxRepairIterations = 2,
        string traceParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01") =>
        new()
        {
            RepositoryId = repositoryId,
            RepositorySlug = repositorySlug,
            HeadSha = headSha,
            IssueNumber = issueNumber,
            LaneId = laneId,
            SpecialistRole = specialistRole,
            OwnedPaths = ownedPaths ?? ["src/SoftwareFactory.Agents", "tests/SoftwareFactory.Agents.Tests"],
            LineCoverageMin = lineCoverageMin,
            BranchCoverageMin = branchCoverageMin,
            MaxRepairIterations = maxRepairIterations,
            TraceParent = traceParent
        };

    [Fact]
    public void ValidateContract_AcceptsFactoryAndStricterConsumerContracts()
    {
        ContractValidationResult factoryOk = PathOwnershipGuard.ValidateContract(
            ValidFactoryContract(),
            WorkItemContract.SoftwareFactoryRepositoryId);
        Assert.True(factoryOk.IsValid);
        Assert.Equal("CONTRACT_VALID", factoryOk.ReasonCode);

        WorkItemContract consumer = ValidFactoryContract(
            repositoryId: 9001L,
            repositorySlug: "example/spellbook",
            lineCoverageMin: 97.0,
            branchCoverageMin: 90.0);
        ContractValidationResult consumerOk = PathOwnershipGuard.ValidateContract(consumer, 9001L);
        Assert.True(consumerOk.IsValid);
    }

    [Fact]
    public void ValidateContract_RejectsNullCrossRepoAndMalformedFieldsFailClosed()
    {
        Assert.Equal("CONTRACT_NULL", PathOwnershipGuard.ValidateContract(null, 1L).ReasonCode);
        Assert.Equal("CROSS_REPO_ISOLATION_VIOLATION", PathOwnershipGuard.ValidateContract(ValidFactoryContract(), 0L).ReasonCode);
        Assert.Equal("CROSS_REPO_ISOLATION_VIOLATION", PathOwnershipGuard.ValidateContract(ValidFactoryContract(repositoryId: 0L), 1L).ReasonCode);
        Assert.Equal("CROSS_REPO_ISOLATION_VIOLATION", PathOwnershipGuard.ValidateContract(ValidFactoryContract(), 9999L).ReasonCode);

        foreach (string badSlug in new[] { "", "noslash", "/leading", "trailing/", "two/slashes/here", "bad..slug/repo", "bad space/repo", new string('a', 201) })
        {
            Assert.Equal(
                "INVALID_REPOSITORY_SLUG",
                PathOwnershipGuard.ValidateContract(ValidFactoryContract(repositorySlug: badSlug), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);
        }

        foreach (string badSha in new[] { "short", new string('A', 40), new string('g', 40) })
        {
            Assert.Equal(
                "INVALID_HEAD_SHA",
                PathOwnershipGuard.ValidateContract(ValidFactoryContract(headSha: badSha), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);
        }
        Assert.False(PathOwnershipGuard.IsValidCommitSha(null));

        Assert.Equal(
            "INVALID_ISSUE_NUMBER",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(issueNumber: 0), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);

        foreach (string badLane in new[] { "", "-leading", "Upper", "bad_underscore", new string('a', 65) })
        {
            Assert.Equal(
                "INVALID_LANE_ID",
                PathOwnershipGuard.ValidateContract(ValidFactoryContract(laneId: badLane), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);
        }

        Assert.Equal(
            "UNKNOWN_SPECIALIST_ROLE",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(specialistRole: "generalist"), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);

        Assert.Equal(
            "INVALID_OWNED_PATHS",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(ownedPaths: []), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);

        string[] tooManyOwned = Enumerable.Range(0, 33).Select(i => $"src/p-{i}").ToArray();
        Assert.Equal(
            "INVALID_OWNED_PATHS",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(ownedPaths: tooManyOwned), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);

        var nullOwnedContract = new WorkItemContract
        {
            RepositoryId = WorkItemContract.SoftwareFactoryRepositoryId,
            RepositorySlug = WorkItemContract.SoftwareFactoryRepositorySlug,
            HeadSha = "c77612ec77612ec77612ec77612ec77612ec7761",
            IssueNumber = 14,
            LaneId = "dotnet-agents",
            SpecialistRole = "api",
            OwnedPaths = null!,
            LineCoverageMin = 98.0,
            BranchCoverageMin = 95.0,
            MaxRepairIterations = 1,
            TraceParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        };
        Assert.Equal(
            "INVALID_OWNED_PATHS",
            PathOwnershipGuard.ValidateContract(nullOwnedContract, WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);

        Assert.Equal(
            "UNSAFE_OR_DUPLICATE_OWNED_PATH",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(ownedPaths: ["../escape"]), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);
        Assert.Equal(
            "UNSAFE_OR_DUPLICATE_OWNED_PATH",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(ownedPaths: ["src/a", "src/a"]), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);
    }

    [Fact]
    public void ValidateContract_EnforcesCoverageRepairAndTraceParentFloors()
    {
        Assert.Equal(
            "COVERAGE_THRESHOLD_BELOW_FLOOR",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(lineCoverageMin: 97.9), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);
        Assert.Equal(
            "COVERAGE_THRESHOLD_BELOW_FLOOR",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(lineCoverageMin: 100.1), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);
        Assert.Equal(
            "COVERAGE_THRESHOLD_BELOW_FLOOR",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(lineCoverageMin: double.NaN), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);
        Assert.Equal(
            "COVERAGE_THRESHOLD_BELOW_FLOOR",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(branchCoverageMin: 94.9), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);
        Assert.Equal(
            "COVERAGE_THRESHOLD_BELOW_FLOOR",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(branchCoverageMin: 101.0), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);
        Assert.Equal(
            "COVERAGE_THRESHOLD_BELOW_FLOOR",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(branchCoverageMin: double.PositiveInfinity), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);

        // Slug-matched SoftwareFactory even with synthetic repo ID still enforces 98/95.
        Assert.Equal(
            "COVERAGE_THRESHOLD_BELOW_FLOOR",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(repositoryId: 42L, lineCoverageMin: 96.0), 42L).ReasonCode);

        Assert.Equal(
            "INVALID_REPAIR_BUDGET",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(maxRepairIterations: -1), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);
        Assert.Equal(
            "INVALID_REPAIR_BUDGET",
            PathOwnershipGuard.ValidateContract(ValidFactoryContract(maxRepairIterations: 6), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);

        string[] badTraceParents =
        [
            "",
            "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "00_4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
            "00-4bf92f3577b34da6a3ce929d0e0e473z-00f067aa0ba902b7-01",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-zz"
        ];
        foreach (string badTp in badTraceParents)
        {
            Assert.Equal(
                "INVALID_TRACEPARENT",
                PathOwnershipGuard.ValidateContract(ValidFactoryContract(traceParent: badTp), WorkItemContract.SoftwareFactoryRepositoryId).ReasonCode);
        }
        Assert.False(PathOwnershipGuard.IsValidTraceParent(null));
    }

    [Fact]
    public void ValidateCandidatePaths_EnforcesPathSafetyOwnershipAndControlPlaneProtection()
    {
        WorkItemContract contract = ValidFactoryContract(ownedPaths: ["src/SoftwareFactory.Agents", "apphost.cs"]);

        Assert.True(PathOwnershipGuard.ValidateCandidatePaths(
            contract,
            contract.RepositoryId,
            ["apphost.cs", "src/SoftwareFactory.Agents/MafCli.cs"]).IsValid);

        Assert.Equal(
            "CROSS_REPO_ISOLATION_VIOLATION",
            PathOwnershipGuard.ValidateCandidatePaths(contract, 0L, ["apphost.cs"]).ReasonCode);
        Assert.Equal(
            "CROSS_REPO_ISOLATION_VIOLATION",
            PathOwnershipGuard.ValidateCandidatePaths(contract, 99L, ["apphost.cs"]).ReasonCode);
        Assert.Equal(
            "EMPTY_OR_EXCESSIVE_CANDIDATE_PATHS",
            PathOwnershipGuard.ValidateCandidatePaths(contract, contract.RepositoryId, null).ReasonCode);
        Assert.Equal(
            "EMPTY_OR_EXCESSIVE_CANDIDATE_PATHS",
            PathOwnershipGuard.ValidateCandidatePaths(contract, contract.RepositoryId, []).ReasonCode);
        Assert.Equal(
            "EMPTY_OR_EXCESSIVE_CANDIDATE_PATHS",
            PathOwnershipGuard.ValidateCandidatePaths(
                contract,
                contract.RepositoryId,
                Enumerable.Range(0, 65).Select(i => $"src/SoftwareFactory.Agents/f{i}.cs").ToArray()).ReasonCode);

        foreach (string unsafePath in new[]
        {
            "",
            "/etc/passwd",
            "src/trailing/",
            "src\\backslash.cs",
            "C:/drive.cs",
            "src/wild*.cs",
            "src//empty.cs",
            "src/./dot.cs",
            "src/../escape.cs",
            new string('a', 201)
        })
        {
            Assert.Equal(
                "UNSAFE_PATH_REJECTED",
                PathOwnershipGuard.ValidateCandidatePaths(contract, contract.RepositoryId, [unsafePath]).ReasonCode);
        }
        Assert.False(PathOwnershipGuard.IsSafeRepoRelativePath(null));

        Assert.Equal(
            "DUPLICATE_CANDIDATE_PATH",
            PathOwnershipGuard.ValidateCandidatePaths(contract, contract.RepositoryId, ["apphost.cs", "apphost.cs"]).ReasonCode);
        Assert.Equal(
            "PROTECTED_CONTROL_PLANE_PATH_REJECTED",
            PathOwnershipGuard.ValidateCandidatePaths(contract, contract.RepositoryId, [".github/workflows/validate.yml"]).ReasonCode);
        Assert.Equal(
            "PROTECTED_CONTROL_PLANE_PATH_REJECTED",
            PathOwnershipGuard.ValidateCandidatePaths(contract, contract.RepositoryId, [".github/aw/reconcile.lock.yml"]).ReasonCode);

        // Even when a lane explicitly owns .github/workflows or config, control-plane edits stay blocked without human sign-off:
        WorkItemContract workflowsOwnedUnsigned = ValidFactoryContract(ownedPaths: [".github/workflows", "config"]);
        Assert.Equal(
            "PROTECTED_CONTROL_PLANE_PATH_REJECTED",
            PathOwnershipGuard.ValidateCandidatePaths(
                workflowsOwnedUnsigned,
                workflowsOwnedUnsigned.RepositoryId,
                [".github/workflows/validate.yml"]).ReasonCode);
        Assert.Equal(
            "PROTECTED_CONTROL_PLANE_PATH_REJECTED",
            PathOwnershipGuard.ValidateCandidatePaths(
                workflowsOwnedUnsigned,
                workflowsOwnedUnsigned.RepositoryId,
                ["config/examples/softwarefactory.json"]).ReasonCode);

        // With explicit HumanOwnerSignOffVerified == true, owned protected paths pass while unowned paths still fail closed:
        var workflowsOwnedSigned = new WorkItemContract
        {
            RepositoryId = WorkItemContract.SoftwareFactoryRepositoryId,
            RepositorySlug = WorkItemContract.SoftwareFactoryRepositorySlug,
            HeadSha = "c77612ec77612ec77612ec77612ec77612ec7761",
            IssueNumber = 14,
            LaneId = "workflows",
            SpecialistRole = "security",
            OwnedPaths = [".github/workflows"],
            LineCoverageMin = 98.0,
            BranchCoverageMin = 95.0,
            MaxRepairIterations = 1,
            TraceParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            HumanOwnerSignOffVerified = true
        };
        Assert.True(PathOwnershipGuard.ValidateCandidatePaths(
            workflowsOwnedSigned,
            workflowsOwnedSigned.RepositoryId,
            [".github/workflows/validate.yml"]).IsValid);
        Assert.Equal(
            "OUT_OF_LANE_PATH_REJECTED",
            PathOwnershipGuard.ValidateCandidatePaths(
                workflowsOwnedSigned,
                workflowsOwnedSigned.RepositoryId,
                ["config/examples/softwarefactory.json"]).ReasonCode);

        Assert.Equal(
            "OUT_OF_LANE_PATH_REJECTED",
            PathOwnershipGuard.ValidateCandidatePaths(contract, contract.RepositoryId, ["docs/ROADMAP.md"]).ReasonCode);

        Assert.True(PathOwnershipGuard.PathsOverlap("src/a", "src/a"));
        Assert.True(PathOwnershipGuard.PathsOverlap("src/a/b", "src/a"));
        Assert.True(PathOwnershipGuard.PathsOverlap("src/a", "src/a/b"));
        Assert.False(PathOwnershipGuard.PathsOverlap("src/a", "src/ab"));
    }
}
