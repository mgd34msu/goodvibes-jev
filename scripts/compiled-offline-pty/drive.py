"""Drive one verified compiled binary in a 40x120 stdlib PTY; no tmux or GUI."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def main():
    fixture_path = Path(sys.argv[1])
    fixture = json.loads(fixture_path.read_text())
    evidence = fixture_path.parent
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    start = time.monotonic()
    parent_pid = os.getppid()
    def interrupt(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    child = None
    prompt_sent = quit_sent = False
    prompt_at = quit_at = None
    with (evidence / 'terminal.raw').open('wb') as output, (evidence / 'terminal.stderr').open('wb') as stderr:
        try:
            child = subprocess.Popen([fixture['binary']], stdin=slave, stdout=slave,
                                     stderr=stderr, cwd=fixture['workspace'],
                                     env=fixture['env'], start_new_session=True)
            os.close(slave)
            slave = None
            readable = True
            while child.poll() is None and time.monotonic() - start < 45:
                if os.getppid() != parent_pid:
                    raise SystemExit('Proof owner exited; stopping compiled child')
                elapsed = time.monotonic() - start
                if elapsed >= 10 and not prompt_sent:
                    os.write(master, b'please answer the e2e marmot question\r')
                    prompt_sent, prompt_at = True, elapsed
                if elapsed >= 25 and not quit_sent:
                    os.write(master, b'/quit\r')
                    quit_sent, quit_at = True, elapsed
                ready, _, _ = select.select([master] if readable else [], [], [], 0.1)
                if ready:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        readable = False
                        continue
                    if not data:
                        readable = False
                        continue
                    output.write(data)
                    output.flush()
            timed_out = child.poll() is None
            if timed_out:
                os.killpg(child.pid, signal.SIGTERM)
            try:
                rc = child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                rc = child.wait()
            try:
                while select.select([master], [], [], 0)[0]:
                    data = os.read(master, 65536)
                    if not data:
                        break
                    output.write(data)
            except OSError:
                pass
            receipt = {'pid': child.pid, 'exit': rc, 'timedOut': timed_out,
                       'promptSent': prompt_sent, 'quitSent': quit_sent,
                       'promptAtSeconds': prompt_at, 'quitAtSeconds': quit_at,
                       'duration': time.monotonic() - start, 'rows': 40, 'columns': 120}
            (evidence / 'terminal-exit.json').write_text(json.dumps(receipt, indent=2) + '\n')
            print(json.dumps(receipt))
            return 1 if timed_out or rc != 0 else 0
        finally:
            if child is not None and child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            if slave is not None:
                os.close(slave)
            os.close(master)


if __name__ == '__main__':
    sys.exit(main())
