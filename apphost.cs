#:package Aspire.Hosting.AppHost@17.0.0
#:package Aspire.Hosting.JavaScript@17.0.0

var builder = DistributedApplication.CreateBuilder(args);
builder.AddNodeApp("synthetic-shadow", "./tools/engineering-factory", "aspire-telemetry-smoke.mjs")
    .WithExplicitStart();
builder.Build().Run();
