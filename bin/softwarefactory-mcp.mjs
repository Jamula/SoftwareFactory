#!/usr/bin/env node
import { startMcpStdioServer } from '../tools/engineering-factory/mcp-agent-connector.mjs';

startMcpStdioServer({
  context: {
    authorizedRepositories: [
      { repositoryId: 1471342715, repository: 'Jamula/SoftwareFactory' }
    ]
  }
});
