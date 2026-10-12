# Cloudflare Workers deploy config

Production-specific Workers settings are **not** committed to git.

1. Copy the example file:

   ```bash
   cp wrangler.example.jsonc wrangler.jsonc
   ```

2. Edit `wrangler.jsonc` and set:
   - `routes[].pattern` and `zone_name` for your domain
   - `kv_namespaces[].id` for your Cloudflare KV namespace

`wrangler.jsonc` is listed in `.gitignore`. Only `wrangler.example.jsonc` is tracked in the repository.
