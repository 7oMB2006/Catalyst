#!/usr/bin/env node
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCatalystServer } from "./mcp-server.js";
import { registerLegacyWorkflowTools } from "./legacy-workflow-tools.js";

// Explicit compatibility entry point for saved task workflows and the task CLI.
const server = createCatalystServer();
registerLegacyWorkflowTools(server);
await server.connect(new StdioServerTransport());
