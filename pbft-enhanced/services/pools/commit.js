const ChainUtility = require("../../utils/chain");

class CommitPool {
  // list object is a map that holds a list of commit messages for a hash of a block
  constructor() {
    this.list = {};
  }

  // commit function initialize a list of commit message for a prepare message
  // and adds the commit message for the current node and
  // returns it
  commit(prepare, wallet) {
    const commit = this.createCommit(prepare, wallet);
    this.addCommit(commit);
    return commit;
  }

  // creates a commit message for the given prepare message
  createCommit(prepare, wallet) {
    const commit = {};
    commit.blockHash = prepare.blockHash;
    commit.publicKey = wallet.getPublicKey();
    commit.signature = wallet.sign(prepare.blockHash);
    return commit;
  }

  // pushes the commit message for a block hash into the list
  addCommit(commit) {
    if (!(commit.blockHash in this.list)) {
      this.list[commit.blockHash] = [];
    }
    this.list[commit.blockHash].push(commit);
  }

  // checks if the commit message already exists
  existingCommit(commit) {
    return !!this.list[commit.blockHash]?.find(
      (p) => p.publicKey === commit.publicKey,
    );
  }

  getList(hash) {
    return this.list[hash];
  }

  // checks if the commit message is valid or not
  isValidCommit(commit) {
    return ChainUtility.verifySignature(
      commit.publicKey,
      commit.signature,
      commit.blockHash,
    );
  }
}

module.exports = CommitPool;
