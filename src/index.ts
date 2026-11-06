#!/usr/bin/env node
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCatalystServer } from "./mcp-server.js";

await createCatalystServer().connect(new StdioServerTransport());
