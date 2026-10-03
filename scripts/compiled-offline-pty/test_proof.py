"""Behavioral negative controls for the terminal replay and combined receipt gate."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import time
import unittest

from replay import REPLY, replay, verify


class ProofTests(unittest.TestCase):
    def setUp(self):
        # Owned, scoped scratch under the checkout; never anonymous system /tmp.
        scratch = Path(__file__).resolve().parents[2] / '.tmp'
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='offline-pty-test-', dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        binary = self.root / 'fake-binary'
        binary.write_bytes(b'test fixture, never executed')
        self.base = {
            'driverExit': 0, 'compiledViolations': [], 'parentViolations': [],
            'preloadReceipt': {'pid': 42, 'execPath': str(binary), 'guardPreloadCompleted': True},
            'judgments': {'accepted': ['identity', 'turn', 'route', 'tier'], 'rejected': [{}] * 16, 'unexpected': []},
            'modelRequests': [{}],
        }
        self.terminal = {'pid': 42, 'exit': 0, 'timedOut': False, 'promptSent': True, 'quitSent': True,
                         'promptAtSeconds': 10.01, 'quitAtSeconds': 25.01, 'duration': 25.1, 'rows': 40, 'columns': 120}
        self.provenance = {'binary': str(binary), 'binarySHA256': hashlib.sha256(binary.read_bytes()).hexdigest(),
                           'verifiedBeforeExecution': True, 'eagerNamespaceScanPassed': True}
        (self.root / 'terminal.raw').write_bytes(('\x1b[2J\x1b[2;4H' + REPLY).encode())
        (self.root / 'terminal.stderr').write_bytes(b'')

    def run_proof(self, base=None, terminal=None, provenance=None):
        for name, value in [('result.json', base or self.base), ('terminal-exit.json', terminal or self.terminal),
                            ('provenance.json', provenance or self.provenance)]:
            (self.root / name).write_text(json.dumps(value))
        return verify(self.root)

    def test_good_receipts_and_cursor_positioned_spaces(self):
        raw = '\x1b[2J\x1b[1;1HThe\x1b[1;5Hmarmot\x1b[1;12Hanswer\x1b[1;19His\x1b[1;22Hforty-two.'
        (self.root / 'terminal.raw').write_bytes(raw.encode())
        self.assertTrue(self.run_proof()['passed'])
        self.assertNotIn(REPLY, re_strip_csi(raw))

    def test_erased_reply_and_unknown_screen_command_fail(self):
        for suffix in ['\x1b[2J', '\x1b[1;1H\x1b[J', '\x1b[3A']:
            with self.subTest(suffix=suffix):
                (self.root / 'terminal.raw').write_bytes((REPLY + suffix).encode())
                self.assertFalse(self.run_proof()['passed'])

    def test_nonempty_stderr_fails(self):
        (self.root / 'terminal.stderr').write_bytes(b'unexpected runtime warning')
        result = self.run_proof()
        self.assertFalse(result['passed'])
        self.assertFalse(result['checks']['stderrEmpty'])

    def test_bad_combined_receipt_fails(self):
        changes = [
            ('driverExit', 1), ('compiledViolations', ['blocked external call']),
            ('parentViolations', ['blocked external call']), ('modelRequests', []),
            ('modelRequests', [{}, {}]),
        ]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                base = copy.deepcopy(self.base)
                base[key] = value
                self.assertFalse(self.run_proof(base=base)['passed'])
        for key, value in [('pid', 99), ('execPath', '/not-the-verified-binary'), ('guardPreloadCompleted', False)]:
            with self.subTest(preload=key):
                base = copy.deepcopy(self.base)
                base['preloadReceipt'][key] = value
                self.assertFalse(self.run_proof(base=base)['passed'])
        for key, value in [('unexpected', [{}]), ('accepted', [])]:
            with self.subTest(judgment=key):
                base = copy.deepcopy(self.base)
                base['judgments'][key] = value
                self.assertFalse(self.run_proof(base=base)['passed'])

    def test_abnormal_exit_timing_and_dimensions_fail(self):
        for key, value in [('exit', -15), ('timedOut', True), ('promptSent', False), ('quitSent', False),
                           ('promptAtSeconds', 9), ('quitAtSeconds', 24), ('duration', 45), ('columns', 80)]:
            with self.subTest(key=key):
                terminal = {**self.terminal, key: value}
                self.assertFalse(self.run_proof(terminal=terminal)['passed'])

    def test_binary_changed_or_provenance_unverified_fails(self):
        for key, value in [('binarySHA256', '0' * 64), ('verifiedBeforeExecution', False), ('eagerNamespaceScanPassed', False)]:
            with self.subTest(key=key):
                self.assertFalse(self.run_proof(provenance={**self.provenance, key: value})['passed'])

    def test_driver_cancellation_reaps_owned_compiled_process(self):
        marker = self.root / 'started-pid'
        binary = self.root / 'sleeping-binary'
        binary.write_text('#!/usr/bin/env python3\nimport os, time\nfrom pathlib import Path\n'
                          + f'Path({str(marker)!r}).write_text(str(os.getpid()))\ntime.sleep(60)\n')
        binary.chmod(0o755)
        fixture = self.root / 'fixture.json'
        fixture.write_text(json.dumps({'binary': str(binary), 'workspace': str(self.root),
                                       'env': {'PATH': os.environ.get('PATH', '/usr/bin:/bin')}}))
        driver = subprocess.Popen([sys.executable, str(Path(__file__).with_name('drive.py')), str(fixture)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(marker.exists(), 'driver did not start its compiled child')
            pid = int(marker.read_text())
            driver.terminate()
            driver.communicate(timeout=5)
            self.assertNotEqual(driver.returncode, 0)
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
            self.assertFalse((self.root / 'terminal-exit.json').exists())
        finally:
            if driver.poll() is None:
                driver.terminate()
                driver.communicate(timeout=5)

    def test_carriage_return_does_not_create_a_new_row(self):
        screen, unsupported = replay('wrong\r' + REPLY)
        self.assertEqual(screen.splitlines()[0], REPLY)
        self.assertEqual(unsupported, [])


def re_strip_csi(raw):
    import re
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', raw)


if __name__ == '__main__':
    unittest.main()
