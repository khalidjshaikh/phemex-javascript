#!/usr/bin/env bash
while true; do
    err=$(mktemp)
    out=$(./long-limit.ts --cancel --spread -64 --gap -.0 --qty .01 --dispersion 1 --sleep 10 2>"$err")
    rc=$?

    cat "$err"
    rm "$err"

    printf "%s\n" "$out" \
        | rg -v cancelled \
        | rg -v Cancelling \
        | rg -v returned \
        | sort -n

    echo "exit code: $rc"

    [ "$rc" -eq 2 ] && break

    date
    sleep 3600
done

