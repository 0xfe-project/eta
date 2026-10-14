# The agenvo relay, the agenvo bundle's service
# (bundles/agenvo/service), from apps/agenvo/out (the
# relay scripts/build/agenvo.sh builds from the pinned commit).
# scripts/build/image.sh builds it as axp-relay. Its state lives in
# /home/node (a volume); the bundle's manifests give it its configuration.
FROM node:24-bookworm-slim
ENV NODE_ENV=production
COPY out/relay/ /opt/agenvo/
USER node
WORKDIR /home/node
EXPOSE 8080
ENTRYPOINT ["node", "/opt/agenvo/node_modules/@agenvo/server/dist/cli.js"]
