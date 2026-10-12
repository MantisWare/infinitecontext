import { buildAuthRuntimeConfig } from '@infinitecontext/auth';

import { buildHealthConfigBooleans } from '../runtime-config';
import type { HttpApp } from '../types/http';

export function registerHealthRoutes(app: HttpApp, env: Record<string, string | undefined>, kvBound = false) {
    app.get('/health', (c) => c.json({ ok: true }));

    app.get('/health/config', (c) => {
        return c.json(buildHealthConfigBooleans(env, { kvBound }));
    });

    app.get('/auth/providers', (c) => {
        const authConfig = buildAuthRuntimeConfig(env);
        const google = Boolean(authConfig?.googleClientId && authConfig?.googleClientSecret);
        return c.json({
            password: Boolean(authConfig),
            google,
        });
    });
}
