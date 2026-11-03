"""Separate-process characterization of a proposed advisory lock (not production)."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

WORKER = Path(__file__).resolve().parents[2] / "scripts/research/native_lock_poc.py"


class NativeLockPocTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="framekit-lock-poc-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.lock = self.root / "coordinator.lock"
        self.reservation = self.root / "reservation.json"
        self.children = []
        self.addCleanup(self.stop_children)

    def stop_children(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=5)

    def run_worker(self, *args):
        result = subprocess.run([sys.executable, str(WORKER), *map(str, args)],
                                text=True, capture_output=True, timeout=5, check=True)
        return json.loads(result.stdout)

    def hold_lock(self):
        child = subprocess.Popen([sys.executable, str(WORKER), "hold", str(self.lock)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        # The worker sends an acknowledgement only after acquiring the lock.
        self.assertEqual(json.loads(child.stdout.readline()), {"locked": True})
        return child

    def test_cooperating_processes_exclude_each_other(self):
        self.hold_lock()
        self.assertEqual(self.run_worker("try", self.lock), {"locked": False})

    def test_crashed_holder_releases_os_lock_for_restart(self):
        holder = self.hold_lock()
        holder.kill()
        holder.wait(timeout=5)
        self.assertEqual(self.run_worker("try", self.lock), {"locked": True})

    def test_legacy_writer_can_create_reservation_while_lock_is_held(self):
        self.hold_lock()
        self.assertEqual(self.run_worker("legacy-create", self.reservation), {"created": True})
        self.assertEqual(self.reservation.read_text(), "legacy reservation\n")
        self.assertEqual(self.run_worker("try", self.lock), {"locked": False})

    def test_unlinking_locked_file_creates_split_lock_domain(self):
        self.hold_lock()
        os.unlink(self.lock)
        self.assertEqual(self.run_worker("try", self.lock), {"locked": True})


if __name__ == "__main__":
    unittest.main()
