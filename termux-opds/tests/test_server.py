import unittest
import xml.etree.ElementTree as ET

import server


ATOM = "{http://www.w3.org/2005/Atom}"


class OpdsTests(unittest.TestCase):
    def setUp(self):
        server.BOOK_CACHE.clear()

    def test_search_entry_is_valid_atom_xml(self):
        book = {
            "id": "12345:ab12cd",
            "name": "A & B",
            "authors": ["Author One", "Author Two"],
            "extension": "epub",
            "description": "A short description",
            "cover": "https://covers.example.test/cover.jpg",
        }
        entry = server.make_entry(book, "http://127.0.0.1:8765")
        xml = server.feed("Search", "http://127.0.0.1:8765/opds/search?q=test", [entry])
        root = ET.fromstring(xml)
        item = root.find(ATOM + "entry")
        self.assertIsNotNone(item)
        self.assertEqual(item.findtext(ATOM + "title"), "A & B")
        links = item.findall(ATOM + "link")
        self.assertTrue(any(link.attrib.get("rel") == "http://opds-spec.org/acquisition"
                            and link.attrib.get("type") == "application/epub+zip"
                            for link in links))
        self.assertTrue(any(link.attrib.get("rel") == "http://opds-spec.org/image"
                            for link in links))

    def test_invalid_book_reference_is_not_emitted(self):
        self.assertEqual(server.make_entry({"id": "../bad", "name": "bad"},
                                           "http://127.0.0.1:8765"), "")

    def test_format_mime_types(self):
        self.assertEqual(server.media_type({"extension": "pdf"}), "application/pdf")
        self.assertEqual(server.media_type({"extension": "epub"}), "application/epub+zip")

    def test_authors_can_be_list_or_string(self):
        self.assertEqual(server.author_text({"authors": ["A", "B"]}), "A, B")
        self.assertEqual(server.author_text({"authors": "A, B"}), "A, B")


if __name__ == "__main__":
    unittest.main()
