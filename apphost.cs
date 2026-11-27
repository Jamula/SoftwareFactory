#:package Aspire.Hosting.AppHost@17.0.0
#:package Aspire.Hosting.Dotnet@17.0.0
#:package Aspire.Hosting.JavaScript@17.0.0

var builder = DistributedApplication.CreateBuilder(args);
builder.AddNodeApp("synthetic-shadow", "./tools/engineering-factory", "aspire-telemetry-smoke.mjs")
    .WithExplicitStart();
builder.AddDotnetProject("maf-specialist-shadow", "./src/SoftwareFactory.Agents/SoftwareFactory.Agents.csproj")
    .WithArgs("--smoke")
    .WithExplicitStart();
builder.Build().Run();
