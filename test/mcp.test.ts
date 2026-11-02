import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

test("stdio exposes legacy tools and returns structured routing failures", { timeout: 20_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "catalyst-protocol-test", version: "1.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "analyze_bilibili_video", "analyze_video", "analyze_video_url", "inspect_video_window",
    ]);
    assert.ok(tools.tools.find((tool) => tool.name === "analyze_video_url")?.outputSchema);
    const response = CallToolResultSchema.parse(await client.callTool({
      name: "analyze_video_url",
      arguments: { url: "https://example.com/video", question: "What is shown?", mode: "vision" },
    }));
    assert.equal(response.isError, true);
    const result = response.structuredContent;
    assert.ok(result && typeof result === "object" && !Array.isArray(result));
    assert.equal(result.schema_version, "1.0");
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.evidence, []);
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
    assert.equal((result.errors[0] as Record<string, unknown>).code, "UNSUPPORTED_PLATFORM");
    const text = response.content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    assert.deepEqual(JSON.parse(text.text), result);
    const ambiguousShare = CallToolResultSchema.parse(await client.callTool({
      name: "analyze_video_url",
      arguments: { url: "视频 https://xhslink.cn/o/one?xsec_token=fixture-private-token 另一个 https://xhslink.com/a/two", question: "What is shown?", mode: "vision" },
    }));
    assert.equal(ambiguousShare.isError, true);
    assert.equal((ambiguousShare.structuredContent?.errors as Array<Record<string, unknown>>)[0].code, "INVALID_URL");
    assert.doesNotMatch(JSON.stringify(ambiguousShare), /fixture-private-token/);
  } finally {
    await client.close();
  }
});
