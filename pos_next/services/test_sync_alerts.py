# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

"""Review alerts by email. frappe.sendmail is replaced throughout, so nothing is ever sent."""

import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import frappe

from pos_next.services import sync_alerts
from pos_next.services.sync_entities import DOCTYPE
from pos_next.tasks import sync as sync_tasks

NOW = datetime(2026, 11, 7, 12, 0)


def _setting(pos_profile="Main", recipients="boss@example.com", last_sent=None):
    return frappe._dict(
        name=pos_profile,
        pos_profile=pos_profile,
        sync_alert_recipients=recipients,
        sync_alert_last_sent_at=last_sent,
    )


def _review(name, pos_profile="Main", processed_at=NOW, error_class="stock", fingerprint="stock-1", message="No stock"):
    return frappe._dict(
        name=name,
        offline_id=f"pos_offline_{name}",
        pos_profile=pos_profile,
        status="Needs Review",
        processed_at=processed_at,
        creation=NOW,
        error_class=error_class,
        error_code="NegativeStockError",
        error_fingerprint=fingerprint,
        error_message=message,
    )


class FakeSite:
    """Holds the rows the job reads, and stands in for the database."""

    def __init__(self, settings, rows):
        self.settings = settings
        self.rows = rows
        self.events = []

    def get_all(self, doctype, filters=None, fields=None, **kwargs):
        if doctype == "POS Settings":
            self.events.append("read settings")
            return [row for row in self.settings if row.sync_alert_recipients]

        rows = [row for row in self.rows if row.pos_profile == filters["pos_profile"] and row.status == filters["status"]]
        if kwargs.get("group_by"):
            return self._groups(rows)
        return sorted(rows, key=lambda row: row.creation)[: kwargs.get("limit")]

    @staticmethod
    def _groups(rows):
        groups = {}
        for row in rows:
            group = groups.setdefault(
                row.error_fingerprint,
                frappe._dict(error_class=row.error_class, error_code=row.error_code, message=row.error_message, count=0),
            )
            group["count"] += 1
            stamps = [stamp for stamp in (group.get("newest"), row.processed_at) if stamp]
            group["newest"] = max(stamps, default=None)
        return sorted(groups.values(), key=lambda group: -group["count"])

    def exists(self, doctype, filters):
        self.events.append(("exists", doctype))
        newer_than = filters.get("processed_at", [None, None])[1]
        return any(
            row.pos_profile == filters["pos_profile"]
            and row.status == filters["status"]
            and (newer_than is None or (row.processed_at and row.processed_at > newer_than))
            for row in self.rows
        )

    def set_value(self, doctype, name, fieldname, value, **kwargs):
        self.events.append(("set_value", doctype, kwargs))
        next(row for row in self.settings if row.name == name)[fieldname] = value

    def commit(self):
        self.events.append("commit")

    def rollback(self):
        self.events.append("rollback")


class AlertCase(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, frappe.local, "db", getattr(frappe.local, "db", None))
        self.site = FakeSite([_setting()], [])
        frappe.local.db = self.site

        self.sendmail = Mock()
        self.log_error = Mock()

        for target, replacement in (
            ("frappe.sendmail", self.sendmail),
            ("frappe.log_error", self.log_error),
            ("frappe.clear_messages", Mock()),
            ("frappe.get_all", self.site.get_all),
            ("pos_next.services.sync_alerts._", lambda text: text),
            ("pos_next.services.sync_alerts.now_datetime", lambda: NOW),
            ("pos_next.services.sync_alerts.format_datetime", str),
            ("pos_next.services.sync_alerts.get_url", lambda uri: f"https://pos.example.com{uri}"),
            (
                "pos_next.services.sync_alerts.get_url_to_form",
                lambda doctype, name: f"https://pos.example.com/desk/{doctype}/{name}",
            ),
        ):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _run(self):
        sync_alerts.email_review_summaries()

    def _mail(self):
        self.assertEqual(self.sendmail.call_count, 1)
        return self.sendmail.call_args.kwargs


