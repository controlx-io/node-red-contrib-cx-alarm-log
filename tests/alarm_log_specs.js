const should = require("should");
const helper = require("node-red-node-test-helper");
const alarmLogNode = require("../nodes/alarm_log");

helper.init(require.resolve("node-red"), {
    logging: {
        console: { level: "info"}
    }
});

describe('Alarm Log Node', function () {

    beforeEach(function (done) {
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it("should be loaded", function (done) {
        const flow = [{ id: "n1", type: "cx_alarm_log", name: "Alarm Log" }];
        helper.load(alarmLogNode, flow, function () {
            const n1 = helper.getNode("n1");
            if (!n1) return done(new Error("The Node doesn't exist"));

            try {
                n1.should.have.property("name", "Alarm Log");
                done();
            } catch (err) {
                done(err);
            }
        });
    });

    it("should 'warn' on empty config dut to wrong tag config path", function(done) {
        const flow = [{
            id: "n1",
            type: "cx_alarm_log",
            name: "Alarm Log",
            isMochaTesting: true,
            path: "../_config/tag_conf_1.csv",
        }];
        helper.load(alarmLogNode, flow, function () {
            const n1 = helper.getNode("n1");

            n1.on('input', () => {
                n1.warn.should.be.calledWithExactly("Event config is empty.");
                done();
            });
            n1.receive({payload: true});
        });
    })

    it("should 'warn' on wrong payload", function(done) {
        const flow = [{
            id: "n1",
            type: "cx_alarm_log",
            name: "Alarm Log",
            isMochaTesting: true,
            path: "../_config/tag_conf.csv",
        }];
        helper.load(alarmLogNode, flow, function () {
            const n1 = helper.getNode("n1");

            n1.on('input', () => {
                n1.warn.should.be.calledWithExactly("Incorrect Payload data type: true");
                done();
            });
            n1.receive({payload: true});
        });
    })


    it("should send config on output 3 when loaded", function(done) {
        const flow = [{
            id: "n1",  wires:[[], ["n2"]],
            type: "cx_alarm_log",
            name: "Alarm Log",
            isMochaTesting: true,
            path: "../_config/tag_conf.csv",
        }, { id: "n2", type: "helper" }];
        helper.load(alarmLogNode, flow, function () {
            const n1 = helper.getNode("n1");
            const n2 = helper.getNode("n2");

            n2.on("input", function (msg) {
                console.log(JSON.stringify(msg, null, 2));
                // msg.should.have.property("payload", ["tag1"]);
                done();
            });
            n1.receive({topic: "__send_config__"});
        });
    })

    // it("should send output on input message", function(done) {
    //     const flow = [{
    //         id: "n1",  wires:[["n2"]],
    //         type: "cx_alarm_log",
    //         name: "Alarm Log",
    //         isMochaTesting: true,
    //         path: "../_config/tag_conf.csv",
    //     }, { id: "n2", type: "helper" }];
    //     helper.load(alarmLogNode, flow, function () {
    //         const n1 = helper.getNode("n1");
    //         const n2 = helper.getNode("n2");
    //
    //         n2.on("input", function (msg) {
    //             msg.should.have.property("payload", ["tag1"]);
    //             done();
    //         });
    //         n1.receive({payload: {tag1: true}});
    //     });
    // })

});
