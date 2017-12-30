const Fs = require("fs");
const Path = require("path");
const Randomstring = require("randomstring");
const Moment = require("moment");
const CryptoJS = require("crypto-js");
const Marky = require("marky");
const Iota = require("iota.lib.js");


/**
 * TANGLESTASH
 * An algorithm to persist any file onto the tangle of IOTA
 * By Jakob Löhnertz (www.jakob.codes)
 * **/

class Tanglestash {
    /**
     * @param {String} `provider` A URI of an IOTA full node
     * @param {String} `datatype` Either 'file' or 'string' based on the data that will later be used
     * @param {String} `seed` [Optional] An IOTA wallet seed; will be automatically generated if not passed here
     */
    constructor(provider, datatype, seed) {
        // CONSTANTS
        this.ChunkShortKeys = {
            "content": "cC",
            "index": "iC",
            "previousHash": "pC",
            "totalAmount": "tC",
        };
        this.IotaTransactionDepth = 4;
        this.IotaTransactionMinWeightMagnitude = 14;
        this.IotaSeedLength = 81;
        this.IotaCharset = '9ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        this.IotaTransactionSignatureMessageFragmentLength = 2187;
        this.ChunkPaddingLength = 9;
        this.ChunkTablePreviousHashLength = 92;
        this.ChunkContentLength = (this.IotaTransactionSignatureMessageFragmentLength - this.ChunkPaddingLength);
        this.ChunkTableFragmentLength = (this.ChunkContentLength - this.ChunkTablePreviousHashLength);
        this.ChunkTag = 'TANGLESTASH9999999999999999';
        this.FirstChunkKeyword = '1st';

        // PROPERTIES
        this.iota = new Iota({'provider': provider});  // Create IOTA instance utilizing the passed provider
        this.datatype = datatype || 'file';  // Set file as the default 'datatype' in case none was passed
        this.seed = seed || this.generateRandomIotaSeed();  // Generate a fresh and random IOTA seed
        this.successfulChunks = 0;
        this.totalChunkAmount = 0;
    }

    /**
     * Retrieves data that was persisted to the tangle in the past.
     *
     * @param {String} `entryHash` The entry-hash to start the retrieval (return value from `saveToTangle()`)
     * @param {String} `secret` [Optional] A secret to decrypt the data if it was persisted with encryption beforehand
     * @returns {Promise.<*>} A file buffer or a string based on `this.datatype`
     */
    async readFromTangle(entryHash, secret) {
        let chunkContents = [];

        let previousHash = entryHash;
        while (previousHash !== this.FirstChunkKeyword) {
            Marky.mark('readFromTangle');
            try {
                let transactionBundle = await this.getTransactionFromTangle(previousHash);
                let chunk = JSON.parse(this.iota.utils.extractJson(transactionBundle));
                chunkContents.unshift(chunk[this.ChunkShortKeys["content"]]);
                previousHash = chunk[this.ChunkShortKeys["previousHash"]];
                this.totalChunkAmount = parseInt(chunk[this.ChunkShortKeys["totalAmount"]]);
                this.currentChunkPosition = (this.totalChunkAmount - parseInt(chunk[this.ChunkShortKeys["index"]]));
            } catch (err) {
                throw err;
            }
            Marky.stop('readFromTangle');
        }

        let datastringBase64 = chunkContents.join('');
        try {
            return this.decodeData(datastringBase64, secret);
        } catch (err) {
            throw err;
        }
    }

    /**
     * Persists data onto the tangle.
     *
     * @param {String} `data` The data as a file path or a string based on `this.datatype`
     * @param {String} `secret` [Optional] A secret to encrypt the data
     * @returns {Promise.<string>} The entry-hash for this persisted data
     */
    async saveToTangle(data, secret) {
        this.chunkBundle = {};
        this.failedChunks = [];

        try {
            let datastring = this.encodeData(data, secret);
            let chunkContents = this.createChunkContents(datastring, this.ChunkContentLength);
            this.chunkBundle = Tanglestash.generateChunkBundle(chunkContents);
        } catch (err) {
            throw err;
        }

        let totalChunkAmount = parseInt(Object.keys(this.chunkBundle).length);
        this.successfulChunks = 0;
        this.totalChunkAmount = totalChunkAmount;

        let initialChunks = [];
        for (let chunk in this.chunkBundle) {
            initialChunks.push(this.chunkBundle[chunk]["index"]);
        }

        this.persistChunks(initialChunks);

        return await this.finalizeChunkBundle();
    }

