# syntax=docker/dockerfile:1
#
# atm-relay 镜像。从仓库根构建：
#   docker build -f apps/relay/Dockerfile -t atm-relay .
# 构建上下文只放进 tsconfig.base.json 与 apps/relay 的源码（见同目录的 Dockerfile.dockerignore，需要 BuildKit）。

# ── 构建：把 src 打成一个零依赖的 dist/atm-relay.mjs ──
FROM node:24-alpine AS build
# 与仓库根 package.json 锁定的版本一致。中继本身没有运行时依赖，不需要装整个工作区。
RUN npm install --global --no-audit --no-fund tsup@8.5.1
WORKDIR /repo
COPY tsconfig.base.json ./
COPY apps/relay/package.json apps/relay/tsconfig.json apps/relay/tsup.config.ts apps/relay/
COPY apps/relay/src apps/relay/src
WORKDIR /repo/apps/relay
RUN tsup && node dist/atm-relay.mjs --version

# ── 运行：Node 运行时 + 一个文件 ──
FROM node:24-alpine
# 运行时用不到包管理器，删掉以缩小体积与攻击面。
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV NODE_ENV=production \
    ATM_RELAY_DATA=/data
COPY --from=build /repo/apps/relay/dist/atm-relay.mjs /opt/atm-relay/atm-relay.mjs
RUN chmod 0755 /opt/atm-relay/atm-relay.mjs \
 && ln -s /opt/atm-relay/atm-relay.mjs /usr/local/bin/atm-relay \
 && mkdir -p /data \
 && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8790
# 直接给了 --tls-cert 时这条检查要改成 https；放在反向代理后面（推荐）则不用改。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8790/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["atm-relay"]
CMD ["serve", "--listen", "0.0.0.0:8790"]
