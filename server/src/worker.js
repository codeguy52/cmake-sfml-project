import { createApp } from './app.js';

/**
 * Entry point for the platforms that speak fetch: Cloudflare Workers and
 * Deno Deploy. Both accept `export default { fetch }`, and both are free tiers
 * that stay awake, which is the reason this file exists — a linking sync that
 * has to wait out a cold start feels broken even when it isn't.
 *
 * The one thing they disagree on is where the environment comes from:
 * Workers pass a bindings object as the second argument, while Deno exposes
 * `Deno.env` and passes connection info in that slot instead. Reading Deno's
 * connection info as if it were configuration would silently produce a backend
 * with no allowed origins and no credentials, so the platform is detected
 * explicitly rather than inferred from the argument.
 */

function environment(workerEnv) {
  const deno = globalThis.Deno;
  if (deno?.env?.toObject) return deno.env.toObject();
  return workerEnv ?? {};
}

let app = null;

export default {
  /** @param {Request} request */
  fetch(request, workerEnv) {
    // Built once and reused: configuration is fixed for the life of a
    // deployment, and the SnapTrade client caches inside the provider.
    app ??= createApp(environment(workerEnv));
    return app.handle(request);
  },
};
