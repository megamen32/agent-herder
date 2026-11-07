"""Fail-closed validation of pages independently read through Herder's transcript API."""


def fetch_transcript(read_page, host, harness, session_id, user_input, assistant_output, max_pages=500):
    if type(max_pages) is not int or max_pages < 2:
        raise ValueError('max_pages must permit at least two pages')
    reads = []
    cursor = None
    seen = set()
    for _ in range(max_pages):
        page = read_page(cursor)
        if not isinstance(page, dict):
            raise ValueError('transcript page missing')
        reads.append({'requestedCursor': cursor, 'page': page})
        cursor = page.get('nextCursor')
        if cursor is None:
            return validate_transcript(reads, host, harness, session_id, user_input, assistant_output)
        if not isinstance(cursor, str) or not cursor or cursor in seen:
            raise ValueError('invalid or repeated continuation cursor')
        seen.add(cursor)
    raise ValueError('transcript page limit exceeded')


def validate_transcript(reads, host, harness, session_id, user_input, assistant_output):
    if not isinstance(reads, list) or len(reads) < 2:
        raise ValueError('multiple transcript pages required')
    if not all(isinstance(value, str) and value for value in (host, harness, session_id, user_input, assistant_output)):
        raise ValueError('exact expected scope and messages required')
    cursor = None
    seen_cursors = set()
    event_ids = set()
    events = []
    total = None
    for i, read in enumerate(reads):
        if not isinstance(read, dict) or 'requestedCursor' not in read or read['requestedCursor'] != cursor:
            raise ValueError('transcript cursor chain mismatch')
        page = read.get('page')
        if not isinstance(page, dict):
            raise ValueError('transcript page missing')
        scope = page.get('scope')
        if not isinstance(scope, dict) or any(scope.get(k) != v for k, v in (
            ('hostId', host), ('harness', harness), ('nativeSessionId', session_id))):
            raise ValueError('transcript scope mismatch')
        count = page.get('totalEvents')
        if type(count) is not int or count < 1 or (total is not None and count != total):
            raise ValueError('invalid or changing transcript total')
        total = count
        batch = page.get('events')
        if not isinstance(batch, list) or not batch:
            raise ValueError('empty or missing transcript page')
        for event in batch:
            if not isinstance(event, dict) or type(event.get('sequence')) is not int or event['sequence'] != len(events):
                raise ValueError('transcript sequence gap or overlap')
            identity = event.get('eventId')
            if not isinstance(identity, str) or not identity or identity in event_ids:
                raise ValueError('missing or duplicate transcript event identity')
            event_ids.add(identity)
            events.append(event)
        cursor = page.get('nextCursor')
        last = i == len(reads) - 1
        if last:
            if cursor is not None or page.get('complete') is not True:
                raise ValueError('transcript did not finish')
        elif not isinstance(cursor, str) or not cursor or cursor in seen_cursors or page.get('complete') is not False:
            raise ValueError('missing or repeated continuation cursor')
        else:
            seen_cursors.add(cursor)
    if len(events) != total:
        raise ValueError('transcript event count mismatch')
    found_user = False
    for event in events:
        author = event.get('author')
        if event.get('kind') != 'message' or not isinstance(author, dict):
            continue
        text = event.get('text')
        if not isinstance(text, str):
            continue
        if author.get('sourceRole') == 'user' and user_input in text:
            found_user = True
        elif found_user and author.get('kind') == 'assistant' and assistant_output in text:
            return len(reads)
    raise ValueError('exact input followed by fixture answer missing')
