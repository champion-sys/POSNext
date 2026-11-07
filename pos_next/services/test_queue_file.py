# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import json
import unittest
from unittest.mock import patch

import frappe

from pos_next.services import queue_file


def _raise(message, *_args, **_kwargs):
    raise frappe.ValidationError(message)


def _file(**values):
    return json.dumps({"format_version": 1, "rows": [], **values}).encode()


class ReadQueueFile(unittest.TestCase):
    def setUp(self):
        for target, replacement in (
            ("frappe.throw", _raise),
            ("pos_next.services.queue_file._", lambda text: text),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def assert_refused(self, content, message):
        with self.assertRaises(frappe.ValidationError) as caught:
            queue_file.read_queue_file(content)
        self.assertIn(message, str(caught.exception))
        self.assertIn("Nothing was imported", str(caught.exception))


class TestAReadableFile(ReadQueueFile):
    def test_gives_what_it_claims(self):
        queue = queue_file.read_queue_file(
            _file(
                device_id="device-1",
                app_version="1.16.0",
                server="https://old.example.com",
                exported_at="2026-11-07T10:00:00.000Z",
                protocol_version=1,
                rows=[{"offline_id": "a"}],
            )
        )

        self.assertEqual(queue.device_id, "device-1")
        self.assertEqual(queue.app_version, "1.16.0")
        self.assertEqual(queue.server, "https://old.example.com")
        self.assertEqual(queue.exported_at, "2026-11-07T10:00:00.000Z")
        self.assertEqual(queue.protocol_version, 1)
        self.assertEqual(queue.rows, [{"offline_id": "a"}])

    def test_the_header_may_be_missing(self):
        queue = queue_file.read_queue_file(_file())

        self.assertIsNone(queue.device_id)
        self.assertEqual(queue.protocol_version, 1)

    def test_rows_come_back_in_queue_order_whatever_the_file_says(self):
        queue = queue_file.read_queue_file(_file(rows=[{"seq": 3}, {"seq": 1}, {"seq": 2}]))
        self.assertEqual([row["seq"] for row in queue.rows], [1, 2, 3])

    def test_a_row_that_cannot_be_ordered_stays_in_the_list(self):
        rows = ["junk", {"seq": {"a": 1}}, {"seq": "first"}, {"seq": 1}]
        self.assertEqual(len(queue_file.read_queue_file(_file(rows=rows)).rows), 4)

    def test_a_windows_editor_leaves_a_mark_at_the_start(self):
        queue = queue_file.read_queue_file(b"\xef\xbb\xbf" + _file(device_id="device-1"))
        self.assertEqual(queue.device_id, "device-1")

    def test_arabic_survives(self):
        content = json.dumps({"format_version": 1, "rows": [{"customer": "عميل"}]}, ensure_ascii=False).encode()
        self.assertEqual(queue_file.read_queue_file(content).rows[0]["customer"], "عميل")

    def test_a_file_at_the_limit_is_read(self):
        content = _file(device_id="d")
        padded = content[:-1] + b" " * (queue_file.MAX_FILE_BYTES - len(content)) + b"}"

        self.assertEqual(queue_file.read_queue_file(padded).device_id, "d")


class TestAFileThatIsRefused(ReadQueueFile):
    def test_not_json(self):
        self.assert_refused(b"{not json", "not valid JSON")

    def test_cut_off_halfway(self):
        self.assert_refused(_file(rows=[{"offline_id": "a"}])[:-3], "not valid JSON")

    def test_empty(self):
        self.assert_refused(b"", "not valid JSON")

    def test_not_text(self):
        self.assert_refused(b"\xff\xfe\x00\x01", "not valid JSON")

    def test_python_numbers_are_not_json(self):
        self.assert_refused(b'{"format_version": 1, "rows": [{"grand_total": NaN}]}', "not valid JSON")

    def test_nesting_that_would_blow_the_stack(self):
        self.assert_refused(b"[" * 200000, "not valid JSON")

    def test_json_that_is_not_an_object(self):
        self.assert_refused(b"[1, 2]", "not a queue file")

    def test_an_object_of_some_other_kind(self):
        self.assert_refused(b'{"customer": "A"}', "not a queue file")

    def test_a_format_from_the_future(self):
        self.assert_refused(_file(format_version=2), "format this server cannot read")

    def test_a_version_of_another_type(self):
        for version in ("1", 1.5, True, None, [1]):
            self.assert_refused(_file(format_version=version), "format this server cannot read")

    def test_over_the_limit(self):
        content = _file() + b" " * queue_file.MAX_FILE_BYTES
        self.assert_refused(content, "larger than 10 MB")

    def test_rows_that_are_not_a_list(self):
        self.assert_refused(_file(rows={"a": 1}), "not a queue file")

    def test_no_rows_at_all(self):
        self.assert_refused(b'{"format_version": 1}', "not a queue file")

    def test_a_device_id_that_will_not_fit_the_field(self):
        self.assert_refused(_file(device_id="d" * 141), "not a queue file")

    def test_a_header_that_is_not_text(self):
        for fieldname in ("device_id", "app_version", "server", "exported_at"):
            self.assert_refused(_file(**{fieldname: {"a": 1}}), "not a queue file")

    def test_the_file_is_not_echoed_into_the_message(self):
        with self.assertRaises(frappe.ValidationError) as caught:
            queue_file.read_queue_file(_file(format_version="<img src=x onerror=alert(1)>"))
        self.assertNotIn("<img", str(caught.exception))
