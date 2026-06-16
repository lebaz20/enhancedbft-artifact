// EDDSA allows us to create key-pairs
// It is collection of cryptographic algorithms that are used to create key-pairs
const EDDSA = require("elliptic").eddsa;

// ed25519 allows us to create key pair from secret
const eddsa = new EDDSA("ed25519");

// uuid/v1 creates timestamp dependent ids
const { v1: uuidv1 } = require("uuid");

// used for hashing data to 256 bits string
const SHA256 = require("crypto-js/sha256");

class ChainUtility {
  // a static function to return key-pair generated using a secret phrase
  static genKeyPair(secret) {
    return eddsa.keyFromSecret(secret);
  }

  // returns ids used in transactions
  static id() {
    return uuidv1();
  }

  // hashes any data using SHA256
  static hash(data) {
    return SHA256(JSON.stringify(data)).toString();
  }

  // verifies the signed hash by decrypting it with public key
  // and matching it with the hash
  static verifySignature(publicKey, signature, dataHash) {
    return eddsa.keyFromPublic(publicKey).verify(dataHash, signature);
  }
}

module.exports = ChainUtility;
