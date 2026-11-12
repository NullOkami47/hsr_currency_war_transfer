FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# Main prepares this small flat build context; the repository is never copied.
COPY --chown=node:node backup-watchdog.mjs backup-retention.mjs ./
COPY --chown=node:node package.json server.mjs ./cloud-backup-monitor/
WORKDIR /app/cloud-backup-monitor
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
