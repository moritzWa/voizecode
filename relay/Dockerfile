FROM denoland/deno:latest
# Build context is the REPO ROOT, not relay/ — main.ts imports ../shared/*.ts (the fenced-block
# and ordered-delivery helpers it shares with the mobile app), so a relay-only context cannot
# resolve them and `deno cache` fails at build time. fly.toml pins the dockerfile path to match.
#
# The repo's directory layout is preserved inside the image for the same reason: the imports are
# relative, so shared/ has to sit next to relay/ exactly as it does in the tree.
WORKDIR /app
COPY relay/deno.json relay/deno.lock* ./relay/
COPY shared/ ./shared/
COPY relay/main.ts relay/storage.ts ./relay/
WORKDIR /app/relay
RUN deno cache main.ts
EXPOSE 8787
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "main.ts"]
