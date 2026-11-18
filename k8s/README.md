# Kubernetes deployment

This directory contains a minimal but honest deployment manifest set.

## Files

- `deployment.yaml` — ConfigMap, Secret, Deployment, Service, and HPA in one file for easy `kubectl apply`.

## Apply

```bash
kubectl apply -f deployment.yaml
```

Wait for rollout:

```bash
kubectl -n uptime-sentinel rollout status deployment/uptime-sentinel
```

## Notes

- The container runs as a non-root user and mounts `/data` as an `emptyDir` volume (swap to a PVC for durable storage across pod restarts).
- `readyz` is the readiness probe; `healthz` is liveness.
- Horizontal Pod Autoscaler targets 60% CPU utilization; adjust min/max and target for your cluster.
- Edit the `SEED_TARGETS` value in the ConfigMap to add default monitors on first start.
