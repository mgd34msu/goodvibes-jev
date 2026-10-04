#!/usr/bin/env python3
"""Manual Linux PTY proof for compiled Agent/TUI legacy-import read routes.

Uses synthetic fixtures and a localhost HTTP server. See
    docs/audit/legacy-import-compiled-proof.md
for prerequisites, build commands, assertions, and limits.
"""

import argparse
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import pty
import select
import shutil
import sqlite3
import struct
import subprocess
import tempfile
import termios
import threading
import time
import urllib.parse

import pyte


TOKEN = "synthetic-host-token"
PROJECT = "synthetic-project"
BINARIES = {
    "agent": "goodvibes-agent-linux-x64",
    "tui": "goodvibes-linux-x64",
}
SCENARIOS = ("status", "preview", "revoked-preview")
PREPARE_SOURCE = """
import { prepareLegacyWorkLedgerMigration } from './packages/engine/sdk/src/platform/workflow/work-ledger/legacy-import.ts';
import fixture from './products/agent/src/test/fixtures/legacy-ledger/preparation.json';
const prepared = prepareLegacyWorkLedgerMigration(fixture);
if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
process.stdout.write(JSON.stringify(prepared));
"""


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def host_type(prepared, scenario, calls):
    sources = [entry["source"] for entry in prepared["manifest"]["sources"]]

    class Host(http.server.BaseHTTPRequestHandler):
        revoked = False

        def respond(self, status, body=None):
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if body is not None:
                self.wfile.write(json.dumps(body).encode())

        def authenticated(self):
            return self.headers.get("Authorization") == "Bearer " + TOKEN

        def do_GET(self):
            authenticated = self.authenticated()
            calls.append({"method": "GET", "path": self.path, "authenticated": authenticated})
            path = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(path.query)
            if path.path == "/api/control-plane/auth" and authenticated:
                self.respond(200, {
                    "authenticated": True, "admin": True,
                    "principalId": "synthetic-principal", "principalKind": "user",
                    "scopes": ["read:work-ledger"] if Host.revoked else ["read:work-ledger", "read:knowledge"],
                    "roles": ["admin"], "authMode": "session", "tokenPresent": True,
                    "authorizationHeaderPresent": True, "sessionCookiePresent": False,
                })
            elif path.path == "/api/knowledge/sources" and authenticated and not Host.revoked:
                if scenario == "revoked-preview":
                    Host.revoked = True
                self.respond(200, {"items": sources[1:], "hasMore": False}
                             if query.get("cursor") == ["second-page"] else
                             {"items": sources[:1], "hasMore": True, "nextCursor": "second-page"})
            else:
                self.respond(503)

        def do_POST(self):
            authenticated = self.authenticated()
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or "{}")
            calls.append({"method": "POST", "path": self.path, "authenticated": authenticated, "body": body})
            expected = {"projectId": PROJECT, "sourceIds": sorted(source["id"] for source in sources)}
            if (self.path == "/api/work-ledger/legacy-import/prepare" and authenticated
                    and not Host.revoked and body == expected):
                self.respond(200, prepared)
            else:
                self.respond(503)

        def log_message(self, *_args):
            pass

    return Host


