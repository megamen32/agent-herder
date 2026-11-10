import sqlite3

def setup(n):
 c=sqlite3.connect(':memory:')
 c.executescript("CREATE TABLE session_search_state(session_ref TEXT PRIMARY KEY NOT NULL, snapshot_id TEXT NOT NULL, content_truncated INTEGER NOT NULL CHECK(content_truncated IN (0,1))) STRICT; CREATE VIRTUAL TABLE session_search_fts USING fts5(session_ref UNINDEXED,content,tokenize='unicode61');")
 c.executemany('INSERT INTO session_search_state VALUES(?,?,0)',((f's{i}',f'v{i}') for i in range(n)))
 c.execute('INSERT INTO session_search_fts(rowid,session_ref,content) SELECT rowid,session_ref,\'needle\' FROM session_search_state')
 c.commit(); return c

def steps(c, query, args):
 ticks=[0]
 def tick(): ticks[0]+=1; return 0
 c.set_progress_handler(tick,1)
 try: list(c.execute(query,args))
 finally: c.set_progress_handler(None,0)
 return ticks[0]

lookup='SELECT rowid,snapshot_id,content_truncated FROM session_search_state WHERE session_ref=?'
doc='SELECT session_ref FROM session_search_fts WHERE rowid=?'
for n in (100,10000):
 c=setup(n)
 rowid=c.execute(lookup,('s50',)).fetchone()[0]
 print('n=',n,'state present/missing steps=',steps(c,lookup,('s50',)),steps(c,lookup,('missing',)),'FTS rowid present/missing steps=',steps(c,doc,(rowid,)),steps(c,doc,(-1,)))
 print('plans:',list(c.execute('EXPLAIN QUERY PLAN '+lookup,('s50',))),list(c.execute('EXPLAIN QUERY PLAN '+doc,(rowid,))),list(c.execute('EXPLAIN QUERY PLAN DELETE FROM session_search_fts WHERE rowid=?',(rowid,))))
 c.execute("INSERT INTO session_search_state(session_ref,snapshot_id,content_truncated) VALUES('s50','updated',0) ON CONFLICT(session_ref) DO UPDATE SET snapshot_id=excluded.snapshot_id,content_truncated=excluded.content_truncated")
 assert c.execute(lookup,('s50',)).fetchone()[0]==rowid
 c.execute('DELETE FROM session_search_fts WHERE rowid=?',(rowid,)); c.execute('INSERT INTO session_search_fts(rowid,session_ref,content) VALUES(?,?,?)',(rowid,'s50','new words')); c.commit()
 assert c.execute(doc,(rowid,)).fetchone()==('s50',)
 assert c.execute("SELECT COUNT(*) FROM session_search_fts WHERE session_search_fts MATCH 'needle'").fetchone()[0]==n-1
 c.close()
# A legacy v4 database permits different rowids, absent and duplicate documents;
# a blind change to rowid lookup would miss existing content.
c=sqlite3.connect(':memory:')
c.executescript("CREATE TABLE session_search_state(session_ref TEXT PRIMARY KEY, snapshot_id TEXT, content_truncated INTEGER); CREATE VIRTUAL TABLE session_search_fts USING fts5(session_ref UNINDEXED,content); INSERT INTO session_search_state(rowid,session_ref,snapshot_id,content_truncated) VALUES(7,'a','v1',0); INSERT INTO session_search_fts(rowid,session_ref,content) VALUES(23,'a','old');")
print('legacy mismatch state/fts:',c.execute('SELECT rowid FROM session_search_state').fetchone(),c.execute('SELECT rowid FROM session_search_fts').fetchone())
assert c.execute('SELECT session_ref FROM session_search_fts WHERE rowid=7').fetchone() is None
