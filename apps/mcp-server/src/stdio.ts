import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "./server.js";
import { sdkReader } from "./reader-sdk.js";
import { ClientAuthError, loadClientAuth } from "./load-client-auth.js";

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
