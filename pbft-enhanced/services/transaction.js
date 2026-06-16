const ChainUtility = require('../utils/chain')

class Transaction {
  constructor(data, wallet) {
    this.id = ChainUtility.id()
    this.from = wallet.publicKey
    this.input = { data: data, timestamp: Date.now() }
    this.hash = ChainUtility.hash(this.input)
    this.signature = wallet.sign(this.hash)
    this.createdAt = Date.now()
    // console.log({
    //   id: this.id, from: this.from, input: this.input, signature: this.signature, hash: this.hash
    // });
  }

  static verifyTransaction(transaction) {
    return ChainUtility.verifySignature(
      transaction.from,
      transaction.signature,
      ChainUtility.hash(transaction.input)
    )
  }
}

module.exports = Transaction
