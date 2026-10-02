#!/bin/zsh
# Starts the fake minilogue xd, runs one logue-cli command against it, and leaves the SysEx
# transcript in <logfile>. Retry on "Logue handshake failed" -- a known, unexplained flake of this
# rig (roughly 1 run in 4), not a protocol problem.
#   usage: run.sh <logfile> <logue-cli command> [logue-cli args...]
#   env:   LOGUE_CLI (default: sibling logue-sdk checkout's tools/logue-cli/ download),
#          MODINFO / SLOTSTAT (hex byte strings overriding the emulator's module-info/slot-status replies)
set -e
cd "$(dirname $0)"
[[ -x logue-emu && logue-emu -nt main.swift ]] || swiftc -O main.swift -o logue-emu
log=$1; shift
CLI=${LOGUE_CLI:-../../../../logue-sdk/tools/logue-cli/logue-cli-osx-0.07-2b/logue-cli}
./logue-emu "$log" > /dev/null & emu=$!
trap "kill $emu 2>/dev/null" EXIT
sleep 1
port=$($CLI probe -l 2>&1 | awk '/in .*EMU SOUND/{gsub(":","",$2); print $2}')
$CLI "$@" -i $port -o $port 2>&1 & p=$!
(sleep 30; kill $p 2>/dev/null) &
wait $p
