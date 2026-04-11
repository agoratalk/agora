#!/bin/bash
set -e
USERNAME="${AGORA_USERNAME:-anon}"
BOOTSTRAP_ARGS=""
if [ -n "$AGORA_BOOTSTRAP" ]; then
  for peer in $(echo "$AGORA_BOOTSTRAP" | tr ',' ' '); do
    BOOTSTRAP_ARGS="$BOOTSTRAP_ARGS --bootstrap $peer"
  done
fi
echo "[entrypoint] starting daemon as user='$USERNAME' bootstrap='$AGORA_BOOTSTRAP'"
# Keep stdin open but never send data, so the REPL blocks on read forever
# instead of hitting EOF and exiting cleanly.
agora --username "$USERNAME" --log info $BOOTSTRAP_ARGS < <(tail -f /dev/null) &
DAEMON_PID=$!
sleep 1
echo "[entrypoint] starting web bridge on :8080"
cd /app/web
node web-server.js &
WEB_PID=$!
trap 'kill $DAEMON_PID $WEB_PID 2>/dev/null; exit 0' TERM INT
wait -n $DAEMON_PID $WEB_PID
EXIT_CODE=$?
echo "[entrypoint] a child process exited ($EXIT_CODE), shutting down"
kill $DAEMON_PID $WEB_PID 2>/dev/null || true
exit $EXIT_CODE
