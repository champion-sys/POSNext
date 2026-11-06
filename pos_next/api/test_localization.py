# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

import os
import unittest
from unittest.mock import patch

import frappe

from pos_next.api import localization

SITE_WIDE = {"Pay": "صرف", "Back": "خلف", "Status": "الحالة"}
POS_SCREENS = {"Pay": "دفع", "Back": "رجوع"}


class TestAppTranslations(unittest.TestCase):
    def setUp(self):
        frappe.local.lang = "ar"
        self.addCleanup(lambda: setattr(frappe.local, "lang", "en"))

    def translations(self):
        with (
            patch("frappe.translate.get_all_translations", return_value=SITE_WIDE),
            patch("frappe.translate.get_translation_dict_from_file", return_value=POS_SCREENS),
            patch("frappe.get_app_path", side_effect=lambda *parts: os.path.join(*parts)),
        ):
            return localization.get_app_translations()

    def test_pos_wording_wins_on_pos_screens(self):
        self.assertEqual(self.translations()["Pay"], "دفع")

    def test_other_strings_keep_the_site_translation(self):
        self.assertEqual(self.translations()["Status"], "الحالة")

    def test_the_dictionary_of_the_site_stays_as_it_was(self):
        self.translations()

        self.assertEqual(SITE_WIDE["Pay"], "صرف")

    def test_a_regional_language_uses_its_base_language_file(self):
        frappe.local.lang = "ar-SA"

        with patch("frappe.translate.get_translation_dict_from_file", return_value={}) as read, patch(
            "frappe.get_app_path", side_effect=lambda *parts: os.path.join(*parts)
        ):
            localization._get_pos_screen_translations("ar-SA")

        self.assertTrue(read.call_args.args[0].endswith(os.path.join("pos_screens", "ar.csv")))