class TestWhenItSends(AlertCase):
    def test_no_recipients_means_no_email(self):
        self.site.settings = [_setting(recipients=None), _setting("Other", recipients="")]
        self.site.rows = [_review("row-1")]

        self._run()

        self.sendmail.assert_not_called()

    def test_recipients_that_hold_no_address_mean_no_email(self):
        self.site.settings = [_setting(recipients=" ,\n ")]
        self.site.rows = [_review("row-1")]

        self._run()

        self.sendmail.assert_not_called()

    def test_nothing_to_review_means_no_email(self):
        self._run()
        self.sendmail.assert_not_called()

    def test_a_record_of_another_profile_is_not_this_ones(self):
        self.site.rows = [_review("row-1", pos_profile="Other")]

        self._run()

        self.sendmail.assert_not_called()

    def test_the_first_review_sends(self):
        self.site.rows = [_review("row-1")]
        self._run()
        self.assertEqual(self._mail()["recipients"], ["boss@example.com"])

    def test_it_goes_through_the_mail_queue(self):
        self.site.rows = [_review("row-1")]

        self._run()

        mail = self._mail()
        self.assertTrue(mail["delayed"])
        self.assertFalse(mail.get("now"))

    def test_each_profile_gets_its_own_email(self):
        self.site.settings = [_setting(), _setting("Other", recipients="other@example.com")]
        self.site.rows = [_review("row-1"), _review("row-2", pos_profile="Other")]

        self._run()

        self.assertEqual(
            [call.kwargs["recipients"] for call in self.sendmail.call_args_list],
            [["boss@example.com"], ["other@example.com"]],
        )


class TestNoRepeats(AlertCase):
    def test_the_same_reviews_are_not_mailed_every_hour(self):
        self.site.rows = [_review("row-1")]

        self._run()
        self._run()
        self._run()

        self.assertEqual(self.sendmail.call_count, 1)

    def test_something_new_sends_again(self):
        self.site.rows = [_review("row-1")]
        self._run()

        self.site.rows.append(_review("row-2", processed_at=NOW + timedelta(hours=1)))
        self._run()

        self.assertEqual(self.sendmail.call_count, 2)

    def test_the_time_kept_is_the_newest_record_covered_not_the_clock(self):
        older = NOW - timedelta(hours=2)
        self.site.rows = [_review("row-1", processed_at=older), _review("row-2", fingerprint="b", processed_at=NOW)]

        with patch("pos_next.services.sync_alerts.now_datetime", lambda: NOW + timedelta(minutes=5)):
            self._run()

        self.assertEqual(self.site.settings[0].sync_alert_last_sent_at, NOW)

    def test_a_record_that_failed_during_the_run_still_counts_as_new(self):
        self.site.rows = [_review("row-1", processed_at=NOW)]
        with patch("pos_next.services.sync_alerts.now_datetime", lambda: NOW + timedelta(minutes=5)):
            self._run()

        # Stamped after the record above, and committed too late for that run to see it
        self.site.rows.append(_review("row-2", processed_at=NOW + timedelta(minutes=1)))
        self._run()

        self.assertEqual(self.sendmail.call_count, 2)

    def test_the_summary_still_counts_what_was_mailed_before(self):
        self.site.rows = [_review("row-1")]
        self._run()

        self.site.rows.append(_review("row-2", processed_at=NOW + timedelta(hours=1)))
        self._run()

        self.assertIn("2 record(s)", self.sendmail.call_args.kwargs["subject"])

    def test_a_record_with_no_processed_at_is_mailed_once(self):
        self.site.rows = [_review("row-1", processed_at=None)]

        self._run()
        self._run()

        self.assertEqual(self.sendmail.call_count, 1)

    def test_keeping_the_time_does_not_look_like_a_settings_change(self):
        """Devices pull their settings again when the table's modified moves."""
        self.site.rows = [_review("row-1")]

        self._run()

        update = next(event for event in self.site.events if event[0] == "set_value")
        self.assertEqual(update[1], "POS Settings")
        self.assertIs(update[2]["update_modified"], False)


