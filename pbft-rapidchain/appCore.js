const Coreserver = require('./services/coreserver')
const Blockchain = require('./services/blockchain')
const IDAGossip = require('./services/idaGossip')

function initCoreServer() {
  const blockchain = new Blockchain(undefined, undefined, true)
  const coreServerPort = 4999
  const idaGossip = new IDAGossip();
  const coreserver = new Coreserver(coreServerPort, blockchain, idaGossip)
  // starts the p2p server
  coreserver.listen();
}

initCoreServer()