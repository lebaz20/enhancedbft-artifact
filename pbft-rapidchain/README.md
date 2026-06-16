# PBFT-RapidChain Implementation

## Overview

This is a **RapidChain-inspired PBFT** implementation featuring a **committee-based consensus architecture** with **two-level validation**. It extends the standard PBFT protocol with a dedicated committee shard that provides an additional layer of validation for enhanced security and scalability.

## Key Features

- **Committee-Based Consensus**: Separate committee shard for block validation
- **Dual-Chain Architecture**: Regular shard chains + committee chain for enhanced security
- **Two-Level Validation**: Blocks validated by both shard nodes and committee
- **Core Server**: Centralized coordination server for committee communication
- **Hierarchical Byzantine Fault Tolerance**: Multi-tier fault tolerance
- **IDA Gossip Protocol**: Efficient information dispersal with committee support
- **Separate Block Thresholds**: Different thresholds for regular and committee blocks
- **Scalable Architecture**: Committee validates blocks from multiple shards

## Architecture

### Components

1. **P2P Servers (`appP2p.js`)**: 
   - Regular shard nodes processing transactions
   - HTTP API for transaction submission
   - WebSocket communication with peers and core server
   - No committee logic (regular consensus only)

2. **Core Server (`appCore.js`)**: 
   - **Committee-only server** managing the committee chain
   - Receives blocks from all shards for committee validation
   - Routes validated blocks back to shards
   - Initialized with `isCore=true` flag

3. **Blockchain Service**: 
   - **Dual chains**:
     - `chain[SUBSET_INDEX]`: Regular shard chain
     - `committeeChain`: Committee validation chain
   - Constructor parameter `isCore` determines chain initialization
   - Supports `isCommittee` parameter throughout validation logic

4. **Transaction Pool**: 
   - **Dual pools**:
     - `transactions`: Regular transaction pool (`TRANSACTION_THRESHOLD`)
     - `committeeTransactions`: Committee transaction pool (`BLOCK_THRESHOLD`)
   - Separate reassignment timeouts for each pool

5. **Consensus Pools**:
   - Each pool maintains **dual lists**:
     - `BlockPool`: `blocks` + `committeeBlocks`
     - `PreparePool`: `list` + `committeeList`
     - `CommitPool`: `list` + `committeeList`
     - `MessagePool`: `list` + `committeeList`
   - All methods accept `isCommittee` parameter for routing

6. **P2P Server Enhanced**:
   - **COMMITTEE_PEERS**: Separate peer list for committee nodes
   - **Dual broadcast methods**: Regular + committee-specific
   - **Core connection**: WebSocket to core server
   - Manages separate socket pools for regular and committee peers

### Committee Consensus Flow

#### Phase 1: Shard-Level Consensus

1. **Transaction Processing**:
   - Clients submit transactions to shard nodes
   - Transactions fill regular pool to `TRANSACTION_THRESHOLD`

2. **Shard Block Creation**:
   - Shard proposer creates block from transaction pool
   - Block goes through standard PBFT (PRE-PREPARE → PREPARE → COMMIT)
   - Shard nodes achieve local consensus

3. **Send to Committee**:
   - After shard consensus, block sent to **core server**
   - Message type: `COMMITTEE_BLOCK_TO_CORE`
   - Core server receives blocks from all shards

#### Phase 2: Committee-Level Validation

4. **Committee Processing**:
   - Core server adds block to committee transaction pool
   - Committee pool fills to `BLOCK_THRESHOLD` (typically lower, e.g., 10)
   - Committee proposer creates validation block

5. **Committee Consensus**:
   - Committee nodes run PBFT on validation block
   - Validates blocks from multiple shards in single committee block
   - Need > 2/3 committee approval

6. **Finalization**:
   - After committee consensus, blocks are finalized
   - Validated blocks can be propagated back to shards
   - System achieves two-level Byzantine fault tolerance

### Message Types

Standard PBFT messages plus:
- `COMMITTEE_BLOCK_TO_CORE`: Shard blocks sent to committee validation
- All standard PBFT messages support `isCommittee` flag internally

