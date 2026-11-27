using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Net.Http;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Exporter;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace SoftwareFactory.Agents.Telemetry;

public sealed class ValidatedLocalOtlpConfig
{
    public required Uri BaseEndpoint { get; init; }
    public required OtlpExportProtocol Protocol { get; init; }
    public required string Headers { get; init; }
    public required string ServiceName { get; init; }
}

public sealed class LocalOtlpConfigurationException : Exception
{
    public LocalOtlpConfigurationException(string reasonCode, string message)
        : base(message)
    {
        ReasonCode = reasonCode;
    }

    public string ReasonCode { get; }
}

public sealed class LocalOtlpRuntime : IDisposable
{
    private readonly TracerProvider? _tracerProvider;
    private readonly MeterProvider? _meterProvider;
    private readonly ILoggerFactory? _loggerFactory;
    private int _disposed;

    internal LocalOtlpRuntime(
        bool isEnabled,
        TracerProvider? tracerProvider,
        MeterProvider? meterProvider,
        ILoggerFactory? loggerFactory,
        ILogger? stageLogger)
    {
        IsEnabled = isEnabled;
        _tracerProvider = tracerProvider;
        _meterProvider = meterProvider;
        _loggerFactory = loggerFactory;
        SoftwareFactoryTelemetry.AttachStageLogger(stageLogger);
    }

    public bool IsEnabled { get; }

    public static LocalOtlpRuntime Disabled() =>
        new(isEnabled: false, tracerProvider: null, meterProvider: null, loggerFactory: null, stageLogger: null);

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        SoftwareFactoryTelemetry.AttachStageLogger(null);
        _tracerProvider?.ForceFlush(3000);
        _meterProvider?.ForceFlush(3000);
        _tracerProvider?.Dispose();
        _meterProvider?.Dispose();
        _loggerFactory?.Dispose();
    }
}

public static class LocalOtlpBootstrap
{
    private static readonly HashSet<string> LoopbackHosts = new(StringComparer.OrdinalIgnoreCase)
    {
        "127.0.0.1",
        "localhost",
        "::1",
        "[::1]"
    };

    private static readonly string[] ForbiddenEnvPrefixes =
    [
        "OTEL_EXPORTER_OTLP_TRACES_",
        "OTEL_EXPORTER_OTLP_METRICS_",
        "OTEL_EXPORTER_OTLP_LOGS_"
    ];