    getTransactionFromTangle(transactionHash) {
        return new Promise((resolve, reject) => {
            this.iota.api.getBundle(transactionHash, (err, transactionBundle) => {
                if (err) {
                    switch (err.message) {
                        case 'Invalid inputs provided':
                            reject(new IncorrectTransactionHashError(err.message));
                            break;
                        case 'Invalid Bundle provided':
                            reject(new NodeOutdatedError(err.message));
                            break;
                        default:
                            reject(new Error(err.message));
                            break;
                    }
                }
                resolve(transactionBundle);
            });
        });
    }

    persistChunks(chunkIndices) {
        for (let chunk in chunkIndices) {
            this.persistChunk(this.chunkBundle[chunk]).then((resolvedChunk) => {
                this.chunkBundle[resolvedChunk["index"]] = resolvedChunk;
                let failedChunkIndex = this.failedChunks.indexOf(resolvedChunk["index"]);
                if (failedChunkIndex !== -1) {
                    this.failedChunks.splice(failedChunkIndex, 1);
                }
                this.successfulChunks += 1;
            }).catch((rejectedChunk) => {
                this.failedChunks.push(rejectedChunk["index"]);
            });
        }
    }

    async persistChunk(chunk) {
        Marky.mark('saveToTangle');
        try {
            this.chunkBundle[chunk["index"]]["lastTry"] = Moment();
            this.chunkBundle[chunk["index"]]["tries"] += 1;
            let trytesMessage = this.iota.utils.toTrytes(JSON.stringify(chunk["content"]));
            let address = await this.getNewIotaAddress();
            let transaction = await this.sendNewIotaTransaction(address, trytesMessage);
            chunk["hash"] = transaction["hash"];
            chunk["persisted"] = true;
            Marky.stop('saveToTangle');
            return chunk;
        } catch (err) {
            Marky.stop('saveToTangle');
            throw err;
        }
    }

    async finalizeChunkBundle() {
        return new Promise((resolve, reject) => {
            let finishedCheck = setInterval(async () => {
                if (this.successfulChunks === this.totalChunkAmount) {
                    clearInterval(finishedCheck);
                    let chunkTable = this.generateChunkTable();
                    let chunkTableFragments = this.createChunkContents(JSON.stringify(chunkTable), this.ChunkTableFragmentLength);
                    try {
                        let entryHash = await this.persistChunkTable(chunkTableFragments);
                        resolve(entryHash);
                    } catch (err) {
                        reject(err);
                    }
                }
            }, 1234);
        });
    }

    encodeData(data, secret) {
        let base64 = '';
        let datastring = '';

        switch (this.datatype) {
            case 'file':
                base64 = Tanglestash.parseFileIntoBase64(data);
                break;
            case 'string':
                base64 = Tanglestash.parseStringIntoBase64(data);
                break;
            default:
                throw new IncorrentDatatypeError('No correct "datatype" was passed');
        }

        if (secret) {
            datastring = Tanglestash.encrypt(base64, secret);
        } else {
            datastring = base64;
        }

        return datastring;
    }

    decodeData(data, secret) {
        let base64 = data;
        let result = '';

        if (secret) {
            base64 = Tanglestash.decrypt(base64, secret);
            if (!base64) {
                throw new IncorrectPasswordError('Provided secret incorrect');
            }
        }

        switch (this.datatype) {
            case 'file':
                result = Tanglestash.parseFileFromBase64(base64);
                break;
            case 'string':
                result = Tanglestash.parseStringFromBase64(base64);
                break;
            default:
                throw new IncorrentDatatypeError('No correct "datatype" was passed');
        }

        return result;
    }

