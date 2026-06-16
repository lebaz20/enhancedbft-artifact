const SHA256 = require('crypto-js/sha256')
const ChainUtility = require('../utils/chain')

class Block {
  // eslint-disable-next-line max-params
  constructor(
    timestamp,
    lastHash,
    hash,
    data,
    proposer,
    signature,
    sequenceNo
  ) {
    this.timestamp = timestamp
    this.lastHash = lastHash
    this.hash = hash
    this.data = data
    this.proposer = proposer
    this.signature = signature
    this.sequenceNo = sequenceNo
  }

  toString() {
    return `Block - 
          Timestamp   : ${this.timestamp}
          Last Hash   : ${this.lastHash}
          Hash        : ${this.hash}
          Data        : ${this.data}
          proposer    : ${this.proposer}
          Signature   : ${this.signature}
          Sequence No : ${this.sequenceNo}`
  }

  static genesis() {
    return new this(
      `genesis time`,
      '----',
      'genesis-hash',
      [],
      'P4@P@53R',
      'SIGN',
      0
    )
  }

  static createBlock(lastBlock, data, wallet) {
    const timestamp = Date.now()
    const lastHash = lastBlock.hash
    const hash = Block.hash(timestamp, lastHash, data)
    const signature = Block.signBlockHash(hash, wallet)
    const proposer = wallet.getPublicKey()
    const sequenceNo = lastBlock.sequenceNo + 1
    return new this(
      timestamp,
      lastHash,
      hash,
      data,
      proposer,
      signature,
      sequenceNo
    )
  }

  static hash(timestamp, lastHash, data) {
    return SHA256(JSON.stringify(`${timestamp}${lastHash}${data}`)).toString()
  }

  static blockHash(block) {
    const { timestamp, lastHash, data } = block
    return Block.hash(timestamp, lastHash, data)
  }

  static signBlockHash(hash, wallet) {
    return wallet.sign(hash)
  }

  static verifyBlock(block) {
    return ChainUtility.verifySignature(
      block.proposer,
      block.signature,
      Block.hash(block.timestamp, block.lastHash, block.data)
    )
  }

  static verifyProposer(block, proposer) {
    return block.proposer === proposer
  }
}

module.exports = Block
