# 个人办公工作台 - 云端同步服务器
# 零依赖纯 Node.js 服务，供腾讯云 CloudBase 云托管（容器模式）部署。
# 部署要点：
#   1. 监听 PORT 环境变量（云托管会注入），已满足。
#   2. 持久化：容器文件系统不持久，必须将 /data 挂为 CFS 持久卷，
#      并在环境变量中设置 DATA_DIR=/data，数据才会落盘不丢。
#   3. 密钥全部走环境变量，切勿写死：
#      TENCENT_WSA_API_KEY / TAVILY_API_KEY / EXA_API_KEY / SYNC_KEY(可选) / DATA_DIR

FROM node:20-alpine

WORKDIR /app

# 仅复制运行所需文件（零依赖，无需 npm install）
COPY server.js ./
COPY Procfile ./

# 云托管健康检查（也可在控制台配置 healthcheckPath: /health）
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

# 容器默认监听端口（云托管单端口；实际以 PORT 环境变量为准）
ENV PORT=3000
EXPOSE 3000

# 默认启动命令（云托管会按其 startCommand 覆盖，这里兜底）
CMD ["node", "server.js"]