## Configuration

Extended configuration in `config.js`:

```javascript
{
  // Standard shard configuration
  TRANSACTION_THRESHOLD: 100,       // Regular transactions per block
  NUMBER_OF_NODES: 4,               // Total nodes in network
  NUMBER_OF_NODES_PER_SHARD: 4,     // Nodes per shard
  NODES_SUBSET: [0,1,2,3],          // Node indices in this shard
  SUBSET_INDEX: "SUBSET1",          // Shard identifier
  PEERS: ["ws://..."],              // Regular peer nodes
  
  // Committee-specific configuration
  BLOCK_THRESHOLD: 10,              // Committee blocks threshold
  COMMITTEE_SUBSET: [0,1,2,3],      // Committee node indices
  COMMITTEE_SUBSET_INDEX: "SUBSET_COMMITTEE",
  COMMITTEE_PEERS: ["ws://..."],    // Committee peer nodes
  HAS_COMMITTEE_SHARD: true,        // Enable committee validation
  CORE: "ws://core-server:4999"     // Core server connection
}
```

### Configuration Generation

`prepare-config.js` generates:
- Kubernetes deployment configs
- Per-node environment variables
- Random committee selection
- Peer topology for regular and committee networks

## Differences from PBFT-Enhanced

| Feature | PBFT-Enhanced | **PBFT-RapidChain** |
|---------|---------------|---------------------|
| **Architecture** | Single-chain per shard | **Dual-chain: shard + committee** |
| **Chains** | `chain[SUBSET_INDEX]` | `chain[SUBSET_INDEX]` + **`committeeChain`** |
| **Transaction Pools** | `transactions` only | `transactions` + **`committeeTransactions`** |
| **Block Thresholds** | `TRANSACTION_THRESHOLD` (100) | `TRANSACTION_THRESHOLD` (100) + **`BLOCK_THRESHOLD`** (10) |
| **Validators** | Shard validators only | Shard validators + **committee validators** |
| **Servers** | P2P servers only | P2P servers + **Core server** |
| **Message Types** | 6 standard types | 7 types + **`COMMITTEE_BLOCK_TO_CORE`** |
| **Consensus Levels** | Single-level (shard) | **Two-level (shard → committee)** |
| **Peer Management** | `PEERS` only | `PEERS` + **`COMMITTEE_PEERS`** |
| **Pool Architecture** | Single lists | **Dual lists** (`list` + `committeeList`) |
| **Blockchain Constructor** | `(validators, pool)` | `(validators, pool, isCore)` |
| **Message Validation** | Standard parameters | Standard + **`isCommittee`** flag |
| **Code References** | N/A | **230 committee-specific references** |

### Why Choose PBFT-RapidChain?

- **Enhanced Security**: Two-level validation reduces attack surface
- **Separation of Concerns**: Processing (shards) vs validation (committee)
- **Scalability**: Committee validates multiple shards efficiently
- **Hierarchical Fault Tolerance**: Tolerates faults at both levels
- **Research-Ready**: Implements cutting-edge consensus architecture
- **Flexible Thresholds**: Different thresholds optimize for different workloads

### When to Use PBFT-Enhanced Instead?

- Need simpler architecture for development/testing
- Lower security requirements don't justify committee overhead
- Smaller networks where single-level consensus suffices
- Want baseline performance comparison

## Key Files with Committee Logic

### Core Services (230 total references)

1. **blockchain.js** (21 refs):
   - `committeeChain` array
   - `addBlock(block, subsetIndex, isCommittee)`
   - `getProposer(blocksCount, isCommittee)`
   - `isValidBlock(block, ..., isCommittee)`

2. **p2pserver.js** (113 refs):
   - `COMMITTEE_PEERS` configuration
   - Dual broadcast methods
   - `connectToCore(isCommittee)` method
   - Threshold calculation: `isCommittee ? BLOCK_THRESHOLD : TRANSACTION_THRESHOLD`

