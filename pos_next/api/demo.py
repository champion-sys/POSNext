# -*- coding: utf-8 -*-
# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt
# bench --site dev-pos.sanad.digital execute pos_next.api.demo.generate_demo_data

import frappe

@frappe.whitelist()
def generate_demo_data():
	"""
	Generates demo data for POS:
	- 30 Item Groups
	- 121 Items (Products) assigned to these groups
	- Selling and Buying Item Prices for each item
	"""
	groups_and_items = {
		"Beverages": ["Cola", "Orange Juice", "Mineral Water", "Green Tea", "Ground Coffee"],
		"Snacks": ["Potato Chips", "Chocolate Bar", "Salted Peanuts", "Gummy Bears", "Popcorn"],
		"Bakery": ["Sliced Bread", "Chocolate Croissant", "Blueberry Muffin", "Bagels"],
		"Dairy": ["Whole Milk", "Cheddar Cheese", "Greek Yogurt", "Butter", "Whipping Cream"],
		"Produce": ["Red Apples", "Bananas", "Fresh Spinach", "Tomatoes", "Carrots"],
		"Meat": ["Chicken Breast", "Ground Beef", "Pork Chops", "Lamb Shanks"],
		"Seafood": ["Salmon Fillet", "Frozen Shrimp", "Canned Tuna"],
		"Frozen Foods": ["Frozen Pizza", "Ice Cream Vanilla", "Frozen Waffles", "Veggie Burger Patties"],
		"Pantry": ["Olive Oil", "Apple Cider Vinegar", "Honey", "Maple Syrup"],
		"Canned Goods": ["Canned Corn", "Tomato Paste", "Canned Black Beans"],
		"Spices & Seasonings": ["Black Pepper", "Sea Salt", "Garlic Powder", "Paprika"],
		"Condiments": ["Ketchup", "Mayonnaise", "Mustard", "Soy Sauce"],
		"Sauces": ["Marinara Sauce", "BBQ Sauce", "Alfredo Sauce"],
		"Grains & Rice": ["Basmati Rice", "Quinoa", "Brown Rice"],
		"Pasta": ["Spaghetti", "Penne Pasta", "Macaroni"],
		"Breakfast & Cereal": ["Corn Flakes", "Oatmeal", "Granola Bars"],
		"Baking Supplies": ["All-Purpose Flour", "White Sugar", "Baking Powder", "Chocolate Chips"],
		"Sweets & Candy": ["Lollipop", "Marshmallows", "Chewing Gum"],
		"Health & Beauty": ["Shampoo", "Conditioner", "Toothpaste", "Toothbrush", "Soap Bar"],
		"Baby Care": ["Baby Wipes", "Baby Powder", "Baby Lotion"],
		"Pet Supplies": ["Dog Food", "Cat Food", "Bird Seed"],
		"Household Supplies": ["Dish Soap", "Laundry Detergent", "Trash Bags", "Multi-purpose Cleaner"],
		"Paper Goods": ["Paper Towels", "Toilet Paper", "Facial Tissues", "Paper Plates"],
		"Personal Care": ["Deodorant", "Hand Sanitizer", "Cotton Swabs"],
		"Medicine & First Aid": ["Band-Aids", "Pain Relievers", "Antiseptic Cream"],
		"Office Supplies": ["Notebook", "Ballpoint Pens", "Sticky Notes", "Paperclips"],
		"Electronics": ["USB Cable", "AA Batteries", "Earbuds"],
		"Toys & Games": ["Playing Cards", "Puzzle", "Toy Car"],
		"Apparel": ["Socks", "Cotton T-Shirt", "Baseball Cap"],
		"Home & Kitchen": ["Coffee Mug", "Glass Bowl", "Kitchen Towel", "Sponge Set"]
	}

	# Ensure parent "All Item Groups" exists (fallback)
	parent_group = "All Item Groups"
	if not frappe.db.exists("Item Group", parent_group):
		ig = frappe.get_doc({
			"doctype": "Item Group",
			"item_group_name": parent_group,
			"is_group": 1
		})
		ig.insert(ignore_permissions=True)

	created_groups = 0
	created_items = 0
	created_prices = 0

	currency = frappe.db.get_default("currency") or "YER"

	idx = 1
	for group_name, items in groups_and_items.items():
		# Create Item Group if not exists
		if not frappe.db.exists("Item Group", group_name):
			ig = frappe.get_doc({
				"doctype": "Item Group",
				"item_group_name": group_name,
				"parent_item_group": parent_group,
				"is_group": 0
			})
			ig.insert(ignore_permissions=True)
			created_groups += 1

		for item_name in items:
			item_code = f"DEMO-{idx:03d}"

			# Create Item if not exists
			if not frappe.db.exists("Item", item_code):
				item = frappe.get_doc({
					"doctype": "Item",
					"item_code": item_code,
					"item_name": item_name,
					"item_group": group_name,
					"stock_uom": "Nos",
					"is_stock_item": 1,
					"custom_company": ""  # Global item
				})
				item.insert(ignore_permissions=True)
				created_items += 1

			# Generate deterministic but varied price rate
			rate = 100.0 + float((idx * 37) % 2000)

			# Create Standard Selling Price
			if not frappe.db.exists("Item Price", {"item_code": item_code, "price_list": "Standard Selling"}):
				selling_price = frappe.get_doc({
					"doctype": "Item Price",
					"item_code": item_code,
					"price_list": "Standard Selling",
					"price_list_rate": rate,
					"currency": currency,
					"selling": 1,
					"buying": 0
				})
				selling_price.insert(ignore_permissions=True)
				created_prices += 1

			# Create Standard Buying Price
			if not frappe.db.exists("Item Price", {"item_code": item_code, "price_list": "Standard Buying"}):
				buying_price = frappe.get_doc({
					"doctype": "Item Price",
					"item_code": item_code,
					"price_list": "Standard Buying",
					"price_list_rate": round(rate * 0.6, 2),
					"currency": currency,
					"selling": 0,
					"buying": 1
				})
				buying_price.insert(ignore_permissions=True)
				created_prices += 1

			idx += 1

	frappe.db.commit()

	result = {
		"message": "Demo data generation completed",
		"created_item_groups": created_groups,
		"created_items": created_items,
		"created_item_prices": created_prices,
		"total_groups_in_db": frappe.db.count("Item Group"),
		"total_items_in_db": frappe.db.count("Item"),
		"total_item_prices_in_db": frappe.db.count("Item Price")
	}
	return result
