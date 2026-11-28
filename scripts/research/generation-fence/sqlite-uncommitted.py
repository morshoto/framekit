"""Hold a synthetic journal insertion open until this test-owned process dies."""
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute("BEGIN IMMEDIATE")
connection.execute(
    "INSERT INTO operations VALUES (?, ?, ?, ?, ?)",
    ("operation-uncommitted", "target-a", "a" * 64, 1, "possibly-dispatched"),
)
print("ready", flush=True)
sys.stdin.read()
