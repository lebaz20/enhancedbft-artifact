const ChainUtility = require('../utils/chain')

describe('ChainUtility', () => {
  describe('genKeyPair', () => {
    it('should generate a key pair from a secret', () => {
      const secret = 'test-secret'
      const keyPair = ChainUtility.genKeyPair(secret)

      expect(keyPair).toBeDefined()
      expect(keyPair.getPublic).toBeDefined()
      expect(keyPair.getSecret).toBeDefined()
    })

    it('should generate the same key pair for the same secret', () => {
      const secret = 'consistent-secret'
      const keyPair1 = ChainUtility.genKeyPair(secret)
      const keyPair2 = ChainUtility.genKeyPair(secret)

      expect(keyPair1.getPublic('hex')).toBe(keyPair2.getPublic('hex'))
    })

    it('should generate different key pairs for different secrets', () => {
      const keyPair1 = ChainUtility.genKeyPair('secret1-with-enough-variation')
      const keyPair2 = ChainUtility.genKeyPair('secret2-with-enough-variation')

      expect(keyPair1.getPublic('hex')).not.toBe(keyPair2.getPublic('hex'))
    })
  })

  describe('id', () => {
    it('should generate a unique ID', () => {
      const id1 = ChainUtility.id()
      const id2 = ChainUtility.id()

      expect(id1).toBeDefined()
      expect(id2).toBeDefined()
      expect(id1).not.toBe(id2)
    })

    it('should generate a valid UUID v1 format', () => {
      const id = ChainUtility.id()
      const uuidv1Regex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

      expect(id).toMatch(uuidv1Regex)
    })
  })

  describe('hash', () => {
    it('should hash data consistently', () => {
      const data = { value: 'test data', timestamp: 123456 }
      const hash1 = ChainUtility.hash(data)
      const hash2 = ChainUtility.hash(data)

      expect(hash1).toBe(hash2)
      expect(hash1).toBeTruthy()
      expect(hash1.length).toBe(64) // SHA256 produces 64 character hex string
    })

    it('should produce different hashes for different data', () => {
      const data1 = { value: 'data1' }
      const data2 = { value: 'data2' }

      const hash1 = ChainUtility.hash(data1)
      const hash2 = ChainUtility.hash(data2)

      expect(hash1).not.toBe(hash2)
    })

    it('should handle complex nested objects', () => {
      const complexData = {
        nested: {
          deep: {
            value: 'test',
            array: [1, 2, 3]
          }
        }
      }

      const hash = ChainUtility.hash(complexData)
      expect(hash).toBeTruthy()
      expect(hash.length).toBe(64)
    })

    it('should handle arrays', () => {
      const arrayData = [1, 2, 3, 4, 5]
      const hash = ChainUtility.hash(arrayData)

      expect(hash).toBeTruthy()
      expect(hash.length).toBe(64)
    })
  })

  describe('verifySignature', () => {
    let keyPair
    let publicKey
    let dataHash
    let signature

    beforeEach(() => {
      keyPair = ChainUtility.genKeyPair('test-secret')
      publicKey = keyPair.getPublic('hex')
      dataHash = ChainUtility.hash({ test: 'data' })
      signature = keyPair.sign(dataHash).toHex()
    })

    it('should verify a valid signature', () => {
      const isValid = ChainUtility.verifySignature(
        publicKey,
        signature,
        dataHash
      )
      expect(isValid).toBe(true)
    })

    it('should reject an invalid signature', () => {
      // Use a valid format signature but from wrong data
      const wrongKeyPair = ChainUtility.genKeyPair('wrong-secret')
      const wrongDataHash = ChainUtility.hash({ wrong: 'data' })
      const wrongSignature = wrongKeyPair.sign(wrongDataHash).toHex()

      const isValid = ChainUtility.verifySignature(
        publicKey,
        wrongSignature,
        dataHash
      )
      expect(isValid).toBe(false)
    })

    it('should reject when wrong public key is used', () => {
      const wrongKeyPair = ChainUtility.genKeyPair('different-secret')
      const wrongPublicKey = wrongKeyPair.getPublic('hex')

      const isValid = ChainUtility.verifySignature(
        wrongPublicKey,
        signature,
        dataHash
      )
      expect(isValid).toBe(false)
    })

    it('should reject when data hash does not match', () => {
      const differentDataHash = ChainUtility.hash({ different: 'data' })
      const isValid = ChainUtility.verifySignature(
        publicKey,
        signature,
        differentDataHash
      )
      expect(isValid).toBe(false)
    })
  })
})
