const Validators = require('../services/validators')
const Wallet = require('../services/wallet')

describe('Validators', () => {
  let validators
  const nodesSubset = [0, 1, 2, 3]

  beforeEach(() => {
    validators = new Validators(nodesSubset)
  })

  describe('constructor', () => {
    it('should create a validators object with a list', () => {
      expect(validators.list).toBeDefined()
      expect(Array.isArray(validators.list)).toBe(true)
      expect(validators.list.length).toBe(nodesSubset.length)
    })

    it('should generate correct number of validator addresses', () => {
      const moreNodes = [0, 1, 2, 3, 4, 5]
      const moreValidators = new Validators(moreNodes)
      expect(moreValidators.list.length).toBe(moreNodes.length)
    })
  })

  describe('generateAddresses', () => {
    it('should generate addresses based on node indices', () => {
      const addresses = validators.generateAddresses(nodesSubset)
      expect(addresses.length).toBe(nodesSubset.length)
      addresses.forEach((address) => {
        expect(typeof address).toBe('string')
        expect(address.length).toBeGreaterThan(0)
      })
    })

    it('should generate consistent addresses for same node indices', () => {
      const addresses1 = validators.generateAddresses([0, 1])
      const addresses2 = validators.generateAddresses([0, 1])
      expect(addresses1).toEqual(addresses2)
    })

    it('should generate different addresses for different node indices', () => {
      const addresses1 = validators.generateAddresses([0])
      const addresses2 = validators.generateAddresses([1])
      expect(addresses1[0]).not.toBe(addresses2[0])
    })

    it('should match wallet public key for node index', () => {
      const nodeIndex = 0
      const wallet = new Wallet(`NODE${nodeIndex}`)
      const addresses = validators.generateAddresses([nodeIndex])
      expect(addresses[0]).toBe(wallet.getPublicKey())
    })
  })

  describe('isValidValidator', () => {
    it('should return true for valid validator', () => {
      const validValidator = validators.list[0]
      expect(validators.isValidValidator(validValidator)).toBe(true)
    })

    it('should return false for invalid validator', () => {
      const invalidValidator = 'invalid-validator-address'
      expect(validators.isValidValidator(invalidValidator)).toBe(false)
    })

    it('should return false for empty string', () => {
      expect(validators.isValidValidator('')).toBe(false)
    })

    it('should return false for null', () => {
      expect(validators.isValidValidator(null)).toBe(false)
    })

    it('should return false for undefined', () => {
      expect(validators.isValidValidator(undefined)).toBe(false)
    })

    it('should validate all generated validators', () => {
      validators.list.forEach((validator) => {
        expect(validators.isValidValidator(validator)).toBe(true)
      })
    })
  })
})
