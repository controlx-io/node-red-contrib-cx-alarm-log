import {Node} from "node-red";
import fs from "fs";

export const EVENT_TYPES = ["E"] as const;
export const ALARM_TYPES = ["I", "W", "F"] as const;

export type EventType = typeof EVENT_TYPES[number];
export type AlarmType = typeof ALARM_TYPES[number];

export interface ITriggerConfig {
    op: "=" | ">" | "<" | "#" | "?",  // equal, gt,
    val: number,
    sp?: string
}

export interface IEventTriggerParam {
    type: "I" | "W" | "F" | "E",
    onTrigger: ITriggerConfig,
    desc: string
}

export interface IEventConfig {
    tagName: string,
    eqName: string,
    alarmParams: IEventTriggerParam[],
    eventParams: IEventTriggerParam[],
}

export interface IEventRecord {
    eventId: string,
    ts: number,
    eqName: string,
    tagName: string,
    type: EventType | AlarmType,
    isActive: boolean,
    triggerCond: ITriggerConfig,
    desc: string,
}

export interface IActiveAlarmsRegister {
    "I": {
        [key: string]: boolean
    },
    "W": {
        [key: string]: boolean
    },
    "F": {
        [key: string]: boolean
    }
}


export function isPrimitive(val: any): boolean {
    return !isNaN(val) && val != null && val !== Object(val);
}

export function isObject(val: any): boolean {
    return val.constructor.name === "Object" && typeof val === "object"
}

export function filterNewValues(oldObject: {[key: string]: any}, newObject: {[key: string]: any}):
    {[key: string]: string | number | boolean} | undefined
{
    const newKeys = Object.keys(newObject);
    if (!newKeys) return;

    const newValues: {[key: string]: any} = {};

    for (const key of newKeys) {
        if (isPrimitive(newObject[key]) && oldObject[key] !== newObject[key]) {
            newValues[key] = newObject[key];
        }
    }

    return newValues
}

export class Logger {

    constructor(public node: Node, public isDebug?: boolean) {
        if (this.isDebug) console.log("Debug is ON for node:", node.name || node.id);
    }

    debug(...args : any[]) {
        if (this.isDebug) {
            const message = [args].map(v => v.toString()).join(" ");
            this.node.warn(message)
        }
    }

    warn(...args : any[]) {
        if (this.isDebug) console.log(...args);
        const message = [args].map(v => v.toString()).join(" ");
        this.node.warn(message)
    }

    error(err: Error) {
        // if (this.isDebug) console.error(err);
        this.node.error(err.message)
    }
}

export class EventConfig {
    public setpoints: {[key: string]: ITriggerConfig} = {};

    constructor(private logger: Logger) {}


    static readCsvFile(fullFilename: string): string {

        if (!fs.existsSync(fullFilename)) throw new Error("file doesn't exists at " + fullFilename);

        try {
            const buff = fs.readFileSync(fullFilename);
            return buff.toString()
        } catch (e) {
            console.error(e);
            return ""
        }
    }


    parseConfig(fullFilename: string) {

        const text = EventConfig.readCsvFile(fullFilename);
        const logger = this.logger;
        const setpoints = this.setpoints;

        const configHeader = {
            eqName: "eqName",
            tagName: "tagName",
            alarm: "alarm",
            event: "event",
        }

        const node = {
            quo: '"',
            hdrin: true,  // header
            sep: ',',
        };

        const lines = text.split(/\r?\n/);
        let isMeta = true;
        let isHeader = false;

        const out = {
            meta: {} as {[key: string]: string},
            headers: [] as string[],
            body: [] as IEventConfig[],
        }

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
            if (tagConfig) out.body.push(tagConfig);
        }

        if (!out.meta.node_version) throw new Error("'node_version' field is missing in the CSV config.");

        return out;

