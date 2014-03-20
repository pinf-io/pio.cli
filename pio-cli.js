
const PATH = require("path");
const FS = require("fs-extra");
const COMMANDER = require("commander");
const COLORS = require("colors");
const Q = require("q");
const PIO = require("pio");
const EXEC = require("child_process").exec;
const REQUEST = require("request");


COLORS.setTheme({
    error: 'red'
});



function ensureUpstream(pio) {

    var upstreamBasePath = PATH.join(pio._configPath, "../.upstream");

    function ensureCatalog(alias, info) {
        var catalogBasePath = PATH.join(upstreamBasePath, alias);

        function ensureCatalogDescriptor(verify) {
            var catalogDescriptorPath = PATH.join(catalogBasePath, "pio.catalog.json");
            return Q.denodeify(function(callback) {
                return FS.exists(catalogDescriptorPath, function(exists) {
                    if (exists) {
                        return FS.readJson(catalogDescriptorPath, callback);
                    }
                    if (verify) {
                        return callback(new Error("No catalog descriptor found at '" + catalogDescriptorPath + "' after download!"));
                    }
                    console.log(("Download catalog for alias '" + alias + "' from '" + info.url + "'").magenta);
                    return REQUEST({
                        method: "GET",
                        url: info.url,
                        headers: {
                            "x-auth-code": info.key
                        }
                    }, function(err, response, body) {
                        if (err) return callback(err);
                        try {
                            JSON.parse(body);
                        } catch(err) {
                            console.error("Error parsing catalog JSON!");
                            return callback(err);
                        }
                        return FS.outputFile(catalogDescriptorPath, body, function(err) {
                            if (err) return callback(err);
                            return ensureCatalogDescriptor(true).then(function(catalog) {
                                return callback(null, catalog);
                            }).fail(callback);
                        });
                    });
                });
            })();
        }

        function ensureArchive(archivePath, url) {
            return Q.denodeify(function(callback) {
                return FS.exists(archivePath, function(exists) {
                    if (exists) return callback(null);
                    if (!FS.existsSync(PATH.dirname(archivePath))) {
                        FS.mkdirsSync(PATH.dirname(archivePath));
                    }
                    try {
                        console.log(("Downloading package archive from '" + url + "'").magenta);
                        REQUEST(url, function(err) {
                            if (err) return callback(err);
                            console.log(("Downloaded package archive from '" + url + "'").green);
                            return callback(null);
                        }).pipe(FS.createWriteStream(archivePath))
                    } catch(err) {
                        return callback(err);
                    }
                });
            })();
        }

        function ensureExtracted(packagePath, archivePath) {
            return Q.denodeify(function(callback) {
                return FS.exists(packagePath, function(exists) {
                    if (exists) return callback(null);
                    console.log(("Extract '" + archivePath + "' to '" + packagePath + "'").magenta);
                    if (!FS.existsSync(packagePath)) {
                        FS.mkdirsSync(packagePath);
                    }
                    return EXEC('tar -xzf "' + PATH.basename(archivePath) + '" --strip 1 -C "' + packagePath + '/"', {
                        cwd: PATH.dirname(archivePath)
                    }, function(err, stdout, stderr) {
                        if (err) return callback(err);
                        console.log(("Archive '" + archivePath + "' extracted to '" + packagePath + "'").green);
                        return callback(null);
                    });
                });
            })();
        }

        // TODO: Use `smi` to install these packages.
        return ensureCatalogDescriptor().then(function(catalogDescriptor) {
            var all = [];
            for (var packageId in catalogDescriptor.packages) {
                if (catalogDescriptor.packages[packageId].archives) {
                    for (var type in catalogDescriptor.packages[packageId].archives) {
                        (function (packageId, type) {
                            var packageIdParts = packageId.split("--");
                            all.push(
                                ensureArchive(
                                    PATH.join(catalogBasePath, packageIdParts[0], packageIdParts[1], type + ".tgz"),
                                    catalogDescriptor.packages[packageId].archives[type]
                                ).then(function() {
                                    return ensureExtracted(
                                        PATH.join(catalogBasePath, packageIdParts[0], packageIdParts[1], type),
                                        PATH.join(catalogBasePath, packageIdParts[0], packageIdParts[1], type + ".tgz")
                                    );
                                })
                            );
                        })(packageId, type);
                    }
                }
            }
            return Q.all(all);
        });
    }

    var done = Q.resolve();
    if (pio._config.upstream) {
        Object.keys(pio._config.upstream).forEach(function(alias) {
            done = Q.when(done, function() {
                return ensureCatalog(alias, pio._config.upstream[alias]);
            });
        });
    }
    return done;
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

        var pio = new PIO(process.cwd());

        function ensure(program, serviceSelector, options) {
            options = options || {};
            if (program.force) {
                options.force = program.force;
            }
            return pio.ready().then(function() {
                return ensureUpstream(pio).then(function() {
                    return pio.ensure(serviceSelector, options);
                });
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
