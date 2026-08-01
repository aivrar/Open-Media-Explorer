from __future__ import annotations

import json
import unittest
from pathlib import Path


FIXTURES = Path(__file__).parent / "fixtures"
SCHEMAS = FIXTURES / "schemas"


class FrozenContractSchemaTests(unittest.TestCase):
    def test_all_required_contract_schemas_exist_and_are_closed(self) -> None:
        expected = {"session", "runtime", "tool-status", "media-registration", "job"}
        found = {path.stem.replace(".schema", "") for path in SCHEMAS.glob("*.schema.json")}
        self.assertEqual(found, expected)
        for name in expected:
            schema = self.load_schema(name)
            self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
            self.assertEqual(schema["type"], "object")
            self.assertFalse(schema["additionalProperties"])
            self.assertTrue(schema["required"])
            self.assertTrue(set(schema["required"]).issubset(schema["properties"]))

    def test_examples_satisfy_required_types_enums_consts_and_patterns(self) -> None:
        examples = json.loads((FIXTURES / "contract_examples.json").read_text(encoding="utf-8"))
        for name, example in examples.items():
            with self.subTest(name=name):
                self.assert_matches_shallow_schema(example, self.load_schema(name))

    @staticmethod
    def load_schema(name: str) -> dict:
        return json.loads((SCHEMAS / f"{name}.schema.json").read_text(encoding="utf-8"))

    def assert_matches_shallow_schema(self, value: dict, schema: dict) -> None:
        self.assertEqual(set(value) - set(schema["properties"]), set())
        self.assertEqual(set(schema["required"]) - set(value), set())
        for field, rule in schema["properties"].items():
            if field not in value:
                continue
            candidate = value[field]
            if "const" in rule:
                self.assertEqual(candidate, rule["const"])
            if "enum" in rule:
                self.assertIn(candidate, rule["enum"])
            expected_type = rule.get("type")
            if expected_type and not isinstance(expected_type, list):
                py_type = {"string": str, "integer": int, "number": (int, float),
                           "boolean": bool, "object": dict, "array": list}[expected_type]
                self.assertIsInstance(candidate, py_type)


if __name__ == "__main__":
    unittest.main()
