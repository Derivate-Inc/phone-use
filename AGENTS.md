# phone-use: agent entry point

Read README.md for what this project is and CONTRIBUTING.md for setup and the commands that
validate a change. Use those commands; do not invent new ones.

- `packages/sdk` is `@phone-use/sdk`, the typed device runtime. It has no runtime dependencies.
- `packages/phone-use` is the CLI, the MCP server and the agent loop. It runs on Bun.
- `apps/api` is the cloud control plane and the workers, `apps/web` the console, `apps/landing`
  the site and the public docs. `apps/landing` has its own AGENTS.md; read it before touching Next.js code.
- `eval/` is the device-layer eval. `docs/` holds the technical write-ups.

Never commit secrets, `.env` files or build output (`.next`, `.turbo`, `dist`).
