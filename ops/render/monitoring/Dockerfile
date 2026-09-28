# PostMind Studio — monitoring on Render (runbooks/monitoring-deploy.md, "Render").
# One private service per environment runs Prometheus + Alertmanager + the blackbox exporter,
# the same pinned versions CI validates the configs with (.github/workflows/ci.yml ops-config)
# and docker-compose.monitoring.yml runs. It scrapes the web service and the six worker private
# services over Render's private network, using each service's "<internal-host>-discovery" DNS
# name, which resolves to every running instance (https://render.com/docs/private-network,
# "Direct IP communication"). The alert rules and routing are the repo's unchanged files.
#
# Build context: the repo root (render.yaml dockerContext "."), so ops/ files can be copied.
# Paths of the binaries come from the upstream Dockerfiles of these exact tags
# (prometheus/prometheus v2.55.1, prometheus/alertmanager v0.28.1,
# prometheus/blackbox_exporter v0.28.0).

FROM prom/alertmanager:v0.28.1 AS alertmanager
FROM prom/blackbox-exporter:v0.28.0 AS blackbox

FROM prom/prometheus:v2.55.1
COPY --from=alertmanager /bin/alertmanager /bin/alertmanager
COPY --from=blackbox /bin/blackbox_exporter /bin/blackbox_exporter
COPY --from=blackbox /etc/blackbox_exporter/config.yml /etc/blackbox_exporter/config.yml
COPY ops/prometheus/studio-alerts.yml /etc/prometheus/rules/studio-alerts.yml
COPY ops/prometheus/studio-slo.yml /etc/prometheus/rules/studio-slo.yml
COPY ops/alertmanager/alertmanager.yml /etc/alertmanager/alertmanager.yml
COPY ops/render/monitoring/prometheus.yml.tmpl /etc/prometheus/prometheus.yml.tmpl
COPY ops/render/monitoring/entrypoint.sh /usr/local/bin/studio-monitoring

# Root so the entrypoint can prepare the Render persistent disk (/data, mounted root-owned) and
# write the secret files from env vars; the three processes only listen on their ports.
USER root
EXPOSE 9090 9093
ENTRYPOINT ["/bin/sh", "/usr/local/bin/studio-monitoring"]
