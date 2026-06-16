const ChainUtility = require("../../utils/chain");

class MessagePool {
  // list object is a map that holds a list of messages for a hash of a block
  constructor() {
    this.list = {};
    this.committeeList = {};
    this.message = "INITIATE NEW ROUND";
  }

  // creates a round change message for the given block hash
  createMessage(block, wallet, isCommittee = false) {
    const roundChange = {
      publicKey: wallet.getPublicKey(),
      message: this.message,
      blockHash: block.hash,
      data: block.data,
      signature: wallet.sign(ChainUtility.hash(this.message + block.hash)),
    };

    if (isCommittee) {
      this.committeeList[block.hash] = [roundChange];
    } else {
      this.list[block.hash] = [roundChange];
    }
    return roundChange;
  }

  // pushes the message for a block hash into the list
  addMessage(message, isCommittee = false) {
    if (isCommittee) {
      if (!(message.blockHash in this.committeeList)) {
        return;
      }
      this.committeeList[message.blockHash].push(message);
    } else {
      if (!(message.blockHash in this.list)) {
        return;
      }
      this.list[message.blockHash].push(message);
    }
  }

  // checks if the message already exists
  existingMessage(message, isCommittee = false) {
    if (isCommittee) {
      if (this.committeeList[message.blockHash]) {
        return !!this.committeeList[message.blockHash]?.find(
          (p) => p.publicKey === message.publicKey,
        );
      }
    } else {
      if (this.list[message.blockHash]) {
        return !!this.list[message.blockHash]?.find(
          (p) => p.publicKey === message.publicKey,
        );
      }
    }
    return false;
  }

  // checks if the message is valid or not
  isValidMessage(message) {
    return ChainUtility.verifySignature(
      message.publicKey,
      message.signature,
      ChainUtility.hash(message.message + message.blockHash),
    );
  }
}

module.exports = MessagePool;
