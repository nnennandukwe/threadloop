"""Offline regression checks for the native Goose proof's retained evidence."""
import hashlib
import pathlib
import runpy
import tempfile
import unittest

proof = runpy.run_path(str(pathlib.Path(__file__).resolve().parents[2] / 'scripts' / 'prove-gaap-goose.py'))


class NativeProofEvidenceTest(unittest.TestCase):
    def setUp(self):
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
        return proof['verify_native_evidence'](self.claim, self.host, self.attestor, turns)

    def test_requires_each_binary_to_match_after_execution(self):
        self.verify()
        for artifact in (self.host, self.attestor):
            with self.subTest(artifact=artifact.name):
                original = artifact.read_bytes()
                artifact.write_bytes(b'changed')
                with self.assertRaisesRegex(RuntimeError, artifact.name):
                    self.verify()
                artifact.write_bytes(original)

    def test_correlates_results_with_a_declared_governed_tool_call(self):
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
        with self.assertRaisesRegex(RuntimeError, 'tool result'):
            self.verify([{**self.turn, 'messages': self.turn['messages'][:1]},
                         {**self.turn, 'messages': self.turn['messages'][1:]}])

    def test_requires_a_declaration_and_a_result_after_the_call(self):
        for turns in ([{**self.turn, 'tools': []}],
                      [{**self.turn, 'messages': list(reversed(self.turn['messages']))}]):
            with self.assertRaisesRegex(RuntimeError, 'tool result'):
                self.verify(turns)


if __name__ == '__main__':
    unittest.main()
