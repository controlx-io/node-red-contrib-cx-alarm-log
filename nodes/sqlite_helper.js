"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
class SqliteHelper {
    constructor(dbPath, tableSuffix) {
        this.tableSuffix = tableSuffix;
        this.db = new better_sqlite3_1.default(dbPath);
        this.createTable();
    }
    get tableName() {
        return `events_${this.tableSuffix}`;
    }
    createTable() {
        const sql = `
            CREATE TABLE IF NOT EXISTS ${this.tableName}
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
    exec(sql) {
        return this.db.exec(sql);
    }
    prepare(sql) {
        return this.db.prepare(sql);
    }
    close() {
        this.db.close();
    }
    insertEvent(event) {
        const stmt = this.prepare(`
            INSERT INTO ${this.tableName} (eventId, ts, eqName, tagName, type, isActive, triggerCond, description)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        return stmt.run(event.eventId, event.ts, event.eqName, event.tagName, event.type, event.isActive ? 1 : 0, JSON.stringify(event.triggerCond), event.description);
    }
    deactivateEvent(eventRecord) {
        const checkStmt = this.prepare(`SELECT *
                                        FROM ${this.tableName}
                                        WHERE eventId = ?
                                        order by id desc
                                        limit 1`);
        const result = checkStmt.get(eventRecord.eventId);
        if (!result) {
            return null;
        }
        const updateStmt = this.prepare(`UPDATE ${this.tableName}
                                         SET isActive = ?,
                                             duration = strftime('%s', 'now') - ts / 1000
                                         WHERE id = ?`);
        return updateStmt.run(eventRecord.isActive ? 1 : 0, result.id);
    }
    fetchAllActiveEvents() {
        const stmt = this.prepare(`SELECT *
                                   FROM ${this.tableName}
                                   where isActive = 1`);
        return stmt.all();
    }
    fetchAllEvents(count) {
        const stmt = this.prepare(`SELECT *
                                   FROM ${this.tableName}
                                   order by id desc
                                   limit ?`);
        const result = stmt.all(count);
        for (const event of result) {
            event.triggerCond = JSON.parse(event.triggerCond);
        }
        return result;
    }
    addAndUpdateEvent(out) {
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
        const stmt = this.prepare(`UPDATE ${this.tableName}
                                   set isActive = 0,
                                       duration = strftime('%s', 'now') - ts / 1000
                                   where isActive = 1`);
        stmt.run();
    }
    getActiveAlarms() {
        const alarms = this.fetchAllActiveEvents();
        const map = {
            "I": {},
            "W": {},
            "F": {},
        };
        for (const alarm of alarms) {
            if (alarm.type === 'E')
                continue;
            map[alarm.type][alarm.eventId] = true;
        }
        return map;
    }
}
exports.default = SqliteHelper;
//# sourceMappingURL=sqlite_helper.js.map