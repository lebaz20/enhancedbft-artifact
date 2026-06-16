const CommitPool = require('../services/pools/commit')
const Wallet = require('../services/wallet')

describe('CommitPool', () => {
  let commitPool
  let wallet
  let prepare

  beforeEach(() => {
    commitPool = new CommitPool()
    wallet = new Wallet('test-secret')
    prepare = {
      blockHash: 'test-block-hash',
      publicKey: wallet.getPublicKey(),
      signature: 'test-signature'
    }
  })

  describe('constructor', () => {
    it('should initialize with empty list', () => {
      expect(commitPool.list).toBeDefined()
      expect(typeof commitPool.list).toBe('object')
      expect(Object.keys(commitPool.list).length).toBe(0)
    })

    it('should initialize with empty committeeList', () => {
      expect(commitPool.committeeList).toBeDefined()
      expect(typeof commitPool.committeeList).toBe('object')
      expect(Object.keys(commitPool.committeeList).length).toBe(0)
    })
  })

  describe('createCommit', () => {
    it('should create a commit message', () => {
      const commit = commitPool.createCommit(prepare, wallet)

      expect(commit).toBeDefined()
      expect(commit.blockHash).toBe(prepare.blockHash)
      expect(commit.publicKey).toBe(wallet.getPublicKey())
      expect(commit.signature).toBeDefined()
      expect(typeof commit.signature).toBe('string')
    })

    it('should create consistent signatures', () => {
      const commit1 = commitPool.createCommit(prepare, wallet)
      const commit2 = commitPool.createCommit(prepare, wallet)

      expect(commit1.signature).toBe(commit2.signature)
    })

    it('should create different signatures for different wallets', () => {
      const wallet2 = new Wallet('different-secret')
      const commit1 = commitPool.createCommit(prepare, wallet)
      const commit2 = commitPool.createCommit(prepare, wallet2)

      expect(commit1.publicKey).not.toBe(commit2.publicKey)
      expect(commit1.signature).not.toBe(commit2.signature)
    })

    it('should use blockHash from prepare', () => {
      const differentPrepare = {
        blockHash: 'different-hash',
        publicKey: 'test-key',
        signature: 'sig'
      }
      const commit = commitPool.createCommit(differentPrepare, wallet)

      expect(commit.blockHash).toBe('different-hash')
    })
  })

  describe('addCommit', () => {
    it('should add commit to list', () => {
      const commit = commitPool.createCommit(prepare, wallet)

      commitPool.addCommit(commit)

      expect(commitPool.list[prepare.blockHash]).toBeDefined()
      expect(commitPool.list[prepare.blockHash].length).toBe(1)
      expect(commitPool.list[prepare.blockHash][0]).toBe(commit)
    })

    it('should initialize list for new block hash', () => {
      const commit = commitPool.createCommit(prepare, wallet)

      commitPool.addCommit(commit)

      expect(Array.isArray(commitPool.list[prepare.blockHash])).toBe(true)
    })

    it('should add multiple commits for same block', () => {
      const wallet2 = new Wallet('different-secret')
      const commit1 = commitPool.createCommit(prepare, wallet)
      const commit2 = commitPool.createCommit(prepare, wallet2)

      commitPool.addCommit(commit1)
      commitPool.addCommit(commit2)

      expect(commitPool.list[prepare.blockHash].length).toBe(2)
    })

    it('should handle commits for different blocks', () => {
      const prepare2 = { ...prepare, blockHash: 'hash2' }
      const commit1 = commitPool.createCommit(prepare, wallet)
      const commit2 = commitPool.createCommit(prepare2, wallet)

      commitPool.addCommit(commit1)
      commitPool.addCommit(commit2)

      expect(Object.keys(commitPool.list).length).toBe(2)
      expect(commitPool.list[prepare.blockHash].length).toBe(1)
      expect(commitPool.list['hash2'].length).toBe(1)
    })

    it('should add commit to committeeList when isCommittee=true', () => {
      const commit = commitPool.createCommit(prepare, wallet)

      commitPool.addCommit(commit, true)

      expect(commitPool.committeeList[prepare.blockHash]).toBeDefined()
      expect(commitPool.committeeList[prepare.blockHash].length).toBe(1)
      expect(commitPool.committeeList[prepare.blockHash][0]).toBe(commit)
      expect(commitPool.list[prepare.blockHash]).toBeUndefined()
    })

    it('should add commit to regular list when isCommittee=false', () => {
      const commit = commitPool.createCommit(prepare, wallet)

      commitPool.addCommit(commit, false)

      expect(commitPool.list[prepare.blockHash]).toBeDefined()
      expect(commitPool.list[prepare.blockHash].length).toBe(1)
      expect(commitPool.committeeList[prepare.blockHash]).toBeUndefined()
    })
  })

  describe('existingCommit', () => {
    it('should return false for non-existing commit', () => {
      const commit = commitPool.createCommit(prepare, wallet)

      expect(commitPool.existingCommit(commit)).toBe(false)
    })

    it('should return true for existing commit', () => {
      const commit = commitPool.createCommit(prepare, wallet)
      commitPool.addCommit(commit)

      expect(commitPool.existingCommit(commit)).toBe(true)
    })

    it('should identify commit by publicKey', () => {
      const commit = commitPool.createCommit(prepare, wallet)
      commitPool.addCommit(commit)

      const sameCommit = {
        blockHash: prepare.blockHash,
        publicKey: wallet.getPublicKey(),
        signature: 'different-signature'
      }

      expect(commitPool.existingCommit(sameCommit)).toBe(true)
    })

    it('should return false for different publicKey', () => {
      const wallet2 = new Wallet('different-secret')
      const commit1 = commitPool.createCommit(prepare, wallet)
      const commit2 = commitPool.createCommit(prepare, wallet2)

      commitPool.addCommit(commit1)

      expect(commitPool.existingCommit(commit2)).toBe(false)
    })
  })

  describe('commit', () => {
    it('should create and add commit', () => {
      const commit = commitPool.commit(prepare, wallet)

      expect(commit).toBeDefined()
      expect(commit.blockHash).toBe(prepare.blockHash)
      expect(commitPool.list[prepare.blockHash].length).toBe(1)
    })

    it('should return the created commit', () => {
      const commit = commitPool.commit(prepare, wallet)

      expect(commitPool.existingCommit(commit)).toBe(true)
    })

    it('should add commit to pool automatically', () => {
      commitPool.commit(prepare, wallet)

      expect(commitPool.list[prepare.blockHash]).toBeDefined()
      expect(commitPool.list[prepare.blockHash].length).toBe(1)
    })
  })

  describe('getList', () => {
    it('should return commit list for block hash', () => {
      const commit = commitPool.createCommit(prepare, wallet)
      commitPool.addCommit(commit)

      const list = commitPool.getList(prepare.blockHash)

      expect(list).toBeDefined()
      expect(Array.isArray(list)).toBe(true)
      expect(list.length).toBe(1)
      expect(list[0]).toBe(commit)
    })

    it('should return undefined for non-existing hash', () => {
      const list = commitPool.getList('non-existing')

      expect(list).toBeUndefined()
    })

    it('should return all commits for a block', () => {
      const wallet2 = new Wallet('secret2')
      const wallet3 = new Wallet('secret3')

      commitPool.commit(prepare, wallet)
      commitPool.commit(prepare, wallet2)
      commitPool.commit(prepare, wallet3)

      const list = commitPool.getList(prepare.blockHash)

      expect(list.length).toBe(3)
    })

    it('should return committeeList when isCommittee=true', () => {
      const commit = commitPool.createCommit(prepare, wallet)
      commitPool.addCommit(commit, true)

      const list = commitPool.getList(prepare.blockHash, true)

      expect(list).toBeDefined()
      expect(Array.isArray(list)).toBe(true)
      expect(list.length).toBe(1)
      expect(list[0]).toBe(commit)
    })

    it('should return regular list when isCommittee=false', () => {
      const commit = commitPool.createCommit(prepare, wallet)
      commitPool.addCommit(commit, false)

      const list = commitPool.getList(prepare.blockHash, false)

      expect(list).toBeDefined()
      expect(list.length).toBe(1)
      expect(list[0]).toBe(commit)
    })
  })

  describe('isValidCommit', () => {
    it('should validate correct commit', () => {
      const commit = commitPool.createCommit(prepare, wallet)

      expect(commitPool.isValidCommit(commit)).toBe(true)
    })

    it('should reject commit with invalid signature', () => {
      const commit = commitPool.createCommit(prepare, wallet)
      commit.signature = 'a'.repeat(128) // Properly sized but invalid

      expect(commitPool.isValidCommit(commit)).toBe(false)
    })

    it('should reject commit with wrong publicKey', () => {
      const wallet2 = new Wallet('different-secret')
      const commit = commitPool.createCommit(prepare, wallet)
      commit.publicKey = wallet2.getPublicKey()

      expect(commitPool.isValidCommit(commit)).toBe(false)
    })

    it('should reject commit with mismatched hash', () => {
      const commit = commitPool.createCommit(prepare, wallet)
      commit.blockHash = 'different-hash'

      expect(commitPool.isValidCommit(commit)).toBe(false)
    })
  })
})
