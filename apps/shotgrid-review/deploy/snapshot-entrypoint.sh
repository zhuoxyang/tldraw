#!/bin/sh

set -eu

operation="${1:-}"

if [ "$operation" = backup ] && [ /var/lib -ef /var/backups ]; then
	echo "The live review data and backup targets must use independent volumes." >&2
	exit 1
fi

if [ "$operation" = restore ] && [ /var/backups -ef /var/lib ]; then
	echo "The snapshot and restore targets must use independent volumes." >&2
	exit 1
fi

exec node /app/review-data-snapshot.js "$@"
