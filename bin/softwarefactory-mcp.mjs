#!/usr/bin/env node
import {
  MAX_MCP_REQUEST_BYTES,
  startMcpStdioServer,
  validateMcpConnectorEnrollment
} from '../tools/engineering-factory/mcp-agent-connector.mjs';

const rawEnrollment = process.env.SOFTWAREFACTORY_MCP_AUTHORIZED_REPOSITORIES;
let authorizedRepositories = [{ repositoryId: 1471342715, repository: 'Jamula/SoftwareFactory' }];
let valid = true;
if (rawEnrollment !== undefined) {
  try {
    if (Buffer.byteLength(rawEnrollment, 'utf8') > MAX_MCP_REQUEST_BYTES) throw new Error();
    authorizedRepositories = JSON.parse(rawEnrollment);
    valid = validateMcpConnectorEnrollment(authorizedRepositories);
  } catch {
    valid = false;
  }
}
if (!valid) {
  process.stderr.write('Invalid MCP repository enrollment.\n');
  process.exitCode = 1;
} else {
  try {
    await startMcpStdioServer({ context: { authorizedRepositories } });
  } catch {
    process.stderr.write('MCP server stopped.\n');
    process.exitCode = 1;
  }
}
