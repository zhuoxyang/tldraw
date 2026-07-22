#!/bin/sh

set -eu

umask 077

load_secret() {
	variable_name="$1"
	secret_path="$2"

	if [ ! -r "$secret_path" ]; then
		echo "Required runtime secret is unavailable: $secret_path" >&2
		exit 1
	fi

	secret_value="$(cat "$secret_path")"
	if [ -z "$secret_value" ] || [ "$(printf '%s' "$secret_value" | wc -l)" -ne 0 ]; then
		echo "Required runtime secret must be one non-empty line: $secret_path" >&2
		exit 1
	fi

	export "$variable_name=$secret_value"
}

load_secret SHOTGRID_SCRIPT_KEY /run/secrets/shotgrid_script_key
load_secret REVIEW_API_TRUSTED_PROXY_TOKEN /run/secrets/review_proxy_token
load_secret REVIEW_SYNC_SECRET /run/secrets/review_sync_secret
load_secret SHOTGRID_WEBHOOK_SECRET /run/secrets/shotgrid_webhook_secret
load_secret REVIEW_METRICS_TOKEN /run/secrets/review_metrics_token

exec "$@"