    private static readonly HashSet<string> ForbiddenExactEnvKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "OTEL_EXPORTER_OTLP_CERTIFICATE",
        "OTEL_EXPORTER_OTLP_INSECURE"
    };

    public static LocalOtlpRuntime StartFromEnvironment(IReadOnlyDictionary<string, string?>? environment = null)
    {
        IReadOnlyDictionary<string, string?> env = environment ?? SnapshotProcessEnvironment();
        ValidatedLocalOtlpConfig? validated = ValidateEnvironment(env);
        if (validated is null)
        {
            return LocalOtlpRuntime.Disabled();
        }

        ResourceBuilder resource = ResourceBuilder.CreateDefault().AddService(validated.ServiceName);

        TracerProvider tracerProvider = Sdk.CreateTracerProviderBuilder()
            .SetResourceBuilder(resource)
            .AddSource(SoftwareFactoryTelemetry.WorkflowsSourceName, SoftwareFactoryTelemetry.AgentsSourceName)
            .AddOtlpExporter(options => ConfigureExporterOptions(options, validated, "/v1/traces"))
            .Build();

        MeterProvider meterProvider = Sdk.CreateMeterProviderBuilder()
            .SetResourceBuilder(resource)
            .AddMeter(SoftwareFactoryTelemetry.AgentsSourceName)
            .AddOtlpExporter(options => ConfigureExporterOptions(options, validated, "/v1/metrics"))
            .Build();

        ILoggerFactory loggerFactory = LoggerFactory.Create(logging =>
        {
            logging.ClearProviders();
            logging.AddOpenTelemetry(otel =>
            {
                otel.SetResourceBuilder(resource);
                otel.IncludeFormattedMessage = false;
                otel.IncludeScopes = false;
                otel.AddOtlpExporter(options => ConfigureExporterOptions(options, validated, "/v1/logs"));
            });
        });

        ILogger stageLogger = loggerFactory.CreateLogger(SoftwareFactoryTelemetry.AgentsSourceName);
        return new LocalOtlpRuntime(
            isEnabled: true,
            tracerProvider: tracerProvider,
            meterProvider: meterProvider,
            loggerFactory: loggerFactory,
            stageLogger: stageLogger);
    }

    public static ValidatedLocalOtlpConfig? ValidateEnvironment(IReadOnlyDictionary<string, string?> env)
    {
        ArgumentNullException.ThrowIfNull(env);

        bool hasEndpoint = env.TryGetValue("OTEL_EXPORTER_OTLP_ENDPOINT", out string? rawEndpoint)
            && !string.IsNullOrWhiteSpace(rawEndpoint);
        bool hasAnyForbiddenOverride = ContainsForbiddenOverrides(env);

        if (!hasEndpoint)
        {
            if (hasAnyForbiddenOverride)
            {
                throw new LocalOtlpConfigurationException(
                    "FORBIDDEN_OTLP_ENV_OVERRIDE",
                    "Signal-specific OTLP or proxy environment overrides are forbidden.");
            }

            return null;
        }

        if (hasAnyForbiddenOverride)
        {
            throw new LocalOtlpConfigurationException(
                "FORBIDDEN_OTLP_ENV_OVERRIDE",
                "Signal-specific OTLP or proxy environment overrides are forbidden.");
        }

        if (env.TryGetValue("OTEL_SDK_DISABLED", out string? disabledValue)
            && string.Equals(disabledValue?.Trim(), "true", StringComparison.OrdinalIgnoreCase))
        {
            throw new LocalOtlpConfigurationException("OTLP_SDK_DISABLED", "OTEL_SDK_DISABLED cannot be true when OTLP endpoint is configured.");
        }

        Uri baseUri = ParseLoopbackEndpoint(rawEndpoint!);
        OtlpExportProtocol protocol = ParseProtocol(env.TryGetValue("OTEL_EXPORTER_OTLP_PROTOCOL", out string? rawProtocol) ? rawProtocol : null);

        string? rawHeaders = env.TryGetValue("OTEL_EXPORTER_OTLP_HEADERS", out string? headerVal) ? headerVal : null;
        ValidateHeaders(rawHeaders);

        string serviceName = env.TryGetValue("OTEL_SERVICE_NAME", out string? rawService) && IsSafeServiceName(rawService)
            ? rawService!
            : "maf-specialist-shadow";

        return new ValidatedLocalOtlpConfig
        {
            BaseEndpoint = baseUri,
            Protocol = protocol,
            Headers = rawHeaders!,
            ServiceName = serviceName
        };
    }

    private static void ConfigureExporterOptions(
        OtlpExporterOptions options,
        ValidatedLocalOtlpConfig config,
        string httpSignalPath)
    {
        options.Protocol = config.Protocol;
        options.Headers = config.Headers;
        options.TimeoutMilliseconds = 3000;
        options.Endpoint = config.Protocol == OtlpExportProtocol.HttpProtobuf
            ? new Uri(config.BaseEndpoint, httpSignalPath)
            : config.BaseEndpoint;

        if (config.Protocol == OtlpExportProtocol.HttpProtobuf)
        {
            options.HttpClientFactory = static () => new HttpClient(
                new SocketsHttpHandler
                {
                    AllowAutoRedirect = false,
                    UseProxy = false
                },
                disposeHandler: true);
        }
    }

    private static Uri ParseLoopbackEndpoint(string rawEndpoint)
    {
        if (!Uri.TryCreate(rawEndpoint.Trim(), UriKind.Absolute, out Uri? uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || !LoopbackHosts.Contains(uri.Host)
            || uri.IsDefaultPort
            || !string.IsNullOrEmpty(uri.UserInfo)
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment)
            || uri.AbsolutePath != "/")
        {
            throw new LocalOtlpConfigurationException(
                "NON_LOOPBACK_OR_INVALID_OTLP_ENDPOINT",
                "OTEL_EXPORTER_OTLP_ENDPOINT must be an explicit-port loopback http/https origin.");
        }

        return new Uri($"{uri.Scheme}://{uri.Authority}/");
    }

    private static OtlpExportProtocol ParseProtocol(string? rawProtocol)
    {
        if (string.IsNullOrWhiteSpace(rawProtocol) || string.Equals(rawProtocol.Trim(), "http/protobuf", StringComparison.Ordinal))
        {
            return OtlpExportProtocol.HttpProtobuf;
        }

        if (string.Equals(rawProtocol.Trim(), "grpc", StringComparison.Ordinal))
        {
            return OtlpExportProtocol.Grpc;
        }

        throw new LocalOtlpConfigurationException("UNSUPPORTED_OTLP_PROTOCOL", "OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf or grpc.");
    }

    private static void ValidateHeaders(string? rawHeaders)
    {
        if (string.IsNullOrWhiteSpace(rawHeaders) || rawHeaders.Length > 2048)
        {
            throw new LocalOtlpConfigurationException("MISSING_OR_OVERSIZED_OTLP_HEADERS", "Authenticated loopback OTLP headers are required.");
        }

        foreach (char c in rawHeaders)
        {
            if (char.IsControl(c))
            {
                throw new LocalOtlpConfigurationException("INVALID_OTLP_HEADER_CHARS", "OTLP headers cannot contain control characters.");
            }
        }

        string[] pairs = rawHeaders.Split(',');
        foreach (string pair in pairs)
        {
            int eq = pair.IndexOf('=');
            if (eq <= 0 || eq == pair.Length - 1)
            {
                throw new LocalOtlpConfigurationException("MALFORMED_OTLP_HEADERS", "Each OTLP header entry must be key=value.");
            }
        }
    }

    private static bool ContainsForbiddenOverrides(IReadOnlyDictionary<string, string?> env)
    {
        foreach ((string key, string? value) in env)
        {
            if (string.IsNullOrEmpty(value))
            {
                continue;
            }

            if (ForbiddenExactEnvKeys.Contains(key))
            {
                return true;
            }

            foreach (string prefix in ForbiddenEnvPrefixes)
            {
                if (key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool IsSafeServiceName(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 64)
        {
            return false;
        }

        foreach (char c in value)
        {
            bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c is '-' or '_';
            if (!ok)
            {
                return false;
            }
        }

        return true;
    }

    private static Dictionary<string, string?> SnapshotProcessEnvironment()
    {
        var snapshot = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if (entry.Key is string key)
            {
                snapshot[key] = entry.Value as string;
            }
        }

        return snapshot;
    }
}
