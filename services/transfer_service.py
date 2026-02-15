"""Transfer data from local SQLite to a remote MySQL database with resume support."""
import threading
import logging
from datetime import datetime

from sqlalchemy import create_engine, text, inspect
from sqlalchemy.orm import scoped_session, sessionmaker

import eel

logger = logging.getLogger(__name__)

# Tables to transfer in dependency order (transfer_progress is local-only, never transferred)
TRANSFER_TABLES = [
    'telegram_accounts',
    'telegram_sessions_db',
    'telegram_chats',
    'telegram_messages',
    'telegram_media_folders',
    'telegram_media_files',
    'telegram_media_folder_accounts',
    'telegram_profiles',
    'telegram_profile_accounts',
    'ai_configs',
    'ai_auto_reply_accounts',
    'blacklist_entries',
]

BATCH_SIZE = 200

# Module-level state
_transfer_thread = None
_cancel_flag = threading.Event()


def test_connection(target_url):
    """Test connectivity to a remote database. Returns {success, error?, tables?}."""
    try:
        target_url = _fix_mysql_url(target_url)
        engine = create_engine(target_url, pool_pre_ping=True)
        with engine.connect() as conn:
            conn.execute(text('SELECT 1'))
        inspector = inspect(engine)
        tables = inspector.get_table_names()
        engine.dispose()
        return {'success': True, 'tables': tables}
    except Exception as e:
        return {'success': False, 'error': str(e)}


def start_transfer(target_url):
    """Launch the transfer in a background thread. Returns immediately."""
    global _transfer_thread
    if _transfer_thread and _transfer_thread.is_alive():
        return {'success': False, 'error': 'Transfer already running'}

    _cancel_flag.clear()
    target_url = _fix_mysql_url(target_url)
    _transfer_thread = threading.Thread(
        target=_transfer_worker, args=(target_url,), daemon=True, name='db-transfer'
    )
    _transfer_thread.start()
    return {'success': True}


def cancel_transfer():
    """Signal the background thread to stop."""
    _cancel_flag.set()
    return {'success': True}


def get_status():
    """Return current transfer progress for all tables."""
    from database import SessionLocal
    from models import TransferProgress

    try:
        rows = TransferProgress.query.all()
        tables = []
        total_all = 0
        transferred_all = 0
        for r in rows:
            pct = round(r.transferred_rows / r.total_rows * 100, 1) if r.total_rows > 0 else 0
            tables.append({
                'table_name': r.table_name,
                'total_rows': r.total_rows,
                'transferred_rows': r.transferred_rows,
                'percent': pct,
                'status': r.status,
            })
            total_all += r.total_rows
            transferred_all += r.transferred_rows

        overall_pct = round(transferred_all / total_all * 100, 1) if total_all > 0 else 0
        running = _transfer_thread is not None and _transfer_thread.is_alive()

        return {
            'tables': tables,
            'total_rows': total_all,
            'transferred_rows': transferred_all,
            'overall_percent': overall_pct,
            'running': running,
        }
    finally:
        SessionLocal.remove()


# ==================== INTERNAL ====================

def _fix_mysql_url(url):
    """Normalise mysql:// to mysql+pymysql://."""
    if not url:
        return url
    if url.startswith('mysql://'):
        url = 'mysql+pymysql://' + url[len('mysql://'):]
    return url


def _push_progress(table_name, transferred, total, overall_transferred, overall_total):
    """Push a progress update to the Eel UI (non-blocking)."""
    pct = round(transferred / total * 100, 1) if total > 0 else 0
    overall_pct = round(overall_transferred / overall_total * 100, 1) if overall_total > 0 else 0
    try:
        eel.on_transfer_progress({
            'table': table_name,
            'transferred': transferred,
            'total': total,
            'percent': pct,
            'overall_transferred': overall_transferred,
            'overall_total': overall_total,
            'overall_percent': overall_pct,
        })
    except Exception:
        pass


