
const PATH = require("path");
const CRYPTO = require("crypto");
const COLORS = require("colors");
const FS = require("fs-extra");
const INQUIRER = require("inquirer");
const UUID = require("uuid");
const SMI = require("smi.cli");
const DEEPMERGE = require("deepmerge");
const WAITFOR = require("waitfor");
const REQUEST = require("request");


// TODO: Instead of implementing all this code here we should be calling the 'pio.profile' service with a specific context.


COLORS.setTheme({
    error: 'red'
});

var packageRootPath = process.cwd();
var packageDescriptorFilePath = PATH.join(packageRootPath, "package.json");
var activationFilePath = PATH.join(packageRootPath + ".activate.sh");
var profileFilePath = PATH.join(packageRootPath + ".profile.json");
var sshKeyBasePath = PATH.join(process.env.HOME, ".ssh");


exports.provision = function (callback) {

    var files = [
        {
            name: "profile.json",
            path: profileFilePath
        },
        {
            name: "activate.sh",
            path: activationFilePath
        },
        {
            name: "ssh.key",
            path: PATH.join(sshKeyBasePath, "{{config.pio.hostname}}")
        }
    ];

    function countFiles (callback) {
        var count = 0;
        files.forEach(function (fileinfo) {
            if (FS.existsSync(fileinfo.path)) {
                count += 1;
            }
        });
        return callback(null, count);
    }

    return countFiles(function (err, count) {
        if (err) return callback(err);
        if (count === files.length) {
            return callback(null);
        }
        if (count < files.length && count > 0) {
            return callback("The following files must all be removed before calling the 'pio-provision-profile' command (cwd: " + packageRootPath + "): " + JSON.stringify(files));
        }

        console.log("See if we can download profile files from online ...");

        if (!process.env.PIO_PROFILE_KEY) {
            return callback("Cannot download profile files from online because 'PIO_PROFILE_KEY' environment variable is not set!");
        }
        if (!process.env.PIO_PROFILE_SECRET) {
            return callback("Cannot download profile files from online because 'PIO_PROFILE_SECRET' environment variable is not set!");
        }

        return SMI.readDescriptor(packageDescriptorFilePath, {
            basePath: packageRootPath,
            resolve: true,
            ignoreMissingExtends: true
        }, function(err, packageDescriptor) {
            if (err) return callback(err);

            var repositoryUri = (process.env.PIO_PROFILE_ENDPOINT || packageDescriptor.config.pio.profileRegistryUri) + "/" + process.env.PIO_PROFILE_KEY;

            var profileConfig = null;

            function downloadFile(fileinfo, callback) {

                var file = fileinfo.path;

                if (fileinfo.name === "ssh.key") {
                    if (!profileConfig.config.pio.hostname) {
                        return callback(new Error("'profileConfig.config.pio.hostname' not set!"));
                    }
                    file = file.replace(/\{\{config\.pio\.hostname\}\}/g, profileConfig.config.pio.hostname);
                }

                var url = repositoryUri + "/" + fileinfo.name;

                console.log("Trying to download '" + url + "' to '" + file + "'");

                return REQUEST(url, function(err, response, body) {
                    if (err) {
                        return callback(err);
                    }
                    if (response.statusCode !== 200) {
                        return callback("No profile file found online!");
                    }
                    var secretHash = CRYPTO.createHash("sha256");
                    secretHash.update(process.env.PIO_PROFILE_KEY+ ":" + process.env.PIO_PROFILE_SECRET);
                    secretHash = secretHash.digest();
                    body = body.split(":");
                    var decrypt = CRYPTO.createDecipheriv('aes-256-cbc', secretHash, new Buffer(body.shift(), 'hex'));
                    var decrypted = decrypt.update(new Buffer(body.join(":"), 'base64').toString('binary'), 'binary', 'utf8');
                    decrypted += decrypt.final('utf8');

                    var cachePath = PATH.join(packageRootPath, ".pio.cache/pio.profile", fileinfo.name + "~mtime");

                    FS.outputFileSync(file, decrypted);
                    FS.outputFileSync(cachePath, Math.ceil(FS.statSync(file).mtime.getTime()/1000));

                    console.log("Wrote file to: " + file);

                    if (fileinfo.name === "profile.json") {
                        profileConfig = JSON.parse(decrypted);
                    } else
                    if (fileinfo.name === "ssh.key") {
                        FS.chmodSync(file, 0600);
                    }

                    return callback(null);
                });
            }

            var waitfor = WAITFOR.serial(function(err) {
                if (err) return callback(err);
                console.log(("Profile downloaded! Run 'source bin/activate.sh' next!").magenta);
                return callback(null);
            });
            files.forEach(function (fileinfo) {
                return waitfor(fileinfo, downloadFile);
            });
            return waitfor();
        });
    });
}


if (require.main === module) {
    exports.provision(function(err) {
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
