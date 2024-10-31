import sqlite3 from 'better-sqlite3';
import { AlarmType, IDBHelper, EventType, IActiveAlarmsRegister, IEventRecord } from "./tools";

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

export default class SqliteHelper implements IDBHelper {
    private db: sqlite3.Database;

    constructor(dbPath: string, private tableSuffix: string) {
        this.db = new sqlite3(dbPath);
        this.createTable(this.tableSuffix); // Create the table when the class is instantiated
    }

    private getTableName() {
        return `events_${this.tableSuffix}`;
    }

    private createTable(tableSuffix: string) {
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

    private exec(sql: string) {
        return this.db.exec(sql);
    }

    private prepare(sql: string) {
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
     * @param eventRecord
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
                                             duration = strftime('%s', 'now') - ts / 1000
                                         WHERE id = ?`);
        return updateStmt.run(eventRecord.isActive ? 1 : 0, result.id);
    }

    /**
     * Fetches all active or inactive events.
     * @returns Array of active event records.
     */
    fetchAllActiveEvents(): IEventRecord[] {
        const stmt = this.prepare(`SELECT *
                                   FROM ${this.getTableName()}
                                   where isActive = 1`);
        return stmt.all() as IEventRecord[];
    }

    /**
     * Fetches all events.
     * @returns Array of event records.
     */
    fetchAllEvents(count: number): IEventRecord[] {
        const stmt = this.prepare(`SELECT *
                                   FROM ${this.getTableName()}
                                   order by id desc
                                   limit ?`);

        const result = stmt.all(count) as IEventSqlRecord[];

        for (const event of result) {
            event.triggerCond = JSON.parse(event.triggerCond);
        }
        // @ts-ignore
        return result as IEventRecord[];
    }

    /**
     * Adds and updates events.
     * @param out
     */
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


    /**
     * Clears all active alarms.
     */
    clearAllActiveAlarms() {
        const stmt = this.prepare(`UPDATE ${this.getTableName()}
                                   set isActive = 0,
                                       duration = strftime('%s', 'now') - ts / 1000
                                   where isActive = 1`);
        stmt.run();
    }

    /**
     * Gets all active alarms.
     * @returns Object containing all active alarms.
     */
    getActiveAlarms() {
        const alarms = this.fetchAllActiveEvents();

        const map: IActiveAlarmsRegister = {
            "I": {},
            "W": {},
            "F": {},
        }

        for (const alarm of alarms) {
            if (alarm.type === 'E') continue;
            map[alarm.type][alarm.eventId] = true;
        }
        return map;
    }
}