def _transfer_worker(target_url):
    """Background thread: transfer all tables from local SQLite to remote MySQL."""
    from database import SessionLocal, engine as src_engine, Base
    from models import TransferProgress

    logger.info(f"Transfer started → {target_url.split('@')[-1] if '@' in target_url else target_url}")

    try:
        # Connect to target
        dst_engine = create_engine(target_url, pool_pre_ping=True, pool_size=2, max_overflow=0)
        DstSession = scoped_session(sessionmaker(bind=dst_engine))

        # Create all tables on target if they don't exist
        Base.metadata.create_all(dst_engine)
        logger.info("Target tables created/verified")

        # Count rows in each source table and init progress entries
        src_inspector = inspect(src_engine)
        src_tables = src_inspector.get_table_names()
        tables_to_transfer = [t for t in TRANSFER_TABLES if t in src_tables]

        row_counts = {}
        for tbl in tables_to_transfer:
            count = SessionLocal.execute(text(f'SELECT COUNT(*) FROM "{tbl}"')).scalar()
            row_counts[tbl] = count
        SessionLocal.remove()

        overall_total = sum(row_counts.values())
        overall_transferred = 0

        # Init/update progress rows
        for tbl in tables_to_transfer:
            try:
                prog = TransferProgress.query.filter_by(table_name=tbl).first()
                if not prog:
                    prog = TransferProgress(
                        table_name=tbl,
                        total_rows=row_counts[tbl],
                        transferred_rows=0,
                        last_transferred_id=0,
                        status='pending',
                        target_url=target_url,
                        started_at=datetime.utcnow(),
                    )
                    SessionLocal.add(prog)
                else:
                    prog.total_rows = row_counts[tbl]
                    prog.target_url = target_url
                    if prog.status == 'completed':
                        overall_transferred += prog.transferred_rows
                SessionLocal.commit()
            finally:
                SessionLocal.remove()

        # Transfer each table
        for tbl in tables_to_transfer:
            if _cancel_flag.is_set():
                logger.info("Transfer cancelled by user")
                break

            try:
                prog = TransferProgress.query.filter_by(table_name=tbl).first()
            finally:
                SessionLocal.remove()

            if prog and prog.status == 'completed':
                _push_progress(tbl, prog.transferred_rows, prog.total_rows,
                               overall_transferred, overall_total)
                continue

            transferred = _transfer_table(tbl, row_counts[tbl],
                                          src_engine, DstSession,
                                          overall_transferred, overall_total)
            overall_transferred += transferred

        # Final push
        _push_progress('', overall_transferred, overall_total,
                        overall_transferred, overall_total)

        dst_engine.dispose()

        if _cancel_flag.is_set():
            logger.info("Transfer paused — can be resumed")
        else:
            logger.info("Transfer completed successfully")

    except Exception as e:
        logger.error(f"Transfer worker error: {e}")
        try:
            eel.on_transfer_progress({
                'error': str(e),
                'overall_percent': -1,
            })
        except Exception:
            pass


def _transfer_table(table_name, total_rows, src_engine, DstSession,
                    overall_transferred, overall_total):
    """Transfer a single table in batches with resume support. Returns rows transferred."""
    from database import SessionLocal
    from models import TransferProgress

    # Get resume point
    try:
        prog = TransferProgress.query.filter_by(table_name=table_name).first()
        last_id = prog.last_transferred_id if prog else 0
        already_done = prog.transferred_rows if prog else 0
    finally:
        SessionLocal.remove()

    # Mark in-progress
    try:
        prog = TransferProgress.query.filter_by(table_name=table_name).first()
        if prog:
            prog.status = 'in_progress'
            SessionLocal.commit()
    finally:
        SessionLocal.remove()

    transferred = already_done
    current_last_id = last_id

    # Get column names
    inspector = inspect(src_engine)
    columns = [c['name'] for c in inspector.get_columns(table_name)]
    has_id = 'id' in columns
    col_list = ', '.join(f'"{c}"' for c in columns)

    try:
        while not _cancel_flag.is_set():
            # Fetch batch from source
            if has_id:
                query = text(
                    f'SELECT {col_list} FROM "{table_name}" '
                    f'WHERE id > :last_id ORDER BY id LIMIT :batch_size'
                )
                rows = SessionLocal.execute(query, {
                    'last_id': current_last_id,
                    'batch_size': BATCH_SIZE,
                }).fetchall()
            else:
                query = text(
                    f'SELECT {col_list} FROM "{table_name}" '
                    f'LIMIT :batch_size OFFSET :offset'
                )
                rows = SessionLocal.execute(query, {
                    'batch_size': BATCH_SIZE,
                    'offset': transferred,
                }).fetchall()
            SessionLocal.remove()

            if not rows:
                break

            # Insert batch into target
            placeholders = ', '.join(f':{c}' for c in columns)
            insert_sql = text(
                f'INSERT INTO `{table_name}` ({", ".join(f"`{c}`" for c in columns)}) '
                f'VALUES ({placeholders})'
            )

            for row in rows:
                row_dict = dict(zip(columns, row))
                try:
                    DstSession.execute(insert_sql, row_dict)
                except Exception:
                    pass  # Skip duplicates (already transferred rows)

            DstSession.commit()
            DstSession.remove()

            # Update progress
            batch_count = len(rows)
            transferred += batch_count
            if has_id:
                id_idx = columns.index('id')
                current_last_id = rows[-1][id_idx]

            try:
                prog = TransferProgress.query.filter_by(table_name=table_name).first()
                if prog:
                    prog.transferred_rows = transferred
                    prog.last_transferred_id = current_last_id
                    prog.updated_at = datetime.utcnow()
                    SessionLocal.commit()
            finally:
                SessionLocal.remove()

            _push_progress(table_name, transferred, total_rows,
                           overall_transferred + transferred - already_done, overall_total)

        # Mark completed or paused
        final_status = 'completed' if not _cancel_flag.is_set() else 'in_progress'
        try:
            prog = TransferProgress.query.filter_by(table_name=table_name).first()
            if prog:
                prog.status = final_status
                prog.updated_at = datetime.utcnow()
                SessionLocal.commit()
        finally:
            SessionLocal.remove()

        if final_status == 'completed':
            logger.info(f"Transferred {table_name}: {transferred} rows")

        return transferred - already_done

    except Exception as e:
        logger.error(f"Transfer error on {table_name}: {e}")
        try:
            prog = TransferProgress.query.filter_by(table_name=table_name).first()
            if prog:
                prog.status = 'failed'
                SessionLocal.commit()
        finally:
            SessionLocal.remove()
        return transferred - already_done
