#!/bin/sh
# Tests 80-ax9000-radio-channel against a fake uci (flat "key=value" file).
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../../feed/ax9000-controls/files/etc/uci-defaults/80-ax9000-radio-channel"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir "$T/bin"
cat > "$T/bin/uci" <<'FAKE'
#!/bin/sh
[ "$1" = "-q" ] && shift
db="$UCI_DB"
case "$1" in
show) grep '^wireless\.[^.]*=wifi-device$' "$db" ;;
get) v="$(grep "^$2=" "$db" | tail -n1)" || exit 1; echo "${v#*=}" ;;
set) k="${2%%=*}"; v="${2#*=}"; v="${v#\'}"; v="${v%\'}"
     grep -v "^$k=" "$db" > "$db.n"; echo "$k=$v" >> "$db.n"; mv "$db.n" "$db" ;;
commit) echo "commit $2" >> "$UCI_LOG" ;;
esac
FAKE
printf '#!/bin/sh\necho "$*" >> "$UCI_LOG"\n' > "$T/bin/logger"
chmod +x "$T/bin/uci" "$T/bin/logger"
export PATH="$T/bin:$PATH" UCI_DB="$T/db" UCI_LOG="$T/log"
fails=0
check() { [ "$2" = "$3" ] || { echo "FAIL: $1: got '$2' want '$3'"; fails=$((fails+1)); }; }

cat > "$UCI_DB" <<'DB'
wireless.radio0=wifi-device
wireless.radio0.path=platform/soc@0/c000000.wifi
wireless.radio0.channel=149
wireless.radio3=wifi-device
wireless.radio3.path=platform/soc@0/20000000.pcie/pci0001:00/0001:00:00.0/0001:01:00.0
wireless.radio3.channel=149
wireless.radio4=wifi-device
wireless.radio4.path=platform/soc@0/20000000.pcie/pci0001:00/0001:00:00.0/0001:01:00.0
wireless.radio4.channel=36
wireless.radio5=wifi-device
wireless.radio5.path=platform/soc@0/20000000.pcie/x
wireless.radio5.channel=auto
DB
: > "$UCI_LOG"
sh "$SCRIPT"; check exit $? 0
check "qcn channel>=100 reset" "$(uci get wireless.radio3.channel)" "auto"
check "other radio untouched" "$(uci get wireless.radio0.channel)" "149"
check "qcn channel 36 kept" "$(uci get wireless.radio4.channel)" "36"
check "qcn auto kept" "$(uci get wireless.radio5.channel)" "auto"
check "committed once" "$(grep -c '^commit wireless' "$UCI_LOG")" "1"
: > "$UCI_LOG"
sh "$SCRIPT"
check "idempotent: no second commit" "$(grep -c '^commit' "$UCI_LOG")" "0"
[ "$fails" = 0 ] && echo "radio migration: all passed"
exit "$fails"
