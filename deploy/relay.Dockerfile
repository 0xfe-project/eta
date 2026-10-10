# The agenvo relay (@agenvo/server from npm, at the version
# apps/relay/package.json pins), the `relay` accessory in deploy/deploy.yml.
# deploy/deploy.sh tags it with that version and this file's hash, so it
# changes only when they do. Its configuration is mounted at
# /config/relay.json, its state lives in /home/node (a volume).
FROM node:24-bookworm-slim
ARG AGENVO_VERSION
ENV NODE_ENV=production
RUN npm install --global --no-audit --no-fund --loglevel=error "@agenvo/server@${AGENVO_VERSION:?}"
USER node
WORKDIR /home/node
EXPOSE 8080
ENTRYPOINT ["agenvo-server"]
CMD ["serve", "--config", "/config/relay.json"]
