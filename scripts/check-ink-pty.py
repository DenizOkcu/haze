"""POSIX PTY contract check, not an emulator/scrollback certification.
Run from the repo root: python3 scripts/check-ink-pty.py [--kitty]
Only synthetic fixture data is read/written; no user configuration is loaded.
"""
import argparse
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument('--kitty', action='store_true')
args = parser.parse_args()
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
child = subprocess.Popen(['node', '--import', 'tsx', 'scripts/ink-terminal-fixture.tsx'],
                         stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = bytearray()
responded = False


def read_until(predicate, timeout=5):
    global responded
    end = time.monotonic() + timeout
    while not predicate(bytes(output)):
        if time.monotonic() > end:
            raise AssertionError('PTY fixture did not reach the expected state')
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            chunk = os.read(master, 65536)
            output.extend(chunk)
            if args.kitty and not responded and b'\x1b[?u' in output:
                os.write(master, b'\x1b[?1u')
                responded = True


try:
    read_until(lambda data: b'fixture-ready' in data and b'\x1b[?2004h' in data)
    payload = '[?0u\r\n界🙂\r\n/exit\r\nR'.encode()
    os.write(master, b'\x1b[200~' + payload[:8])
    os.write(master, payload[8:] + b'\x1b[201~')
    read_until(lambda data: b'[paste #1 +4 lines]' in data)
    assert child.poll() is None, 'Pasted /exit was interpreted as a command'
    os.write(master, b'\r')
    read_until(lambda data: b'submitted:' in data)
    for columns, rows in [(40, 12), (20, 6), (10, 3), (1, 1), (80, 24)]:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        child.send_signal(signal.SIGWINCH)
        # Wait for actual output from a render, not just a fixed sleep.
        previous = len(output)
        read_until(lambda data: len(data) > previous)
    os.write(master, b'\x1b[99;5u' if args.kitty else b'\x03')
    # Keep draining the PTY while Ink flushes its exit frame and mode resets.
    read_until(lambda _data: child.poll() is not None)
    child.wait(timeout=1)
    assert child.returncode == 0, f'Fixture exited {child.returncode}'
    read_until(lambda data: b'\x1b[?2004l' in data)
    raw = bytes(output)
    assert b'\x1b[3J' not in raw, 'Scrollback erase emitted'
    assert raw.count(b'fixture-history-99') == 1, 'Static history replayed'
    assert termios.tcgetattr(slave) == original, 'Terminal mode was not restored'
    if args.kitty:
        assert responded, 'Kitty support was not negotiated'
        assert b'\x1b[<u' in raw, 'Kitty mode was not popped'
    print(f'PASS: {"Kitty" if args.kitty else "legacy"} PTY, paste, resize, Static ordering, interrupt, raw-mode restoration ({len(raw)} bytes)')
finally:
    if child.poll() is None:
        child.kill()
        child.wait(timeout=5)
    os.close(master)
    os.close(slave)
