"""These tests deliberately fail before the authentication repair is merged."""
import unittest
from app import list_orders


class OrderSecurity(unittest.TestCase):
    def test_anonymous_is_denied(self):
        status, body = list_orders({})
        self.assertEqual(status, 401)
        self.assertNotIn("orders", body)

    def test_invalid_token_is_denied(self):
        self.assertEqual(list_orders({"Authorization": "Bearer invalid"})[0], 401)

    def test_alice_cannot_read_bobs_orders(self):
        status, body = list_orders({"Authorization": "Bearer synthetic-alice-token"})
        self.assertEqual(status, 200)
        self.assertTrue(body["orders"])
        self.assertTrue(all(row["customer_id"] == "CUST-10001" for row in body["orders"]))

    def test_bob_cannot_read_alices_orders(self):
        status, body = list_orders({"Authorization": "Bearer synthetic-bob-token"})
        self.assertEqual(status, 200)
        self.assertTrue(body["orders"])
        self.assertTrue(all(row["customer_id"] == "CUST-10002" for row in body["orders"]))

    def test_support_listing_still_works(self):
        status, body = list_orders({"Authorization": "Bearer synthetic-support-token"})
        self.assertEqual(status, 200)
        self.assertEqual(len(body["orders"]), 3)

    def test_query_parameters_cannot_supply_identity(self):
        self.assertEqual(list_orders({"customer_id": "CUST-10001"})[0], 401)


if __name__ == "__main__":
    unittest.main()
