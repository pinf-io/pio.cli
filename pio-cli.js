
const PATH = require("path");
const FS = require("fs-extra");
const COMMANDER = require("commander");
const COLORS = require("colors");
const Q = require("q");
const PIO = require("pio");
const EXEC = require("child_process").exec;
const WAITFOR = require("waitfor");
const SPAWN = require("child_process").spawn;


COLORS.setTheme({
    error: 'red'
});


function install(pio) {

    function loadPackageDescriptor(serviceBasePath) {
        function loadDescriptor(path, callback) {
            return FS.readJson(path, function(err, descriptor) {
                if (err) return callback(err);
                descriptor._path = path;
                return callback(null, descriptor);
            });
        }
        return Q.denodeify(function(callback) {
            // TODO: Look at `directories` property to determine where to look for sources.
            var packageDescriptorPath = PATH.join(serviceBasePath, "source/package.json");
            return FS.exists(packageDescriptorPath, function(exists) {
                if (exists) {
                    return loadDescriptor(packageDescriptorPath, callback);
                }
                packageDescriptorPath = PATH.join(serviceBasePath, "package.json");
                return FS.exists(packageDescriptorPath, function(exists) {
                    if (exists) {
                        return loadDescriptor(packageDescriptorPath, callback);
                    }
                    return callback(null, null);                    
                });
            });
        })();
    }

    function install(descriptor, services) {
        return Q.denodeify(function(callback) {
            var sourcePath = PATH.dirname(descriptor._path);
            var realSourcePath = FS.realpathSync(sourcePath);
            var realSeedPath = FS.realpathSync(PATH.dirname(pio._configPath));
            if (realSourcePath.substring(0, realSeedPath.length) !== realSeedPath) {
                console.log(("Skip install package '" + sourcePath + "' as it is linked from: " + realSourcePath).yellow);
                return callback(null);
            }
            if (descriptor.dependencies) {
                for (var name in descriptor.dependencies) {
                    if (services[name]) {
                        var linkPath = PATH.join(sourcePath, "node_modules", name);
                        console.log("Linking '" + PATH.dirname(services[name]._path) + "' to '" + linkPath + "'.");
                        if (!FS.existsSync(PATH.dirname(linkPath))) {
                            FS.mkdirsSync(PATH.dirname(linkPath));
                        } else
                        if (FS.existsSync(linkPath)) {
                            FS.removeSync(linkPath);
                        }
                        FS.symlinkSync(PATH.dirname(services[name]._path), linkPath);
                    }
                }
            }
            console.log(("Calling `npm install` for: " + sourcePath).magenta);
            var proc = SPAWN("npm", [
                "install"
            ], {
                cwd: sourcePath
            });
            proc.stdout.on('data', function (data) {
                process.stdout.write(data);
            });
            proc.stderr.on('data', function (data) {
                process.stderr.write(data);
            });
            proc.on('close', function (code) {
                if (code !== 0) {
                    console.error("ERROR: `npm install` exited with code '" + code + "'");
                    return callback(new Error("`npm install` script exited with code '" + code + "'"));
                }
                console.log(("`npm install` for '" + sourcePath + "' done!").green);
                return callback(null);
            });
        })().fail(function(err) {
            if (err.code === "EACCES") {
                console.log(("Ignore install error '" + err.message + "'. We are assuming everything was installed in previous run before being set to read-only.").yellow);
                return;
            }
            throw err;
        });
    }

    var services = {};
    var all = [];    
    Object.keys(pio._config.services).forEach(function(serviceGroup) {
        Object.keys(pio._config.services[serviceGroup]).forEach(function(serviceAlias) {            
            if (pio._config.services[serviceGroup][serviceAlias].enabled === false) {
                return;
            }
            if (pio._config.services[serviceGroup][serviceAlias].install !== true) {
                return;
            }
            all.push(loadPackageDescriptor(PATH.join(pio._configPath, "..", "_upstream", serviceAlias)).then(function(descriptor) {
                if (descriptor) {
                    if (descriptor.pm === "npm") {
                        services[serviceAlias] = descriptor;
                    }
                }
            }));
            all.push(loadPackageDescriptor(PATH.join(pio._configPath, "..", pio._config.config["pio"].servicesPath, serviceGroup, serviceAlias)).then(function(descriptor) {
                if (descriptor) {
                    if (descriptor.pm === "npm") {
                        services[serviceAlias] = descriptor;
                    }
                }
            }));
        });
    });
    return Q.all(all).then(function() {
        var all = [];
        Object.keys(services).forEach(function(serviceAlias) {
            all.push(install(services[serviceAlias], services));
        });
        return Q.all(all).then(function() {
            return Q.denodeify(function(callback) {
                return EXEC([
                    'chmod -Rf 0544 _upstream',
                    'find _upstream -type f -iname "*" -print0 | xargs -I {} -0 chmod 0444 {}',
                    'find _upstream/* -maxdepth 1 -type d -print0 | xargs -I {} -0 chmod u+w {}'
                ].join("\n"), {
                    cwd: PATH.dirname(pio._configPath)
                }, function(err, stdout, stderr) {
                    if (err) {
                        console.error(stdout);
                        console.error(stderr);
                        return callback(err);
                    }
                    return callback(null);
                });
            })();
        });
    });
}


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

        var pio = new PIO(process.env.PIO_SEED_PATH || process.cwd());

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
                .command("deploy [service-selector]")
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
                .command("info [service-selector]")
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
                .command("status [service-selector]")
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
                .command("test [service-selector]")
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
                .command("publish [service-selector]")
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
                .command("install")
                .description("Install local tools")
                .action(function() {
                    acted = true;
                    return pio.ready().then(function() {
                        return install(pio);
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
                        'sudo rm -Rf .pio.*',
                        'sudo rm -Rf */.pio.*',
                        'sudo rm -Rf */*/.pio.*',
                        'sudo rm -Rf */*/*/.pio.*',
                        'sudo rm -Rf */*/*/*/.pio.*'
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
