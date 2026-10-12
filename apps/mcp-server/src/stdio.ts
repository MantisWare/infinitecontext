import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InfiniteContext } from "infinitecontext";

import { createMcpServer } from "./server.js";
import { sdkReader } from "./reader-sdk.js";

// -- resolve config from ~/.infinitecontext/config.json → env vars → fail -------

function loadConfig() {
  const configPath = join(homedir(), ".infinitecontext", "config.json");

  // try config file first
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    if (raw.apiKey) {
      return {
        apiKey: String(raw.apiKey),
        baseUrl: String(raw.baseUrl ?? "https://api.infinitecontext.ai"),
      };
    }
  } catch { /* fall through */ }

  // fallback to env vars
  if (process.env.INFINITECONTEXT_API_KEY) {
    return {
      apiKey: process.env.INFINITECONTEXT_API_KEY,
      baseUrl: process.env.INFINITECONTEXT_BASE_URL ?? "https://api.infinitecontext.ai",
    };
  }

  console.error("INFINITECONTEXT_API_KEY is required (set in ~/.infinitecontext/config.json or env)");
  process.exit(1);
}

// -- start stdio transport ----------------------------------------------------

const { apiKey, baseUrl } = loadConfig();
const uc = new InfiniteContext({ apiKey, baseUrl });
const mcp = createMcpServer(sdkReader(uc));
const transport = new StdioServerTransport();

await mcp.connect(transport);
