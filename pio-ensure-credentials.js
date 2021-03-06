
const PATH = require("path");
const COLORS = require("colors");
const FS = require("fs-extra");
const INQUIRER = require("inquirer");
const UUID = require("uuid");
const SMI = require("smi.cli");
const DEEPMERGE = require("deepmerge");
const PIO_PROVISION_PROFILE = require("./pio-provision-profile.js");


COLORS.setTheme({
    error: 'red'
});

var packageRootPath = process.cwd();
var packageDescriptorFilePath = PATH.join(packageRootPath, "package.json");
var activationFilePath = PATH.join(packageRootPath + ".activate.sh");
var profileFilePath = PATH.join(packageRootPath + ".profile.json");
var providers = {
    "digitalocean": {
        "id": "digitalocean",
        "label": "Digital Ocean",
        "url": "https://digitalocean.com/",
        "variables": {
            "DIGIO_EMAIL": {
                "type": "password",
                "question": "Enter the email address for the Digital Ocean account"
            },
            "DIGIO_TOKEN_NAME": {
                "type": "password",
                "question": "Enter the name of your Digital Ocean Personal Access Token"
            },
            "DIGIO_TOKEN": {
                "type": "password",
                "question": "Enter your Digital Ocean Personal Access Token"
            }
        }
    },
    "aws": {
        "id": "aws",
        "label": "Amazon Web Services",
        "url": "http://aws.amazon.com/",
        "variables": {
            "AWS_ACCOUNT_EMAIL": {
                "type": "password",
                "question": "Enter the email address for the AWS account"
            },
            "AWS_ACCESS_KEY": {
                "type": "password",
                "question": "Enter your AWS Access Key"
            },
            "AWS_SECRET_KEY": {
                "type": "password",
                "question": "Enter your AWS Secret Key"
            }
        }
    },
    "pio": {
        "id": "pio",
        "label": "PIO Profile",
        "url": "http://pio.pinf.io/",
        "variables": {
            "PIO_PROFILE_ENDPOINT": {
                "type": "input",
                "question": "Enter the PIO_PROFILE_ENDPOINT"
            },
            "PIO_PROFILE_KEY": {
                "type": "password",
                "question": "Enter the PIO_PROFILE_KEY"
            },
            "PIO_PROFILE_SECRET": {
                "type": "password",
                "question": "Enter the PIO_PROFILE_SECRET"
            }
        }
    }
};


