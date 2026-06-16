// Import all required models
const express = require('express')
const bodyParser = require('body-parser')
const config = require('./config')
const logger = require('./utils/logger')
const Wallet = require('./services/wallet')
const P2pserver = require('./services/p2pserver')
const Validators = require('./services/validators')
const Blockchain = require('./services/blockchain')
const IDAGossip = require('./services/idaGossip')
const TransactionPool = require('./services/pools/transaction')
const BlockPool = require('./services/pools/block')
const CommitPool = require('./services/pools/commit')
const PreparePool = require('./services/pools/prepare')
const MessagePool = require('./services/pools/message')
const MESSAGE_TYPE = require('./constants/message')

const HTTP_PORT = process.env.HTTP_PORT || 3001
const P2P_PORT = process.env.P2P_PORT || 5001
const { NODES_SUBSET, SUBSET_INDEX, COMMITTEE_SUBSET } = config.get()

// Instantiate all objects
const app = express()
app.use(bodyParser.json())

const wallet = new Wallet(process.env.SECRET)
const transactionPool = new TransactionPool()
const validators = new Validators(NODES_SUBSET)
// Committee validators are based on COMMITTEE_SUBSET so that committee nodes
// from different shards can validate each other's messages. Without this, cross-shard
// committee transactions would be silently rejected by shard validators.
const committeeValidators =
  COMMITTEE_SUBSET.length > 0 ? new Validators(COMMITTEE_SUBSET) : validators
const blockchain = new Blockchain(validators, transactionPool, false, committeeValidators)
const blockPool = new BlockPool()
const preparePool = new PreparePool()
const commitPool = new CommitPool()
const messagePool = new MessagePool()
const idaGossip = new IDAGossip()
const p2pserver = new P2pserver(
  blockchain,
  transactionPool,
  wallet,
  blockPool,
  preparePool,
  commitPool,
  messagePool,
  validators,
  idaGossip,
  committeeValidators
)

// sends all transactions in the transaction pool to the user
app.get('/transactions', (request, response) => {
  response.json(transactionPool.transactions)
})

// sends the entire chain to the user
app.get('/blocks', (request, response) => {
  response.json(blockchain.chain)
})

// sends the chain stats to the user
app.get('/stats', async (request, response) => {
  const rate = await blockchain.getRate(p2pserver.sockets)
  const { IS_FAULTY } = config.get()
  const stats = {
    total: blockchain.getTotal(),
    rate,
    isFaulty: IS_FAULTY
  }
  logger.log(`REQUEST STATS FOR #${SUBSET_INDEX}:`, JSON.stringify(stats))
  response.json(stats)
})

// check server health
app.get('/health', (request, response) => {
  response.status(200).send('Ok')
})

async function processTransactions(data) {
  for (const item of data) {
    logger.debug(`Processing transaction on ${HTTP_PORT}`, JSON.stringify(item))
    const transaction = wallet.createTransaction(item)
    p2pserver.parseMessage({ type: MESSAGE_TYPE.transaction, transaction, port: P2P_PORT })
    p2pserver.broadcastTransaction(P2P_PORT, transaction)
  }
}

// creates transactions for the sent data
app.post('/transaction', async (request, response) => {
  const { IS_FAULTY, REDIRECT_TO_URL, SHOULD_REDIRECT_FROM_FAULTY_NODES } = config.get()
  const unassignedTransactions = transactionPool.transactions.unassigned
  const hasUnassignedTransactions = unassignedTransactions && unassignedTransactions.length > 0
  if (
    IS_FAULTY &&
    SHOULD_REDIRECT_FROM_FAULTY_NODES &&
    Array.isArray(REDIRECT_TO_URL) &&
    REDIRECT_TO_URL.length > 0
  ) {
    let lastError = null
    for (const redirectUrl of REDIRECT_TO_URL) {
      logger.log(`Redirect from ${HTTP_PORT} to ${redirectUrl}`)
      try {
        await idaGossip.sendToAnotherShard({
          message: {
            transactions: hasUnassignedTransactions
              ? [
                  ...unassignedTransactions.map((transaction) => transaction.input.data),
                  request.body
                ]
              : request.body
          },
          chunkKey: 'transactions',
          targetsSubset: [`${redirectUrl}/transaction`]
        })
        if (hasUnassignedTransactions) {
          transactionPool.transactions.unassigned = []
        }
        // If successful, return the response immediately
        return response.status(200).send()
      } catch (error) {
        lastError = error
        // Try next redirectUrl in the array
        logger.warn(`Redirect to ${redirectUrl} failed:`, error)
      }
    }
    // If all redirects fail, return the last error
    return response
      .status(lastError?.response?.status || 500)
      .send(lastError?.message || 'All redirects failed')
  } else {
    try {
      const data = request.body.transactions ? request.body.transactions : [request.body]
      // Respond immediately before P2P work so HTTP round-trip is not blocked
      // by gossip/socket-write fan-out — matches Enhanced's setImmediate pattern.
      response.json({ ok: true })
      setImmediate(() => processTransactions(data))
    } catch (error) {
      logger.warn(`Transaction processing error on ${HTTP_PORT}:`, error)
      response.json({ ok: true })
    }
  }
})

// parse message
app.post('/message', async (request, response) => {
  logger.log(`Processing message on ${HTTP_PORT}`, JSON.stringify(request.body))
  p2pserver.parseMessage(request.body)
  response.status(200).send('Ok')
})

// Defence-in-depth: catch any uncaught exception or unhandled rejection that
// slips through so the process does NOT exit (which would cause CrashLoopBackOff
// and TCP "Connection reset" errors in JMeter).  The primary fix is in gossipChunk
// (no longer re-throws), but this ensures any future unhandled throw is logged
// instead of killing the process.
process.on('uncaughtException', (err) => {
  logger.error(`UNCAUGHT EXCEPTION (process kept alive): ${err.message}`, err.stack)
})
process.on('unhandledRejection', (reason) => {
  logger.error(`UNHANDLED REJECTION (process kept alive):`, reason)
})

// starts the app server
app.listen(HTTP_PORT, () => {
  logger.log(`Listening on port ${HTTP_PORT}`)
})

// starts the p2p server
p2pserver.listen()
