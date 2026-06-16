const ChainUtility = require("../../utils/chain");

class CommitPool {
  // list object is a map that holds a list of commit messages for a hash of a block
  constructor() {
    this.list = {};
    this.committeeList = {};
  }

  // commit function initialize a list of commit message for a prepare message
  // and adds the commit message for the current node and
  // returns it
  commit(prepare, wallet, isCommittee = false) {
    const commit = this.createCommit(prepare, wallet);
    this.addCommit(commit, isCommittee);
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
  addCommit(commit, isCommittee = false) {
    if (!isCommittee) {
      if (!(commit.blockHash in this.list)) {
        this.list[commit.blockHash] = [];
      }
      this.list[commit.blockHash].push(commit);
    } else {
      if (!(commit.blockHash in this.committeeList)) {
        this.committeeList[commit.blockHash] = [];
      }
      this.committeeList[commit.blockHash].push(commit);
    }
  }

  // checks if the commit message already exists
  existingCommit(commit, isCommittee = false) {
    if (!isCommittee) {
      return !!this.list[commit.blockHash]?.find(
        (p) => p.publicKey === commit.publicKey,
      );
    } else {
      return !!this.committeeList[commit.blockHash]?.find(
        (p) => p.publicKey === commit.publicKey,
      );
    }
  }

  getList(hash, isCommittee = false) {
    if (!isCommittee) {
      return this.list[hash];
    } else {
      return this.committeeList[hash];
    }
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
