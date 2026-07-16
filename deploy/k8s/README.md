# Kustomize deployment credentials

The game API Deployment requires an `Opaque` Secret named
`paint-arena-auth` in the `paint-arena` namespace. Real credentials are not
stored in this directory.

For a local kind deployment, use the repository script:

```powershell
.\scripts\deploy-kind.ps1
```

By default, the script generates independent 256-bit URL-safe
`ADMIN_TOKEN` and `OPS_EVENT_TOKEN` values for every deployment, creates or
updates the Secret, and prints the admin URL and login token. To retain known
credentials across deployments, pass them explicitly and keep them in a
password manager:

```powershell
.\scripts\deploy-kind.ps1 `
  -AdminToken $env:PAINT_ARENA_ADMIN_TOKEN `
  -OpsEventToken $env:PAINT_ARENA_OPS_EVENT_TOKEN
```

`ALLOW_DEMO_SERVER_SHUTDOWN` is written as `false` by default. Only for an
isolated, self-healing demo cluster with no public ingress or tunnel, opt in
explicitly:

```powershell
.\scripts\deploy-kind.ps1 -AllowServerShutdown
```

This permits the selected room owner's game-api process to terminate through
the injected graceful shutdown handler. The Demo/Chaos endpoints still require
the `ADMIN_TOKEN` Bearer token even when general demo admin authentication is
disabled. Runtime Tick-lag and Full-Broadcast controls are also process-scoped,
so they can affect every Room owned by that process.

For a manual deployment, create the namespace and Secret before applying the
Kustomize resources:

```powershell
kubectl apply -f .\deploy\k8s\namespace.yaml
kubectl -n paint-arena create secret generic paint-arena-auth `
  --from-literal="ADMIN_TOKEN=$env:PAINT_ARENA_ADMIN_TOKEN" `
  --from-literal="OPS_EVENT_TOKEN=$env:PAINT_ARENA_OPS_EVENT_TOKEN" `
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -k .\deploy\k8s
```

Do not add a rendered Secret or real token values to the repository.
