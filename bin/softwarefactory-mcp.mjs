#!/usr/bin/env node
import { runMcpStdioCli } from '../tools/engineering-factory/mcp-agent-connector.mjs';

process.exitCode = await runMcpStdioCli();
