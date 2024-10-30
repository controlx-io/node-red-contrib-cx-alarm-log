import sqlite3 from 'better-sqlite3';
import { AlarmType, EventType, IEventRecord, ITriggerConfig } from "./tools";

export interface IEventSqlRecord {
    id: number;
    eventId: string;
    ts: number;
    eqName: string;
    tagName: string;
    type: EventType | AlarmType;
    isActive: number;
    triggerCond: string;
    description: string;
    duration: number; // duration, unit: second
}

export default class SqliteHelper {
    private db: sqlite3.Database;

    constructor(dbPath: string, private tableSuffix: string) {
        this.db = new sqlite3(dbPath);
        this.createTable(this.tableSuffix); // Create the table when the class is instantiated
    }

    getTableName() {
        return `events_${this.tableSuffix}`;
    }

    createTable(tableSuffix: string) {
        const sql = `
            CREATE TABLE IF NOT EXISTS ${this.getTableName()}
            (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                eventId     TEXT,
                ts          INTEGER,
                eqName      TEXT,
                tagName     TEXT,
                type        TEXT,
                isActive    INTEGER,
                triggerCond TEXT,
                description TEXT,
                duration    INTEGER
            );
        `;
        this.exec(sql);
    }

    exec(sql: string) {
        return this.db.exec(sql);
    }

    prepare(sql: string) {
        return this.db.prepare(sql);
    }

    close() {
        this.db.close();
    }

    /**
     * Inserts a new event record into the events table.
     * @param event - The event data to insert.
     */
    insertEvent(event: IEventRecord) {
        const stmt = this.prepare(`
            INSERT INTO ${this.getTableName()} (eventId, ts, eqName, tagName, type, isActive, triggerCond, description)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        return stmt.run(
            event.eventId,
            event.ts,
            event.eqName,
            event.tagName,
            event.type,
            event.isActive ? 1 : 0,
            JSON.stringify(event.triggerCond),
            event.description
        );
    }

    /**
     * Updates an event record if it is inactive.
     * @param eventId - The ID of the event to update.
     */
    deactivateEvent(eventRecord: IEventRecord) {
        const checkStmt = this.prepare(`SELECT *
                                        FROM ${this.getTableName()}
                                        WHERE eventId = ?
                                        order by id desc
                                        limit 1`);
        const result = checkStmt.get(eventRecord.eventId) as IEventSqlRecord;
        if (!result) {
            return null;
        }

        const updateStmt = this.prepare(`UPDATE ${this.getTableName()}
                                         SET isActive = ?,
                                             duration = ?
                                         WHERE id = ?`);
        return updateStmt.run(eventRecord.isActive ? 1 : 0, Math.round((Date.now() - result.ts) / 1000), result.id);
    }

    /**
     * Fetches a single event by its ID.
     * @param eventId - The ID of the event to fetch.
     * @returns The event record if found, or null.
     */
    fetchEvent(eventId: string): IEventRecord | null {
        const stmt = this.prepare(`SELECT *
                                   FROM ${this.getTableName()}
                                   WHERE eventId = ?
                                   order by id desc
                                   limit 1`);
        const event = stmt.get(eventId) as IEventRecord;

        return event; // Return the event or null if not found
    }

    /**
     * Fetches all active or inactive events.
     * @returns Array of matching event records.
     */
    fetchAllActiveEvents(): IEventSqlRecord[] {
        const stmt = this.prepare(`SELECT *
                                   FROM ${this.getTableName()}
                                   where isActive = 1`);
        return stmt.all() as IEventSqlRecord[];
    }

    /**
     * Fetches all events.
     * @returns Array of matching event records.
     */
    fetchAllEvents(count: number): IEventSqlRecord[] {
        const stmt = this.prepare(`SELECT *
                                   FROM ${this.getTableName()}
                                   order by id desc
                                   limit ?`);

        const result = stmt.all(count) as IEventSqlRecord[];

        for (const event of result) {
            event.triggerCond = JSON.parse(event.triggerCond);
        }
        return result as IEventSqlRecord[];
    }

    addAndUpdateEvent(out: { toAdd: IEventRecord[], toUpdate?: IEventRecord[] }) {
        for (const event of out.toAdd) {
            this.insertEvent(event);
        }

        if (!out.toUpdate) {
            return;
        }

        for (const event of out.toUpdate) {
            this.deactivateEvent(event);
        }
    }

    clearAllActiveAlarms() {
        const stmt = this.prepare(`UPDATE ${this.getTableName()}
                                   set isActive = 0`);
        stmt.run();
    }
}
