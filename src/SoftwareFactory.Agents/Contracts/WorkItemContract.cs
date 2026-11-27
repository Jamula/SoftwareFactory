namespace SoftwareFactory.Agents.Contracts;

public sealed class WorkItemContract
{
    public const long SoftwareFactoryRepositoryId = 1471342715L;
    public const string SoftwareFactoryRepositorySlug = "Jamula/SoftwareFactory";

    public required long RepositoryId { get; init; }
    public required string RepositorySlug { get; init; }
    public required string HeadSha { get; init; }
    public required int IssueNumber { get; init; }
    public required string LaneId { get; init; }
    public required string SpecialistRole { get; init; }
    public required IReadOnlyList<string> OwnedPaths { get; init; }
    public required double LineCoverageMin { get; init; }
    public required double BranchCoverageMin { get; init; }
    public required int MaxRepairIterations { get; init; }
    public required string TraceParent { get; init; }
    public bool HumanOwnerSignOffVerified { get; init; }
}

public sealed class ContractValidationResult
{
    public required bool IsValid { get; init; }
    public required string ReasonCode { get; init; }

    public static ContractValidationResult Valid() =>
        new() { IsValid = true, ReasonCode = "CONTRACT_VALID" };

    public static ContractValidationResult Deny(string reasonCode) =>
        new() { IsValid = false, ReasonCode = reasonCode };
}

public static class PathOwnershipGuard
{
    private static readonly HashSet<string> AllowedRoles = new(StringComparer.Ordinal)
    {
        "api", "data", "security", "test", "infra", "ui", "docs", "coordinator"
    };

    private static readonly string[] ProtectedPrefixes =
    [
        ".github/workflows",
        "config",
        "SECURITY.md",
        "docs/POLICY.md",
        "docs/ENGINEERING-STANDARDS.md",
        "tools/engineering-factory/core.mjs",
        "tools/engineering-factory/protected-squash.mjs",
        "tools/engineering-factory/platform-merge-gates.mjs",
        "tools/engineering-factory/coverage-evidence.mjs",
        "tools/engineering-factory/budget.mjs"
    ];

    public static ContractValidationResult ValidateContract(WorkItemContract? contract, long trustedRepositoryId)
    {
        if (contract is null)
        {
            return ContractValidationResult.Deny("CONTRACT_NULL");
        }

        if (trustedRepositoryId <= 0 || contract.RepositoryId <= 0 || contract.RepositoryId != trustedRepositoryId)
        {
            return ContractValidationResult.Deny("CROSS_REPO_ISOLATION_VIOLATION");
        }

        if (!IsValidRepositorySlug(contract.RepositorySlug))
        {
            return ContractValidationResult.Deny("INVALID_REPOSITORY_SLUG");
        }

        if (!IsValidCommitSha(contract.HeadSha))
        {
            return ContractValidationResult.Deny("INVALID_HEAD_SHA");
        }

        if (contract.IssueNumber <= 0)
        {
            return ContractValidationResult.Deny("INVALID_ISSUE_NUMBER");
        }

        if (!IsValidIdentifier(contract.LaneId))
        {
            return ContractValidationResult.Deny("INVALID_LANE_ID");
        }

        if (!AllowedRoles.Contains(contract.SpecialistRole))
        {
            return ContractValidationResult.Deny("UNKNOWN_SPECIALIST_ROLE");
        }

        if (contract.OwnedPaths is null || contract.OwnedPaths.Count == 0 || contract.OwnedPaths.Count > 32)
        {
            return ContractValidationResult.Deny("INVALID_OWNED_PATHS");
        }

        var seenOwned = new HashSet<string>(StringComparer.Ordinal);
        foreach (string owned in contract.OwnedPaths)
        {
            if (!IsSafeRepoRelativePath(owned) || !seenOwned.Add(owned))
            {
                return ContractValidationResult.Deny("UNSAFE_OR_DUPLICATE_OWNED_PATH");
            }
        }

        bool isFactory = contract.RepositoryId == WorkItemContract.SoftwareFactoryRepositoryId
            || string.Equals(contract.RepositorySlug, WorkItemContract.SoftwareFactoryRepositorySlug, StringComparison.OrdinalIgnoreCase);
        double minLineFloor = isFactory ? 98.0 : 95.0;
        double minBranchFloor = isFactory ? 95.0 : 90.0;

        if (!double.IsFinite(contract.LineCoverageMin) || contract.LineCoverageMin < minLineFloor || contract.LineCoverageMin > 100.0)
        {
            return ContractValidationResult.Deny("COVERAGE_THRESHOLD_BELOW_FLOOR");
        }

        if (!double.IsFinite(contract.BranchCoverageMin) || contract.BranchCoverageMin < minBranchFloor || contract.BranchCoverageMin > 100.0)
        {
            return ContractValidationResult.Deny("COVERAGE_THRESHOLD_BELOW_FLOOR");
        }

        if (contract.MaxRepairIterations < 0 || contract.MaxRepairIterations > 5)
        {
            return ContractValidationResult.Deny("INVALID_REPAIR_BUDGET");
        }

        if (!IsValidTraceParent(contract.TraceParent))
        {
            return ContractValidationResult.Deny("INVALID_TRACEPARENT");
        }

        return ContractValidationResult.Valid();
    }

