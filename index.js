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
    child = require("child_process")
    crypto = require("crypto")
 
program
  .version("0.0.1")
  .option("-k, --keyname [key_name]", "The name of the key that will be generated to sign the modpack.")
  .option("-t, --tools [tool_path]", "The path where the ARMA 3 tools are located.")
  .option("-o, --output [directory]", "The output directory where the final mod will be published.")
  .option("-i, --input [directory]", "The input directory where the individual mods files have been unpacked.")
  .option("-n, --name [name]", "The name of the modpack in the Mod.cpp")
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

    // Generate key material
    child.execFileSync(path.resolve(program.tools, "./DSSignFile/DSCreateKey"), [program.keyname], {
        cwd: program.output
    })

    // Binarize the logo file and emit a mod.cpp
    child.execFileSync(path.resolve(program.tools, "./ImageToPAA/ImageToPAA"), [path.resolve(program.input, "./logo.png"), path.resolve(program.output, "./logo.paa")], {
        cwd: program.output
    })

    // Output the mod.cpp
    fs.writeFileSync(path.resolve(program.output, "./mod.cpp"), 
    `name = "${program.name}";
    picture = "logo.paa";
    actionName = "Website";
    action = "https://1st-rrf.com";
    tooltip = "${program.name}";
    author = "1st Rapid Response Force";
    `)

    let binarized_logo = fs.readFileSync(path.resolve(program.output, "./logo.paa")),
        mod_cpp = fs.readFileSync(path.resolve(program.output, "./mod.cpp"))

    let logo_hash = crypto.createHash("sha256"),
        mod_hash = crypto.createHash("sha256")

    logo_hash.update(binarized_logo)
    mod_hash.update(mod_cpp)

    manifest["logo.paa"] = logo_hash.digest("hex")
    manifest["mod.cpp"] = mod_hash.digest("hex")

    binarized_logo = null
    mod_cpp = null

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
                hash_construct = crypto.createHash("sha256")

            // Build the hash
            read_stream.on("data", (data) => {
                hash_construct.update(data)
            })

            // Write the file out to the output directory
            read_stream.pipe(outbound_stream)

            outbound_stream.on("finish", () => {
                let hash = hash_construct.digest("hex"),
                    relative_output = path.relative(program.output, output_file)
                
                // Check if this file is a duplicate and if so whether it shares a hash with it's duplicate
                if ( manifest[relative_output] && manifest[relative_output] !== hash ) {
                    console.error("Critical failure - There was a namespace collision on " + relative_output + " caused by " + relative_path)
                    process.exit(5)
                }

                manifest[relative_output] = hash

                if ( relative_path.endsWith(".pbo") ) {
                    async.waterfall([
                        (cb) => child.execFile(path.resolve(program.tools, "./DSSignFile/DSSignFile"), [path.resolve(program.output, program.keyname + ".biprivatekey"), output_file], {}, cb),
                        (stdout, stderr, cb) => fs.readFile(output_file + "." + program.keyname + ".bisign", cb)
                    ], (err, key_file) => {
                        let key_hash_construct = crypto.createHash("sha256")
                        key_hash_construct.update(key_file)

                        let key_digest = key_hash_construct.digest("hex")
                        manifest[relative_output + "." + program.keyname + ".bisign"] = key_digest

                        console.log("File completed: " + relative_output + " with hash: " + hash)
                        callback(null, hash)
                    })
                } else {
                    console.log("File completed: " + relative_output + " with hash: " + hash)
                    callback(null, hash)
                }

            })
        }

    })

    async.parallelLimit(operations, 4, (err, result) => {
        fs.writeFileSync(path.resolve(program.output, "./SYNC_manifest.json"), JSON.stringify(manifest))
        console.log("Compilation complete - " + result.length + " unique items")
    })

})