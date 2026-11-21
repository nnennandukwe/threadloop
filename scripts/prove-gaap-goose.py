"""Own a fresh real-Goose provider fixture for the ThreadLoop process consumer."""
import argparse
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import threading
import tempfile
import hashlib


def input_digest(project):
    """Identify the source and proof inputs, including uncommitted local work."""
    paths = subprocess.check_output(['git', '-C', str(project), 'ls-files', '--cached', '--others',
              '--exclude-standard', '-z', '--', 'src', 'tests/fixtures', 'scripts', 'package.json',
              'package-lock.json', 'tsconfig.build.json', 'tsconfig.json']).split(b'\0')
    rows = []
    for name in sorted(set(filter(None, paths))):
        relative = os.fsdecode(name)
        filename = project / relative
        rows.append([relative, hashlib.sha256(filename.read_bytes()).hexdigest() if filename.is_file() else None])
    return hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()


def install_workflow_cli(project, output, scratch):
    """Build and install the local package without a registry or lifecycle hooks."""
    environment = {**os.environ, 'npm_config_offline': 'true', 'npm_config_cache': str(scratch / 'npm-cache'),
                   'npm_config_audit': 'false', 'npm_config_fund': 'false', 'npm_config_update_notifier': 'false'}
    source_digest = input_digest(project)
    subprocess.run(['npm', 'run', 'build'], cwd=project, env=environment, check=True, stdout=sys.stderr)
    packed = json.loads(subprocess.check_output(['npm', 'pack', '--offline', '--ignore-scripts',
                        '--json', '--pack-destination', str(output)], cwd=project, env=environment))[0]
    archive = output / packed['filename']
    prefix = scratch / 'installed'
    subprocess.run(['npm', 'install', '--offline', '--ignore-scripts', '--no-save', '--no-package-lock',
                    '--prefix', str(prefix), str(archive)], cwd=scratch, env=environment, check=True, stdout=sys.stderr)
    cli = prefix / 'node_modules' / '.bin' / 'threadloop'
    (output / 'installed-package.json').write_text(json.dumps({
        'source_inputs_sha256': source_digest, 'post_pack_inputs_sha256': input_digest(project),
        'filename': archive.name, 'package_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
        'cli_sha256': hashlib.sha256(cli.read_bytes()).hexdigest(), 'npm_integrity': packed['integrity']
    }, indent=2))
    return str(cli)


def main():
    """Own fixture resources through signing, admission and controller re-evaluation."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gaap', required=True, type=pathlib.Path)
    parser.add_argument('--goose', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--case', choices=['allow', 'bad_patch'], default='allow')
    parser.add_argument('--workflow-run', action='store_true', help='Execute a selected action from a persisted Workflow Run')
    args = parser.parse_args()
    gaap = args.gaap.resolve(strict=True)
    goose = args.goose.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    reference = gaap / 'examples' / 'governed-goose'
    specification = importlib.util.spec_from_file_location('gaap_reference', reference / 'run.py')
    upstream = importlib.util.module_from_spec(specification)
    sys.dont_write_bytecode = True
    specification.loader.exec_module(upstream)
    import platform
    if upstream.file_hash(goose) != 'sha256:' + upstream.PINS[(platform.system(), platform.machine())]:
        raise RuntimeError('Goose binary differs from the pinned reference release')
    binary = reference / 'target' / 'debug' / 'gaap-governed-goose'
    attestor = gaap / 'adapters' / 'attestation' / 'target' / 'debug' / 'gaap-attestation'
    workspace = output / 'repository'
    workspace.mkdir()
    (workspace / 'shipping.py').write_text(upstream.BAD)
    templates = output / 'git-templates'
    templates.mkdir()
    git_environment = {'PATH': os.defpath, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_TEMPLATE_DIR': str(templates)}
    subprocess.run(['git', 'init', '--quiet', '-b', 'feature', str(workspace)], check=True, env=git_environment)
    subprocess.run(['git', '-C', str(workspace), 'add', 'shipping.py'], check=True, env=git_environment)
    subprocess.run(['git', '-C', str(workspace), '-c', 'user.name=ThreadLoop Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Initial owned fixture'], check=True, env=git_environment)
    state = output / 'agent-state'
    (state / 'config').mkdir(parents=True)
    config_file = state / 'config' / 'config.yaml'
    config_file.write_text('extensions:\n  developer:\n    enabled: false\n    type: builtin\n    name: developer\n')
    transcript = []
    server = upstream.provider(args.case, transcript, workspace)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    python = pathlib.Path(sys.executable).resolve()
    token = os.urandom(32).hex()
    socket = output / 'ingress.sock'
    environment = {'HOME': str(state), 'PATH': os.defpath, 'GOOSE_PATH_ROOT': str(state), 'GOOSE_PROVIDER': 'openai', 'GOOSE_MODEL': 'gaap-fixture', 'GOOSE_MODE': 'auto', 'OPENAI_BASE_URL': 'http://127.0.0.1:' + str(server.server_port) + '/v1'}
    agent = {'executable': str(goose), 'arguments': ['acp'], 'environment': environment, 'working_directory': str(workspace), 'expected_name': 'goose', 'expected_version': '1.54.0', 'artifacts': [upstream.artifact(goose), upstream.artifact(config_file)]}
    ingress = {'executable': str(python), 'arguments': [str(reference / 'server.py'), 'ingress', str(socket), token], 'environment': {}, 'working_directory': str(workspace), 'expected_name': 'gaap-proposals', 'expected_version': '1', 'artifacts': [upstream.artifact(python), upstream.artifact(reference / 'server.py')]}
    configuration = output / 'native-host.json'
    configuration.write_text(json.dumps({'agent': agent, 'proposal_server': ingress, 'python': str(python), 'server': str(reference / 'server.py'), 'socket': str(socket), 'token': token, 'output': str(output / 'unused.json'), 'case': args.case}))
    project = pathlib.Path(__file__).resolve().parent.parent
    try:
        with tempfile.TemporaryDirectory(prefix='threadloop-native-proof-') as scratch:
            command = ['node', str(project / 'node_modules' / 'tsx' / 'dist' / 'cli.mjs'), str(project / 'scripts' / 'prove-gaap-goose.ts'), str(configuration), str(binary), str(attestor), str(output)]
            if args.workflow_run:
                command.append(install_workflow_cli(project, output, pathlib.Path(scratch)))
            subprocess.run(command, cwd=str(project), check=True, timeout=180)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        (output / 'provider-transcript.json').write_text(json.dumps(transcript, indent=2))
    if args.workflow_run:
        tool = 'gaap-proposals__governed_operation'
        tool_results = [message for turn in transcript for message in turn.get('messages', [])
                        if message.get('role') == 'tool']
        if not tool_results or not any(item.get('function', {}).get('name') == tool
                                       for turn in transcript for item in turn.get('tools', [])):
            raise RuntimeError('The local Goose transcript lacks the governed operation and its tool result.')
        package = json.loads((output / 'installed-package.json').read_text())
        provenance = json.loads((output / 'provenance.json').read_text())
        provenance.update({'installed_package': package, 'final_source_inputs_sha256': input_digest(project),
                           'goose_sha256': upstream.file_hash(goose), 'goose_version': '1.54.0',
                           'provider_requests': len(transcript),
                           'provider_transcript_sha256': hashlib.sha256((output / 'provider-transcript.json').read_bytes()).hexdigest()})
        (output / 'provenance.json').write_text(json.dumps(provenance, indent=2))


if __name__ == '__main__':
    main()
