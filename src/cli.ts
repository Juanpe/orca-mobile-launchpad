// The `launchpad` command for agents and scripts. It talks to the worker through files in a private
// folder: it drops a request, the worker (which looks every second) answers with a file of shell
// assignments the command sources, and writes another one when the run ends.

/** The request a `launchpad` invocation leaves: one `key<TAB>value` per line. */
export type CliRequest = {
  cmd: 'run' | 'stop' | 'status' | 'devices'
  cwd?: string
  device?: string // present (maybe empty) with --device
  simulator?: string // present (maybe empty) with --simulator
  scheme?: string
  configuration?: string
  platform?: 'ios' | 'android'
}

export function parseRequest(text: string): CliRequest | null {
  const fields: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab > 0) fields[line.slice(0, tab)] = line.slice(tab + 1)
  }
  const cmd = fields.cmd
  if (cmd !== 'run' && cmd !== 'stop' && cmd !== 'status' && cmd !== 'devices') return null
  const request: CliRequest = { cmd }
  for (const key of ['cwd', 'device', 'simulator', 'scheme', 'configuration'] as const) {
    if (key in fields) request[key] = fields[key]
  }
  if (fields.platform === 'ios' || fields.platform === 'android') request.platform = fields.platform
  return request
}

/**
 * The command itself, written by the worker next to its requests folder (`REQ_DIR` is set in the
 * line the worker puts first). Plain bash so any agent can run it; no `${` (TypeScript template).
 */