    public static ContractValidationResult ValidateCandidatePaths(
        WorkItemContract contract,
        long candidateRepositoryId,
        IReadOnlyList<string>? candidatePaths)
    {
        if (candidateRepositoryId <= 0 || candidateRepositoryId != contract.RepositoryId)
        {
            return ContractValidationResult.Deny("CROSS_REPO_ISOLATION_VIOLATION");
        }

        if (candidatePaths is null || candidatePaths.Count == 0 || candidatePaths.Count > 64)
        {
            return ContractValidationResult.Deny("EMPTY_OR_EXCESSIVE_CANDIDATE_PATHS");
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (string candidate in candidatePaths)
        {
            if (!IsSafeRepoRelativePath(candidate))
            {
                return ContractValidationResult.Deny("UNSAFE_PATH_REJECTED");
            }

            if (!seen.Add(candidate))
            {
                return ContractValidationResult.Deny("DUPLICATE_CANDIDATE_PATH");
            }

            if (IsProtectedControlPlanePath(candidate) && !contract.HumanOwnerSignOffVerified)
            {
                return ContractValidationResult.Deny("PROTECTED_CONTROL_PLANE_PATH_REJECTED");
            }

            if (!IsOwnedByAny(candidate, contract.OwnedPaths))
            {
                return ContractValidationResult.Deny("OUT_OF_LANE_PATH_REJECTED");
            }
        }

        return ContractValidationResult.Valid();
    }

    public static bool PathsOverlap(string left, string right) =>
        string.Equals(left, right, StringComparison.Ordinal)
        || left.StartsWith(right + "/", StringComparison.Ordinal)
        || right.StartsWith(left + "/", StringComparison.Ordinal);

    public static bool IsSafeRepoRelativePath(string? path)
    {
        if (string.IsNullOrEmpty(path) || path.Length > 200)
        {
            return false;
        }

        if (path[0] == '/' || path[^1] == '/' || path.Contains('\\', StringComparison.Ordinal) || path.Contains(':', StringComparison.Ordinal))
        {
            return false;
        }

        foreach (char c in path)
        {
            if (!IsAllowedPathChar(c))
            {
                return false;
            }
        }

        string[] segments = path.Split('/');
        foreach (string segment in segments)
        {
            if (segment.Length == 0 || segment is "." or "..")
            {
                return false;
            }
        }

        return true;
    }

    public static bool IsValidIdentifier(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 64 || !IsLowerAlphaNumeric(value[0]))
        {
            return false;
        }

        for (int i = 1; i < value.Length; i++)
        {
            char c = value[i];
            if (!IsLowerAlphaNumeric(c) && c != '-')
            {
                return false;
            }
        }

        return true;
    }

    public static bool IsValidCommitSha(string? sha)
    {
        if (sha is null || sha.Length != 40)
        {
            return false;
        }

        foreach (char c in sha)
        {
            if (!IsLowerHex(c))
            {
                return false;
            }
        }

        return true;
    }

    public static bool IsValidTraceParent(string? traceParent)
    {
        if (traceParent is null || traceParent.Length != 55)
        {
            return false;
        }

        if (traceParent[0] != '0' || traceParent[1] != '0' || traceParent[2] != '-' || traceParent[35] != '-' || traceParent[52] != '-')
        {
            return false;
        }

        string traceId = traceParent.Substring(3, 32);
        string spanId = traceParent.Substring(36, 16);
        string flags = traceParent.Substring(53, 2);

        return IsNonZeroLowerHex(traceId) && IsNonZeroLowerHex(spanId) && IsLowerHexPair(flags);
    }

    private static bool IsValidRepositorySlug(string? slug)
    {
        if (string.IsNullOrEmpty(slug) || slug.Length > 200 || slug.Contains("..", StringComparison.Ordinal))
        {
            return false;
        }

        int slash = slug.IndexOf('/');
        if (slash <= 0 || slash == slug.Length - 1 || slug.IndexOf('/', slash + 1) >= 0)
        {
            return false;
        }

        foreach (char c in slug)
        {
            if (c != '/' && !IsAllowedPathChar(c))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsOwnedByAny(string candidate, IReadOnlyList<string> ownedPaths)
    {
        foreach (string owned in ownedPaths)
        {
            if (string.Equals(candidate, owned, StringComparison.Ordinal)
                || candidate.StartsWith(owned + "/", StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsProtectedControlPlanePath(string candidate)
    {
        if (candidate.EndsWith(".lock.yml", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        foreach (string prefix in ProtectedPrefixes)
        {
            if (PathsOverlap(candidate, prefix))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsAllowedPathChar(char c) =>
        (c >= 'a' && c <= 'z')
        || (c >= 'A' && c <= 'Z')
        || (c >= '0' && c <= '9')
        || c is '.' or '_' or '-' or '/';

    private static bool IsLowerAlphaNumeric(char c) =>
        (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');

    private static bool IsLowerHex(char c) =>
        (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');

    private static bool IsLowerHexPair(string value) =>
        IsLowerHex(value[0]) && IsLowerHex(value[1]);

    private static bool IsNonZeroLowerHex(string value)
    {
        bool anyNonZero = false;
        foreach (char c in value)
        {
            if (!IsLowerHex(c))
            {
                return false;
            }

            if (c != '0')
            {
                anyNonZero = true;
            }
        }

        return anyNonZero;
    }
}
