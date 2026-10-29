# SuijiLedger 单容器镜像：前端静态资源 + API 同进程
# 构建镜像前先在宿主机执行：npm install && npm run build:web
FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

# 依赖（利用层缓存）
COPY package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm install --omit=dev --no-audit --no-fund

# 代码与已构建的前端产物
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web/dist apps/web/dist

# 数据目录（挂载卷）
ENV DATA_DIR=/app/apps/server/data
ENV PORT=3000
VOLUME ["/app/apps/server/data"]
EXPOSE 3000

CMD ["npx", "ts-node", "apps/server/src/main.ts"]
