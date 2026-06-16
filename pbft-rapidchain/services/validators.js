const Wallet = require('./wallet')

class Validators {
  constructor(nodesSubset) {
    this.list = this.generateAddresses(nodesSubset)
  }

  generateAddresses(nodesSubset) {
    return nodesSubset.map((nodeIndex) =>
      new Wallet(`NODE${nodeIndex}`).getPublicKey()
    )
  }

  isValidValidator(validator) {
    return this.list.includes(validator)
  }
}
module.exports = Validators
