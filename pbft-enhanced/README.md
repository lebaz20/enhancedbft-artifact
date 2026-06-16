# PBFT-Enhanced Implementation

## Overview

This is an **enhanced Practical Byzantine Fault Tolerant (PBFT)** consensus implementation with **Information Dispersal Algorithm (IDA)** gossip protocol. It provides a baseline PBFT consensus mechanism with standard shard-based architecture.

## Key Features

- **Standard PBFT Consensus**: Classic three-phase commit protocol (Pre-Prepare, Prepare, Commit)
- **IDA Gossip Protocol**: Efficient information dispersal for transaction and block propagation
- **Shard-Based Architecture**: Multiple independent shards processing transactions in parallel
- **Byzantine Fault Tolerance**: Can tolerate up to f faulty nodes where n ≥ 3f + 1
- **Dynamic Transaction Pool**: Manages transaction assignment and reassignment across shards
- **Faulty Node Simulation**: Supports testing with intentionally faulty nodes for robustness validation

## Architecture

### Components

1. **P2P Server (`appP2p.js`)**: 
   - HTTP API for transaction submission and blockchain queries
   - WebSocket-based peer-to-peer communication
   - Transaction broadcasting and message handling

2. **Blockchain Service**: 
   - Single chain per shard: `chain[SUBSET_INDEX]`
   - Block validation and consensus management
   - Rate tracking for performance monitoring

3. **Transaction Pool**: 
   - Single pool: `transactions` object
   - Manages unassigned and assigned transactions
   - Standard threshold: `TRANSACTION_THRESHOLD` (default: 100)

4. **Consensus Pools**:
   - `BlockPool`: Stores pending blocks
   - `PreparePool`: Manages PREPARE messages
   - `CommitPool`: Tracks COMMIT messages
   - `MessagePool`: Handles round change messages

5. **IDA Gossip**: 
   - Information dispersal for efficient broadcast
   - Chunk-based transmission to reduce network load

### Consensus Flow

1. **Transaction Phase**:
   - Clients submit transactions via HTTP POST `/transaction`
   - Transactions are broadcast to all peers in the shard
   - Transaction pool fills up to `TRANSACTION_THRESHOLD`

2. **Block Proposal (PRE-PREPARE)**:
   - When pool is full, proposer creates a block
   - Block is broadcast to all validators in the shard
   - IDA gossip disperses block data efficiently

3. **Block Validation (PREPARE)**:
   - Validators verify block and signature
   - Send PREPARE messages to peers
   - Need > 2/3 PREPARE messages to proceed

4. **Block Commitment (COMMIT)**:
   - After sufficient PREPAREs, send COMMIT message
   - Need > 2/3 COMMIT messages to finalize
   - Block is added to the blockchain

5. **Round Change**:
   - If consensus fails, initiate round change
   - Validators vote for new round
   - System continues with next proposer

## Configuration

Key configuration parameters in `config.js`:

```javascript
{
  TRANSACTION_THRESHOLD: 100,  // Transactions per block
  NUMBER_OF_NODES: 4,          // Total nodes in network
  NUMBER_OF_NODES_PER_SHARD: 4, // Nodes per shard
  NODES_SUBSET: [0,1,2,3],     // Node indices in this shard
  SUBSET_INDEX: "SUBSET1",     // Shard identifier
  PEERS: ["ws://..."],         // WebSocket URLs of peer nodes
  MIN_APPROVALS: 3             // Minimum approvals (> 2/3)
}
```

## Differences from PBFT-RapidChain

| Feature | PBFT-Enhanced | PBFT-RapidChain |
|---------|---------------|-----------------|
| **Architecture** | Standard single-chain per shard | Dual-chain with committee validation |
| **Chains** | `chain[SUBSET_INDEX]` only | `chain[SUBSET_INDEX]` + `committeeChain` |
| **Transaction Pool** | Single `transactions` object | Dual: `transactions` + `committeeTransactions` |
| **Block Threshold** | `TRANSACTION_THRESHOLD` only | `TRANSACTION_THRESHOLD` + `BLOCK_THRESHOLD` |
| **Validators** | All nodes in shard | Regular validators + committee validators |
| **Servers** | P2P servers only | P2P servers + Core server |
| **Message Types** | Standard PBFT messages | Standard + `COMMITTEE_BLOCK_TO_CORE` |
| **Consensus** | Direct finalization | Two-level validation (shard → committee) |
| **Configuration** | Shard-level only | Shard + committee configurations |

### Why Choose PBFT-Enhanced?

- **Simpler Architecture**: Easier to understand and maintain
- **Lower Overhead**: No committee validation layer
- **Direct Consensus**: Faster finalization for low-security requirements
- **Standard PBFT**: Well-understood consensus mechanism
- **Testing & Development**: Baseline for comparing optimizations

### When to Use PBFT-RapidChain Instead?

- Need higher security with committee validation
- Require separation of concerns (processing vs validation)
- Large-scale networks benefiting from hierarchical consensus
- Want to test committee-based architectures

## Running the Implementation

### Prerequisites

```bash
npm install
```

### Development Mode

```bash
# Start a single node
HTTP_PORT=3001 P2P_PORT=5001 SECRET=NODE0 node appP2p.js
```

### Production with Kubernetes

```bash
# Configure and deploy
./start.sh
```

## Testing

```bash
# Run all tests with coverage
yarn test:coverage

# Run specific test suite
yarn test services/blockchain.test.js
```

**Current Test Coverage**: 75.56% (exceeds 50% threshold)

## API Endpoints

- `GET /transactions` - List all transactions in pool
- `GET /blocks` - Get entire blockchain
- `GET /stats` - Get blockchain statistics (total, rate)
- `GET /health` - Health check
- `POST /transaction` - Submit new transaction(s)
- `POST /message` - Process PBFT message (internal)

## Performance Monitoring

The implementation tracks:
- **Block rate**: Blocks per minute per shard
- **Transaction throughput**: Transactions processed per minute
- **CPU utilization**: Resource usage per node
- **Consensus latency**: Time from proposal to finalization

## Logging

Uses custom logger utility (`utils/logger.js`) for structured logging:
- File output: `server.log`
- Console output: stdout/stderr with timestamps
- Log levels: info, warn, error

## Project Structure

```
pbft-enhanced/
├── appP2p.js                 # Main P2P node application
├── config.js                 # Configuration management
├── services/
│   ├── blockchain.js         # Blockchain logic
│   ├── p2pserver.js          # P2P networking
│   ├── wallet.js             # Cryptographic operations
│   ├── validators.js         # Validator management
│   ├── transaction.js        # Transaction creation
│   ├── block.js              # Block structure
│   ├── idaGossip.js          # IDA protocol
│   └── pools/                # Consensus message pools
├── utils/
│   ├── chain.js              # Chain utilities
│   ├── logger.js             # Logging utility
│   └── messageValidator.js   # Message validation
└── constants/
    ├── message.js            # Message type constants
    ├── status.js             # Status constants
    └── timeouts.js           # Timeout configurations
```

## License

[Add your license here]

## Contributing

[Add contributing guidelines here]
