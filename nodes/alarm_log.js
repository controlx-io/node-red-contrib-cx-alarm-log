"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const tools_1 = require("./tools");
const path = __importStar(require("path"));
module.exports = function (RED) {
    const plcTagValuesState = {};
    const activeAlarms = {};
    function AlarmLogNode(config) {
        let eventConfigs = [];
        RED.nodes.createNode(this, config);
        const node = this;
        activeAlarms[node.id] = { F: {}, I: {}, W: {} };
        const logger = new tools_1.Logger(node, config.isDebug || config.isMochaTesting);
        const eventConfig = new tools_1.EventConfig(logger);
        if (config.path && typeof config.path === "string") {
            try {
                const fileWorkingDirectory = config.isMochaTesting ? __dirname : RED.settings.fileWorkingDirectory;
                let fullFilename = config.path;
                if (config.path && fileWorkingDirectory && !path.isAbsolute(config.path)) {
                    fullFilename = path.resolve(path.join(fileWorkingDirectory, config.path));
                }
                const conf = eventConfig.parseConfig(fullFilename);
                eventConfigs = conf.body;
                logger.debug(`Config v.${conf.meta.version ? conf.meta.version : "'NOT IN META'"} is set.`);
            }
            catch (e) {
                logger.error(e);
            }
        }
        node.on("input", (msg) => {
            const isSent = checkTopicAndSend(msg);
            const isSet = checkTopicAndSet(msg);
            if (isSent || isSet)
                return;
            if (!Object.keys(eventConfigs).length)
                return logger.error(new Error("Event config is empty."));
            if (!(0, tools_1.isObject)(msg.payload)) {
                const errMsg = "Incorrect Payload data type: " + JSON.stringify(msg.payload);
                return logger.error(new Error(errMsg));
            }
            const newValues = (0, tools_1.filterNewValues)(plcTagValuesState, msg.payload);
            if (!newValues)
                return;
            plcTagValuesState[node.id] = Object.assign(Object.assign({}, plcTagValuesState), newValues);
            const alarmsOut = {
                toAdd: [],
                toUpdate: []
            };
            const eventsOut = {
                toAdd: []
            };
            for (const [tagName, newValue] of Object.entries(newValues)) {
                const val = typeof newValue === "boolean" ?
                    (newValue ? 1 : 0) :
                    newValue;
                if (typeof val !== "number" || !Number.isFinite(val))
                    continue;
                const eventConfig = eventConfigs.find(event => event.tagName === tagName);
                if (!eventConfig)
                    continue;
                alarmChecker(eventConfig, tagName, val, alarmsOut, true);
                alarmChecker(eventConfig, tagName, val, eventsOut, false);
            }
            if (alarmsOut.toUpdate.length || alarmsOut.toAdd.length || eventsOut.toAdd.length) {
                const alarmMsg = (alarmsOut.toUpdate.length || alarmsOut.toAdd.length) ?
                    { payload: alarmsOut, topic: config.alarmTopic } : null;
                const eventMsg = (eventsOut.toAdd.length) ?
                    { payload: eventsOut, topic: config.eventTopic } : null;
                const alarmsCountMsg = alarmMsg ?
                    { payload: countActiveAlarms(), topic: "__active_alarms_count__" } : null;
                node.send([alarmMsg, eventMsg, alarmsCountMsg]);
            }
        });
        function alarmChecker(eventConfig, tagName, val, result, isAlarm) {
            const { eqName, alarmParams, eventParams } = eventConfig;
            const configParam = isAlarm ? alarmParams : eventParams;
            const ts = Date.now();
            for (const [i, eventParam] of configParam.entries()) {
                const event = {
                    ts, eqName, tagName,
                    triggerCond: Object.assign({}, eventParam.onTrigger),
                    eventId: tagName + "::" + eventParam.type + "::" + i,
                    isActive: false,
                    type: eventParam.type,
                    desc: eventParam.desc
                };
                const isTriggered = tools_1.EventConfig.isAlarmTriggered(val, eventParam);
                if (isTriggered == null)
                    return;
                if (isAlarm) {
                    const type = event.type;
                    const isActive = activeAlarms[node.id][type][event.eventId];
                    if (isTriggered === false && !isActive)
                        return;
                    if (isTriggered && isActive)
                        return;
                    if (isActive && result.toUpdate) {
                        result.toUpdate.push(event);
                        delete activeAlarms[node.id][type][event.eventId];
                    }
                    else {
                        event.isActive = true;
                        result.toAdd.push(event);
                        activeAlarms[node.id][type][event.eventId] = event.isActive;
                    }
                }
                else {
                    if (isTriggered)
                        result.toAdd.push(event);
                }
            }
        }
        function countActiveAlarms() {
            const out = {};
            for (const key of Object.keys(activeAlarms[node.id])) {
                out[key] = Object.keys(activeAlarms[node.id][key]).length;
            }
            return out;
        }
        function checkTopicAndSet(msg) {
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
                    if (!activeAlarm.isActive)
                        continue;
                    if (!tools_1.ALARM_TYPES.includes(activeAlarm.type)) {
                        logger.warn(`Alarm prop 'type' must be ${tools_1.ALARM_TYPES.join(",")}, got ` +
                            JSON.stringify(activeAlarm.type));
                        continue;
                    }
                    if (typeof activeAlarm.eventId !== "string") {
                        logger.warn(`Alarm prop 'eventId' must be a string, got ` +
                            JSON.stringify(activeAlarm.eventId));
                        continue;
                    }
                    activeAlarms[node.id][activeAlarm.type][activeAlarm.eventId] = true;
                }
                const count = Object.keys(activeAlarms[node.id].F).length +
                    Object.keys(activeAlarms[node.id].I).length +
                    Object.keys(activeAlarms[node.id].W).length;
                logger.debug(`Set ${count} active alarms`);
                return true;
            }
            if (msg.topic === "__set_setpoints__") {
                const setpoints = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
                for (const setpoint of setpoints) {
                    if (!(0, tools_1.isObject)(setpoint)) {
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
        function checkTopicAndSend(msg) {
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
            return false;
        }
    }
    RED.nodes.registerType("cx_alarm_log", AlarmLogNode);
};
//# sourceMappingURL=alarm_log.js.map