import {Node, NodeRedApp} from "node-red";
import {
    ALARM_TYPES,
    AlarmType,
    EventConfig,
    filterNewValues,
    IActiveAlarmsRegister,
    IEventConfig, IEventRecord,
    isObject,
    Logger
} from "./tools";
import * as path from "path";

interface IConfig {
    plcTagValuesState: {[key:string]: any},
    path: string,
    alarmTopic?: string,
    eventTopic?: string,
    isMochaTesting?: boolean,
    isDebug?: boolean,
    isUpdatedConfig?: boolean,
    configText?: string,
    isTabSeparator: boolean,

    storage?: string,
    storageType: "global" | "flow",
}


module.exports = function(RED: NodeRedApp) {
    const plcTagValuesState: {[nodeId: string]: any} = {};
    const activeAlarms: {[nodeId: string]: IActiveAlarmsRegister} = {};


    function AlarmLogNode(config: IConfig) {
        let eventConfigs: IEventConfig[] = [];

        // @ts-ignore
        RED.nodes.createNode(this, config);
        const node: Node = this;
        activeAlarms[node.id] = {F: {}, I: {}, W: {}};
        let saveActiveAlarmsFn: () => void;

        let ctxStorage: undefined | IActiveAlarmsRegister;
        if (config.storage) {
            const contextKey = RED.util.parseContextStore(config.storage);
            ctxStorage = (node.context()[config.storageType].get(contextKey.key, contextKey.store) as
                undefined | IActiveAlarmsRegister);

            saveActiveAlarmsFn = () => {
                node.context()[config.storageType].set(contextKey.key, activeAlarms[node.id], contextKey.store);
            };

            if (ctxStorage) activeAlarms[node.id] = ctxStorage;
            else saveActiveAlarmsFn();
        }

        const logger = new Logger(node, config.isDebug || config.isMochaTesting);
        const eventConfig = new EventConfig(logger);


        if (config.configText) {
            try {
                const sep = config.isTabSeparator ? "\t" : ",";

                const conf = eventConfig.parseConfig("", config.configText, sep);
                eventConfigs = conf.body;
                logger.debug(`Config v.${conf.meta.version ? conf.meta.version : "'NOT IN META'" } ` +
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

                logger.debug(`Config v.${conf.meta.version ? conf.meta.version : "'NOT IN META'" } ` +
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

            if (!isObject(msg.payload)) {
                const errMsg = "Incorrect Payload data type: " + JSON.stringify(msg.payload);
                return logger.error(new Error(errMsg));
            }


            const newValues = filterNewValues(plcTagValuesState, msg.payload);
            if (!newValues) return;
            plcTagValuesState[node.id] = {...plcTagValuesState[node.id], ...newValues};

            const alarmsOut = {
                toAdd: [] as IEventRecord[],
                toUpdate: [] as IEventRecord[]
            };

            const eventsOut = {
                toAdd: [] as IEventRecord[]
            };

            for (const [tagName, newValue] of Object.entries(newValues)) {
                const val = typeof newValue === "boolean" ?
                    (newValue ? 1 : 0):
                    newValue;

                if (typeof val !== "number" || !Number.isFinite(val)) continue;

                // Find first config matched by Tag Name
                const eventConfig = eventConfigs.find(event => event.tagName === tagName);
                if (!eventConfig) continue;

                alarmChecker(eventConfig, tagName, val, alarmsOut, true);
                alarmChecker(eventConfig, tagName, val, eventsOut, false);
            }


            if (alarmsOut.toUpdate.length || alarmsOut.toAdd.length || eventsOut.toAdd.length) {
                const alarmMsg = (alarmsOut.toUpdate.length || alarmsOut.toAdd.length) ?
                    {payload: alarmsOut, topic: config.alarmTopic} : null;

                const eventMsg = (eventsOut.toAdd.length) ?
                    {payload: eventsOut, topic: config.eventTopic} : null;

                const alarmsCountMsg = alarmMsg ?
                    {payload: countActiveAlarms(), topic: "__active_alarms_count__"} : null;

                node.send([alarmMsg, eventMsg, alarmsCountMsg]);
            }
        });


        function alarmChecker(eventConfig : IEventConfig, tagName: string, val: number,
                              result: {toAdd: IEventRecord[], toUpdate?: IEventRecord[]}, isAlarm: boolean)
        {
            const {eqName, alarmParams, eventParams} = eventConfig;

            const configParam = isAlarm ? alarmParams : eventParams;
            const ts = Date.now();

            for (const [i, eventParam] of configParam.entries()) {
                const event: IEventRecord = {
                    ts, eqName, tagName,
                    triggerCond: {...eventParam.onTrigger},
                    eventId: tagName + "::" + eventParam.type + "::" + i,
                    isActive: false,
                    type: eventParam.type,
                    desc: eventParam.desc
                };

                const isTriggered = EventConfig.isAlarmTriggered(val, eventParam);
                if (isTriggered == null) return;

                if (isAlarm) {
                    const type = event.type as AlarmType;
                    const isActive =  activeAlarms[node.id][type][event.eventId];

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

        /**
         * returns example {F:2, I:1, W:2}
         */
        function countActiveAlarms() {
            const out: {[key: string]: number} = {};
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
                activeAlarms[node.id] = {F: {}, I: {}, W: {}};

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


            return false;
        }

        function checkTopicAndSend(msg: any): boolean {

            if (msg.topic === "__get_remembered_values__") {
                node.send([null, null, {payload: plcTagValuesState, topic: msg.topic}]);
                return true;
            }


            if (msg.topic === "__get_config__") {
                node.send([null, null, {payload: eventConfigs, topic: msg.topic}]);
                return true;
            }

            if (msg.topic === "__get_active_alarms__") {
                node.send([null, null, {payload: activeAlarms[node.id], topic: msg.topic}]);
                return true;
            }

            if (msg.topic === "__get_setpoints__") {
                node.send([null, null, {payload: eventConfig.setpoints, topic: msg.topic}]);
                return true;
            }

            return false;
        }

    }
    // @ts-ignore
    RED.nodes.registerType("cx_alarm_log", AlarmLogNode);
}