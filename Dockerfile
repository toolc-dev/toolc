FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY macros ./macros
RUN pnpm install --frozen-lockfile
ENTRYPOINT ["node", "packages/cli/bin/toolc.mjs", "-c", "/config/toolc.config.jsonc"]