def configure(root, repo, port):
    home, workspace, temporary = (root / name for name in ("home", "workspace", "tmp"))
    workspace.mkdir(parents=True)
    temporary.mkdir()
    now = int(time.time() * 1000)
    for leaf in ("agent", "tui", "goodvibes", "daemon"):
        directory = home / ".goodvibes" / leaf
        directory.mkdir(parents=True)
        write_json(directory / "settings.json", {
            "update": {"auto": False},
            "daemon": {"enabled": True, "connectedHost": {"enabled": True}},
            "controlPlane": {"host": "127.0.0.1", "port": port},
            "provider": {"model": "synthetic:fixture"},
        })
        write_json(directory / "onboarding-complete.json", {
            "version": 1, "checkedAt": now, "updatedAt": now, "source": "wizard",
        })
        (directory / "providers").mkdir()
        write_json(directory / "providers" / "synthetic.json", {
            "name": "synthetic", "displayName": "Synthetic", "type": "openai-compat",
            "baseURL": "http://127.0.0.1:9/v1", "apiKey": "synthetic-no-live-key",
            "models": [{"id": "fixture", "displayName": "Fixture", "contextWindow": 64000,
                        "capabilities": {"toolCalling": True, "codeEditing": True,
                                         "reasoning": False, "multimodal": False}}],
        })
        for cache in (directory, directory / "control-plane"):
            cache.mkdir(exist_ok=True)
            records = {
                "model-catalog.json": {"version": 5, "models": []},
                "model-limits.json": {"version": 1, "models": {}},
                "benchmarks.json": {"version": 1, "entries": []},
                "gateway-pricing-aihubmix.json": {"version": 1, "models": {}},
                "gateway-pricing-vercel-ai-gateway.json": {"version": 1, "models": {}},
            }
            for filename, content in records.items():
                write_json(cache / filename, dict(content, fetchedAt=now, ttlMs=86400000))
    token = home / ".goodvibes" / "daemon" / "operator-tokens.json"
    write_json(token, {"token": TOKEN, "peerId": "synthetic-peer", "createdAt": 1})
    token.chmod(0o600)
    (workspace / "README.md").write_text("Synthetic compiled import read probe\n")
    preload = repo / "packages/engine/scripts/test-network-preload.ts"
    (workspace / "bunfig.toml").write_text("preload = [" + json.dumps(str(preload)) + "]\n")
    # Deliberately do not inherit real provider keys, credentials, HOME, or settings.
    environment = {
        "PATH": "/usr/bin:/bin", "HOME": str(home), "GOODVIBES_HOME": str(home),
        "GOODVIBES_WORKING_DIR": str(workspace), "GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD": "1",
        "GOODVIBES_TEST_NETWORK_VIOLATIONS": str(root / "network.log"),
        "TERM": "xterm-256color", "LANG": "C.UTF-8", "TMPDIR": str(temporary),
    }
    return home, workspace, token, environment


