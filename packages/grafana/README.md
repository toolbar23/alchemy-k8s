# alchemy-grafana

Composable Grafana Cloud resources for Alchemy.

Phase 1 provides the package and its Redacted deployment credential boundary:

```ts
providers: Layer.mergeAll(Grafana.providers()),
```

`providers()` reads `GRAFANA_CLOUD_ACCESS_TOKEN` and `GRAFANA_CLOUD_ORG_SLUG`.
Access-policy resources and the `OtlpDestination` composite belong to Phase 2;
this package does not yet make Grafana API calls.
