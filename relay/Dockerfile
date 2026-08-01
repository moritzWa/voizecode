FROM denoland/deno:latest
WORKDIR /app
COPY deno.json deno.lock* ./
COPY main.ts storage.ts ./
RUN deno cache main.ts
EXPOSE 8787
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "main.ts"]