def exercise(binary, workspace, environment, scenario, timeout):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 150, 0, 0))
    screen = pyte.Screen(150, 42)
    stream = pyte.Stream(screen)
    data = bytearray()
    sent = quit_sent = observed = timed_out = False
    target = {
        "status": "No saved legacy import for selected project.",
        "preview": "Legacy import preview",
        "revoked-preview": "Current admin, read:work-ledger and read:knowledge required",
    }[scenario]
    process = None
    try:
        process = subprocess.Popen([str(binary)], cwd=workspace, env=environment,
                                   stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        slave = None
        start = time.monotonic()
        while time.monotonic() - start < timeout:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                data.extend(chunk)
                stream.feed(chunk.decode(errors="replace"))
            if time.monotonic() - start > 6 and not sent:
                os.write(master, b"\x1b")
                time.sleep(0.2)
                command = "status" if scenario == "status" else "preview"
                os.write(master, f"/work-import {command} {PROJECT}\r".encode())
                sent = True
            if target in "".join(screen.display):
                observed = True
            if observed and not quit_sent:
                os.write(master, b"\x03")
                time.sleep(0.2)
                os.write(master, b"\x03")
                quit_sent = True
            if process.poll() is not None:
                break
        # PTY EOF can precede process exit while the app finishes cleanup.
        # Do not turn that normal ordering into an artificial timeout/SIGTERM.
        if process.poll() is None and time.monotonic() - start >= timeout:
            timed_out = True
            process.terminate()
        try:
            code = process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.kill()
            code = process.wait()
        return data, screen, code, observed, timed_out
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        if slave is not None:
            os.close(slave)
        os.close(master)


def run_scenario(repo, output, prepared, surface, scenario, timeout):
    calls = []
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), host_type(prepared, scenario, calls))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    root = output / (surface + "-" + scenario)
    binary = repo / "products" / surface / "dist" / BINARIES[surface]
    try:
        home, workspace, token, environment = configure(root, repo, server.server_port)
        token_before = token.read_bytes()
        data, screen, code, observed, timed_out = exercise(binary, workspace, environment, scenario, timeout)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    (root / "terminal.raw").write_bytes(data)
    (root / "screen.txt").write_text("\n".join(screen.display))
    write_json(root / "requests.json", calls)
    journal_states = []
    for journal in home.rglob("*.sqlite"):
        connection = sqlite3.connect(journal)
        try:
            count = connection.execute("SELECT count(*) FROM legacy_import").fetchone()[0]
            journal_states.append({"mode": oct(journal.stat().st_mode & 0o777), "savedCommands": count})
        except sqlite3.OperationalError:
            pass  # Other product SQLite databases are not the import journal.
        finally:
            connection.close()
    result = {
        "surface": surface, "scenario": scenario, "exit": code, "bytes": len(data),
        "readCommandObserved": observed, "timedOut": timed_out,
        "authCalls": sum(call["path"] == "/api/control-plane/auth" for call in calls),
        "sourcePageCalls": sum(call["path"].startswith("/api/knowledge/sources") for call in calls),
        "prepareCalls": sum(call["path"] == "/api/work-ledger/legacy-import/prepare" for call in calls),
        "importCalls": sum(call["path"] == "/api/work-ledger/legacy-import" for call in calls),
        "tokenUnchanged": token.read_bytes() == token_before, "journalStates": journal_states,
        "networkViolations": (root / "network.log").read_text() if (root / "network.log").exists() else "",
    }
    write_json(root / "result.json", result)
    print(json.dumps(result), flush=True)
    with (output / "results.log").open("a") as log:
        log.write(json.dumps(result) + "\n")
    assert observed and code == 0 and not timed_out, result
    assert result["importCalls"] == 0 and result["tokenUnchanged"] and not result["networkViolations"], result
    assert journal_states == [{"mode": "0o600", "savedCommands": 0}], result
    assert result["prepareCalls"] == (1 if scenario == "preview" else 0), result
    assert result["sourcePageCalls"] == {"preview": 2, "revoked-preview": 1, "status": 0}[scenario], result
    assert result["authCalls"] > 0, result


def main():
    if not __debug__:
        raise RuntimeError("Run without Python optimization; this proof requires its assertions")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--bun", default="bun", help="Bun executable used only to prepare the synthetic source fixture")
    parser.add_argument("--output", type=Path, help="New, nonexistent output directory (default: fresh system temp directory)")
    parser.add_argument("--timeout", type=float, default=40, help="Per-scenario timeout in seconds")
    args = parser.parse_args()
    repo = args.repo.resolve()
    bun = shutil.which(args.bun)
    if not bun:
        parser.error("Bun is required to prepare the published synthetic fixture")
    for surface, filename in BINARIES.items():
        binary = repo / "products" / surface / "dist" / filename
        if not binary.is_file() or not os.access(binary, os.X_OK):
            parser.error(f"Build the executable first: {binary}")
    if args.output:
        output = args.output.resolve()
        output.mkdir(parents=True, exist_ok=False)
    else:
        output = Path(tempfile.mkdtemp(prefix="legacy-import-compiled-pty-"))
    print(f"Synthetic proof artifacts: {output}", flush=True)
    prepared = json.loads(subprocess.check_output([bun, "--eval", PREPARE_SOURCE], cwd=repo, text=True))
    assert prepared["kind"] == "prepared" and prepared["manifest"]["projectId"] == PROJECT
    write_json(output / "prepared.json", prepared)
    write_json(output / "provenance.json", {
        "sourceHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
        "binaries": {surface: hashlib.sha256((repo / "products" / surface / "dist" / filename).read_bytes()).hexdigest()
                     for surface, filename in BINARIES.items()},
    })
    for surface in BINARIES:
        for scenario in SCENARIOS:
            run_scenario(repo, output, prepared, surface, scenario, args.timeout)
    print("PASS: six compiled protected-read scenarios", flush=True)


if __name__ == "__main__":
    main()
