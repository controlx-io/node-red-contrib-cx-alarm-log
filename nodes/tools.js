"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventConfig = exports.Logger = exports.filterNewValues = exports.isObject = exports.isPrimitive = exports.ALARM_TYPES = exports.EVENT_TYPES = void 0;
const fs_1 = __importDefault(require("fs"));
exports.EVENT_TYPES = ["E"];
exports.ALARM_TYPES = ["I", "W", "F"];
function isPrimitive(val) {
    return !isNaN(val) && val != null && val !== Object(val);
}
exports.isPrimitive = isPrimitive;
function isObject(val) {
    return val.constructor.name === "Object" && typeof val === "object";
}
exports.isObject = isObject;
function filterNewValues(oldObject, newObject) {
    const newKeys = Object.keys(newObject);
    if (!newKeys)
        return;
    const newValues = {};
    for (const key of newKeys) {
        if (isPrimitive(newObject[key]) && oldObject[key] !== newObject[key]) {
            newValues[key] = newObject[key];
        }
    }
    return newValues;
}
exports.filterNewValues = filterNewValues;
class Logger {
    constructor(node, isDebug) {
        this.node = node;
        this.isDebug = isDebug;
        if (this.isDebug)
            console.log("Debug is ON for node:", node.name || node.id);
    }
    debug(...args) {
        if (this.isDebug) {
            const message = [args].map(v => v.toString()).join(" ");
            this.node.warn(message);
        }
    }
    warn(...args) {
        if (this.isDebug)
            console.log(...args);
        const message = [args].map(v => v.toString()).join(" ");
        this.node.warn(message);
    }
    error(err) {
        this.node.error(err.message);
    }
}
exports.Logger = Logger;
class EventConfig {
    constructor(logger) {
        this.logger = logger;
        this.setpoints = {};
    }
    static readCsvFile(fullFilename) {
        if (!fs_1.default.existsSync(fullFilename))
            throw new Error("file doesn't exists at " + fullFilename);
        try {
            const buff = fs_1.default.readFileSync(fullFilename);
            return buff.toString();
        }
        catch (e) {
            console.error(e);
            return "";
        }
    }
    parseConfig(fullFilename) {
        const text = EventConfig.readCsvFile(fullFilename);
        const logger = this.logger;
        const setpoints = this.setpoints;
        const configHeader = {
            eqName: "eqName",
            tagName: "tagName",
            alarm: "alarm",
            event: "event",
        };
        const node = {
            quo: '"',
            hdrin: true,
            sep: ',',
        };
        const lines = text.split(/\r?\n/);
        let isMeta = true;
        let isHeader = false;
        const out = {
            meta: {},
            headers: [],
            body: [],
        };
        for (const line of lines) {
            if (line.startsWith("---")) {
                isHeader = true;
                isMeta = false;
                continue;
            }
            if (isMeta) {
                const keys = line.split(node.sep);
                out.meta[keys[0]] = keys[1];
                continue;
            }
            if (isHeader) {
                out.headers.push(...clean(line));
                isHeader = false;
                continue;
            }
            const tagConfig = parseArrayFromLine(line, out.headers);
            if (tagConfig)
                out.body.push(tagConfig);
        }
        if (!out.meta.node_version)
            throw new Error("'node_version' field is missing in the CSV config.");
        return out;
        function parseArrayFromLine(line, header) {
            const regTestIsNumber = /^[-]?(?!E)(?!0\d)\d*\.?\d*(E-?\+?)?\d+$/i;
            let j = 0;
            let k = [""];
            let isOutsideQuotes = true;
            const out = {
                eqName: "", tagName: "", alarmParams: [], eventParams: [],
            };
            for (let i = 0; i < line.length; i++) {
                if (line[i] === node.quo) {
                    isOutsideQuotes = !isOutsideQuotes;
                    if (line[i - 1] === node.quo) {
                        if (!isOutsideQuotes === false)
                            k[j] += '\"';
                    }
                }
                else if ((line[i] === node.sep && isOutsideQuotes) || i === line.length - 1) {
                    if (header[j] && header[j] !== "") {
                        if (line[i - 1] === node.sep)
                            k[j] = "";
                        if (header[j] === configHeader.tagName && !k[j])
                            return;
                        if (header[j] === configHeader.tagName) {
                            out.tagName = k[j];
                        }
                        else if (header[j] === configHeader.eqName) {
                            out.eqName = k[j];
                        }
                        else if (header[j] === configHeader.alarm) {
                            out.alarmParams = parseEventActions(k[j], false);
                        }
                        else if (header[j] === configHeader.event) {
                            out.eventParams = parseEventActions(k[j], true);
                        }
                    }
                    j += 1;
                    k[j] = line.length - 1 === i ? null : "";
                }
                else {
                    k[j] += line[i];
                }
            }
            return out;
        }
        function clean(col) {
            const re = new RegExp(node.sep.replace(/[-[\]{}()*+!<=:?.\/\\^$|#\s,]/g, '\\$&') +
                '(?=(?:(?:[^"]*"){2})*[^"]*$)', 'g');
            let arr = col.trim().split(re) || [""];
            arr = arr.map(x => x.replace(/"/g, "").trim());
            return arr;
        }
        function parseEventActions(paramStr, isEvent) {
            const out = [];
            const isAlarm = !isEvent;
            if (!paramStr)
                return [];
            const actions = paramStr.split("|");
            for (const action of actions) {
                const params = action.split(":");
                const type = isAlarm ? params[0] : "E";
                const triggerString = isAlarm ? params[1] : params[0];
                const descIndex = isAlarm ? 2 : 1;
                const desc = params.slice(descIndex, params.length).join(":");
                if (isAlarm && !["I", "W", "F"].includes(type)) {
                    logger.warn(`Alarm Type must be I, W or F, got ${type}`);
                    continue;
                }
                const onTrigger = EventConfig.parseTriggerStr(triggerString, isEvent);
                if (onTrigger.op === "?") {
                    logger.warn("Cannot parse parameters string '" + paramStr + "'");
                    continue;
                }
                if (onTrigger.sp)
                    setpoints[onTrigger.sp] = onTrigger;
                const a = {
                    type: isAlarm ? params[0] : "E",
                    onTrigger, desc,
                };
                out.push(a);
            }
            return out;
        }
    }
    static parseTriggerStr(param, isEvent) {
        const out = { op: "?", val: 0 };
        const spTest = param.match(/{([^}]+)}/);
        if (spTest) {
            out.sp = spTest[1].trim();
            param = param.replace(`{${spTest[1]}}`, "");
        }
        if (!isNaN(Number(param))) {
            out.val = Number(param);
            out.op = "=";
            return out;
        }
        if (param === "true") {
            out.val = 1;
            out.op = "=";
            return out;
        }
        if (param === "false") {
            out.val = 0;
            out.op = "=";
            return out;
        }
        if (isEvent)
            return out;
        const operator = param.charAt(0);
        const value = Number(param.slice(1).trim());
        if (!["=", ">", "<", "#", "?"].includes(operator) || isNaN(value))
            return out;
        out.op = operator;
        out.val = value;
        return out;
    }
    static isAlarmTriggered(tagValue, alarmParam) {
        if (!["=", ">", "<"].includes(alarmParam.onTrigger.op))
            return;
        switch (alarmParam.onTrigger.op) {
            case "=":
                return tagValue === alarmParam.onTrigger.val;
            case "<":
                return tagValue < alarmParam.onTrigger.val;
            case ">":
                return tagValue > alarmParam.onTrigger.val;
        }
    }
}
exports.EventConfig = EventConfig;
//# sourceMappingURL=tools.js.map