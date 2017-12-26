const Fs = require("fs");
const Path = require("path");
const Iota = require("iota.lib.js");
const CryptoJS = require("crypto-js");


class Tanglestash {
    /**
     * TANGLESTASH
     * **/

    constructor(datatype, secret) {
        // CONSTANTS
        this.IotaTransactionExampleHash = '999999999999999999999999999999999999999999999999999999999999999999999999999999999';
        this.IotaTransactionSignatureMessageFragmentLength = 2187;
        this.ChunkPaddingLength = 9;
        this.ChunkScaffoldLength = JSON.stringify(Tanglestash.buildChunk('', 0, this.IotaTransactionExampleHash, 2)).length;
        this.ChunkContentLength = (this.IotaTransactionSignatureMessageFragmentLength - this.ChunkPaddingLength - this.ChunkScaffoldLength);
        this.ChunkContentLength = 5;
        this.firstChunkKeyword = '1st';

        // PROPERTIES
        this.datatype = datatype || 'file';  // Set file as the default 'datatype' in case none was passed
        this.secret = secret || null;  // Set the secret to 'null' if the user does not want to use encryption
    }

    readFromTangle(entryHash) {
        let nextHash = entryHash;
        while (nextHash !== this.firstChunkKeyword) {
            // TODO: Implement read-out from the Tangle
            nextHash = 'nextHash';
        }
    }

    persistToTangle(data) {
        let datastring = this.prepareData(data);
        let chunksContents = this.createChunkContents(datastring);
        let totalChunkAmount = parseInt(chunksContents.length);

        let previousChunkHash = this.firstChunkKeyword;
        for (let chunkContent in chunksContents) {
            let chunk = Tanglestash.buildChunk(
                chunksContents[chunkContent],
                parseInt(chunkContent),
                previousChunkHash,
                totalChunkAmount
            );

            // TODO: Implement attachment to the Tangle

            previousChunkHash = 'nextHash';
        }
        let startChunkHash = previousChunkHash;
    }

    prepareData(data) {
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
                // TODO: Throw error
                console.error('No correct "datatype" was passed!');
        }

        if (this.secret) {
            datastring = Tanglestash.encrypt(base64, this.secret);
        } else {
            datastring = base64;
        }

        return datastring;
    }

    decryptData(data) {
        let base64 = Tanglestash.decrypt(data, this.secret);

        switch (this.datatype) {
            case 'file':
                return Tanglestash.parseFileFromBase64(base64);
                break;
            case 'string':
                return Tanglestash.parseStringFromBase64(base64);
                break;
            default:
                // TODO: Throw error
                console.error('No correct "datatype" was passed!');
        }
    }

    createChunkContents(datastring) {
        let regex = new RegExp(`.{1,${this.ChunkContentLength}}`, 'g');
        return datastring.match(regex);
    }

    static buildChunk(chunkContent, indexChunk, previousChunkHash, totalChunksAmount) {
        return (
            {
                "cC": chunkContent,
                "iC": indexChunk,
                "pC": previousChunkHash,
                "tC": totalChunksAmount
            }
        );
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
        return new Buffer(base64, 'base64').toString('utf-8')
    }

    static encrypt(plaintext, secret) {
        let ciphertext = CryptoJS.AES.encrypt(plaintext, secret);
        return ciphertext.toString();
    }

    static decrypt(ciphertext, secret) {
        let bytes = CryptoJS.AES.decrypt(ciphertext, secret);
        return bytes.toString(CryptoJS.enc.Utf8);
    }
}

module.exports = Tanglestash;

let tanglestash = new Tanglestash('string', 'lel');
tanglestash.persistToTangle('Dies ist nur ein Test!');
