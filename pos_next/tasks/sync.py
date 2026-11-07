# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

from pos_next.services import closing_alerts, sync_alerts, sync_inbox, sync_retention


def sweep_inbox():
    sync_inbox.sweep()


def remind_about_reviews():
    sync_inbox.remind_about_reviews()
    sync_alerts.email_review_summaries()
    closing_alerts.remind_about_closings()


def clear_old_payloads():
    sync_retention.clear_old_payloads()