export const CLI_SCRIPT = String.raw`
usage() {
  cat << 'USAGE'
Usage: launchpad <command> [options]

Builds and runs the iOS or Android app of the Orca worktree you are in, through Mobile Launchpad:
the run shows up in Orca's panel and status bar, and this command reports how it went.

Commands:
  run        Build, install and launch. Exits once the app is running (or the run failed).
  status     The worktree's current run.
  stop       Stop the worktree's run: the build, or the app it launched.
  devices    List the simulators, emulators and phones you can run on.

Options for run:
  --ios, --android       Which app, when the worktree has both (default: the one chosen in Orca).
  --device [NAME]        On a phone: the first connected one, or the one whose name has NAME.
  --simulator [NAME]     On a simulator (iOS) or emulator (Android): a running one, or the one
                         whose name has NAME.
  --scheme NAME          iOS: the Xcode scheme. Android: the app module, such as :app.
  --configuration NAME   iOS: Debug or Release. Android: the build variant, such as debug.
  --follow               Print the build output as it goes (default: one line per step).
  --no-wait              Start the run and exit at once.
  What you pass becomes the worktree's choice in Orca's panel as well.

Exit codes: 0 the app is running (or ran and exited), 1 the build or launch failed,
2 the app crashed, 3 Mobile Launchpad is not reachable (is Orca open?), 4 bad usage, 130 stopped.
USAGE
}

say() { printf '%s\n' "$*"; }
die() {
  printf 'launchpad: %s\n' "$1" >&2
  if [ $# -ge 2 ]; then exit "$2"; fi
  exit 4
}

alive() {
  [ -f "$REQ_DIR/.alive" ] || return 1
  local age=$(( $(date +%s) - $(stat -f %m "$REQ_DIR/.alive") ))
  [ "$age" -lt 6 ]
}

# Leaves the request and sources the worker's answer (res-ID.sh) into this shell.
ask() {
  alive || die "Mobile Launchpad is not running. Open Orca (the plugin must be enabled) and try again." 3
  ID="$(date +%s)-$$-$RANDOM"
  local tmp="$REQ_DIR/.req-$ID"
  {
    printf 'cmd\t%s\n' "$CMD"
    printf 'cwd\t%s\n' "$PWD"
    if [ "$HAS_DEVICE" = 1 ]; then printf 'device\t%s\n' "$DEVICE"; fi
    if [ "$HAS_SIM" = 1 ]; then printf 'simulator\t%s\n' "$SIM"; fi
    if [ -n "$SCHEME_ARG" ]; then printf 'scheme\t%s\n' "$SCHEME_ARG"; fi
    if [ -n "$CONFIG_ARG" ]; then printf 'configuration\t%s\n' "$CONFIG_ARG"; fi
    if [ -n "$PLATFORM" ]; then printf 'platform\t%s\n' "$PLATFORM"; fi
  } > "$tmp"
  mv "$tmp" "$REQ_DIR/req-$ID.txt"
  local i=0
  while [ ! -f "$REQ_DIR/res-$ID.sh" ]; do
    i=$((i + 1))
    [ "$i" -gt 600 ] && die "Mobile Launchpad did not answer." 3
    sleep 0.1
  done
  . "$REQ_DIR/res-$ID.sh"
  rm -f "$REQ_DIR/res-$ID.sh"
  [ "$OK" = 1 ] || die "$ERROR" 1
}

[ $# -ge 1 ] || { usage; exit 4; }
CMD="$1"
shift
case "$CMD" in
  run | status | stop | devices) ;;
  -h | --help | help) usage; exit 0 ;;
  *) usage >&2; exit 4 ;;
esac

HAS_DEVICE=0; DEVICE=""; HAS_SIM=0; SIM=""; SCHEME_ARG=""; CONFIG_ARG=""; PLATFORM=""; FOLLOW=0; WAIT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --device)
      HAS_DEVICE=1
      if [ $# -ge 2 ] && [ "$(printf '%s' "$2" | cut -c1-2)" != "--" ]; then DEVICE="$2"; shift; fi ;;
    --simulator)
      HAS_SIM=1
      if [ $# -ge 2 ] && [ "$(printf '%s' "$2" | cut -c1-2)" != "--" ]; then SIM="$2"; shift; fi ;;
    --scheme) [ $# -ge 2 ] || die "--scheme needs a name"; SCHEME_ARG="$2"; shift ;;
    --configuration) [ $# -ge 2 ] || die "--configuration needs a name"; CONFIG_ARG="$2"; shift ;;
    --ios) PLATFORM=ios ;;
    --android) PLATFORM=android ;;
    --follow) FOLLOW=1 ;;
    --no-wait) WAIT=0 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option $1 (see launchpad --help)" ;;
  esac
  shift
done
[ "$HAS_DEVICE" = 1 ] && [ "$HAS_SIM" = 1 ] && die "choose --device or --simulator, not both"

ask

case "$CMD" in
  devices) say "$DEVICES"; exit 0 ;;
  stop) say "$MESSAGE"; exit 0 ;;
  status)
    say "$WORKSPACE: $PHASE_LABEL"
    [ -n "$DETAIL" ] && say "$DETAIL"
    exit 0 ;;
esac

say "▸ $SCHEME ($CONFIGURATION) → $DESTINATION  [$WORKSPACE]"
say "  Follow it in Orca's Mobile Launchpad panel; build log: $LOG_FILE"
[ "$WAIT" = 1 ] || exit 0

TAIL_PID=""
if [ "$FOLLOW" = 1 ]; then
  tail -n +1 -f "$OUT_FILE" &
  TAIL_PID=$!
fi
finish() {
  [ -n "$TAIL_PID" ] && kill "$TAIL_PID" 2> /dev/null
  exit "$1"
}
trap 'say ""; say "Detached: the run goes on in Orca (launchpad stop ends it)."; finish 130' INT

LAST=""
GONE=0
while [ ! -f "$REQ_DIR/done-$ID.sh" ]; do
  if [ "$FOLLOW" = 0 ]; then
    NOW="$(cut -d: -f1 "$STATUS_FILE" 2> /dev/null)"
    if [ -n "$NOW" ] && [ "$NOW" != "$LAST" ]; then
      case "$NOW" in preparing | building | installing | launching) say "  · $NOW" ;; esac
      LAST="$NOW"
    fi
  fi
  if alive; then GONE=0; else GONE=$((GONE + 1)); fi
  [ "$GONE" -gt 40 ] && { say "launchpad: Mobile Launchpad stopped answering (Orca closed?)." >&2; finish 3; }
  sleep 0.5
done
. "$REQ_DIR/done-$ID.sh"
rm -f "$REQ_DIR/done-$ID.sh"
[ -n "$TAIL_PID" ] && { sleep 0.5; kill "$TAIL_PID" 2> /dev/null; }

case "$PHASE" in
  running) say "✓ $SCHEME is running on $DESTINATION"; finish 0 ;;
  exited) say "✓ $SCHEME ran on $DESTINATION and exited"; finish 0 ;;
  failed)
    say "✗ $MESSAGE"
    [ -n "$ERRORS" ] && say "$ERRORS"
    say "Full build log: $LOG_FILE"
    finish 1 ;;
  crashed)
    say "✗ $SCHEME crashed: $CRASH_TITLE"
    [ -n "$CRASH_PATH" ] && say "Crash report: $CRASH_PATH"
    finish 2 ;;
  *)
    if [ -n "$MESSAGE" ]; then say "■ Stopped: $MESSAGE"; else say "■ Stopped"; fi
    finish 130 ;;
esac
`