    sendNewIotaTransaction(address, message) {
        return new Promise((resolve, reject) => {
            this.iota.api.sendTransfer(
                this.seed,
                this.IotaTransactionDepth,
                this.IotaTransactionMinWeightMagnitude,
                [
                    {
                        'address': address,
                        'message': message,
                        'tag': this.ChunkTag,
                        'value': 0,
                    }
                ],
                (err, bundle) => {
                    // TODO: Check why this sometimes doesn't reject correctly (if node is outdated)
                    if (err) {
                        if (err.message.includes('failed consistency check')) {
                            reject(new NodeOutdatedError(err.message));
                        } else {
                            reject(new Error(err.message));
                        }
                    }
                    resolve(bundle[0]);
                }
            );
        });
    }

    /**
     * Generates a random valid IOTA wallet seed.
     *
     * @returns {String} The generated seed
     */
    generateRandomIotaSeed() {
        return Randomstring.generate({
            length: this.IotaSeedLength,
            charset: this.IotaCharset,
        });
    }

    /**
     * Retrieves a new valid IOTA wallet address based on `this.seed`.
     *
     * @returns {Promise.<string>} The retrieved wallet address
     */
    getNewIotaAddress() {
        return new Promise((resolve, reject) => {
            this.iota.api.getNewAddress(this.seed, (err, address) => {
                if (err) reject(new Error(err.message));
                resolve(address);
            });
        });
    }

    createChunkContents(datastring, chunkLength) {
        let regex = new RegExp(`.{1,${chunkLength}}`, 'g');
        return datastring.match(regex);
    }

    /**
     * Returns all the `marky` entries used to time the main processes.
     *
     * @returns {Array.<object>} The array of the entries from `marky` entries
     */
    getAllMarkyEntries() {
        return Marky.getEntries();
    }

    static generateChunkBundle(chunkContents) {
        let bundle = {};
        for (let chunkContent in chunkContents) {
            bundle[chunkContent] = Tanglestash.buildChunkBundleEntry(chunkContents[chunkContent], chunkContent);
        }
        return bundle;
    }

    static buildChunkBundleEntry(chunkContent, index) {
        return ({
            content: chunkContent,
            hash: null,
            index: index,
            lastTry: null,
            persisted: false,
            tries: 0,
        });
    }

    static parseFileIntoBase64(path) {
        let buffer = new Buffer(Fs.readFileSync(Path.resolve(path)));
        return buffer.toString('base64');
    }

    static parseStringIntoBase64(string) {
        return new Buffer(string).toString('base64');
    }

    static parseFileFromBase64(base64) {
        return new Buffer(base64, 'base64');
    }

    static parseStringFromBase64(base64) {
        return new Buffer(base64, 'base64').toString('utf-8');
    }

    static encrypt(plaintext, secret) {
        let ciphertext = CryptoJS.AES.encrypt(plaintext, secret);
        return ciphertext.toString();
    }

    static decrypt(ciphertext, secret) {
        let bytes = CryptoJS.AES.decrypt(ciphertext, secret);
        try {
            return bytes.toString(CryptoJS.enc.Utf8);
        } catch (err) {
            return false;
        }
    }
}


/**
 * Custom Exceptions
 * **/

class IncorrectPasswordError extends Error {
    constructor(...args) {
        super(...args);
        this.name = IncorrectPasswordError.name;
    }
}

class IncorrentDatatypeError extends Error {
    constructor(...args) {
        super(...args);
        this.name = IncorrentDatatypeError.name;
    }
}

class IncorrectTransactionHashError extends Error {
    constructor(...args) {
        super(...args);
        this.name = IncorrectTransactionHashError.name;
    }
}

class NodeOutdatedError extends Error {
    constructor(...args) {
        super(...args);
        this.name = NodeOutdatedError.name;
    }
}


module.exports = {
    Tanglestash,
    IncorrectPasswordError,
    IncorrentDatatypeError,
    IncorrectTransactionHashError,
    NodeOutdatedError,
};
