import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "./server.js";
import { sdkReader } from "./reader-sdk.js";
import { loadClientAuth } from "./load-client-auth.js";

// -- resolve config from ~/.infinitecontext/config.json → env vars → fail -------

const auth = loadClientAuth();
const uc = await Promise.resolve(auth.createClient());
const mcp = createMcpServer(sdkReader(uc));
const transport = new StdioServerTransport();

await mcp.connect(transport);
