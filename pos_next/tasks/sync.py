# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

from pos_next.services import sync_inbox


def sweep_inbox():
    sync_inbox.sweep()


def remind_about_reviews():
    sync_inbox.remind_about_reviews()