        function parseArrayFromLine(line: string, header: string[]): IEventConfig | undefined {
            const regTestIsNumber = /^[-]?(?!E)(?!0\d)\d*\.?\d*(E-?\+?)?\d+$/i;

            let j = 0; // pointer into array of template items
            let k: string[] = [""]; // array of data for each of the template items
            let isOutsideQuotes = true;

            const out: IEventConfig = {
                eqName: "", tagName: "", alarmParams: [], eventParams: [],
            };
            for (let i = 0; i < line.length; i++) {
                if (line[i] === node.quo) { // if it's a quote toggle inside or outside
                    isOutsideQuotes = !isOutsideQuotes;
                    if (line[i-1] === node.quo) {
                        if (!isOutsideQuotes === false) k[j] += '\"';
                    } // if it's a quotequote then it's actually a quote

                } else if ((line[i] === node.sep && isOutsideQuotes) || i === line.length - 1) { // if it is the end of the line then finish
                    if (header[j] && header[j] !== "") {
                        // if no value between separators ('1,,"3"...') or if the line beings with separator (',1,"2"...') treat value as null
                        if (line[i-1] === node.sep) k[j] = "";

                        if (header[j] === configHeader.tagName && !k[j]) return;

                        if (header[j] === configHeader.tagName) {
                            out.tagName = k[j]
                        } else if (header[j] === configHeader.eqName) {
                            out.eqName = k[j]
                        } else if (header[j] === configHeader.alarm) {
                            out.alarmParams = parseEventActions(k[j], false);
                        } else if (header[j] === configHeader.event) {
                            out.eventParams = parseEventActions(k[j], true);
                        }

                        // @ts-ignore
                        // out[header[j]] = k[j];
                    }
                    j += 1;
                    // if separator is last char in processing string line (without end of line), add null value at the end - example: '1,2,3\n3,"3",'
                    k[j] = line.length - 1 === i ? null : "";

                } else { // just add to the part of the message
                    k[j] += line[i];
                }
            }
            return out
        }

        function clean(col: string) {
            const re = new RegExp(node.sep.replace(/[-[\]{}()*+!<=:?.\/\\^$|#\s,]/g,'\\$&') +
                '(?=(?:(?:[^"]*"){2})*[^"]*$)','g');
            let arr = col.trim().split(re) || [""];
            arr = arr.map(x => x.replace(/"/g,"").trim());
            return arr;
        }


        function parseEventActions(paramStr: string, isEvent: boolean): IEventTriggerParam[] {
            const out: IEventTriggerParam[] = [];
            const isAlarm = !isEvent;

            if (!paramStr) return [];

            const actions = paramStr.split("|");
            for (const action of actions) {
                const params = action.split(":");
                const type = isAlarm ? params[0] as "I" | "W" | "F" : "E";
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

                if (onTrigger.sp) setpoints[onTrigger.sp] = onTrigger;

                const a: IEventTriggerParam = {
                    type: isAlarm ? params[0] as "I" | "W" | "F" : "E",
                    onTrigger, desc,
                }
                out.push(a)
            }

            return out;
        }
    }

    static parseTriggerStr(param: string, isEvent?: boolean): ITriggerConfig {
        const out: ITriggerConfig = {op: "?", val: 0};

        const spTest = param.match(/{([^}]+)}/);
        if (spTest) {
            out.sp = spTest[1].trim();
            param = param.replace(`{${spTest[1]}}`, "")
        }

        if (!isNaN(Number(param))) {
            out.val = Number(param);
            out.op = "=";
            return out
        }

        if (param === "true") {
            out.val = 1;
            out.op = "=";
            return out
        }
        if (param === "false") {
            out.val = 0;
            out.op = "=";
            return out
        }

        if (isEvent) return out;

        const operator = param.charAt(0);
        const value = Number(param.slice(1).trim());

        if (!["=", ">", "<", "#", "?"].includes(operator) || isNaN(value))
            return out;

        out.op = operator as "=" | ">" | "<" | "#" | "?";
        out.val = value;

        return out;
    }


    static isAlarmTriggered(tagValue: number, alarmParam: IEventTriggerParam): boolean | undefined {
        if (!["=", ">", "<"].includes(alarmParam.onTrigger.op)) return;

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