"""Read every transcript page from the normal Herder HTTP route."""
import json
import urllib.parse
import urllib.request

from transcript_proof import fetch_transcript


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_transcript(base, host, harness, session_id, user_input, assistant_output):
    url = urllib.parse.urlsplit(base)
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port
            or url.path not in ('', '/') or url.username or url.password or url.query or url.fragment):
        raise ValueError('Herder endpoint must be an explicit loopback HTTP origin')
    origin = f'http://127.0.0.1:{url.port}'
    if not all(isinstance(s, str) and s and '/' not in s for s in (harness, session_id)):
        raise ValueError('exact harness and session ID required')
    path = '/api/sessions/' + urllib.parse.quote(harness, safe='') + '/' + urllib.parse.quote(session_id, safe='') + '/transcript'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def read_page(cursor):
        query = {'limit': '1'}
        if cursor is not None:
            query['cursor'] = cursor
        request = urllib.request.Request(origin + path + '?' + urllib.parse.urlencode(query), headers={'Origin': origin})
        with opener.open(request, timeout=10) as response:
            body = response.read(4_000_001)
        if len(body) > 4_000_000:
            raise ValueError('transcript page too large')
        data = json.loads(body)
        if not isinstance(data, dict) or not isinstance(data.get('transcript'), dict):
            raise ValueError('Herder response has no transcript')
        return data['transcript']
    return fetch_transcript(read_page, host, harness, session_id, user_input, assistant_output)
