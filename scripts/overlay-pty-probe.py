#!/usr/bin/env python3
"""POSIX native Pi TUI PTY probe. Fixture callbacks only; no downloads or inference."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time


def probe(directory):
    log = directory / "frames.jsonl"
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    root = Path(__file__).resolve().parent.parent
    child = subprocess.Popen(["node", "tests/fixtures/overlay-pty-fixture.mjs", str(log)], cwd=root,
                             stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    capture = bytearray()
    checks = []

    def drain():
        while select.select([master], [], [], 0)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            capture.extend(data)

    def wait(label, predicate):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            drain()
            records = log.read_text().splitlines() if log.exists() else []
            if records:
                try:
                    frame = json.loads(records[-1])
                except json.JSONDecodeError:
                    continue
                if predicate(frame):
                    checks.append(label)
                    return frame
            if child.poll() is not None:
                raise AssertionError(f"{label}: child exited {child.returncode}; {capture[-2000:]!r}")
            select.select([master], [], [], .02)
        raise AssertionError(f"{label}: timeout; last frame: {records[-1:]}")

    def key(data):
        os.write(master, data.encode())

    def view(number):
        key(str(number))
        return wait(f"view {number}", lambda f: f.get("state", {}).get("view") == number - 1)

    def text(label, value):
        return wait(label, lambda f: value in f.get("text", ""))

    def resize(columns, rows):
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.kill(child.pid, signal.SIGWINCH)
        wait(f"resize {columns}x{rows}", lambda f: f.get("rows") == rows and f.get("width", 999) <= columns)

    try:
        text("native overlay mounted", "PTY original report")
        key("s"); text("original finding marked", "selected")
        view(2)
        key("s"); text("scope editing", "Enter validate")
        key("\x1b[200~目录/123oSq\x1b[201~")
        wait("Unicode paste owns shortcuts", lambda f: f.get("state", {}).get("similarCode", {}).get("scope") == "目录/123oSq")
        resize(40, 12)
        resize(20, 8)
        key("y")
        text("small terminal blocks hidden actions", "Resize")
        resize(100, 30)
        key("\x15"); key("\x1b")
        text("scope draft preserved, edit ended", "S Setup")
        key("t"); key(".8"); key("\r")
        text("validate without Run", "Options valid")
        key("\r"); text("result in same overlay", "Analysis complete")
        key("b"); text("Back to retained form", "S Setup")
        key("R"); text("retained result reopened", "Analysis complete")
        key("b"); text("form again", "S Setup")
        view(3)
        key("a"); key("\x1b[200~/tmp/目录/capture.json\x1b[201~")
        wait("artifact editing retains path", lambda f: f.get("state", {}).get("runtimeCoverage", {}).get("input") == "/tmp/目录/capture.json")
        key("\x1b"); text("artifact edit ended", "S Setup")
        view(2)
        key("S"); text("explicit setup preview", "y explicitly")
        key("\x1b[200~y\x1b[201~"); key("n")
        text("paste is not consent; decline", "Fixture declined")
        key("\x1b"); text("declined setup Back", "S Setup")
        key("S"); text("second preview", "y explicitly")
        key("y"); text("explicit fixture consent", "Fixture installing")
        key("q"); text("setup cleanup settled", "Setup cancelled")
        key("\x1b"); text("setup Back", "S Setup")
        key("\r"); text("analysis running", "Fixture running")
        resize(64, 24)
        key("q"); text("analysis cancellation settled", "Analysis cancelled")
        key("b"); text("analysis Back", "S Setup")
        view(1)
        key("q")
        final = wait("single overlay closed", lambda f: f.get("completed"))
        assert final["mounts"] == 1 and final["runs"] == 2 and final["confirms"] == 1, final
        deadline = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < deadline:
            drain()
            select.select([master], [], [], .02)
        assert child.poll() == 0, "native terminal did not shut down cleanly"
        report = {"status": "pass", "checks": checks, **final,
                  "scope": "Native Pi TUI / ProcessTerminal, fixture callbacks. Not human UX review or model-backed certification."}
        (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        drain()
        (directory / "terminal.bin").write_bytes(capture)
        os.close(master)


if __name__ == "__main__":
    directory = Path(tempfile.mkdtemp(prefix="pi-fallow-overlay-pty-"))
    print(f"Evidence: {directory}", flush=True)
    probe(directory)
