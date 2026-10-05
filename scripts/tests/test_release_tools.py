import importlib.util
import unittest
from pathlib import Path


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CandidateManifestTests(unittest.TestCase):
    def test_missing_verified_build_receipt_rejected(self):
        manifest = load('release-manifest')
        with self.assertRaises(ValueError):
            manifest.validate_receipt(None, 'a' * 40, b'candidate')

    def test_stale_binary_receipt_rejected(self):
        manifest = load('release-manifest')
        receipt = {'sourceCommit': 'a' * 40, 'image': manifest.IMAGE,
                   'sha256': 'b' * 64, 'byteLength': 9}
        with self.assertRaises(ValueError):
            manifest.validate_receipt(receipt, 'a' * 40, b'candidate')


class DependencyGateTests(unittest.TestCase):
    def test_unknown_warning_fails(self):
        gate = load('check-dependencies')
        report = {'vulnerabilities': {'count': 0}, 'warnings': {'unsound': [
            {'advisory': {'id': 'RUSTSEC-2099-0001'}, 'package': {'name': 'rand', 'version': '0.7.3'}}]}}
        with self.assertRaises(ValueError):
            gate.validate_advisories(report)

    def test_incomplete_index_response_fails(self):
        gate = load('check-dependencies')
        with self.assertRaises(ValueError):
            gate.index_record('{"vers":"1.0.0","yanked":false}\n', '1.0.1')

    def test_yanked_version_fails(self):
        gate = load('check-dependencies')
        with self.assertRaises(ValueError):
            gate.index_record('{"vers":"1.0.0","yanked":true}\n', '1.0.0')

    def test_non_yanked_version_passes(self):
        gate = load('check-dependencies')
        self.assertFalse(gate.index_record('{"vers":"1.0.0","yanked":false}\n', '1.0.0')['yanked'])


if __name__ == '__main__':
    unittest.main()
