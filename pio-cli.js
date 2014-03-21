
const PATH = require("path");
const FS = require("fs-extra");
const COMMANDER = require("commander");
const COLORS = require("colors");
const Q = require("q");
const PIO = require("pio");
const EXEC = require("child_process").exec;


COLORS.setTheme({
    error: 'red'
});


if (require.main === module) {

    function error(err) {
        if (typeof err === "string") {
            console.error((""+err).red);
        } else
        if (typeof err === "object" && err.stack) {
            console.error((""+err.stack).red);
        }
        process.exit(1);
    }

    try {

        var pio = new PIO(process.cwd());

        function ensure(program, serviceSelector, options) {
            options = options || {};
            if (program.force) {
                options.force = program.force;
            }
            return pio.ready().then(function() {
                return pio.ensure(serviceSelector, options);
            });
        }

        return Q.denodeify(function(callback) {

            var program = new COMMANDER.Command();

            program
                .version(JSON.parse(FS.readFileSync(PATH.join(__dirname, "package.json"))).version)
                .option("-v, --verbose", "Show verbose progress")
                .option("--debug", "Show debug output")
                .option("-f, --force", "Force an operation when it would normally be skipped");

            var acted = false;

            program
                .command("list [filter]")
                .description("List services")
                .action(function(path) {
                    acted = true;
                    return ensure(program, null).then(function() {
                        return pio.list().then(function(list) {
                            list.forEach(function(service) {
                                console.log(service);
                            });
                        });
                    }).then(function() {
                        return callback(null);
                    }).fail(callback);
                });

            program
                .command("deploy [service selector]")
                .description("Deploy a service")
                .action(function(selector) {
                    acted = true;
                    return ensure(program, selector).then(function() {
                        return pio.deploy();
                    }).then(function() {
                        return callback(null);
                    }).fail(callback);
                });

            program
                .command("info [service selector]")
                .description("Config and runtime info")
                .action(function(selector) {
                    acted = true;
                    return ensure(program, selector).then(function() {
                        return pio.info().then(function(info) {
                            console.log(JSON.stringify(info, null, 4));
                            return;
                        });
                    }).then(function() {
                        return callback(null);
                    }).fail(callback);
                });

            program
                .command("status [service selector]")
                .description("Get the status of a service")
                .action(function(selector) {
                    acted = true;
                    return ensure(program, selector).then(function() {
                        return pio.status().then(function(status) {
                            console.log(JSON.stringify(status, null, 4));
                            return;
                        });
                    }).then(function() {
                        return callback(null);
                    }).fail(callback);
                });

            program
                .command("test [service selector]")
                .description("Test a service")
                .action(function(selector) {
                    acted = true;
                    return ensure(program, selector).then(function() {
                        return pio.test().then(function(status) {
                            console.log(JSON.stringify(status, null, 4));
                            return;
                        });
                    }).then(function() {
                        return callback(null);
                    }).fail(callback);
                });

            program
                .command("publish [service selector]")
                .description("Publish a service")
                .action(function(selector) {
                    acted = true;
                    return ensure(program, selector).then(function() {
                        return pio.publish();
                    }).then(function() {
                        return callback(null);
                    }).fail(callback);
                });

            program
                .command("clean")
                .description("Clean all cache information forcing a fresh fetch on next run")
                .action(function() {
                    acted = true;
                    return EXEC([
                        'rm -Rf .pio.*',
                        'rm -Rf */.pio.*',
                        'rm -Rf */*/.pio.*',
                        'rm -Rf */*/*/.pio.*',
                        'rm -Rf */*/*/*/.pio.*'
                    ].join("; "), {
                        cwd: PATH.dirname(pio._configPath)
                    }, function(err, stdout, stderr) {
                        if (err) {
                            console.error(stdout);
                            console.error(stderr);
                            return callback(err);
                        }
                        console.log("All cache files cleaned!".green);
                        return callback(null);
                    });
                });

            program
                .command("gen-uuid")
                .description("Generate a new v4 UUID")
                .action(function() {
                    acted = true;
                    console.log(pio.API.UUID.v4());
                    return callback(null);
                });

            program.parse(process.argv);

            if (!acted) {
                var command = process.argv.slice(2).join(" ");
                if (command) {
                    console.error(("ERROR: Command '" + process.argv.slice(2).join(" ") + "' not found!").error);
                }
                program.outputHelp();
                return callback(null);
            }
        })().then(function() {
            return pio.shutdown().then(function() {

                // NOTE: We force an exit here as for some reason it hangs when there is no server.
                // TODO: Try and do low-level connect to IP first.

                return process.exit(0);
            });
        }).fail(error);
    } catch(err) {
        return error(err);
    }
}
