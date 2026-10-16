"""Own a fresh real-Goose provider fixture for the ThreadLoop process consumer."""
import argparse
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import threading


def main():
    """Own fixture resources through signing, admission and controller re-evaluation."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gaap', required=True, type=pathlib.Path)
    parser.add_argument('--goose', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--case', choices=['allow', 'bad_patch'], default='allow')
    args = parser.parse_args()
    gaap = args.gaap.resolve(strict=True)
    goose = args.goose.resolve(strict=True)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    reference = gaap / 'examples' / 'governed-goose'
    specification = importlib.util.spec_from_file_location('gaap_reference', reference / 'run.py')
    upstream = importlib.util.module_from_spec(specification)
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
        subprocess.run(['node', str(project / 'node_modules' / 'tsx' / 'dist' / 'cli.mjs'), str(project / 'scripts' / 'prove-gaap-goose.ts'), str(configuration), str(binary), str(attestor), str(output)], cwd=str(project), check=True, timeout=120)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        (output / 'provider-transcript.json').write_text(json.dumps(transcript, indent=2))


if __name__ == '__main__':
    main()
