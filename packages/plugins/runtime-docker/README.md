# @composio/ao-plugin-runtime-docker

Docker runtime plugin for Agent Orchestrator.

This runtime is meant for server and CI usage where you want stronger isolation, reproducible images, or explicit resource limits. It preserves AO's interactive workflow by starting `tmux` inside the container and attaching through `docker exec`.

## Behavior

- Starts a long-lived container per AO session
- Starts a `tmux` session inside that container
- Sends launch commands and follow-up prompts through `tmux send-keys`
- Returns Docker-aware attach info so CLI and web terminal surfaces can attach with:

```bash
docker exec -it <container> tmux attach -t <session>
```

## Configuration

Set `runtime: docker` on a project and provide `runtimeConfig.image`.

```yaml
projects:
  my-app:
    repo: owner/my-app
    path: ~/my-app
    defaultBranch: main
    runtime: docker
    runtimeConfig:
      image: ghcr.io/composio/ao:latest
      limits:
        cpus: 2
        memory: 4g
        gpus: all
      readOnlyRoot: true
      capDrop: [ALL]
      network: bridge
      tmpfs: [/tmp]
```

Supported `runtimeConfig` keys:

- `image`: container image to run
- `shell`: shell used for the keepalive process and command bootstrap
- `user`: explicit container user; defaults to host `uid:gid` when available
- `network`: forwarded to `docker run --network`
- `readOnlyRoot`: forwarded to `docker run --read-only`
- `capDrop`: forwarded as repeated `--cap-drop`
- `tmpfs`: forwarded as repeated `--tmpfs`
- `limits.cpus`, `limits.memory`, `limits.gpus`: forwarded to `docker run`

## CLI overrides

AO also supports one-off Docker overrides from the CLI:

```bash
ao start --runtime docker --runtime-image ghcr.io/composio/ao:latest
ao spawn 123 --runtime docker --runtime-memory 4g --runtime-cpus 2 --runtime-read-only
```

## Notes

- Prefer rootless Docker on Linux servers.
- Use pinned image tags for reproducibility.
- Run `ao doctor` after changing Docker runtime config; it now validates Docker daemon access and required image configuration when `runtime: docker` is enabled.
