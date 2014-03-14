
const ASSERT = require("assert");
const PIO = require("./pio");


describe("pio", function() {

    it("status", function(done) {
        return PIO.pio().status().then(function (status) {

            console.log("status", status);

            return done();
        }).fail(done);
    });

    it("list", function(done) {
        return PIO.pio().list().then(function (services) {

            console.log("services", services);

            return done();
        }).fail(done);
    });

    it("ensure", function(done) {
        return PIO.pio().ensure({}).then(function (runtimeConfig) {

            console.log("runtimeConfig", runtimeConfig);

            return done();
        }).fail(done);
    });

});

