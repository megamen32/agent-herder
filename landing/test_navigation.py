"""Small offline regression tests for public-only product navigation."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit
import re
import unittest

ROOT = Path(__file__).resolve().parent

class Links(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.items = []
        self.feed(html)
    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.items.append(dict(attrs))

class PublicNavigationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / 'index.html').read_text()
        cls.links = Links(cls.html).items
    def test_only_public_external_destinations(self):
        allowed = {'github.com', 'bezrabotnyi.com', 'agentherder.bezrabotnyi.com',
                   'shtatno.bezrabotnyi.com', 'notify.bezrabotnyi.com',
                   'became.bezrabotnyi.com', 'msg.bezrabotnyi.com', 'airlockrun.ru',
                   'notice.bezrabotnyi.com'}
        for link in self.links:
            host = urlsplit(link.get('href', '')).hostname
            if host:
                self.assertIn(host, allowed)
    def test_operator_console_button_points_to_notice_place(self):
        console = [a for a in self.links if 'header-console' in a.get('class', '').split()]
        self.assertEqual(len(console), 1)
        button = console[0]
        self.assertEqual(button['href'], 'https://notice.bezrabotnyi.com/admin/')
        self.assertEqual(button.get('target'), '_blank')
        self.assertIn('noopener', button.get('rel', ''))
        self.assertIn('Кабинет', button.get('aria-label', ''))

    def test_hero_and_closing_start_self_hosted_install(self):
        primary = [a for a in self.links if 'primary' in a.get('class', '').split()]
        self.assertEqual(len(primary), 2)
        self.assertTrue(all(a['href'] == '#start' for a in primary))
    def test_source_and_documentation_preserved(self):
        urls = {a.get('href') for a in self.links}
        self.assertIn('https://github.com/megamen32/agent-herder', urls)
        self.assertIn('https://github.com/megamen32/agent-herder/blob/main/README.ru.md', urls)
    def test_ecosystem_destinations(self):
        urls = {a.get('href') for a in self.links}
        for host in ['shtatno', 'notify', 'became', 'msg']:
            self.assertIn('https://' + host + '.bezrabotnyi.com/', urls)
    def test_airlock_is_partner_at_official_site(self):
        partner = re.search(r'<span class="partner-project">(.*?)</span>', self.html)
        self.assertIsNotNone(partner)
        self.assertIn('Партнёрская интеграция:', partner.group(1))
        self.assertIn('href="https://airlockrun.ru/"', partner.group(1))
    def test_mobile_ecosystem_navigation_is_not_hidden(self):
        css = (ROOT / 'styles.css').read_text()
        self.assertIn('.related-projects{display:flex;', css)
        self.assertIn('class="related-projects wrap"', self.html)

if __name__ == '__main__':
    unittest.main()
