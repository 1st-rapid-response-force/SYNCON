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
    zlib = require("zlib")
 
program
  .version("0.0.1")
  .option("-key, --privatekey [key_path]", "The full length path specifier of the BIkey private key to sign files")
  .option("-o, --output [directory]", "The output directory where the final mod will be published.")
  .option("-i, --input [directory]", "The input directory where the individual mods files have been unpacked.")
  .parse(process.argv)
 
// Use a glob on the path to find all .pbo files in the directory

// For each file generate a SHA512 of the file in a streaming configuration
// Add this to an internal tree structure for caching
// Concurrently to streaming the data to a hash also stream the data out to a file and convert the name of that file to an underscore
// When the file has been written, call DSSignFile to sign the new file with the provided bikey
console.log("Starting File Traversal")
glob(program.input + "/**/*.{pbo,dll}", (err, files_to_process) => {
    
    fs.emptyDirSync(program.output)
    fs.ensureDirSync(path.resolve(program.output, "./addons"))

    let manifest = {}

    let operations = _.map(files_to_process, (file) => {

        return (callback) => {
            
            let relative_path = path.relative(program.input, file)
            console.log("Opening file stream: " + relative_path)

            let target_directory = program.output

            if ( relative_path.endsWith(".pbo") ) {
                target_directory = path.resolve(target_directory, "./addons")
            }

            let output_file = path.resolve(target_directory, path.basename(file).toLowerCase())

            let read_stream = fs.createReadStream(file),
                outbound_stream = fs.createWriteStream(output_file),
                hash_construct = crypto.createHash("sha256"),
                zip_stream = zlib.createGzip()

            // Build the hash
            read_stream.on("data", (data) => {
                hash_construct.update(data)
            })

            // Write the gziped file out to the output directory
            read_stream.pipe(zip_stream).pipe(outbound_stream)

            read_stream.on("end", () => {
                let hash = hash_construct.digest("base64"),
                    relative_output = path.relative(program.output, output_file)
                
                // Check if this file is a duplicate and if so whether it shares a hash with it's duplicate
                if ( manifest[relative_output] && manifest[relative_output] !== hash ) {
                    console.error("Critical failure - There was a namespace collision on " + relative_output + " caused by " + relative_path)
                    process.exit(5)
                }

                manifest[relative_output] = hash

                console.log("File completed: " + relative_output + " with hash: " + hash)

                callback(null, hash)
            })
        }

    })

    async.parallelLimit(operations, 4, (err, result) => {
        fs.writeFileSync(path.resolve(program.output, "./SYNC_manifest.json"), JSON.stringify(manifest))
        console.log("Compilation complete - " + result.length + " unique items")
    })

})