
const PATH = require("path");
const COLORS = require("colors");
const FS = require("fs-extra");
const INQUIRER = require("inquirer");
const UUID = require("uuid");

COLORS.setTheme({
    error: 'red'
});

var activationFilePath = PATH.join(process.cwd() + ".activate.sh");
var profileFilePath = PATH.join(process.cwd() + ".profile.json");
var providers = {
    "digitalocean": {
        "label": "Digital Ocean",
        "url": "https://digitalocean.com/",
        "variables": {
            "DIGIO_EMAIL": {
                "type": "password",
                "question": "Enter the email address for the Digital Ocean account"
            },
            "DIGIO_CLIENT_ID": {
                "type": "password",
                "question": "Enter your Digital Ocean Client ID"
            },
            "DIGIO_API_KEY": {
                "type": "password",
                "question": "Enter your Digital Ocean API Key"
            }
        }
    },
    "aws": {
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
    }
};


function main (callback) {

    function ensureActivationFile(callback) {

        if (FS.existsSync(activationFilePath)) {
            // Activation file exists so we don't mess with it.
            // If you want to modify it you need to do that manually for now.
            return callback(null);
        }

        function configureProvider(provider, callback) {
            console.log(("Using provider: " + provider.label).yellow);
            var prompts = Object.keys(provider.variables).map(function(name) {
                return {
                    name: name,
                    type: provider.variables[name].type,
                    message: provider.variables[name].question + ":",
                    choices: Object.keys(providers).map(function(id) {
                        choicesMap[providers[id].label + " - " + providers[id].url] = id;
                        return providers[id].label + " - " + providers[id].url;
                    })
                };
            });
            INQUIRER.prompt(prompts, function(answers) {
                return callback(null, [
                    '# ' + provider.label + " - " + provider.url
                ].concat(Object.keys(answers).map(function(name) {
                    return 'export ' + name + '="' + answers[name] + '"';
                })));
            });
        }

        console.log("");
        console.log(("Environment activation file not found at '" + activationFilePath + "'!").cyan);
        console.log(("Creating activation file ...").magenta);

        console.log("");
        console.log(("NOTE: It is recommended you use DEDICATD accounts for each of the following environments:").magenta);
        console.log(("  * Playground - to first experiment with new code on highly disposable instances").magenta);
        console.log(("  * Development - to conduct development on stable instances").magenta);
        console.log(("  * Production - to deploy your live systems into mission-critical locked-down clusters").magenta);
        console.log(("So use credentials for the CORRECT account and keep in mind that for now you should be using a").magenta);
        console.log(("DEDICATED ACCOUNT FOR this EARLY DEV RELEASE of this dev system!").magenta);
        console.log(("e.g. accounting+aws-play@company.com, accounting+aws-dev@company.com, accounting+aws-prod@company.com").magenta);
        console.log("");

        var choicesMap = {};
        INQUIRER.prompt([
            {
                name: "provider",
                type: "list",
                message: "Choose a provider to deploy your instance to:",
                choices: Object.keys(providers).map(function(id) {
                    choicesMap[providers[id].label + " - " + providers[id].url] = id;
                    return providers[id].label + " - " + providers[id].url;
                })
            }
        ], function(answers) {

            return configureProvider(providers[choicesMap[answers.provider]], function(err, _lines) {
                if (err) return callback(err);

                var lines = [
                    "#!/bin/bash -e",
                    ""
                ];
                lines = lines.concat(_lines);
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
                    'export PIO_PROFILE_PATH="' + profileFilePath + '"'
                ]);

                var profileDescriptor = null;
                if (FS.existsSync(profileFilePath)) {
                    profileDescriptor = JSON.parse(FS.readFileSync(profileFilePath));
                }
                if (!profileDescriptor) profileDescriptor = {};
                if (!profileDescriptor.config) profileDescriptor.config = {};
                if (!profileDescriptor.config["pio.vm"]) profileDescriptor.config["pio.vm"] = {};

                profileDescriptor.config["pio.vm"].adapter = choicesMap[answers.provider];

                console.log(("Writing activation file to: " + activationFilePath).magenta);
                FS.outputFileSync(activationFilePath, lines.join("\n"));

                console.log(("Writing profile file to: " + profileFilePath).magenta);
                FS.outputFileSync(profileFilePath, JSON.stringify(profileDescriptor, null, 4));

                return callback(null);                
            });
        });
    }

    return ensureActivationFile(callback);
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