3. **coreserver.js** (10 refs):
   - `COMMITTEE_SUBSET_INDEX` import
   - `listen(isCommittee=true)` method
   - `sendBlockToCommitteeShard()` routing
   - Committee-specific message handling

4. **pools/transaction.js** (35 refs):
   - `committeeTransactions` object
   - `addTransaction(transaction, isCommittee)`
   - `assignTransactions(block, isCommittee)`
   - `poolFull(isCommittee)` with `BLOCK_THRESHOLD` check

5. **pools/block.js** (5 refs):
   - `committeeBlocks` array
   - All methods: `existingBlock`, `addBlock`, `getBlock` with `isCommittee`

6. **pools/commit.js, prepare.js, message.js** (6 refs each):
   - `committeeList` object
   - All methods accept `isCommittee` parameter
   - Separate list management for regular and committee consensus

7. **appCore.js**:
   - Initializes blockchain with `isCore=true`
   - Creates `committeeChain` instead of shard chains
   - Dedicated to committee validation logic

8. **config.js** (5 refs):
   - `BLOCK_THRESHOLD` configuration
   - `COMMITTEE_SUBSET`, `COMMITTEE_PEERS` arrays
   - `COMMITTEE_SUBSET_INDEX` identifier
   - `HAS_COMMITTEE_SHARD` flag

9. **utils/messageValidator.js** (9 refs):
   - All validation methods accept `isCommittee`
   - `isValidPrepare(prepare, ..., isCommittee)`
   - `isValidCommit(commit, ..., isCommittee)`
   - `isValidBlock(block, ..., isCommittee)`

10. **constants/message.js** (1 ref):
    - `COMMITTEE_BLOCK_TO_CORE` message type

11. **prepare-config.js** (13 refs):
    - Generates committee configurations
    - Creates `committeeSubset` array
    - Sets `COMMITTEE_PEERS` for committee nodes

## Running the Implementation

### Prerequisites

```bash
npm install
```

### Development Mode

```bash
# Start P2P node
HTTP_PORT=3001 P2P_PORT=5001 SECRET=NODE0 node appP2p.js

# Start Core server
node appCore.js
```

### Production with Kubernetes

```bash
# Configure: sets NUMBER_OF_NODES, BLOCK_THRESHOLD, etc.
# Generates kubeConfig.yml and nodesEnv.yml
./start.sh

# Deploys:
# - Multiple P2P server pods (one per node)
# - One Core server pod (committee coordinator)
# - Services for each pod with port forwarding
```

## Testing

```bash
# Run all tests with coverage
yarn test:coverage

# Run specific test suite
yarn test services/blockchain.test.js
```

**Current Test Coverage**: 66.59% (exceeds 50% threshold)
- 282 tests passing
- All committee logic tested

## API Endpoints

### P2P Nodes
- `GET /transactions` - List transactions in regular pool
- `GET /blocks` - Get shard blockchain
- `GET /stats` - Blockchain statistics (includes rate)
- `GET /health` - Health check
- `POST /transaction` - Submit transaction(s)
- `POST /message` - Process PBFT message (internal)

### Core Server
- WebSocket-only (no HTTP API)
- Receives blocks from shards
- Routes blocks to committee nodes

## Performance Monitoring

Tracks metrics for both regular and committee:
- **Block rate**: Separate rates for shard and committee chains
- **Transaction throughput**: Per shard and aggregate
- **Committee efficiency**: Time from shard consensus to committee validation
- **CPU utilization**: Per node and per server type
- **Consensus latency**: Shard + committee validation time

## Logging

Uses `utils/logger.js` for structured logging:
- Separate logs for P2P and Core servers
- Committee operations clearly labeled
- File output: `server.log`
- Console output with timestamps

## Project Structure

