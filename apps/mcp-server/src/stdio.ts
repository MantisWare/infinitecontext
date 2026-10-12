import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "./server.js";
import { sdkReader } from "./reader-sdk.js";
import { ClientAuthError, loadClientAuth } from "./load-client-auth.js";

function printHelp() {
    console.log(`infinitecontext-mcp — Model Context Protocol server for InfiniteContext

Usage:
  infinitecontext-mcp              Start stdio MCP server (requires auth)
  infinitecontext-mcp --help       Show this help

Authentication: set INFINITECONTEXT_API_KEY, config.json apiKey, or run \`infinitecontext login\`.
`);
}

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
    printHelp();
    process.exit(0);
}

try {
    const auth = loadClientAuth();
    const uc = await Promise.resolve(auth.createClient());
    const mcp = createMcpServer(sdkReader(uc));
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
} catch (error) {
    const message =
        error instanceof ClientAuthError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
    console.error(message);
    process.exit(1);
}
