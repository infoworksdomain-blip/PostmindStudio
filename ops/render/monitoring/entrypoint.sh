#!/bin/sh
# PostMind Studio — monitoring entrypoint on Render (busybox sh; see Dockerfile beside this file).
#  1. Checks the internal hostnames render.yaml passes in (fromService `host`) and renders
#     prometheus.yml from the template.
#  2. Writes METRICS_TOKEN, PAGERDUTY_ROUTING_KEY and SLACK_WEBHOOK_URL to the files the configs
#     read (mode 0600) and removes them from the environment before starting anything, so no
#     child process sees them and no config file in the image contains them.
#  3. Starts the blackbox exporter (127.0.0.1 only), Alertmanager and Prometheus, and exits
#     non-zero as soon as any of them dies so Render restarts the whole service.
set -eu

fail() {
  echo "studio-monitoring: $*" >&2
  exit 1
}

host_var() {
  eval "value=\${$1:-}"
  case "$value" in
    '' | *[!a-z0-9-]*) fail "$1 must be a Render internal hostname (a-z, 0-9, -)" ;;
  esac
  printf '%s' "$value"
}

ENVIRONMENT="$(host_var STUDIO_ENVIRONMENT)"
WEB="$(host_var STUDIO_WEB_HOST)"
ORCHESTRATION="$(host_var STUDIO_WORKER_ORCHESTRATION_HOST)"
ASSETS="$(host_var STUDIO_WORKER_ASSETS_HOST)"
PUBLISH="$(host_var STUDIO_WORKER_PUBLISH_HOST)"
SCHEDULED="$(host_var STUDIO_WORKER_SCHEDULED_HOST)"
ANALYTICS="$(host_var STUDIO_WORKER_ANALYTICS_HOST)"
LIBRARY="$(host_var STUDIO_WORKER_LIBRARY_HOST)"
EMAIL="$(host_var STUDIO_WORKER_EMAIL_HOST)"

[ -n "${METRICS_TOKEN:-}" ] || fail "METRICS_TOKEN is not set (env group studio-metrics-<env>)"
[ -n "${PAGERDUTY_ROUTING_KEY:-}" ] || fail "PAGERDUTY_ROUTING_KEY is not set"
[ -n "${SLACK_WEBHOOK_URL:-}" ] || fail "SLACK_WEBHOOK_URL is not set"

sed \
  -e "s/__ENVIRONMENT__/${ENVIRONMENT}/g" \
  -e "s/__WEB_HOST__/${WEB}/g" \
  -e "s/__ORCHESTRATION_HOST__/${ORCHESTRATION}/g" \
  -e "s/__ASSETS_HOST__/${ASSETS}/g" \
  -e "s/__PUBLISH_HOST__/${PUBLISH}/g" \
  -e "s/__SCHEDULED_HOST__/${SCHEDULED}/g" \
  -e "s/__ANALYTICS_HOST__/${ANALYTICS}/g" \
  -e "s/__LIBRARY_HOST__/${LIBRARY}/g" \
  -e "s/__EMAIL_HOST__/${EMAIL}/g" \
  /etc/prometheus/prometheus.yml.tmpl >/etc/prometheus/prometheus.yml

umask 077
mkdir -p /etc/prometheus/secrets /etc/alertmanager/secrets
printf '%s' "$METRICS_TOKEN" >/etc/prometheus/secrets/metrics-token
printf '%s' "$PAGERDUTY_ROUTING_KEY" >/etc/alertmanager/secrets/pagerduty-routing-key
printf '%s' "$SLACK_WEBHOOK_URL" >/etc/alertmanager/secrets/slack-webhook-url
unset METRICS_TOKEN PAGERDUTY_ROUTING_KEY SLACK_WEBHOOK_URL
umask 022

DATA="${MONITORING_DATA_DIR:-/data}"
mkdir -p "$DATA/prometheus" "$DATA/alertmanager"

/bin/promtool check config /etc/prometheus/prometheus.yml >/dev/null ||
  fail "rendered prometheus.yml is invalid"

/bin/blackbox_exporter \
  --config.file=/etc/blackbox_exporter/config.yml \
  --web.listen-address=127.0.0.1:9115 &
BLACKBOX=$!

# --cluster.listen-address= turns off Alertmanager's HA gossip (one instance per environment).
/bin/alertmanager \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --storage.path="$DATA/alertmanager" \
  --web.listen-address=:9093 \
  --cluster.listen-address= \
  --web.external-url="${ALERTMANAGER_EXTERNAL_URL:-http://127.0.0.1:9093}" &
ALERTMANAGER=$!

/bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path="$DATA/prometheus" \
  --storage.tsdb.retention.time="${PROMETHEUS_RETENTION:-15d}" \
  --web.listen-address=:9090 \
  --web.external-url="${PROMETHEUS_EXTERNAL_URL:-http://127.0.0.1:9090}" &
PROMETHEUS=$!

PIDS="$BLACKBOX $ALERTMANAGER $PROMETHEUS"
stop() {
  # shellcheck disable=SC2086 # word splitting of the pid list is intended
  kill -TERM $PIDS 2>/dev/null || true
  wait
}
trap 'stop; exit 0' TERM INT

while :; do
  for pid in $PIDS; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "studio-monitoring: process $pid exited; stopping so Render restarts the service" >&2
      stop
      exit 1
    fi
  done
  sleep 5 &
  wait $! || true
done
