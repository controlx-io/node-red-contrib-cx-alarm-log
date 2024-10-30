import { Node, NodeRedApp } from "node-red";
import {
    ALARM_TYPES,
    AlarmType,
    EventConfig,
    filterNewValues,
    IActiveAlarmsRegister,
    IEventConfig,
    IEventRecord,
    isObject,
    Logger
} from "./tools";
import * as path from "path";
import SqliteHelper from "./sqlite_helper";

interface IConfig {
    plcTagValuesState: { [key: string]: any },
    path: string,
    alarmTopic?: string,
    eventTopic?: string,
    isMochaTesting?: boolean,
    isDebug?: boolean,
    isUpdatedConfig?: boolean,
    configText?: string,
    isTabSeparator: boolean,
}


module.exports = function (RED: NodeRedApp) {

    const plcTagValuesState: { [nodeId: string]: any } = {};

    const activeAlarms: { [nodeId: string]: IActiveAlarmsRegister } = {};

    function getActiveAlarms(sqliteHelper: SqliteHelper) {
        const alarms = sqliteHelper.fetchAllActiveEvents();

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

    function AlarmLogNode(config: IConfig) {
        let eventConfigs: IEventConfig[] = [];
        const disabledEventMap: { [key: string]: boolean } = {};
        const unacknowledgedEventMap: { [key: string]: boolean } = {};

        // @ts-ignore
        RED.nodes.createNode(this, config);
        const node: Node = this;
        const sqliteHelper = new SqliteHelper(`./alarmNode_${node.id}.sqlite`);
        activeAlarms[node.id] = getActiveAlarms(sqliteHelper);

        const logger = new Logger(node, config.isDebug || config.isMochaTesting);
        const eventConfig = new EventConfig(logger);

        if (config.configText) {
            try {
                const sep = config.isTabSeparator ? "\t" : ",";

                const conf = eventConfig.parseConfig("", config.configText, sep);
                eventConfigs = conf.body;
                logger.debug(`Config v.${conf.meta.version ? conf.meta.version : "'NOT IN META'"} ` +
                    `is set with ${eventConfigs.length} config tags.`);
            } catch (e) {
                logger.error(e);
            }

        } else if (config.path && typeof config.path === "string") {
            try {
                // @ts-ignore
                const fileWorkingDirectory = config.isMochaTesting ? __dirname : RED.settings.fileWorkingDirectory;

                let fullFilename = config.path;
                if (config.path && fileWorkingDirectory && !path.isAbsolute(config.path)) {
                    fullFilename = path.resolve(path.join(fileWorkingDirectory, config.path));
                }

                const conf = eventConfig.parseConfig(fullFilename);
                eventConfigs = conf.body;

                logger.debug(`Config v.${conf.meta.version ? conf.meta.version : "'NOT IN META'"} ` +
                    `is set with ${eventConfigs.length} config tags.`);
            } catch (e) {
                logger.error(e);
            }
        }

        node.on("input", (msg: any) => {

            const isSent = checkTopicAndSend(msg);
            const isSet = checkTopicAndSet(msg);
            if (isSent || isSet) return;

            if (!Object.keys(eventConfigs).length)
                return logger.error(new Error("Event config is empty."));

            // If tags property is defined, and it is an array, convert it to an object and use this object as payload
            if (msg.tags && Array.isArray(msg.tags)) {
                const payload: { [key: string]: any } = {};
                for (const tag of msg.tags) {
                    const { group, name, value } = tag;
                    const key = group + "__" + name
                    if (group && name && value != null) {
                        payload[key] = value;
                    }
                }
                msg.payload = payload;
            } else if (!isObject(msg.payload)) {
                const errMsg = "Incorrect Payload data type: " + JSON.stringify(msg.payload);
                return logger.error(new Error(errMsg));
            }

            const newValues = filterNewValues(plcTagValuesState, msg.payload);
            if (!newValues) return;
            plcTagValuesState[node.id] = { ...plcTagValuesState[node.id], ...newValues };

            const alarmsOut = {
                toAdd: [] as IEventRecord[],
                toUpdate: [] as IEventRecord[]
            };

            const eventsOut = {
                toAdd: [] as IEventRecord[]
            };

            for (const [tagName, newValue] of Object.entries(newValues)) {
                if (disabledEventMap[tagName]) continue; // if the tag is disabled, skip it
                const val = typeof newValue === "boolean" ?
                    (newValue ? 1 : 0) :
                    newValue;

                if (typeof val !== "number" || !Number.isFinite(val)) continue;

                // Find first config matched by Tag Name
                const eventConfig = eventConfigs.find(event => event.tagName === tagName);
                if (!eventConfig) continue;

                alarmChecker(eventConfig, val, alarmsOut, true);
                alarmChecker(eventConfig, val, eventsOut, false);
            }

            sqliteHelper.addAndUpdateEvent(alarmsOut);
            sqliteHelper.addAndUpdateEvent(eventsOut);

            sendNodeREDMsg(alarmsOut, eventsOut);
        });

        function sendNodeREDMsg(alarmsOut: {
            toAdd: IEventRecord[],
            toUpdate: IEventRecord[]
        }, eventsOut: {
            toAdd: IEventRecord[]
        }) {
            const eventsToNotify = [];
            if (alarmsOut.toAdd.length || eventsOut.toAdd.length) {
                for (const record of alarmsOut.toAdd.concat(eventsOut.toAdd)) {
                    if (unacknowledgedEventMap[record.tagName]) continue;
                    eventsToNotify.push(record);
                    unacknowledgedEventMap[record.tagName] = true;
                }
            }

            if (alarmsOut.toUpdate.length || alarmsOut.toAdd.length || eventsOut.toAdd.length) {
                const alarmMsg = (alarmsOut.toUpdate.length || alarmsOut.toAdd.length) ?
                    { payload: alarmsOut, topic: config.alarmTopic } : null;

                const eventMsg = (eventsOut.toAdd.length) ?
                    { payload: eventsOut, topic: config.eventTopic } : null;

                const alarmsCountMsg = alarmMsg ?
                    { payload: countActiveAlarms(), topic: "__active_alarms_count__" } : null;

                const allEventMsg = {
                    payload: sqliteHelper.fetchAllEvents(),
                    topic: "__get_all_events__"
                }
                node.send([alarmMsg, eventMsg, allEventMsg, { payload: eventsToNotify }]);
            }
        }

        function alarmChecker(eventConfig: IEventConfig, val: number,
                              result: { toAdd: IEventRecord[], toUpdate?: IEventRecord[] }, isAlarm: boolean) {
            const tagName = eventConfig.tagName;
            const { eqName, alarmParams, eventParams } = eventConfig;

            const configParam = isAlarm ? alarmParams : eventParams;
            const ts = Date.now();

            for (const [i, eventParam] of configParam.entries()) {
                const event: IEventRecord = {
                    ts, eqName, tagName,
                    triggerCond: { ...eventParam.onTrigger },
                    eventId: EventConfig.getEventId(tagName, eventParam.type, i),
                    isActive: false,
                    type: eventParam.type,
                    description: eventParam.desc
                };

                const isTriggered = EventConfig.isAlarmTriggered(val, eventParam);
                if (isTriggered == null) return;

                if (isAlarm) {
                    const type = event.type as AlarmType;
                    const isActive = activeAlarms[node.id][type][event.eventId];

                    // if NOT triggered and NOT in active buffer
                    if (isTriggered === false && !isActive) return;

                    // if IS triggered and IS in active buffer
                    if (isTriggered && isActive) return;


                    // if is already Triggered and in the buffer
                    if (isActive && result.toUpdate) {
                        result.toUpdate.push(event);
                        delete activeAlarms[node.id][type][event.eventId];
                    }
                    // else add to the DB
                    else {
                        event.isActive = true;
                        result.toAdd.push(event);
                        activeAlarms[node.id][type][event.eventId] = event.isActive;
                    }
                } else {
                    if (isTriggered)
                        result.toAdd.push(event);
                }
            }
        }

        function clearAlarm(eventConfig: IEventConfig, result: {
            toAdd: IEventRecord[],
            toUpdate?: IEventRecord[]
        }) {
            const tagName = eventConfig.tagName;
            const { eqName, alarmParams } = eventConfig;

            const configParam = alarmParams;
            const ts = Date.now();

            for (const [i, eventParam] of configParam.entries()) {
                const event: IEventRecord = {
                    ts, eqName, tagName,
                    triggerCond: { ...eventParam.onTrigger },
                    eventId: EventConfig.getEventId(tagName, eventParam.type, i),
                    isActive: false,
                    type: eventParam.type,
                    description: eventParam.desc
                };

                const type = event.type as AlarmType;
                const isActive = activeAlarms[node.id][type][event.eventId];

                // if NOT triggered and NOT in active buffer
                if (!isActive) return;

                delete activeAlarms[node.id][type][event.eventId];
                result.toUpdate.push(event);
            }
        }

        /**
         * returns example {F:2, I:1, W:2}
         */
        function countActiveAlarms() {
            const out: { [key: string]: number } = {};
            for (const key of Object.keys(activeAlarms[node.id])) {
                out[key] = Object.keys(activeAlarms[node.id][(key as AlarmType)]).length
            }
            return out
        }

        function checkTopicAndSet(msg: any): boolean {
            if (msg.topic === "__clear_remembered_values__") {
                plcTagValuesState[node.id] = {};
                return true;
            }

            if (msg.topic === "__set_active_alarms__") {
                if (!Array.isArray(msg.payload)) {
                    logger.error(new Error("Payload must be an array, got " + JSON.stringify(msg.payload)));
                    return true;
                }
                activeAlarms[node.id] = { F: {}, I: {}, W: {} };

                for (const activeAlarm of msg.payload) {
                    if (!activeAlarm.isActive) continue;

                    if (!ALARM_TYPES.includes(activeAlarm.type)) {
                        logger.warn(`Alarm prop 'type' must be ${ALARM_TYPES.join(",")}, got ` +
                            JSON.stringify(activeAlarm.type));
                        continue;
                    }

                    if (typeof activeAlarm.eventId !== "string") {
                        logger.warn(`Alarm prop 'eventId' must be a string, got ` +
                            JSON.stringify(activeAlarm.eventId));
                        continue;
                    }

                    activeAlarms[node.id][(activeAlarm.type as AlarmType)][activeAlarm.eventId] = true;
                }

                const count = Object.keys(activeAlarms[node.id].F).length +
                    Object.keys(activeAlarms[node.id].I).length +
                    Object.keys(activeAlarms[node.id].W).length

                logger.debug(`Set ${count} active alarms`);
                return true;
            }

            if (msg.topic === "__set_setpoints__") {

                const setpoints = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
                for (const setpoint of setpoints) {
                    if (!isObject(setpoint)) {
                        const errMsg = "Setpoint to be an Object: e.g '{tagName: 5}', got " + JSON.stringify(msg.payload);
                        logger.error(new Error(errMsg));
                        return true;
                    }

                    for (const spTag in setpoint) {
                        const spValue = setpoint[spTag];
                        if (!Number.isFinite(spValue)) {
                            logger.warn(`Value of ${spTag} must be a Number (use 1 for TRUE and 0 for FALSE)`);
                            continue;
                        }

                        if (!eventConfig.setpoints[spTag]) {
                            logger.debug(`Tag ${spTag} is NOT in the Config`);
                            continue;
                        }

                        eventConfig.setpoints[spTag].val = spValue;

                        logger.debug(`Setpoint ${spTag} set to ${spValue}`);
                    }

                }
                return true;
            }

            if (msg.topic === "__add_tag_config__") {
                const configArr = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
                for (const config of configArr) {
                    // validate the payload
                    if (!EventConfig.validateConfig(config)) {
                        logger.warn(new Error("Config is invalid: " + JSON.stringify(config)));
                        continue;
                    }

                    // if eventConfigs already has the tag, update it
                    const existingTag = eventConfigs.find(event => event.tagName === config.tagName);
                    if (existingTag) {
                        Object.assign(existingTag, config);
                    } else {
                        // else add the tag to the eventConfigs
                        eventConfigs.push(config);
                    }
                }
                return true;
            }

            if (msg.topic === "__manage_event__") {
                if (typeof msg.payload !== "object") return false;
                const alarmsOut = {
                    toAdd: [] as IEventRecord[],
                    toUpdate: [] as IEventRecord[]
                };

                for (const [tagName, enable] of Object.entries(msg.payload)) {
                    let val = plcTagValuesState[node.id][tagName];
                    val = typeof val === "boolean" ? (val ? 1 : 0) : val;
                    if (typeof val !== "number" || !Number.isFinite(val)) continue;

                    const eventConfig = eventConfigs.find(event => event.tagName === tagName);
                    if (!eventConfig) continue;

                    if (enable) {
                        delete disabledEventMap[tagName];
                        alarmChecker(eventConfig, val, alarmsOut, true);
                    } else {
                        disabledEventMap[tagName] = true;
                        // clear the existing alarm
                        clearAlarm(eventConfig, alarmsOut);
                    }
                }
                sqliteHelper.addAndUpdateEvent(alarmsOut);

                // send NodeRED msg
                sendNodeREDMsg(alarmsOut, { toAdd: [] });
                return true;
            }

            if (msg.topic === "__acknowledge_event__") {
                const ackEvents = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
                for (const event of ackEvents) {
                    if (unacknowledgedEventMap[event]) delete unacknowledgedEventMap[event];
                }
                return true;
            }

            if (msg.topic === "__clear_all_active_alarms__") {
                activeAlarms[node.id] = { F: {}, I: {}, W: {} };
                sqliteHelper.clearAllActiveAlarms();
                node.send([null, null, { payload: activeAlarms[node.id], topic: "__get_all_events__" }]);
                return true;
            }

            return false;
        }

        function checkTopicAndSend(msg: any): boolean {

            if (msg.topic === "__get_remembered_values__") {
                node.send([null, null, { payload: plcTagValuesState, topic: msg.topic }]);
                return true;
            }


            if (msg.topic === "__get_config__") {
                node.send([null, null, { payload: eventConfigs, topic: msg.topic }]);
                return true;
            }

            if (msg.topic === "__get_active_alarms__") {
                node.send([null, null, { payload: activeAlarms[node.id], topic: msg.topic }]);
                return true;
            }

            if (msg.topic === "__get_setpoints__") {
                node.send([null, null, { payload: eventConfig.setpoints, topic: msg.topic }]);
                return true;
            }

            if (msg.topic === "__get_all_events__") {
                node.send([null, null, { payload: sqliteHelper.fetchAllEvents(), topic: msg.topic }]);
                return true;
            }

            return false;
        }

    }

    // @ts-ignore
    RED.nodes.registerType("cx_alarm_log", AlarmLogNode);
}
