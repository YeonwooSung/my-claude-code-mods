#!/usr/bin/env python3
"""Opt-in real-CLI smoke test. Uses a temporary config and a dead loopback API.

Run in a venv with qa/requirements.txt, passing --claude-bin explicitly.
No real account, model, external API or system network setting is used.
"""
import argparse
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import tempfile
import time
import termios

import pyte


class Terminal:
    def __init__(self, binary, plugin, config, artifacts, name, combined=False):
        self.artifacts = artifacts
        self.name = name
        self.screen = pyte.Screen(120, 40)
        self.stream = pyte.Stream(self.screen)
        self.decoder = codecs.getincrementaldecoder('utf-8')('replace')
        self.raw = open(artifacts / (name + '.ansi'), 'wb')
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            # Copy only fixed, non-credential OS metadata; never enumerate the installer's environment.
            env = {'PATH': os.getenv('PATH', os.defpath), 'HOME': os.path.expanduser('~'),
                   'LANG': os.getenv('LANG', 'en_US.UTF-8'), 'TERM': 'xterm-256color'}
            env.update(TERM='xterm-256color', CLAUDE_CONFIG_DIR=str(config),
                       ANTHROPIC_API_KEY='local-test-only', ANTHROPIC_BASE_URL='http://127.0.0.1:1',
                       CLAUDE_CODE_ENABLE_FUNCTION_HOOKS='1', DISABLE_AUTOUPDATER='1',
                       CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', CLAUDE_CODE_MAX_RETRIES='0')
            args = [str(binary), '--plugin-dir', str(plugin), '--setting-sources', '',
                    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
            if combined:
                for mod in ['agent-profiler', 'context-inspector', 'time-machine',
                            'loop-detective', 'pin-memo', 'model-effort-band']:
                    args += ['--plugin-dir', str(plugin.parent / mod)]
            os.execve(str(binary), args, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))

    def pump(self, seconds=0.15):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            if select.select([self.fd], [], [], min(0.05, max(0, until - time.monotonic())))[0]:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                self.raw.write(data)
                self.raw.flush()
                self.stream.feed(self.decoder.decode(data))

    @property
    def text(self):
        return '\n'.join(self.screen.display)

    def snapshot(self, label):
        (self.artifacts / f'{self.name}-{label}.txt').write_text(self.text + '\n')

    def wait(self, predicate, label, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump(0.08)
            if predicate():
                self.snapshot(label)
                print('PASS', self.name, label, flush=True)
                return
        self.snapshot('FAIL-' + label)
        raise AssertionError(f'{self.name}: {label}; inspect {self.artifacts}')

    def send(self, text, delay=0.35):
        os.write(self.fd, text.encode())
        self.pump(delay)

    def command(self, text):
        self.send(text)
        self.send('\r')

    def startup(self):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self.pump(0.12)
            if '/effort' in self.text:
                self.snapshot('startup')
                return
        self.snapshot('FAIL-startup')
        raise AssertionError('CLI did not reach its prompt')

    def score(self):
        match = re.search(r'SCORE\s+(\d+)\s+BEST\s+(\d+)', self.text)
        return tuple(map(int, match.groups())) if match else (-1, -1)

    def origin(self):
        lines = self.screen.display
        row = next(i for i, line in enumerate(lines) if any(s in line for s in ['CLICK + SPACE', 'GAME OVER R', 'PAUSED P', 'TOKEN RUN |']))
        line = lines[row]
        col = next(line.index(s) for s in ['CLICK + SPACE', 'GAME OVER R', 'PAUSED P', 'TOKEN RUN |'] if s in line)
        return row, col

    def click(self, x, y):
        self.send(f'\x1b[<0;{x};{y}M')
        self.send(f'\x1b[<0;{x};{y}m')

    def track_click(self):
        row, col = self.origin()
        self.click(col + 13, row + 5)  # 1-based SGR coordinates.

    def control_click(self, key):
        row, col = self.origin()
        self.click(col + {'r': 6, 'p': 8}[key], row + 8)

    def airborne(self):
        row, _col = self.origin()
        return any('@' in line for line in self.screen.display[row + 2:row + 5])

    def resize(self, columns, rows):
        self.screen.resize(lines=rows, columns=columns)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)
        self.pump(0.3)

    def stop(self):
        # Drain/close the PTY before reaping: an exiting renderer may still flush output.
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        self.pump(0.2)
        os.close(self.fd)
        for _ in range(30):
            if os.waitpid(self.pid, os.WNOHANG)[0]:
                break
            time.sleep(0.03)
        else:
            os.kill(self.pid, signal.SIGKILL)
            for _ in range(30):
                if os.waitpid(self.pid, os.WNOHANG)[0]:
                    break
                time.sleep(0.03)
            else:
                print('WARNING: child could not be reaped promptly', self.pid, flush=True)
        self.raw.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--claude-bin', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--combined', action='store_true')
    args = parser.parse_args()
    binary = args.claude_bin.resolve()
    plugin = Path(__file__).resolve().parents[1]
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='token-run-pty-config-') as config_name:
        config = Path(config_name)
        (config / '.claude.json').write_text(json.dumps({
            'hasCompletedOnboarding': True, 'theme': 'dark', 'lastOnboardingVersion': '2.1.301',
            'projects': {str(plugin.parent): {'hasTrustDialogAccepted': True}},
            'customApiKeyResponses': {'approved': ['local-test-only'], 'rejected': []},
        }))
        first = Terminal(binary, plugin, config, artifacts, 'play', args.combined)
        try:
            first.startup()
            first.command('/token-run')
            first.wait(lambda: 'CLICK + SPACE' in first.text, 'open')
            first.track_click()
            first.wait(lambda: first.score()[0] >= 1, 'click-start-frames')
            first.send('\x1b[A')
            first.wait(first.airborne, 'up-key-jump')
            first.send('p')
            first.wait(lambda: 'PAUSED P' in first.text, 'pause')
            paused = first.score()[0]
            first.pump(0.8)
            assert first.score()[0] == paused, 'Paused score advanced'
            first.snapshot('pause-frozen')
            first.resize(28, 40)
            first.wait(lambda: 'PAUSED P' in first.text and first.score()[0] == paused, 'narrow-playable')
            first.resize(120, 40)
            first.control_click('p')
            before_resize = first.score()[0]
            first.resize(22, 40)
            first.wait(lambda: 'Resize' in first.text, 'undersized-hint')
            first.pump(1.3)
            first.resize(120, 40)
            first.wait(lambda: first.score()[0] >= 0, 'resize-restore')
            assert first.score()[0] <= before_resize + 1, 'Clipped game continued advancing'
            # Dock/inline remount resets native keyboard focus. Use the visible R button.
            first.control_click('r')
            first.wait(lambda: 'CLICK + SPACE' in first.text and first.score()[0] == 0, 'restart')
            first.track_click()
            first.wait(lambda: 'GAME OVER R' in first.text, 'collision', timeout=10)
            best = first.score()[1]
            assert best >= 1
            first.send('q')
            first.wait(lambda: first.score()[0] == -1, 'q-close')
            first.command('/token-run')
            first.wait(lambda: first.score()[1] >= best, 'reopen-record')
            first.track_click()
            first.send('p')
            first.wait(lambda: 'PAUSED P' in first.text, 'pause-before-return')
            first.send('\x1b')
            first.send('draft-marker')
            first.wait(lambda: 'draft-marker' in first.text, 'escape-returns-composer')
            first.send('\x15')
            first.send('\x1b')
            first.wait(lambda: first.score()[0] == -1, 'escape-close')
            # Real main-turn failure against an unavailable loopback endpoint.
            first.command('offline-check')
            first.wait(lambda: '요청 실패' in first.text, 'request-failure-invite', timeout=45)
            first.command('/token-run')
            first.wait(lambda: 'CLICK + SPACE' in first.text, 'open-after-request-failure')
            first.track_click()
            first.wait(lambda: first.score()[0] >= 1, 'play-after-request-failure')
            first.send('q')
            first.wait(lambda: first.score()[0] == -1, 'offline-q-close')
        finally:
            first.stop()
        second = Terminal(binary, plugin, config, artifacts, 'restore', args.combined)
        try:
            second.startup()
            second.command('/token-run')
            second.wait(lambda: second.score()[1] >= best, 'record-after-process-restart')
        finally:
            second.stop()
        (artifacts / 'result.json').write_text(json.dumps({'passed': True, 'best': best, 'combined': args.combined}, indent=2) + '\n')


if __name__ == '__main__':
    main()
