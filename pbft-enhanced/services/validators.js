const Wallet = require('./wallet')

class Validators {
  constructor(nodesSubset) {
    this.list = this.generateAddresses(nodesSubset)
  }

  generateAddresses(nodesSubset) {
    return nodesSubset.map((nodeIndex) => new Wallet(`NODE${nodeIndex}`).getPublicKey())
  }

  isValidValidator(validator) {
    return this.list.includes(validator)
  }

  // Replace the validator list with public keys derived from the new node indices.
  // Called when core merges broken shards — the merged virtual shard has a
  // different set of participating nodes than the original shard.
  updateValidators(nodesSubset) {
    this.list = this.generateAddresses(nodesSubset)
  }
}
module.exports = Validators
