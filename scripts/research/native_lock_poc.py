#!/usr/bin/env python3
"""Disposable flock experiment only; never use for Framekit state or recovery."""
import fcntl
import json
import os
import sys


def emit(**result):
    print(json.dumps(result), flush=True)


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {"hold", "try", "legacy-create"}:
        raise SystemExit("usage: native_lock_poc.py {hold|try|legacy-create} PATH")
    action, path = sys.argv[1:]
    if action == "legacy-create":
        # Model the old guard's exclusive reservation creation without flock.
        with open(path, "x", encoding="utf-8") as reservation:
            reservation.write("legacy reservation\n")
        emit(created=True)
        return
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            emit(locked=False)
            return
        emit(locked=True)
        if action == "hold":
            sys.stdin.read(1)
    finally:
        os.close(fd)


if __name__ == "__main__":
    main()
