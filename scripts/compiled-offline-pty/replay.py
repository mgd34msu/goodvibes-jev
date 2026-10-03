"""Reconstruct visible terminal cells, then require every proof receipt to agree."""
import hashlib
import json
from pathlib import Path
import re
import sys
import unicodedata

ROWS, COLUMNS = 40, 120
REPLY = 'The marmot answer is forty-two.'


def replay(raw):
    cells = [[' '] * COLUMNS for _ in range(ROWS)]
    row = col = 0
    # The renderer uses absolute cursor positions, erase display, SGR and mode
    # toggles. Reject unknown screen-mutating commands rather than guessing.
    tokens = re.split(r'(\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\))', raw)
    unsupported = []
    for token in tokens:
        if token.startswith('\x1b['):
            body, command = token[2:-1], token[-1]
            if command == 'H':
                parts = body.split(';')
                row = max(0, int(parts[0] or 1) - 1)
                col = max(0, int(parts[1] or 1) - 1) if len(parts) > 1 else 0
            elif command == 'J':
                mode = int(body or 0)
                if mode == 2:
                    cells = [[' '] * COLUMNS for _ in range(ROWS)]
                elif mode == 0:
                    if row < ROWS:
                        cells[row][min(col, COLUMNS):] = [' '] * (COLUMNS - min(col, COLUMNS))
                    for i in range(row + 1, ROWS):
                        cells[i] = [' '] * COLUMNS
                elif mode != 3:  # Erase scrollback does not alter visible cells.
                    unsupported.append(token)
            elif command not in 'mhlu':
                unsupported.append(token)
        elif token.startswith('\x1b]'):
            continue
        else:
            for char in token:
                if char == '\x1b':
                    unsupported.append('unrecognized escape')
                elif char == '\r':
                    col = 0
                elif char == '\n':
                    row = min(row + 1, ROWS - 1)
                elif ord(char) < 32 or unicodedata.combining(char):
                    continue
                else:
                    if row < ROWS and col < COLUMNS:
                        cells[row][col] = char
                    col += 2 if unicodedata.east_asian_width(char) in ('W', 'F') else 1
    return '\n'.join(''.join(line).rstrip() for line in cells), unsupported


def verify(root):
    raw = (root / 'terminal.raw').read_bytes()
    screen, unsupported = replay(raw.decode('utf-8'))
    (root / 'terminal-screen.txt').write_text(screen + '\n')
    base = json.loads((root / 'result.json').read_text())
    terminal = json.loads((root / 'terminal-exit.json').read_text())
    provenance = json.loads((root / 'provenance.json').read_text())
    preload = base['preloadReceipt'] or {}
    binary = Path(provenance['binary'])
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    reply = REPLY in screen
    checks = {
        'replyObservedInCells': reply,
        'supportedScreenCommandsOnly': not unsupported,
        'stderrEmpty': (root / 'terminal.stderr').stat().st_size == 0,
        'eagerNamespaceScanPassed': provenance['eagerNamespaceScanPassed'] is True,
        'driverPassed': base['driverExit'] == 0,
        'compiledGuardClean': not base['compiledViolations'],
        'parentGuardClean': not base['parentViolations'],
        'guardPreloadCompleted': preload.get('guardPreloadCompleted') is True,
        'strictJudgments': not base['judgments']['unexpected'],
        'requiredJudgments': sorted(base['judgments']['accepted']) == ['identity', 'route', 'tier', 'turn'],
        'oneModelRequest': len(base['modelRequests']) == 1,
        'normalExit': terminal['exit'] == 0 and not terminal['timedOut'],
        'promptAndQuitSent': terminal['promptSent'] and terminal['quitSent'],
        'timingPreserved': (terminal['promptAtSeconds'] is not None and terminal['quitAtSeconds'] is not None
                            and 10 <= terminal['promptAtSeconds'] < terminal['quitAtSeconds']
                            and 25 <= terminal['quitAtSeconds'] <= terminal['duration'] < 45),
        'dimensionsPreserved': terminal['rows'] == ROWS and terminal['columns'] == COLUMNS,
        'samePid': preload.get('pid') == terminal['pid'],
        'sameExecutable': preload.get('execPath') == str(binary),
        'provenanceVerifiedBeforeExecution': provenance['verifiedBeforeExecution'] is True,
        'unchangedVerifiedBinary': binary_hash == provenance['binarySHA256'],
    }
    result = {
        'passed': all(checks.values()), 'checks': checks,
        'unsupportedScreenCommands': unsupported,
        'compiledGuardViolations': len(base['compiledViolations']),
        'parentGuardViolations': len(base['parentViolations']),
        'modelRequests': len(base['modelRequests']),
        'judgmentAccepted': base['judgments']['accepted'],
        'judgmentExpectedRejections': len(base['judgments']['rejected']),
        'judgmentUnexpected': len(base['judgments']['unexpected']),
        'stderrBytes': (root / 'terminal.stderr').stat().st_size,
        'terminalExit': terminal, 'preloadReceipt': preload, 'provenance': provenance,
        'binarySHA256': binary_hash, 'rawTerminalSHA256': hashlib.sha256(raw).hexdigest(),
    }
    (root / 'screen-verification.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    result = verify(Path(sys.argv[1]))
    print(json.dumps(result, indent=2))
    sys.exit(0 if result['passed'] else 1)
