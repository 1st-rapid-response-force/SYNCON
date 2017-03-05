#!/usr/bin/env node
 
/**
 * Module dependencies.
 */
 
var program = require("commander"),
    glob = require("glob"),
    path = require("path"),
    _ = require("underscore"),
    async = require("async"),
    fs = require("fs-extra"),
    crypto = require("crypto"),
    request = require("request"),
    diff = require("deep-diff")
 
program
  .version("0.0.1")
  .option("-r, --remote [base_url]", "The remote HTTP server base directory URL where the folder can be found")
  .option("-o, --output [target_folder]", "The target folder where the output will be downloaded to")
  .parse(process.argv)
 
// Start by downloading the manifest.json file from the base_url
// Then build a manifest structure of the existing directory tree which is diffed against the actual state of the tree using rus-diff
// The rus diff will then be applied in order ( removals, then updates, then new files ) which will cause the end state of the file system to exactly mirror the addon
console.log("Downloading target manifest")

fs.ensureDirSync(path.resolve(program.output, "./addons"))

request(program.remote + "/SYNC_manifest.json", (err, response, body) => {

    let target_manifest = JSON.parse(body),
        present_manifest = {}

    // Construct the file system manifest
    glob(program.output + "/**/*.{pbo,dll}", (err, files_to_process) => {
        
        let operations = _.map(files_to_process, (file) => {

            return (callback) => {
                
                let read_stream = fs.createReadStream(file),
                    hash_construct = crypto.createHash("sha256")

                // Build the hash
                read_stream.on("data", (data) => {
                    hash_construct.update(data)
                })

                read_stream.on("end", () => {
                    present_manifest[path.relative(program.output, file)] = hash_construct.digest("hex")
                    callback(null)
                })

            }

        })

        async.parallelLimit(operations, 4, (err, result) => {
            
            let required_operations = diff(present_manifest, target_manifest)

            let download_operations = _.map(required_operations, (operation) => {
                
                return (callback) => { 
                    
                    let operation_file_relative_path = operation.path[0].replace("\\", "/"),
                        filename = path.join(program.output, operation_file_relative_path)

                    if ( operation.kind === "N" || operation.kind === "E" ) {
                        
                        let output_stream = fs.createWriteStream(filename)

                        let download_stream = request(program.remote + "/" + operation_file_relative_path)
                        
                        download_stream.on("error", () => {
                            console.error("An error occured with the download - please try again later.")
                            callback("Download failed for file: " + filename)
                        }).pipe(output_stream)

                        output_stream.on("finish", () => {
                            console.log("Download and install completed for file: " + operation_file_relative_path)
                            callback(null)
                        })

                    } else if ( operation.kind === "D" ) {
                        console.log(filename)
                        fs.remove(filename, () => {
                            console.log("Unrecognized file removed: " + operation_file_relative_path)
                            callback(null)
                        })

                    }

                }

            })

            async.parallelLimit(download_operations, 10, (err, result) => {

                if ( err ) {
                    console.error(err)
                    process.exit(2)
                }

                console.log("All files downloaded")

            })

        })

    })

})