function main (callback) {

    return SMI.readDescriptor(packageDescriptorFilePath, {
        basePath: packageRootPath,
        resolve: true,
        ignoreMissingExtends: true
    }, function(err, packageDescriptor) {
        if (err) return callback(err);

        function ensureActivationFile(callback) {

            if (FS.existsSync(activationFilePath)) {
                // Activation file exists so we don't mess with it.
                // If you want to modify it you need to do that manually for now.
                return callback(null);
            }

            var choicesMap = {};
            var choices = Object.keys(providers).map(function(id) {
                choicesMap[providers[id].label + " - " + providers[id].url] = id;
                return providers[id].label + " - " + providers[id].url;
            });

            function configureProvider(provider, callback) {
                console.log(("Using provider: " + provider.label + " - " + provider.url).yellow);
                var prompts = Object.keys(provider.variables).map(function(name) {
                    return {
                        name: name,
                        type: provider.variables[name].type,
                        message: provider.variables[name].question + ":",
                        choices: choices
                    };
                });
                var answers = {};
                prompts = prompts.filter(function (prompt) {
                    if (typeof process.env[prompt.name] !== "undefined") {
                        answers[prompt.name] = process.env[prompt.name];
                        return false;
                    }
                    return true;
                });
                function finalize (callback) {
                    if (provider.id === "pio") {
                        [
                            "PIO_PROFILE_ENDPOINT",
                            "PIO_PROFILE_KEY",
                            "PIO_PROFILE_SECRET"
                        ].forEach(function (name) {
                            process.env[name] = answers[name];
                        });
                        return PIO_PROVISION_PROFILE.provision(function (err) {
                            if (err) return callback(err);
                            return callback(null, null);
                        });
                    }

                    return callback(null, [
                        '# ' + provider.label + " - " + provider.url
                    ].concat(Object.keys(answers).map(function(name) {
                        return 'export ' + name + '="' + answers[name] + '"';
                    })));
                }
                if (prompts.length === 0) {
                    return finalize(callback);
                }
                INQUIRER.prompt(prompts, function(_answers) {
                    for (var name in _answers) {
                        answers[name] = _answers[name];
                    }
                    return finalize(callback);
                });
            }

            console.log("");
            console.log(("Environment activation file not found at '" + activationFilePath + "'!").cyan);
            console.log(("Creating activation file ...").magenta);


            function ensureProvider(callback) {
                var provider = null;
                if (process.env.PIO_PROFILE_PROVIDER) {
                    provider = process.env.PIO_PROFILE_PROVIDER;
                } else
                if (
                    packageDescriptor &&
                    packageDescriptor.config &&
                    packageDescriptor.config["pio.vm"] &&
                    packageDescriptor.config["pio.vm"].adapter
                ) {
                    provider = packageDescriptor.config["pio.vm"].adapter;
                }
                if (provider) {
                    // Let user enter credentials for pre-selected provider.

                    console.log("");
                    console.log(("NOTE: It is recommended you use an account DEDICATD to evaluating software!").magenta);
                    console.log(("WE ACCEPT NO LIABILITY FOR DAMAGE TO YOUR EXISTING RESOURCES RESULTING FROM THE USE OF OUR TOOLING!").magenta);
                    console.log("");

                    return configureProvider(providers[provider], function(err, _lines) {
                        if (err) return callback(err);

                        if (!_lines) {
                            return callback(null, null, null);
                        }

                        return callback(null, _lines, {
                            "config": {
                                "pio.vm": {
                                    "adapter": packageDescriptor.config["pio.vm"].adapter
                                }
                            }
                        });
                    });
                }

                // Let user pick provider.

                console.log("");
                console.log(("NOTE: It is recommended you use DEDICATD accounts for each of the following environments:").magenta);
                console.log(("  * Playground - to first experiment with new code on highly disposable instances").magenta);
                console.log(("  * Development - to conduct development on stable instances").magenta);
                console.log(("  * Production - to deploy your live systems into mission-critical locked-down clusters").magenta);
                console.log(("So use credentials for the CORRECT account and keep in mind that for now you should be using a").magenta);
                console.log(("DEDICATED ACCOUNT FOR this EARLY DEV RELEASE of this dev system!").magenta);
                console.log(("e.g. accounting+aws-play@company.com, accounting+aws-dev@company.com, accounting+aws-prod@company.com").magenta);
                console.log(("WE ACCEPT NO LIABILITY FOR DAMAGE TO YOUR EXISTING RESOURCES RESULTING FROM THE USE OF OUR TOOLING!").magenta);
                console.log("");

                var choicesMap = {
                    "Skip": "skip"
                };
                INQUIRER.prompt([
                    {
                        name: "provider",
                        type: "list",
                        message: "Choose a provider to deploy your instance to:",
                        choices: Object.keys(providers).map(function(id) {
                            choicesMap[providers[id].label + " - " + providers[id].url] = id;
                            return providers[id].label + " - " + providers[id].url;
                        }).concat("Skip")
                    }
                ], function(answers) {
                    if (choicesMap[answers.provider] === "skip") {
                        return callback(null, null, null);
                    }
                    return configureProvider(providers[choicesMap[answers.provider]], function(err, _lines) {
                        if (err) return callback(err);

                        if (!_lines) {
                            return callback(null, null, null);
                        }

                        return callback(null, _lines, {
                            "config": {
                                "pio.vm": {
                                    "adapter": choicesMap[answers.provider]
                                }
                            }
                        });
                    });
                });
            }

            function ensurePIOAndWriteFile(_lines, _profileDescriptor, callback) {

                var lines = [
                    '#!/bin/bash -e',
                    '',
                    '# @credit http://stackoverflow.com/a/246128/330439',
                    'SOURCE="${BASH_SOURCE[0]}"',
                    'while [ -h "$SOURCE" ]; do',
                    '  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"',
                    '  SOURCE="$(readlink "$SOURCE")"',
                    '  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"',
                    'done',
                    '_BASE_PATH="$( cd -P "$( dirname "$SOURCE" )" && pwd )"',
                    ''
                ];
                if (_lines) {
                    lines = lines.concat(_lines);
                }
                lines = lines.concat([
                    "",
                    "# pio credentials"
                ]);
                lines = lines.concat([
                    "PIO_SEED_SALT",
                    "PIO_SEED_KEY",
                    "PIO_USER_ID",
                    "PIO_USER_SECRET"
                ].map(function(name) {
                    return 'export ' + name + '="' + UUID.v4() + '"';
                }));
                lines = lines.concat([
                    "",
                    "# pio config",
                    'export PIO_PROFILE_PATH="$_BASE_PATH/' + PATH.basename(profileFilePath) + '"'
                ]);

                console.log(("Writing activation file to: " + activationFilePath).magenta);
                FS.outputFileSync(activationFilePath, lines.join("\n"));


                var profileDescriptor = {};
                if (FS.existsSync(profileFilePath)) {
                    profileDescriptor = JSON.parse(FS.readFileSync(profileFilePath));
                }
                if (_profileDescriptor) {
                    profileDescriptor = DEEPMERGE(profileDescriptor, _profileDescriptor);
                }

                console.log(("Writing profile file to: " + profileFilePath).magenta);
                FS.outputFileSync(profileFilePath, JSON.stringify(profileDescriptor, null, 4));

                return callback(null);
            }

            return ensureProvider(function(err, _lines, _profileDescriptor) {
                if (err) return callback(err);

                if (!_lines && !_profileDescriptor) {
                    return callback(null);
                }
            
                return ensurePIOAndWriteFile(_lines, _profileDescriptor, callback);
            });
        }

        return ensureActivationFile(callback);
    });
}


if (require.main === module) {
    main(function(err) {
        if (err) {
            if (typeof err === "string") {
                console.error((""+err).red);
            } else
            if (typeof err === "object" && err.stack) {
                console.error((""+err.stack).red);
            }
            process.exit(1);
        }
        process.exit(0);
    });
}
