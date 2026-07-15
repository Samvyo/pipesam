import os
import psycopg2
from loguru import logger


def get_connection():
    return psycopg2.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("DB_PORT", "5432")),
        database=os.environ.get("DB_NAME", "samvyo"),
        user=os.environ.get("DB_USER", "samvyo"),
        password=os.environ.get("DB_PASSWORD", "")
    )


def save_action_item(room_id: str,owner: str,task: str,due_date: str | None = None):
    conn = get_connection()

    try:
        cur = conn.cursor()

        cur.execute(
            """
            INSERT INTO action_items
            (room_id, owner, task, due_date)
            VALUES (%s, %s, %s, %s)
            """,
            (
                room_id,
                owner,
                task,
                due_date
            )
        )

        conn.commit()

        logger.info(
            f"✅ Action item saved: {owner} -> {task}"
        )

    finally:
        conn.close()


async def save_action_items(room_id, items, signalling):

    await signalling.send_action_items(items)

    logger.info(
        f"Saving {len(items)} action items"
    )

    for item in items:
        save_action_item(
            room_id=room_id,
            owner=item.get("owner", "Unknown"),
            task=item.get("task", ""),
            due_date=item.get("due_date")
        )
def get_action_items(room_id: str):  
    conn = get_connection()

    try:
        cur = conn.cursor()

        cur.execute("""
            SELECT owner, task, due_date
            FROM action_items
            WHERE room_id = %s
            ORDER BY created_at
        """, (room_id,))  

        rows = cur.fetchall()

        return [
            {
                "owner": row[0],
                "task": row[1],
                "due_date": str(row[2]) if row[2] else None
            }
            for row in rows
        ]

    finally:
        conn.close()