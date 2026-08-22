import unittest

from assign_labels import labels_for_pull_request


class AssignLabelsTest(unittest.TestCase):
    def test_branch_and_changed_file_labels(self) -> None:
        labels = labels_for_pull_request(
            "feat/labeling",
            ["README.md", "backend/model.py", "terraform/main.tf"],
        )
        self.assertEqual(
            labels,
            {
                "Type: New Feature",
                "Type: Document",
                "Feedback: Feature Request",
                "Group: Backend",
                "Group: Infrastructure",
                "Type: Improvement",
                "Priority: Mid",
            },
        )

    def test_fix_and_refactor_branch_labels(self) -> None:
        self.assertEqual(labels_for_pull_request("fix/socket", []), {"Problem: Bug"})
        self.assertEqual(labels_for_pull_request("refactor/runtime", []), {"Type: Improvement"})

    def test_unmatched_changes_do_not_create_labels(self) -> None:
        self.assertEqual(labels_for_pull_request("chore/cleanup", ["package.json"]), set())


if __name__ == "__main__":
    unittest.main()
