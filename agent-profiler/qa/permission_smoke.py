#!/usr/bin/env python3
"""Real-engine permission/OTLP smoke test. Standard library only; no model/account needed.

Runs a temporary driver mod alongside this checkout. Uses a fresh config, disabled
telemetry exporters and a refused loopback API URL. Only a fixed temporary Write
can be approved by this test host. Does not modify user settings or project files.
"""
import argparse
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile
import time


DRIVER = """import type { Register } from 'claude-code'
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'profile-probe', description: 'Exercise fixed local sample tools' })
    return next(e)
  })
  on('command.run', { command: 'profile-probe' }, async ($, e) => {
    const path = `${await $.session.cwd()}/sample.txt`
    const result = e.args === 'read'
      ? await $.tool.call({ tool: 'Read', file_path: path })
      : await $.tool.call({ tool: 'Write', file_path: path, content: 'local permission probe\\n' })
    return { text: JSON.stringify({ result }) }
  })
}
"""


def run_case(binary, profiler, workspace, case, expected_version):
    case_root = workspace / case
    config = case_root / 'config'
    driver = case_root / 'driver'
    exports = case_root / 'exports'
    for folder in [config, driver / '.claude-plugin', driver / 'hooks']:
        folder.mkdir(parents=True)
    (config / '.claude.json').write_text(json.dumps({
        'hasCompletedOnboarding': True,
        'customApiKeyResponses': {'approved': ['YOUR_API_KEY'], 'rejected': []},
    }))
    (driver / '.claude-plugin/plugin.json').write_text(json.dumps({
        'name': 'profiler-permission-probe', 'version': '0.0.1',
    }))
    (driver / 'hooks/hooks.json').write_text(json.dumps({'modules': ['./register.ts']}))
    (driver / 'hooks/register.ts').write_text(DRIVER)
    sample = case_root / 'sample.txt'
    if case == 'automatic':
        sample.write_text('local permission probe\n')
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('ANTHROPIC_', 'CLAUDE', 'OTEL_', 'BETA_', 'ENABLE_BETA_'))}
    env.update(
        CLAUDE_CONFIG_DIR=str(config), ANTHROPIC_API_KEY='YOUR_API_KEY',
        ANTHROPIC_BASE_URL='http://127.0.0.1:1', DISABLE_AUTOUPDATER='1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', CLAUDE_CODE_MAX_RETRIES='0',
        CLAUDE_CODE_ENABLE_FUNCTION_HOOKS='1', CLAUDE_CODE_ENABLE_TELEMETRY='0',
        OTEL_LOGS_EXPORTER='none', OTEL_METRICS_EXPORTER='none',
    )
    # Keep every write inside the fixture even if the engine ignores configured defaults.
    # The production implementation is copied unchanged apart from its fallback data directory.
    local_profiler = case_root / 'agent-profiler'
    shutil.copytree(profiler, local_profiler, ignore=shutil.ignore_patterns('types', 'tests', 'qa'))
    register = local_profiler / 'hooks/register.tsx'
    source = register.read_text()
    assert source.count("'~/.claude/agent-profiler'") == 1
    register.write_text(source.replace("'~/.claude/agent-profiler'", json.dumps(str(exports))))
    settings = {'pluginConfigs': {'agent-profiler': {'outputDir': str(exports)}}}
    args = [str(binary), '--plugin-dir', str(local_profiler), '--plugin-dir', str(driver),
            '--settings', json.dumps(settings), '--setting-sources', '',
            '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
            '--permission-prompt-tool', 'stdio', '--input-format', 'stream-json',
            '--output-format', 'stream-json', '--verbose', '--print']
    proc = subprocess.Popen(args, cwd=case_root, env=env, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    requests = []
    stderr = bytearray()
    result = None
    exported = False
    buffer = b''
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    selector.register(proc.stderr, selectors.EVENT_READ)
    try:
        prompt = '/profile-probe ' + ('read' if case == 'automatic' else 'write')
        proc.stdin.write((json.dumps({'type': 'user', 'message': {'role': 'user', 'content': prompt}}) + '\n').encode())
        proc.stdin.flush()
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline and result is None:
            for key, _ in selector.select(0.1):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if key.fileobj is proc.stderr:
                    stderr.extend(chunk)
                    continue
                buffer += chunk
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if row.get('type') == 'control_request':
                        request = row['request']
                        # Fail closed: this host approves only the exact temporary fixture.
                        assert request.get('subtype') == 'can_use_tool', request
                        assert request.get('tool_name') == 'Write', request
                        tool_input = request.get('input', {})
                        assert tool_input == {'file_path': str(sample), 'content': 'local permission probe\n'}, request
                        assert case != 'automatic', request
                        requests.append(request['tool_use_id'])
                        time.sleep(0.3)
                        answer = ({'behavior': 'allow', 'updatedInput': tool_input} if case == 'approve'
                                  else {'behavior': 'deny', 'message': 'probe denial'})
                        reply = {'type': 'control_response', 'response': {
                            'subtype': 'success', 'request_id': row['request_id'], 'response': answer}}
                        proc.stdin.write((json.dumps(reply) + '\n').encode())
                        proc.stdin.flush()
                    if row.get('type') == 'result':
                        assert not row.get('is_error'), row
                        if not exported:
                            exported = True
                            proc.stdin.write((json.dumps({'type': 'user', 'message': {'role': 'user', 'content': '/profile-export'}}) + '\n').encode())
                            proc.stdin.flush()
                        else:
                            result = row
            if proc.poll() is not None and not selector.get_map():
                break
        assert result is not None, f'{case}: no result; {stderr.decode(errors="replace")[-1500:]}'
    finally:
        selector.close()
        if proc.poll() is None:
            proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        for pipe in [proc.stdin, proc.stdout, proc.stderr]:
            pipe.close()
    assert len(requests) == (0 if case == 'automatic' else 1), requests
    assert sample.exists() == (case != 'reject'), f'{case}: wrong file-write outcome'
    files = list(exports.rglob('*-full-*.otlp.json'))
    assert files, f'{case}: missing trace exports: {result}'
    spans = []
    for path in files:
        resource = json.loads(path.read_text())['resourceSpans'][0]
        assert resource['scopeSpans'][0]['scope']['version'] == expected_version
        spans.extend(resource['scopeSpans'][0]['spans'])
    tool = next(span for span in spans if span['name'].startswith('execute_tool '))
    attributes = {entry['key']: next(iter(entry['value'].values())) for entry in tool['attributes']}
    expected_decision = 'reject' if case == 'reject' else 'accept'
    expected_source = {'automatic': 'config', 'approve': 'user_temporary', 'reject': 'user_reject'}[case]
    assert attributes['agent_profiler.permission_decision'] == expected_decision, attributes
    assert attributes['agent_profiler.permission_source'] == expected_source, attributes
    assert 'agent_profiler.permission' not in attributes
    if requests:
        assert attributes['gen_ai.tool.call.id'] == requests[0], attributes
        assert int(attributes['agent_profiler.permission_wait_ms']) >= 250, attributes
        assert any(span['name'] == 'tool.approval_wait' for span in spans)
    else:
        assert 'agent_profiler.permission_wait_ms' not in attributes, attributes
    if case == 'reject':
        assert int(attributes['agent_profiler.exec_ms']) == 0
        assert tool['status']['message'] == 'denied'
        assert not any(span['name'] == 'tool.exec' for span in spans)
    return {'case': case, 'passed': True, 'permission_requests': len(requests),
            'decision': expected_decision, 'source': expected_source,
            'estimated_wait_ms': attributes.get('agent_profiler.permission_wait_ms'),
            'file_exists': sample.exists()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--claude-bin', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    args = parser.parse_args()
    profiler = Path(__file__).resolve().parents[1]
    expected_version = json.loads((profiler / '.claude-plugin/plugin.json').read_text())['version']
    version = subprocess.check_output([str(args.claude_bin.resolve()), '--version'], text=True).strip()
    with tempfile.TemporaryDirectory(prefix='profiler-permission-smoke-') as temporary:
        cases = [run_case(args.claude_bin.resolve(), profiler, Path(temporary).resolve(), case, expected_version)
                 for case in ['automatic', 'approve', 'reject']]
    args.artifacts.mkdir(parents=True, exist_ok=True)
    summary = {'engine': version, 'profiler_version': expected_version, 'telemetry_export_enabled': False, 'cases': cases}
    (args.artifacts / 'result.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
