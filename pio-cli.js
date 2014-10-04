
const PATH = require("path");
const FS = require("fs-extra");
const COMMANDER = require("commander");
const CRYPTO = require("crypto");
const COLORS = require("colors");
const Q = require("q");
const PIO = require("pio");
const EXEC = require("child_process").exec;
const WAITFOR = require("waitfor");
const SPAWN = require("child_process").spawn;
const ASYNC = require("async");
const CLI_TABLE = require("cli-table");
const INQUIRER = require("inquirer");


COLORS.setTheme({
    error: 'red'
});


function spin(pio) {

    var FS_CONCURRENCY = 30;
    var CHECK_FREQUENCY_COMPLETE = 5 * 1000;
    var CHECK_FREQUENCY_SHORTLIST = 1 * 1000;

    function doIndex(pio) {

        var checkShortlistInterval = null;

        function index() {
            var deferred = Q.defer();
            var filelists = {};    
            var waitfor = WAITFOR.parallel(function(err) {
                if (err) return deferred.reject(err);
                return deferred.resolve(filelists);
            });
            function loadFileList(serviceId, path, callback) {
                return FS.exists(path, function(exists) {
                    if (!exists) {
                        return callback(null);
                    }
                    return FS.readJson(path, function(err, _filelist) {
                        if (err) return callback(err);

                        var originalPath = PATH.join(
                            pio._state["pio.services"].services[serviceId].path,
                            PATH.basename(PATH.dirname(path))
                        );
                        if (!FS.existsSync(originalPath)) {
                            originalPath = PATH.dirname(originalPath);
                        }

                        if (!filelists[serviceId]) {
                            filelists[serviceId] = [];
                        }

                        filelists[serviceId].push({
                            path: originalPath,
                            aspect: PATH.basename(PATH.dirname(path)),
                            filelist: _filelist
                        });
                        return callback(null);
                    });
                });
            }
            Object.keys(pio._state["pio.services"].services).forEach(function(serviceId) {
                if (pio._state["pio.services"].services[serviceId].enabled === false) {
                    return;
                }
                waitfor(function(callback) {
                    return loadFileList(serviceId, PATH.join(pio._configPath, "../.pio.sync", serviceId, "source", ".pio.filelist"), function(err) {
                        if (err) return callback(err);
                        return loadFileList(serviceId, PATH.join(pio._configPath, "../.pio.sync", serviceId, "scripts", ".pio.filelist"), callback);
                    });
                });
            });
            waitfor();
            return deferred.promise;
        }


        var shortlist = {};
        var pending = {};

        var pendingSync = null;
        function syncPending() {
            if (pendingSync !== null) {
                return;
            }
            pendingSync = setTimeout(function() {
                var filepaths = pending;
                pending = {};

                var all = [];
                var services = {};
                function uploadFile(task) {
                    var targetPath = "/opt/services/" + task.serviceId + "/live/" + ((task.aspect) ? "install" : task.aspect) + task.relpath;
                    return Q.denodeify(FS.lstat)(task.path).then(function(stats) {
                        if (stats.isSymbolicLink()) {
                            console.log(("Skip '" + task.path + "'. It is a symlink.").yellow);
                            return false;
                        }
                        if (stats.isFile()) {
                            return Q.denodeify(FS.readFile)(task.path).then(function(body) {
                                console.log(("Uploading '" + task.path + "' to '" + targetPath + "' ...").magenta);
                                return pio._state["pio.deploy"]._call("_putFile", {
                                    path: targetPath,
                                    body: body.toString("base64")
                                }).then(function(response) {
                                    if (response !== true) {
                                        throw Error("Error uploading!");
                                        if (response === null) {
                                            throw "Cannot connect to VM!";
                                        }
                                    }
                                    console.log(("Uploaded '" + task.path + "' to '" + targetPath + "' done!").green);
                                    services[task.serviceId] = true;
                                });
                            }).fail(function(err) {
                                console.error("Error uploading file for:", task.serviceId);
                                throw err;                        
                            });
                        } else {
    //                        console.error(("NOTE: Run `pio deploy " + task.serviceId + "` to deploy new files!").red);

                            console.log(("Triggering full deploy for service '" + task.serviceId + "' as new files were found!").magenta);                        
                            var servicePio = new PIO(process.env.PIO_SEED_PATH || process.cwd());
                            return servicePio.ready().then(function() {
                                return servicePio.ensure(task.serviceId, {}).then(function() {
                                    return servicePio.deploy();
                                });
                            }).then(function() {

                                // Stop our current watcher before starting another one.
                                clearInterval(checkShortlistInterval);

                                return doIndex(pio);
                            });
                        }
                    });
                }
                for (var path in filepaths) {
                    all.push(uploadFile(filepaths[path]));
                }
                return Q.all(all).then(function() {
                    var all = [];
                    Object.keys(services).forEach(function(serviceId) {
                        console.log(("Trigger restart script for service '" + serviceId + "'.").magenta);

                        return pio.ensure(serviceId).then(function() {

                            // TODO: Notify service more gently to see if it can reload first before issuing a full restart.
                            return pio.restart();
                        }).fail(function(err) {
                            console.error("Error ensuring service:", serviceId);
                            throw err;                        
                        });
                    });
                    return Q.all(all);
                }).fail(function(err) {
                    console.error(("Error syncing file: " + err.stack).red);
                }).then(function() {
                    pendingSync = null;
                });
            }, 1 * 1000);
        }

        function notifyChanged(task) {
            shortlist[task.path] = true;
            pending[task.path] = task;
            syncPending();
        }

        var _checkIfChanged_running = {};
        function checkIfChanged(filelists, mode) {
            if (_checkIfChanged_running[mode]) {
                return Q.resolve();
            }
            _checkIfChanged_running[mode] = true;
            var deferred = Q.defer();
            var q = ASYNC.queue(function (task, callback) {
                return FS.stat(task.path, function(err, stat) {
                    if (err) {
                        // For now we ignore missing files as some paths are still wrong.
                        if (err.code === "ENOENT") {
                            return callback(null, null);
                        }
                        return callback(err);
                    } else
                    if (stat.size !== task.size) {
                        // HACK: This file changes even though no FS changes happened.
                        // TODO: Need to exclude this file.
                        if (PATH.basename(task.path) === ".smi.json") {
                            return callback(null, null);
                        }
                        console.log(("File '" + task.path + "' changed (size before: " + task.size + "; size after: " + stat.size + ")").magenta);
                        notifyChanged(task);
                        return callback(null, stat.size);
                    }
                    return callback(null, null);
                });
            }, FS_CONCURRENCY);
            function finalize() {
                _checkIfChanged_running[mode] = false;
                return deferred.resolve();
            }
            q.drain = finalize;
            var path = null;
            var queued = false;
            for (var serviceId in filelists) {
                filelists[serviceId].forEach(function(info) {
                    for (var relpath in info.filelist) {
                        function check(serviceId, relpath, info) {

                            if (mode === "shortlist") {
                                if (!shortlist[info.path + relpath]) {
                                    return;
                                }
                            } else
                            if (mode === "complete") {
                                if (shortlist[info.path + relpath]) {
                                    return;
                                }
                            }

                            queued = true;

                            q.push({
                                serviceId: serviceId,
                                relpath: relpath,
                                path: info.path + relpath,
                                aspect: info.aspect,
                                size: info.filelist[relpath].size
                            }, function(err, newSize) {
                                if (err) {
                                    return deferred.reject(err);
                                }
                                if (newSize) {
                                    info.filelist[relpath].size = newSize;
                                }
                                // Nothing more to do here.
                                return;
                            });
                        }
                        check(serviceId, relpath, info);
                    }
                });
            }
            if (!queued) {
                finalize();
            }
            return deferred.promise;
        }

        return index().then(function(filelists) {
            var counts = {
                services: 0,
                files: 0
            };
            for (var serviceId in filelists) {
                counts.services += 1;
                filelists[serviceId].forEach(function(info) {
                    counts.files += Object.keys(info.filelist).length;
                });
            }
            if (pio._state["pio.cli.local"].verbose) {
                console.log(JSON.stringify(filelists, null, 4));
            }            
            console.log(("Watching '" + counts.files + "' files for '" + counts.services + "' services ...").yellow);

            // We return a promise that never resolves (unless error) as we want to keep process running.
            var deferred = Q.defer();

            var checkCompleteInterval = null;
            function checkComplete() {
                return checkIfChanged(filelists, "complete").fail(function(err) {
                    clearInterval(checkCompleteInterval);
                    return deferred.reject(err);
                });
            }
            checkCompleteInterval = setInterval(function() {
                return checkComplete();
            }, CHECK_FREQUENCY_COMPLETE);
            checkComplete();

            function checkShortlist() {
                return checkIfChanged(filelists, "shortlist").fail(function(err) {
                    clearInterval(checkShortlistInterval);
                    return deferred.reject(err);
                });
            }
            checkShortlistInterval = setInterval(function() {
                return checkShortlist();
            }, CHECK_FREQUENCY_SHORTLIST);
            checkShortlist();

            return deferred.promise;
        });
    }

    return doIndex(pio);
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
            options.force = program.force || false;
            options.verbose = program.verbose || program.debug || false;
            options.debug = program.debug || false;
            options.silent = program.silent || false;
            return pio.ensure(serviceSelector, options);
        }

        return pio.ready().then(function() {

            return Q.denodeify(function(callback) {

                var program = new COMMANDER.Command();

                program
                    .version(JSON.parse(FS.readFileSync(PATH.join(__dirname, "package.json"))).version)
                    .option("-v, --verbose", "Show verbose progress")
                    .option("-d, --debug", "Show debug output")
                    .option("-s, --silent", "Show no output")
                    .option("-f, --force", "Force an operation when it would normally be skipped");

                var acted = false;

                program
                    .command("list [filter]")
                    .description("List services")
                    .action(function(path) {
                        acted = true;
                        if (!pio._config.config["pio.vm"].ip) {
                            return callback("Instance not running! Create instance by calling 'pio deploy'.");
                        }
                        return ensure(program, null).then(function() {
                            return pio.list().then(function(list) {

                                // TODO: Get plugins without having to ensure `pio.server`.
                                //       The plugins should already be accessible and summarized by now.
                                return ensure(program, "pio.server").then(function() {
                                    var table = new CLI_TABLE({
                                        chars: {'mid': '', 'left-mid': '', 'mid-mid': '', 'right-mid': ''},
                                        head: ['Group', 'Service', 'Host'],
                                        colWidths: [30, 40, 80]
                                    });
                                    list.forEach(function(service) {
                                        var hostname = "";
                                        if (
                                            pio._state['pio.service.deployment']['config.plugin'][service.id] &&
                                            pio._state['pio.service.deployment']['config.plugin'][service.id].vhosts
                                        ) {
                                            hostname = Object.keys(pio._state['pio.service.deployment']['config.plugin'][service.id].vhosts).map(function(hostname) {
                                                return hostname + ":"+ pio._config.services["0-pio"]["pio.server"].env.PORT;
                                            }).join(", ");
                                        }
                                        table.push([
                                            service.group,
                                            service.id,
                                            hostname
                                        ]);
                                    });
        
                                    process.stdout.write(table.toString() + "\n");
                                });
                            });
                        }).then(function() {
                            return callback(null);
                        }).fail(callback);
                    });

                program
                    .command("deploy [service-selector]")
                    .option("--no-build-cache", "Don't download assets from build cache")
                    .description("Deploy a service")
                    .action(function(selector, options) {
                        acted = true;
                        return ensure(program, selector).then(function() {
                            return pio.deploy({
                                buildCache: options.buildCache
                            });
                        }).then(function() {
                            return callback(null);
                        }).fail(callback);
                    });

                program
                    .command("info [service-selector]")
                    .option("--variable <selector>", "Return specific variable value only")
                    .description("Useful information")
                    .action(function(selector, options) {
                        acted = true;
                        return ensure(program, selector).then(function() {
                            return pio.info().then(function(info) {
                                if (options.variable) {
                                    eval('process.stdout.write(info.' + options.variable + ');');
                                } else {
                                    console.log("For docs on how workspaces are initialized see: https://gist.github.com/cadorn/73609798c63c60489b63");
                                    for (var group in info) {
                                        console.log((group).bold);
                                        for (var name in info[group]) {
                                            if (info[group].hasOwnProperty(name)) {
                                                console.log("  " + name + ": " + (""+info[group][name]).yellow);
                                            }
                                        }
                                    }
                                }
                                return;
                            });
                        }).then(function() {
                            return callback(null);
                        }).fail(callback);
                    });

                program
                    .command("config [service-selector]")
                    .option("--variable <selector>", "Return specific variable value only")
                    .description("Config and runtime info")
                    .action(function(selector, options) {
                        acted = true;
                        if (!pio._config.config["pio.vm"].ip) {
                            return callback("Instance not running! Create instance by calling 'pio deploy'.");
                        }
                        return ensure(program, selector).then(function() {
                            return pio.config().then(function(config) {
                                if (options.variable) {
                                    eval('process.stdout.write(config.' + options.variable + ');');
                                } else {
                                    console.log(JSON.stringify(config, null, 4));
                                }
                                return;
                            });
                        }).then(function() {
                            return callback(null);
                        }).fail(callback);
                    });

                program
                    .command("status [service-selector]")
                    .description("Get the status of a service")
                    .action(function(selector, options) {
                        acted = true;
                        if (!pio._config.config["pio.vm"].ip) {
                            return callback("Instance not running! Create instance by calling 'pio deploy'.");
                        }
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
                    .option("--local", "Run local tests instead of calling instance.")
                    .option("--cycle [delay]", "Run tests again after specified delay (in seconds).")
                    .description("Test a service")
                    .action(function(selector, options) {
                        acted = true;
                        if (!pio._config.config["pio.vm"].ip) {
                            return callback("Instance not running! Create instance by calling 'pio deploy'.");
                        }
                        return ensure(program, selector).then(function() {
                            return pio.test({
                                local: options.local || false,
                                cycle: (options.cycle && (options.cycle === true ? 3 : parseInt(options.cycle) || 3)) || false
                            }).then(function(status) {
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
                        if (!pio._config.config["pio.vm"].ip) {
                            return callback("Instance not running! Create instance by calling 'pio deploy'.");
                        }
                        return ensure(program, selector).then(function() {
                            return pio.publish();
                        }).then(function() {
                            return callback(null);
                        }).fail(callback);
                    });

                program
                    .command("start <service-selector>")
                    .description("Start a service")
                    .action(function(selector) {
                        acted = true;
                        if (!pio._config.config["pio.vm"].ip) {
                            return callback("Instance not running! Create instance by calling 'pio deploy'.");
                        }
                        return ensure(program, selector).then(function() {
                            return pio.start();
                        }).then(function() {
                            return callback(null);
                        }).fail(callback);
                    });

                program
                    .command("stop <service-selector>")
                    .description("Stop a service")
                    .action(function(selector) {
                        acted = true;
                        if (!pio._config.config["pio.vm"].ip) {
                            return callback("Instance not running! Create instance by calling 'pio deploy'.");
                        }
                        return ensure(program, selector).then(function() {
                            return pio.stop();
                        }).then(function() {
                            return callback(null);
                        }).fail(callback);
                    });

                program
                    .command("restart <service-selector>")
                    .description("Restart a service")
                    .action(function(selector) {
                        acted = true;
                        if (!pio._config.config["pio.vm"].ip) {
                            return callback("Instance not running! Create instance by calling 'pio deploy'.");
                        }
                        return ensure(program, selector).then(function() {
                            return pio.restart();
                        }).then(function() {
                            return callback(null);
                        }).fail(callback);
                    });

                program
                    .command("spin")
                    .description("Watch source code, sync and reload service on every change")
                    .action(function() {
                        acted = true;
                        if (!pio._config.config["pio.vm"].ip) {
                            return callback("Instance not running! Create instance by calling 'pio deploy'.");
                        }
                        return ensure(program, null).then(function() {
                            return spin(pio);
                        }).then(function() {
                            return callback(null);
                        }).fail(callback);
                    });

                program
                    .command("open")
                    .description("Open instance admin")
                    .action(function() {
                        acted = true;
                        if (!pio._config.config["pio.vm"].ip) {
                            return callback("Instance not running! Create instance by calling 'pio deploy'.");
                        }
                        return ensure(program, null).then(function() {
                            return pio.open();
                        }).then(function() {
                            return callback(null);
                        }).fail(callback);
                    });

                program
                    .command("clean")
                    .option("--dns", "Flush DNS cache (requires sudo)")
                    .option("--terminate", "Terminate the instance")
                    .option("--noclean", "Do not clean")
                    .description("Clean all cache information forcing a fresh fetch on next run")
                    .action(function(options) {
                        acted = true;
                        var commands = [];
                        if (!options.noclean) {
                            commands = commands.concat([
                                'echo "You can always delete and re-create with \'smi install\'" > /dev/null',
                                'rm -Rf _upstream',
                                'rm -Rf node_modules',
                                'rm -Rf services/*/*/node_modules',
                                'rm -Rf services/*/*/*/node_modules',
                                'rm -Rf services/*/*/*/*/node_modules',
                                'rm -Rf services/*/*/_packages',
                                'rm -Rf services/*/*/*/_packages',
                                'rm -Rf services/*/*/*/*/_packages',
                                'echo "Remove cache files that will get re-created" > /dev/null',
                                'rm -Rf services/*/*/.pio.cache',
                                'rm -Rf *.json~extends~*'
                            ]);
                        }
                        if (options.dns) {
                            commands = commands.concat([
                                'echo "Flush DNS cache" > /dev/null',
                                'sudo killall -HUP mDNSResponder',
                                'sudo dscacheutil -flushcache'
                            ]);
                        }
                        function clean(callback) {
                            console.log(commands.join("\n").magenta);
                            return EXEC(commands.join("; "), {
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
                        }
                        if (options.terminate) {
                            return ensure(program, null, {
                                "state": {
                                    "pio.vm": {
                                        "required": false,
                                        "skip": [
                                            "provision"
                                        ]
                                    },
                                    "pio.dns": {
                                        "required": false,
                                        "skip": [
                                            "provision"
                                        ]
                                    }
                                }
                            }).then(function() {
                                return Q.denodeify(function(callback) {

                                    if (!pio._state["pio.vm"].ip) {
                                        return callback("Cannot terminate. Cannot determine IP! Does VM at '" + pio._state["pio"].hostname + "' have an IP yet?");
                                    }

                                    var code = ""+(""+Math.random()).substring(5, 8);

                                    console.log("");
                                    console.log("Are you " + "ABSOLUTELY".bold + " sure you want to " + "FOREVER DESTROY".bold + " the VM at\n  " + (""+pio._state["pio.vm"].ip).red.bold + " <- " + (""+pio._state["pio"].hostname).red.bold + "\nand ALL DATA on it?");
                                    console.log("");

                                    return INQUIRER.prompt([
                                        {
                                            name: "destroy",
                                            type: "input",
                                            message: "If so enter " + code.bold.red
                                        }
                                    ], function(answers) {

                                        if (answers["destroy"] !== code) {
                                            console.log("Aborted.");
                                            return callback(true);
                                        }

                                        return pio.terminate(pio._state["pio.vm"].ip).then(function() {
                                            return callback(null);
                                        }).fail(callback);
                                    });
                                })();
                            }).then(function() {
                                return clean(callback);
                            }).fail(callback);
                        }
                        return clean(callback);
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
            })();
        }).then(function() {
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
