"""Offline regression checks for the native Goose proof's retained evidence."""
import hashlib
import json
import pathlib
import runpy
import subprocess
import tempfile
import unittest

proof = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[2] / 'scripts' / 'prove-gaap-goose.py'))


class NativeProofEvidenceTest(unittest.TestCase):
    """Check the binary and transcript evidence required to publish native proof provenance."""

    def setUp(self):
        """Create fixture binaries, their expected digests, and one matched tool call and result."""
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.host = pathlib.Path(scratch.name) / 'host'
        self.attestor = pathlib.Path(scratch.name) / 'attestor'
        self.host.write_bytes(b'fixture host')
        self.attestor.write_bytes(b'fixture attestor')
        self.claim = {'implementation_digest': 'sha256:' + hashlib.sha256(b'fixture host').hexdigest(),
                      'attestor_digest': 'sha256:' + hashlib.sha256(b'fixture attestor').hexdigest()}
        tool = {'type': 'function', 'function': {'name': 'gaap-proposals__governed_operation'}}
        call = {'id': 'proposal-1', **tool}
        self.turn = {'tools': [tool], 'messages': [
            {'role': 'assistant', 'tool_calls': [call]},
            {'role': 'tool', 'tool_call_id': 'proposal-1', 'content': 'Host executed the admitted effect.'}]}

    def verify(self, turns=None):
        """Run the proof verifier on the fixtures. The default checks only the binaries."""
        return proof['verify_native_evidence'](self.claim, self.host, self.attestor, turns)

    def test_standalone_provenance_keeps_its_original_fields(self):
        """Publish the standalone proof without package measurements."""
        directory = self.host.parent
        proof['write_native_provenance'](directory, directory, self.claim, None)
        self.assertEqual(json.loads((directory / 'provenance.json').read_text()), self.claim)

    def test_requires_each_binary_to_match_after_execution(self):
        """Changing either fixture binary must fail the final digest check."""
        self.verify()
        for artifact in (self.host, self.attestor):
            with self.subTest(artifact=artifact.name):
                original = artifact.read_bytes()
                artifact.write_bytes(b'changed')
                with self.assertRaisesRegex(RuntimeError, artifact.name):
                    self.verify()
                artifact.write_bytes(original)

    def test_correlates_results_with_a_declared_governed_tool_call(self):
        """A different result ID or tool name must break the link to the governed call."""
        self.verify([self.turn])
        self.turn['messages'][1]['tool_call_id'] = 'unrelated-result'
        with self.assertRaisesRegex(RuntimeError, 'tool result'):
            self.verify([self.turn])
        self.turn['messages'][1]['tool_call_id'] = 'proposal-1'
        self.turn['messages'][0]['tool_calls'][0] = {
            'id': 'proposal-1', 'type': 'function', 'function': {'name': 'another-tool'}}
        with self.assertRaisesRegex(RuntimeError, 'tool result'):
            self.verify([self.turn])

    def test_keeps_tool_call_ids_in_their_original_turn(self):
        """A call in one provider turn can't establish the origin of a result in another."""
        with self.assertRaisesRegex(RuntimeError, 'tool result'):
            self.verify([{**self.turn, 'messages': self.turn['messages'][:1]},
                         {**self.turn, 'messages': self.turn['messages'][1:]}])

    def test_requires_a_declaration_and_a_result_after_the_call(self):
        """Reject a missing tool declaration or a result that precedes the call."""
        for turns in ([{**self.turn, 'tools': []}],
                      [{**self.turn, 'messages': list(reversed(self.turn['messages']))}]):
            with self.assertRaisesRegex(RuntimeError, 'tool result'):
                self.verify(turns)


class PackagedSourceEvidenceTest(unittest.TestCase):
    """Exercise the proof package with a small local npm project."""

    def setUp(self):
        """Create an offline npm package in a temporary Git repository."""
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        root = pathlib.Path(work.name)
        self.project, self.output, self.scratch = (root / name for name in ('project', 'output', 'scratch'))
        for directory in (self.project, self.output, self.scratch):
            directory.mkdir()
        (self.project / 'src').mkdir()
        self.source = self.project / 'src' / 'cli.js'
        self.source.write_text('#!/usr/bin/env node\n')
        (self.project / 'scripts').mkdir()
        self.build = self.project / 'scripts' / 'build.cjs'
        self.build.write_text('')
        (self.project / 'package.json').write_text(json.dumps({
            'name': 'threadloop', 'version': '0.0.0', 'bin': {'threadloop': 'src/cli.js'},
            'scripts': {'build': 'node scripts/build.cjs'}, 'files': ['src']
        }))
        subprocess.run(['git', 'init', '--quiet', str(self.project)], check=True)

    def test_refuses_a_package_whose_build_changed_source_inputs(self):
        """Stop before installing a package whose build modified its own source."""
        self.build.write_text("require('node:fs').appendFileSync('src/cli.js', '// generated change\\n')")
        with self.assertRaisesRegex(RuntimeError, 'source inputs changed'):
            proof['install_workflow_cli'](self.project, self.output, self.scratch)
        self.assertIn('// generated change', self.source.read_text())
        self.assertFalse((self.output / 'installed-package.json').exists())
        self.assertFalse((self.output / 'provenance.json').exists())

    def test_checks_the_original_package_inputs_before_publishing_provenance(self):
        """A final source change blocks publication until the measured files match again."""
        _, package = proof['install_workflow_cli'](self.project, self.output, self.scratch)
        original = self.source.read_bytes()
        self.source.write_bytes(original + b'// change after installation\n')
        with self.assertRaisesRegex(RuntimeError, 'source inputs changed'):
            proof['write_native_provenance'](self.project, self.output, {'case': 'allow'}, package)
        published = self.output / 'provenance.json'
        self.assertFalse(published.exists())
        self.source.write_bytes(original)
        proof['write_native_provenance'](self.project, self.output, {'case': 'allow'}, package)
        record = json.loads(published.read_text())
        self.assertEqual(record['installed_package'], json.loads((self.output / 'installed-package.json').read_text()))
        self.assertEqual(record['final_source_inputs_sha256'], package['source_inputs_sha256'])
        self.assertEqual(record['final_source_inputs_sha256'], package['post_pack_inputs_sha256'])


if __name__ == '__main__':
    unittest.main()