class TestFailure(AlertCase):
    def test_a_failed_send_does_not_break_the_job(self):
        self.site.rows = [_review("row-1")]
        self.sendmail.side_effect = frappe.OutgoingEmailError("No outgoing account")

        self._run()

        self.log_error.assert_called_once()

    def test_a_failed_send_is_tried_again_next_hour(self):
        self.site.rows = [_review("row-1")]
        self.sendmail.side_effect = frappe.OutgoingEmailError("No outgoing account")
        self._run()
        self.assertIsNone(self.site.settings[0].sync_alert_last_sent_at)

        self.sendmail.side_effect = None
        self._run()

        self.assertEqual(self.sendmail.call_count, 2)

    def test_one_profile_failing_leaves_the_next_one_its_email(self):
        self.site.settings = [_setting(), _setting("Other", recipients="other@example.com")]
        self.site.rows = [_review("row-1"), _review("row-2", pos_profile="Other")]
        self.sendmail.side_effect = [frappe.OutgoingEmailError("Bad"), None]

        self._run()

        self.assertEqual(self.sendmail.call_count, 2)
        self.assertIsNone(self.site.settings[0].sync_alert_last_sent_at)
        self.assertIsNotNone(self.site.settings[1].sync_alert_last_sent_at)

    def test_the_reminders_are_committed_before_anything_can_roll_back(self):
        """The system reminders wait for a commit, and a rollback would drop them."""
        self.site.rows = [_review("row-1")]
        self.sendmail.side_effect = frappe.OutgoingEmailError("Bad")

        self._run()

        events = [event for event in self.site.events if event in ("commit", "rollback")]
        self.assertEqual(events[:2], ["commit", "rollback"])

    def test_the_reason_survives_the_rollback(self):
        self.site.rows = [_review("row-1")]
        self.sendmail.side_effect = frappe.OutgoingEmailError("Bad")

        self._run()

        events = [event for event in self.site.events if event in ("commit", "rollback")]
        self.assertEqual(events[-1], "commit")


class TestContent(AlertCase):
    def test_it_counts_by_error_group(self):
        self.site.rows = [
            _review("row-1"),
            _review("row-2"),
            _review("row-3", error_class="bug", fingerprint="bug-1", message="Boom"),
        ]

        self._run()

        mail = self._mail()
        self.assertIn("3 record(s)", mail["subject"])
        self.assertIn("Stock", mail["message"])
        self.assertIn("<td>2</td>", mail["message"])
        self.assertIn("System Error", mail["message"])
        self.assertIn("<td>1</td>", mail["message"])

    def test_it_names_the_oldest_record(self):
        first = _review("row-1")
        first.creation = NOW - timedelta(days=3)
        self.site.rows = [_review("row-2"), first]

        self._run()

        message = self._mail()["message"]
        self.assertIn(f"https://pos.example.com/desk/{DOCTYPE}/row-1", message)
        self.assertIn("pos_offline_row-1", message)
        self.assertIn(str(first.creation), message)

    def test_it_links_to_the_sync_center_on_the_v16_route(self):
        self.site.rows = [_review("row-1")]
        self._run()
        self.assertIn("https://pos.example.com/desk/pos-sync-center", self._mail()["message"])

    def test_text_that_came_from_a_device_is_escaped(self):
        self.site.rows = [_review("row-1", message="<script>alert(1)</script>")]

        self._run()

        self.assertNotIn("<script>", self._mail()["message"])
        self.assertIn("&lt;script&gt;", self._mail()["message"])

    def test_it_reads_correctly_in_arabic(self):
        self.site.rows = [_review("row-1")]
        self._run()
        self.assertTrue(self._mail()["message"].strip().startswith('<div dir="auto">'))

    def test_an_error_group_with_no_label_still_shows(self):
        self.site.rows = [_review("row-1", error_class=None)]
        self._run()
        self.assertIn("Other", self._mail()["message"])


class TestRecipients(unittest.TestCase):
    def test_commas(self):
        self.assertEqual(sync_alerts.get_recipients("a@example.com, b@example.com"), ["a@example.com", "b@example.com"])

    def test_one_per_line(self):
        self.assertEqual(sync_alerts.get_recipients("a@example.com\nb@example.com"), ["a@example.com", "b@example.com"])

    def test_a_form_line_ending(self):
        self.assertEqual(sync_alerts.get_recipients("a@example.com\r\nb@example.com"), ["a@example.com", "b@example.com"])

    def test_a_bad_address_does_not_cost_the_others_their_alert(self):
        self.assertEqual(
            sync_alerts.get_recipients("a@example.com, nonsense\nb@example.com"),
            ["a@example.com", "b@example.com"],
        )

    def test_nothing(self):
        self.assertEqual(sync_alerts.get_recipients(None), [])


class TestHourlyJob(unittest.TestCase):
    def test_the_job_sends_its_reminders_then_its_emails(self):
        calls = Mock()
        with (
            patch("pos_next.tasks.sync.sync_inbox.remind_about_reviews", calls.remind),
            patch("pos_next.tasks.sync.sync_alerts.email_review_summaries", calls.email),
        ):
            sync_tasks.remind_about_reviews()

        self.assertEqual([call[0] for call in calls.mock_calls], ["remind", "email"])
