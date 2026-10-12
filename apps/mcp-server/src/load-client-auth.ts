import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { InfiniteContext } from "infinitecontext";
import { getValidAccessToken, loadCredentials } from "infinitecontext/credentials";
import { resolveBaseUrl } from "infinitecontext/lib/client-config.mjs";

export type LoadedClientAuth = {
    baseUrl: string;
    createClient: () => InfiniteContext | Promise<InfiniteContext>;
};

function readConfigFile(): Record<string, unknown> {
    const configPath = join(homedir(), ".infinitecontext", "config.json");
    try {
        return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {
        return {};
    }
}

export function loadClientAuth(): LoadedClientAuth {
    const config = readConfigFile();
    const baseUrl = resolveBaseUrl({ config });

    const envKey = String(process.env.INFINITECONTEXT_API_KEY ?? "").trim();
    const fileKey = String(config.apiKey ?? "").trim();
    const apiKey = envKey || fileKey;

    if (apiKey) {
        return {
            baseUrl,
            createClient: () => new InfiniteContext({ apiKey, baseUrl }),
        };
    }

    const credentials = loadCredentials();
    if (credentials?.refreshToken) {
        return {
            baseUrl,
            createClient: async () => {
                const session = await getValidAccessToken({ baseUrl });
                if (!session?.accessToken) {
                    throw new Error("Session expired or invalid. Run `infinitecontext login`.");
                }
                return new InfiniteContext({
                    baseUrl,
                    getAccessToken: async () => {
                        const next = await getValidAccessToken({ baseUrl });
                        if (!next?.accessToken) {
                            throw new Error("Session expired or invalid. Run `infinitecontext login`.");
                        }
                        return next.accessToken;
                    },
                });
            },
        };
    }

    throw new Error(
        "Authentication required: set INFINITECONTEXT_API_KEY, add apiKey to ~/.infinitecontext/config.json, or run `infinitecontext login`. " +
            "See https://docs.infinitecontext.ai/configuration/keys-and-services",
    );
}
