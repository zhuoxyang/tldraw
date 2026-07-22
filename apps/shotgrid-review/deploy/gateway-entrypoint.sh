#!/bin/sh

set -eu

umask 077

if [ ! -r /run/secrets/review_proxy_token ]; then
	echo "The review proxy token runtime secret is unavailable." >&2
	exit 1
fi

REVIEW_API_TRUSTED_PROXY_TOKEN="$(cat /run/secrets/review_proxy_token)"

if [ "${#REVIEW_API_TRUSTED_PROXY_TOKEN}" -lt 32 ] || \
	[ "${#REVIEW_API_TRUSTED_PROXY_TOKEN}" -gt 1024 ]; then
	echo "The review proxy token must contain from 32 to 1024 characters." >&2
	exit 1
fi

case "$REVIEW_API_TRUSTED_PROXY_TOKEN" in
	*[!A-Za-z0-9_-]*)
		echo "The review proxy token must use a base64url-safe value." >&2
		exit 1
		;;
esac

if [ -z "${REVIEW_FIXED_ACTOR_SUBJECT:-}" ] || [ "${#REVIEW_FIXED_ACTOR_SUBJECT}" -gt 512 ]; then
	echo "REVIEW_FIXED_ACTOR_SUBJECT must contain from 1 to 512 characters." >&2
	exit 1
fi

case "$REVIEW_FIXED_ACTOR_SUBJECT" in
	*[!A-Za-z0-9._:@/+~-]*)
		echo "REVIEW_FIXED_ACTOR_SUBJECT contains a character unsafe for proxy configuration." >&2
		exit 1
		;;
esac

if [ -z "${REVIEW_FORWARD_AUTH_UPSTREAM:-}" ] || \
	[ "$(printf '%s' "$REVIEW_FORWARD_AUTH_UPSTREAM" | wc -l)" -ne 0 ] || \
	! printf '%s' "$REVIEW_FORWARD_AUTH_UPSTREAM" | \
		grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/%?=&:+-]*)?$'; then
	echo "REVIEW_FORWARD_AUTH_UPSTREAM must be a plain HTTP(S) forward-auth URL." >&2
	exit 1
fi

export REVIEW_API_TRUSTED_PROXY_TOKEN REVIEW_FIXED_ACTOR_SUBJECT REVIEW_FORWARD_AUTH_UPSTREAM

envsubst \
	'${REVIEW_API_TRUSTED_PROXY_TOKEN} ${REVIEW_FIXED_ACTOR_SUBJECT} ${REVIEW_FORWARD_AUTH_UPSTREAM}' \
	< /etc/nginx/review-nginx.conf.template \
	> /tmp/review-nginx.conf

unset REVIEW_API_TRUSTED_PROXY_TOKEN REVIEW_FIXED_ACTOR_SUBJECT REVIEW_FORWARD_AUTH_UPSTREAM

exec "$@"
