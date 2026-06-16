const ChainUtility = require("../../utils/chain");

class PreparePool {
  // list object is a map that holds a list of prepare messages for a hash of a block
  constructor() {
    this.list = {};
    this.committeeList = {};
  }

  // prepare function initialize a list of prepare message for a block
  // and adds the prepare message for the current node and
  // returns it
  prepare(block, wallet, isCommittee = false) {
    const prepare = this.createPrepare(block, wallet);
    this.addPrepare(prepare, isCommittee);
    return prepare;
  }

  // creates a prepare message for the given block
  createPrepare(block, wallet) {
    return {
      blockHash: block.hash,
      publicKey: wallet.getPublicKey(),
      signature: wallet.sign(block.hash),
    };
  }

  // pushes the prepare message for a block hash into the list
  addPrepare(prepare, isCommittee = false) {
    if (!isCommittee) {
      if (!(prepare.blockHash in this.list)) {
        this.list[prepare.blockHash] = [];
      }
      this.list[prepare.blockHash].push(prepare);
    } else {
      if (!(prepare.blockHash in this.committeeList)) {
        this.committeeList[prepare.blockHash] = [];
      }
      this.committeeList[prepare.blockHash].push(prepare);
    }
  }

  // checks if the prepare message already exists
  existingPrepare(prepare, isCommittee = false) {
    return !!(isCommittee ? this.committeeList : this.list)[prepare.blockHash]?.find(
      (p) => p.publicKey === prepare.publicKey,
    );
  }

  // checks if the block already exists
  isBlockPrepared(block, wallet, isCommittee = false) {
    if (!block?.hash) {
      return false;
    }
    const prepare = this.createPrepare(block, wallet);
    return this.existingPrepare(prepare, isCommittee);
  }

  getList(hash, isCommittee = false) {
    return (isCommittee ? this.committeeList : this.list)[hash];
  }

  // checks if the prepare message is valid or not
  isValidPrepare(prepare) {
    return ChainUtility.verifySignature(
      prepare.publicKey,
      prepare.signature,
      prepare.blockHash,
    );
  }
}

module.exports = PreparePool;