```
pbft-rapidchain/
├── appP2p.js                 # P2P node application (regular consensus)
├── appCore.js                # Core server (committee consensus)
├── prepare-config.js         # Config generation with committee support
├── config.js                 # Extended configuration (+ committee)
├── services/
│   ├── blockchain.js         # Dual-chain blockchain (+ committeeChain)
│   ├── p2pserver.js          # Enhanced P2P (+ COMMITTEE_PEERS)
│   ├── coreserver.js         # Core server for committee coordination
│   ├── wallet.js             # Cryptographic operations
│   ├── validators.js         # Validator management
│   ├── transaction.js        # Transaction creation
│   ├── block.js              # Block structure
│   ├── idaGossip.js          # IDA protocol
│   └── pools/                # Dual-list consensus pools
│       ├── block.js          # blocks + committeeBlocks
│       ├── transaction.js    # transactions + committeeTransactions
│       ├── prepare.js        # list + committeeList
│       ├── commit.js         # list + committeeList
│       └── message.js        # list + committeeList
├── utils/
│   ├── chain.js              # Chain utilities
│   ├── logger.js             # Logging utility
│   ├── cpu.js                # CPU monitoring
│   ├── rate.js               # Rate calculation
│   └── messageValidator.js   # Validation (+ isCommittee support)
├── constants/
│   ├── message.js            # Message types (+ COMMITTEE_BLOCK_TO_CORE)
│   ├── status.js             # Status constants
│   └── timeouts.js           # Timeout configurations
└── Dockerfile.core           # Core server container
    Dockerfile.p2p            # P2P server container
```

## Committee Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Applications                     │
└──────────────┬──────────────────────────┬───────────────────┘
               │                          │
               ▼                          ▼
    ┌──────────────────┐      ┌──────────────────┐
    │   Shard 1 Nodes  │      │   Shard 2 Nodes  │
    │  (P2P Servers)   │      │  (P2P Servers)   │
    │                  │      │                  │
    │ • PBFT Consensus │      │ • PBFT Consensus │
    │ • Regular Chain  │      │ • Regular Chain  │
    │ • Tx Threshold   │      │ • Tx Threshold   │
    └────────┬─────────┘      └─────────┬────────┘
             │                          │
             │   COMMITTEE_BLOCK_       │
             │   TO_CORE Message        │
             │                          │
             └──────────┬───────────────┘
                        ▼
              ┌─────────────────────┐
              │    Core Server      │
              │                     │
              │ • Committee Chain   │
              │ • Block Threshold   │
              │ • Shard Aggregation │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │  Committee Nodes    │
              │  (subset of P2Ps)   │
              │                     │
              │ • PBFT on Blocks    │
              │ • Final Validation  │
              │ • committeeChain    │
              └─────────────────────┘
                         │
                         ▼
                  [ Finalized ]
```

## Security Considerations

### Byzantine Fault Tolerance

- **Shard Level**: Tolerates up to f₁ faulty nodes where n₁ ≥ 3f₁ + 1
- **Committee Level**: Tolerates up to f₂ faulty committee nodes where n₂ ≥ 3f₂ + 1
- **Combined**: Two-level validation makes attacks significantly harder

### Attack Vectors

1. **Shard Compromise**: Even if entire shard is compromised, committee rejects invalid blocks
2. **Committee Compromise**: Requires compromising both shard AND committee
3. **Core Server**: Single point of coordination but doesn't participate in consensus

## Research & References

This implementation is inspired by:
- **RapidChain** (Zamani et al., 2018): Committee-based sharding
- **PBFT** (Castro & Liskov, 1999): Core consensus algorithm
- **IDA** (Rabin, 1989): Information Dispersal Algorithm for gossip

## License

[Add your license here]

## Contributing

[Add contributing guidelines here]

## Troubleshooting

### Common Issues

1. **Committee not receiving blocks**: Check `CORE` websocket connection
2. **Wrong threshold**: Verify `BLOCK_THRESHOLD` vs `TRANSACTION_THRESHOLD`
3. **Pool routing**: Ensure `isCommittee` parameter passed correctly
4. **Missing committee peers**: Check `COMMITTEE_PEERS` configuration

### Debug Tips

- Enable verbose logging: `logger.log` statements throughout
- Check committee references: `grep -r "isCommittee\|committeeChain" services/`
- Verify dual pools: Check both regular and committee lists exist
- Test committee flow: Submit blocks and trace through core server
