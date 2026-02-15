from sqlalchemy import create_engine, event
from sqlalchemy.orm import scoped_session, sessionmaker, declarative_base
from config import DATABASE_URL, ENGINE_OPTIONS, IS_SQLITE

if IS_SQLITE:
    engine = create_engine(DATABASE_URL, connect_args={'check_same_thread': False})
else:
    engine = create_engine(DATABASE_URL, **ENGINE_OPTIONS)

# Enable WAL mode + foreign keys for SQLite (better concurrency)
if IS_SQLITE:
    @event.listens_for(engine, 'connect')
    def _set_sqlite_pragma(dbapi_conn, connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute('PRAGMA journal_mode=WAL')
        cursor.execute('PRAGMA foreign_keys=ON')
        cursor.close()

SessionLocal = scoped_session(sessionmaker(bind=engine))
Base = declarative_base()
Base.query = SessionLocal.query_property()
