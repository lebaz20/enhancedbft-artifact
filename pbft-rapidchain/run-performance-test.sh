#!/bin/bash

# Performance Test Script for PBFT-RapidChain
# This script starts the blockchain using start.sh, runs JMeter tests, and saves performance results

set -e

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a server.log
}

# Configuration (use defaults from start.sh if not set)
export NUMBER_OF_NODES=${NUMBER_OF_NODES:-512}
export TRANSACTION_THRESHOLD=${TRANSACTION_THRESHOLD:-100}
export BLOCK_THRESHOLD=${BLOCK_THRESHOLD:-2}
export NUMBER_OF_FAULTY_NODES=${NUMBER_OF_FAULTY_NODES:-85}
export NUMBER_OF_NODES_PER_SHARD=${NUMBER_OF_NODES_PER_SHARD:-12}
export HAS_COMMITTEE_SHARD=${HAS_COMMITTEE_SHARD:-1}
export SHOULD_REDIRECT_FROM_FAULTY_NODES=${SHOULD_REDIRECT_FROM_FAULTY_NODES:-0}
export CPU_LIMIT=${CPU_LIMIT:-0.2}

# JMeter configuration
JMETER_THREADS=${JMETER_THREADS:-10}
JMETER_RAMP_UP=${JMETER_RAMP_UP:-5}
JMETER_DURATION=${JMETER_DURATION:-60}
# Ramp-down: last N seconds of the test window — JMeter stops sending at
# (DURATION - RAMP_DOWN) so the blockchain can drain without new load before
# the drain-wait phase starts. Set to 0 to disable (default: no ramp-down).
JMETER_RAMP_DOWN=${JMETER_RAMP_DOWN:-0}
# ConstantThroughputTimer unit is req/min; 6000 = 100 req/s
JMETER_THROUGHPUT=${JMETER_THROUGHPUT:-6000}

# Output files
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="performance-results"
RESULTS_FILE="${RESULTS_DIR}/pbft-rapidchain-${TIMESTAMP}.jtl"
SUMMARY_FILE="${RESULTS_DIR}/pbft-rapidchain-${TIMESTAMP}-summary.txt"
STATS_FILE="${RESULTS_DIR}/pbft-rapidchain-${TIMESTAMP}-stats.csv"

log "${BLUE}========================================${NC}"
log "${BLUE}PBFT-RapidChain Performance Test${NC}"
log "${BLUE}========================================${NC}"
log "Nodes: ${NUMBER_OF_NODES}"
log "Transaction Threshold: ${TRANSACTION_THRESHOLD}"
log "Block Threshold: ${BLOCK_THRESHOLD}"
log "Committee Shard: ${HAS_COMMITTEE_SHARD}"
log "JMeter Threads: ${JMETER_THREADS}"
log "Test Duration: ${JMETER_DURATION}s"
log "${BLUE}========================================${NC}"
echo

# Create results directory
mkdir -p "${RESULTS_DIR}"

# Cleanup function
cleanup() {
    log "\n${YELLOW}Cleaning up...${NC}"
    
    # Capture pod states BEFORE deletion for diagnostics
    log "Pod states at cleanup:"
    kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | awk '{print $3}' | sort | uniq -c | tee -a server.log || true
    kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | grep -v 'Running' > pods-not-running-detail.txt 2>/dev/null || true
    
    # Stop port forwarding and background log streaming
    if [ "${USE_HOST_NETWORK:-}" != "true" ]; then
        log "Stopping port forwarding..."
        pkill -f "kubectl port-forward" 2>&1 | tee -a server.log || true
        pkill -f "kubectl proxy" 2>&1 | tee -a server.log || true
    fi
    pkill -f "kubectl logs" 2>/dev/null || true
    
    # Delete Kubernetes resources
    log "Deleting Kubernetes resources..."
    kubectl delete -f kubeConfig.yml --ignore-not-found --grace-period=1 --force 2>&1 | tee -a server.log || true
    
    log "${GREEN}Cleanup complete${NC}"
}

# Set trap to cleanup on exit
trap cleanup EXIT INT TERM

# Step 1: Start blockchain using existing start.sh
log "${BLUE}Step 1: Starting blockchain (using start.sh)...${NC}"
# Run start.sh to completion so kubectl apply finishes all resources.
# Previously ran in background and killed early when port 3001 responded,
# but with hostNetwork the first pod responds almost immediately — while
# kubectl is still applying the remaining hundreds of resources.
AUTOMATED_TEST=true ./start.sh 2>&1 | tee -a server.log

# Clean up any port-forwards set up by start.sh (run-performance-test.sh
# manages its own port-forwards with a watchdog in non-hostNetwork mode)
if [ "${USE_HOST_NETWORK:-}" != "true" ]; then
    pkill -f "kubectl port-forward" 2>/dev/null || true
    pkill -f "kubectl proxy" 2>/dev/null || true
    sleep 2
fi

log "${GREEN}✓ Blockchain deployed and ready${NC}"
echo

# Step 2: Wait for ALL pods to pass readiness probes (httpGet /health).
# Memory raised to 256Mi so pods no longer crash under the P2P connection storm.
# Readiness probes are lenient (10s period, 5s timeout, 6 failures) to tolerate
# busy startup without false negatives.
log "${BLUE}Step 2: Waiting for all nodes to be ready...${NC}"
TOTAL_EXPECTED=$((NUMBER_OF_NODES))  # p2p-server pods only (core-server has no probe)
TIMEOUT=$((NUMBER_OF_NODES * 3))
[ $TIMEOUT -lt 600 ] && TIMEOUT=600
ELAPSED=0

while true; do
    READY=$(kubectl get pods -l app=p2p-server --no-headers 2>/dev/null | grep -c '1/1.*Running' || true)
    TOTAL=$(kubectl get pods -l app=p2p-server --no-headers 2>/dev/null | wc -l | tr -d ' ')
    PCT=0; [ "$TOTAL" -gt 0 ] && PCT=$((READY * 100 / TOTAL))

    if [ "$READY" -ge "$TOTAL_EXPECTED" ] && [ "$TOTAL" -ge "$TOTAL_EXPECTED" ]; then
        log "${GREEN}✓ All $READY/$TOTAL nodes are ready ($PCT%)${NC}"
        break
    fi

    if [ $ELAPSED -ge $TIMEOUT ]; then
        NOT_READY=$(kubectl get pods -l app=p2p-server --no-headers 2>/dev/null | grep -v '1/1.*Running' | awk '{print $3}' | sort | uniq -c | tr '\n' ', ')
        log "${RED}✗ Timeout after ${ELAPSED}s: $READY/$TOTAL ready ($PCT%), need all $TOTAL_EXPECTED${NC}"
        log "  Not ready: $NOT_READY"
        exit 1
    fi

    sleep 5
    ELAPSED=$((ELAPSED + 5))
    if (( ELAPSED % 10 == 0 )); then
        NOT_READY=$(kubectl get pods -l app=p2p-server --no-headers 2>/dev/null | grep -v '1/1.*Running' | awk '{print $3}' | sort | uniq -c | tr '\n' ', ')
        log "[Health] Ready: $READY/$TOTAL ($PCT%) | Need: all $TOTAL_EXPECTED | ${ELAPSED}s"
        [ -n "$NOT_READY" ] && log "  Not ready: $NOT_READY"
    fi
done
echo

# Step 2b: Wait for P2P mesh to stabilize before JMeter starts.
# Readiness probes only verify the HTTP endpoint is up — they don't check peer
# connectivity. At 512 nodes, ~1536 WebSocket connections fire simultaneously;
# until they all complete, many healthy shards self-report as FAULTY because
# they see fewer than MIN_APPROVALS connected peers. Polling the core-server's
# shard status ensures consensus can actually run before we send transactions.
if [ "${NUMBER_OF_NODES}" -gt 32 ]; then
    # Expected healthy shards = total_shards - broken_shards
    # Adversarial placement breaks floor(FAULTY_NODES / faultyPerShardToBreak) shards
    TOTAL_SHARDS=$((NUMBER_OF_NODES / NUMBER_OF_NODES_PER_SHARD))
    FAULTY_PER_SHARD_TO_BREAK=$(( NUMBER_OF_NODES_PER_SHARD / 3 + 1 ))
    BROKEN_SHARDS=$(( NUMBER_OF_FAULTY_NODES / FAULTY_PER_SHARD_TO_BREAK ))
    EXPECTED_HEALTHY=$(( TOTAL_SHARDS - BROKEN_SHARDS ))
    # Require at least 80% of expected healthy shards to be reporting UNDER-UTILIZED
    MIN_HEALTHY=$(( EXPECTED_HEALTHY * 80 / 100 ))
    [ "$MIN_HEALTHY" -lt 1 ] && MIN_HEALTHY=1
    log "${BLUE}Step 2b: Waiting for P2P mesh to stabilize ($MIN_HEALTHY/$EXPECTED_HEALTHY healthy shards needed)...${NC}"
    STABILIZE_TIMEOUT=300
    STABILIZE_ELAPSED=0
    while [ $STABILIZE_ELAPSED -lt $STABILIZE_TIMEOUT ]; do
        # Sample every Nth node (N = nodes_per_shard) and count distinct
        # non-FAULTY shard indices. Nodes are shuffled across shards so any
        # sampling stride covers different shards.
        HEALTHY_COUNT=$(
            for ((i=0; i<NUMBER_OF_NODES; i+=NUMBER_OF_NODES_PER_SHARD)); do
                PORT=$((3001 + i))
                curl -s --max-time 2 http://localhost:$PORT/stats 2>/dev/null || true
                echo  # newline delimiter so Python parses each response as a separate line
            done | python3 -c "
import sys, json
healthy = set()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        d = json.loads(line)
        shard = d.get('rate',{}).get('shardIndex','')
        status = d.get('rate',{}).get('shardStatus','FAULTY')
        if status != 'FAULTY' and shard:
            healthy.add(shard)
    except: pass
print(len(healthy))" 2>/dev/null || echo 0
        )
        if [ "${HEALTHY_COUNT:-0}" -ge "$MIN_HEALTHY" ]; then
            log "${GREEN}✓ P2P mesh stabilized: $HEALTHY_COUNT healthy shards (need $MIN_HEALTHY)${NC}"
            break
        fi
        sleep 5
        STABILIZE_ELAPSED=$((STABILIZE_ELAPSED + 5))
        if (( STABILIZE_ELAPSED % 15 == 0 )); then
            log "[P2P] Healthy shards: ${HEALTHY_COUNT:-0}/$EXPECTED_HEALTHY (need $MIN_HEALTHY) | ${STABILIZE_ELAPSED}s"
        fi
    done
    if [ $STABILIZE_ELAPSED -ge $STABILIZE_TIMEOUT ]; then
        log "${YELLOW}⚠ P2P stabilization timeout (${STABILIZE_TIMEOUT}s) — proceeding with ${HEALTHY_COUNT:-0} healthy shards${NC}"
    fi
fi

# Set up port-forwards for JMeter (skip in hostNetwork mode — pods bind directly)
if [ "${USE_HOST_NETWORK:-}" = "true" ]; then
    log "Skipping port-forwards (hostNetwork mode — pods bind directly to host ports)"
else
    log "Setting up port-forwards for JMeter..."
    # Raise file-descriptor and inotify limits
    ulimit -n 65536 2>/dev/null || true
    if [ -f /proc/sys/fs/inotify/max_user_instances ]; then
        sudo sysctl -w fs.inotify.max_user_instances=8192 2>/dev/null || true
        sudo sysctl -w fs.inotify.max_user_watches=524288 2>/dev/null || true
    fi
    # Start in batches to avoid overwhelming the API server
    PF_BATCH=50
    for ((i=0; i<NUMBER_OF_NODES; i++)); do
        nohup kubectl port-forward pod/p2p-server-$i $((3001+i)):$((3001+i)) >> server.log 2>&1 &
        if (( (i+1) % PF_BATCH == 0 )); then sleep 2; fi
    done
    # Scale settle time with node count
    PF_SETTLE=$((NUMBER_OF_NODES / 10))
    [ $PF_SETTLE -lt 10 ] && PF_SETTLE=10
    [ $PF_SETTLE -gt 60 ] && PF_SETTLE=60
    log "Waiting ${PF_SETTLE}s for port-forwards to stabilize..."
    sleep $PF_SETTLE
fi

# Step 3: Run JMeter test
# Start diagnostic pod log streaming BEFORE JMeter — captures block commits,
# clears, redistributions, and duplicate rejections for post-test analysis.
# start.sh may have already started this, but if it crashed early (e.g. kubectl
# apply --server-side conflict), there are no background kubectl-log processes.
# Kill any stale ones first, then start fresh.
pkill -f "kubectl logs" 2>/dev/null || true
sleep 1
if [ -f nodesEnv.yml ]; then
    DIAG_PODS=$(python3 - <<'PYEOF'
import re, collections
text = open("nodesEnv.yml").read()
entries = []
for block in re.split(r'\n(?=- )', text.strip()):
    entry = {}
    for line in block.splitlines():
        m = re.match(r"[ -]*(\w+):\s*'?([^']+?)'?\s*$", line.strip())
        if m:
            entry[m.group(1)] = m.group(2).strip("'\"")
    if "P2P_PORT" in entry:
        entries.append(entry)
by_shard = collections.defaultdict(list)
for e in entries:
    by_shard[e.get("SUBSET_INDEX","")].append(e)
healthy_pod_indices = []
dead_pod_indices    = []
for subset, nodes in by_shard.items():
    faulty_count = sum(1 for n in nodes if n.get("IS_FAULTY","false").lower() == "true")
    pod_indices  = [int(n["P2P_PORT"]) - 5001 for n in nodes]
    if faulty_count == 0 and not healthy_pod_indices:
        healthy_pod_indices = pod_indices
    elif faulty_count >= 2 and not dead_pod_indices:
        dead_pod_indices = pod_indices
    if healthy_pod_indices and dead_pod_indices:
        break
all_indices = healthy_pod_indices + dead_pod_indices
print(" ".join(f"p2p-server-{i}" for i in all_indices))
PYEOF
)
    if [ -n "$DIAG_PODS" ]; then
        log "Diagnostic log streaming: core-server $DIAG_PODS"
        kubectl logs core-server -f --prefix >> server.log 2>&1 &
        for _POD in $DIAG_PODS; do
            kubectl logs "$_POD" -f --prefix >> server.log 2>&1 &
        done
    fi
fi

log "${BLUE}Step 3: Running JMeter performance test...${NC}"
log "  Duration: ${JMETER_DURATION}s (active load: $((JMETER_DURATION - JMETER_RAMP_DOWN))s + ramp-down: ${JMETER_RAMP_DOWN}s)"
log "  Threads: ${JMETER_THREADS}"
log "  Ramp-up: ${JMETER_RAMP_UP}s"
log "  Ramp-down: ${JMETER_RAMP_DOWN}s"
echo

# Start port-forward watchdog (only when not using hostNetwork)
if [ "${USE_HOST_NETWORK:-}" != "true" ]; then
(
    while true; do
        sleep 3
        for ((i=0; i<NUMBER_OF_NODES; i++)); do
            PORT=$((3001+i))
            if ! pgrep -f "port-forward pod/p2p-server-$i $PORT" > /dev/null 2>&1; then
                nohup kubectl port-forward pod/p2p-server-$i $PORT:$PORT >> server.log 2>&1 &
            fi
        done
    done
) &
WATCHDOG_PID=$!
fi

# Active load duration = total duration minus ramp-down quiet phase
JMETER_ACTIVE_DURATION=$(( JMETER_DURATION - JMETER_RAMP_DOWN ))
if [ "${JMETER_ACTIVE_DURATION}" -le 0 ]; then
    log "${RED}✗ JMETER_RAMP_DOWN (${JMETER_RAMP_DOWN}s) must be less than JMETER_DURATION (${JMETER_DURATION}s)${NC}"
    exit 1
fi

TEST_START_TIME=$(date +%s)
jmeter -n -t "Test Plan.jmx" \
    -Jthreads=${JMETER_THREADS} \
    -Jrampup=${JMETER_RAMP_UP} \
    -Jduration=${JMETER_ACTIVE_DURATION} \
    -Jthroughput=${JMETER_THROUGHPUT} \
    -l "${RESULTS_FILE}" \
    -e -o "${RESULTS_DIR}/pbft-rapidchain-${TIMESTAMP}-report" 2>&1 | tee -a server.log

# Kill watchdog
if [ -n "${WATCHDOG_PID:-}" ]; then
    kill $WATCHDOG_PID 2>/dev/null || true
fi

log "${GREEN}✓ JMeter test completed${NC}"

# Ramp-down quiet phase: no new transactions; blockchain completes in-flight blocks
if [ "${JMETER_RAMP_DOWN}" -gt 0 ]; then
    log "${YELLOW}Ramp-down: ${JMETER_RAMP_DOWN}s quiet phase (no new TXs)...${NC}"
    sleep "${JMETER_RAMP_DOWN}"
    log "${GREEN}✓ Ramp-down complete${NC}"
fi
echo

# Re-establish port-forwarding before stats collection (only when not using hostNetwork)
if [ "${USE_HOST_NETWORK:-}" != "true" ]; then
    pkill -f "kubectl port-forward" 2>/dev/null || true
    sleep 1
    for ((i=0; i<NUMBER_OF_NODES; i++)); do
        nohup kubectl port-forward pod/p2p-server-$i $((3001+i)):$((3001+i)) >> server.log 2>&1 &
    done
fi

# Wait for transaction pool to drain (wait until unassigned hits 0)
log "${BLUE}Waiting for transaction pool to drain...${NC}"
DRAIN_TIMEOUT=60
DRAIN_ELAPSED=0
PREV_UNASSIGNED=-1
UNCHANGED_COUNT=0
DRAIN_END_TIME=
while [ $DRAIN_ELAPSED -lt $DRAIN_TIMEOUT ]; do
    sleep 5
    DRAIN_ELAPSED=$((DRAIN_ELAPSED + 5))
    # Step by NODES_PER_SHARD to sample exactly one representative node per shard,
    # then SUM the per-shard unassigned counts.
    # MIN was wrong: a drained shard returns 0 and would falsely signal completion
    # while other shards still had stuck transactions.
    STEP=${NUMBER_OF_NODES_PER_SHARD}
    [ $STEP -lt 1 ] && STEP=1
    SUM_UNASSIGNED=0
    VALID_SAMPLES=0
    OFFSET=0
    while [ $(( OFFSET * STEP )) -lt $NUMBER_OF_NODES ]; do
        IDX=$(( OFFSET * STEP ))
        PORT=$((3001+IDX))
        DRAIN_STATS=$(curl -s --max-time 1 http://localhost:$PORT/stats 2>/dev/null || echo '')
        if [ -n "$DRAIN_STATS" ]; then
            NODE_UNASSIGNED=$(echo "$DRAIN_STATS" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('isFaulty', False):
        print(-1)
    else:
        total = sum(v.get('unassignedTransactions', 0) for v in d.get('total', {}).values())
        print(total)
except: print(-1)
" 2>/dev/null || echo -1)
            if [ "$NODE_UNASSIGNED" != "-1" ]; then
                SUM_UNASSIGNED=$(( SUM_UNASSIGNED + NODE_UNASSIGNED ))
                VALID_SAMPLES=$(( VALID_SAMPLES + 1 ))
            fi
        fi
        OFFSET=$(( OFFSET + 1 ))
    done
    # No valid samples means all polled nodes were unreachable/faulty — treat as unknown
    [ $VALID_SAMPLES -eq 0 ] && SUM_UNASSIGNED=-1
    CUR_UNASSIGNED=${SUM_UNASSIGNED}
    echo -ne "  Drain wait ${DRAIN_ELAPSED}s — unassigned: ${CUR_UNASSIGNED}\r"
    if [ "$CUR_UNASSIGNED" = "0" ]; then
        echo ""
        DRAIN_END_TIME=$(date +%s)
        log "${GREEN}✓ All transactions processed (unassigned=0)${NC}"
        break
    else
        # Treat as stalled if within ±STALL_TOLERANCE (small polling noise from
        # sampling different shard representatives each tick).
        STALL_TOLERANCE=50
        DELTA=$(( CUR_UNASSIGNED - PREV_UNASSIGNED ))
        [ $DELTA -lt 0 ] && DELTA=$(( -DELTA ))
        if [ $DELTA -le $STALL_TOLERANCE ]; then
            UNCHANGED_COUNT=$(( UNCHANGED_COUNT + 1 ))
            if [ $UNCHANGED_COUNT -ge 3 ]; then
                echo ""
                DRAIN_END_TIME=$(date +%s)
                log "${YELLOW}Pool stalled at ${CUR_UNASSIGNED} unassigned (±${STALL_TOLERANCE} for 15s) — stopping drain wait${NC}"
                break
            fi
        else
            UNCHANGED_COUNT=0
        fi
    fi
    PREV_UNASSIGNED=$CUR_UNASSIGNED
done
DRAIN_END_TIME=${DRAIN_END_TIME:-$(date +%s)}
TOTAL_ELAPSED=$(( DRAIN_END_TIME - TEST_START_TIME ))

# Step 4: Collect blockchain statistics
log "${BLUE}Step 4: Collecting blockchain statistics...${NC}"
{
    echo "PBFT-RapidChain Performance Test Results"
    echo "=========================================="
    echo "Timestamp: ${TIMESTAMP}"
    echo "Configuration:"
    echo "  - Number of Nodes: ${NUMBER_OF_NODES}"
    echo "  - Transaction Threshold: ${TRANSACTION_THRESHOLD}"
    echo "  - Block Threshold: ${BLOCK_THRESHOLD}"
    echo "  - Committee Shard: ${HAS_COMMITTEE_SHARD}"
    echo "  - Faulty Nodes: ${NUMBER_OF_FAULTY_NODES}"
    echo "  - CPU Limit: ${CPU_LIMIT}"
    echo ""
    echo "JMeter Configuration:"
    echo "  - Threads: ${JMETER_THREADS}"
    echo "  - Ramp-up: ${JMETER_RAMP_UP}s"
  echo "  - Ramp-down: ${JMETER_RAMP_DOWN}s"
  echo "  - Duration: ${JMETER_DURATION}s (active: $((JMETER_DURATION - JMETER_RAMP_DOWN))s)"
    echo "  - Target Throughput: ${JMETER_THROUGHPUT} req/s"
    echo ""
    
    # Count total transactions fired by JMeter
    if [ -f "${RESULTS_FILE}" ]; then
        JMETER_TX_FIRED=$(grep -c '<httpSample' "${RESULTS_FILE}" 2>/dev/null || true)
        echo "Total Transactions Fired by Test: $JMETER_TX_FIRED"
    else
        JMETER_TX_FIRED=0
        echo "Total Transactions Fired by Test: (pending)"
    fi
    
    echo ""
    echo "Blockchain Statistics (By Shard):"
    echo "=========================================="
    
    TOTAL_BLOCKS=0
    TOTAL_TX_IN_BLOCKS=0
    TOTAL_UNASSIGNED_TX=0
    NODES_RESPONDED=0

    # Fetch all node stats in parallel (128 sequential curls → 14s; parallel → ~1-2s).
    # Each curl writes to a temp file; a single python3 script aggregates all results.
    STATS_TMP=$(mktemp -d)
    trap "rm -rf $STATS_TMP" RETURN 2>/dev/null || true
    for ((i=0; i<NUMBER_OF_NODES; i++)); do
        PORT=$((3001+i))
        curl -s --max-time 2 "http://localhost:$PORT/stats" > "$STATS_TMP/$i.json" 2>/dev/null &
    done
    wait

    # Single python3 invocation processes all node responses
    AGGREGATED=$(python3 - "$STATS_TMP" "$NUMBER_OF_NODES" << 'PYAGG'
import sys, json, os
stats_dir = sys.argv[1]
num_nodes = int(sys.argv[2])

shard_max = {}   # shard_idx -> {blocks, tx, unassigned}
nodes_responded = 0
per_shard_text = []

for i in range(num_nodes):
    fpath = os.path.join(stats_dir, f"{i}.json")
    if not os.path.exists(fpath) or os.path.getsize(fpath) == 0:
        continue
    try:
        with open(fpath) as f:
            d = json.load(f)
    except (json.JSONDecodeError, IOError):
        continue
    if d.get("isFaulty", False):
        continue
    nodes_responded += 1
    for shard_idx, vals in d.get("total", {}).items():
        blocks = vals.get("blocks", 0)
        tx = vals.get("transactions", 0)
        ua = vals.get("unassignedTransactions", 0)
        prev = shard_max.get(shard_idx)
        if prev is None:
            shard_max[shard_idx] = {"blocks": blocks, "tx": tx, "ua": ua}
        else:
            if blocks > prev["blocks"]:
                prev["blocks"] = blocks; prev["ua"] = ua
            if tx > prev["tx"]:
                prev["tx"] = tx

total_blocks = 0; total_tx = 0; total_ua = 0
for idx in sorted(shard_max.keys()):
    s = shard_max[idx]
    per_shard_text.append(f"Shard {idx} (max across shard nodes):")
    per_shard_text.append("----------------------------------------")
    per_shard_text.append(f"  Blocks Created: {s['blocks']}")
    per_shard_text.append(f"  Transactions in Blocks: {s['tx']}")
    per_shard_text.append(f"  Unassigned Transactions: {s['ua']}")
    per_shard_text.append("")
    total_blocks += s["blocks"]; total_tx += s["tx"]; total_ua += s["ua"]

print(f"NODES_RESPONDED={nodes_responded}")
print(f"TOTAL_BLOCKS={total_blocks}")
print(f"TOTAL_TX_IN_BLOCKS={total_tx}")
print(f"TOTAL_UNASSIGNED_TX={total_ua}")
print("---SHARDS---")
print("\n".join(per_shard_text) if per_shard_text else "  (No node responded to /stats query)")
PYAGG
    )
    rm -rf "$STATS_TMP"

    # Parse the aggregated output
    eval "$(echo "$AGGREGATED" | sed -n '/^[A-Z_]*=/p')"
    SHARD_TEXT=$(echo "$AGGREGATED" | sed '1,/^---SHARDS---$/d')

    echo "$SHARD_TEXT"
    
    echo ""
    echo "=========================================="
    echo "TOTAL (All Shards):"
    echo "=========================================="
    echo "Total Blocks Created: $TOTAL_BLOCKS"
    echo "Total Transactions in Blocks: $TOTAL_TX_IN_BLOCKS"
    echo "Total Unassigned Transactions: $TOTAL_UNASSIGNED_TX"
    echo "Nodes Responded: $NODES_RESPONDED"
    echo "Nodes Total: $NUMBER_OF_NODES"
    if [ "$NODES_RESPONDED" -lt "$NUMBER_OF_NODES" ]; then
        MISSED=$(( NUMBER_OF_NODES - NODES_RESPONDED ))
        echo "WARNING: $MISSED node(s) did not respond — stats may be incomplete"
    fi
    echo ""
    echo "UNASSIGNED TRANSACTION REASONS:"
    echo "  - Transaction pool not full (threshold: ${TRANSACTION_THRESHOLD}) — includes inflight (assigned-to-block) transactions"
    echo "  - Block pool not full (block threshold: ${BLOCK_THRESHOLD})"
    echo "  - Waiting for committee validation"
    echo "  - Consensus not reached for pending blocks"
    echo "  - Block creation in progress"
    echo "  - Test duration ended before block finalization"
} | tee "${SUMMARY_FILE}" | tee -a server.log > /dev/null

log "${GREEN}✓ Statistics collected${NC}"
echo

# Step 5: Parse JMeter results
log "${BLUE}Step 5: Parsing JMeter results...${NC}"
if [ -f "${RESULTS_FILE}" ]; then
    {
        echo "Metric,Value"
        TOTAL=$(awk -F',' 'NR>1 {count++} END {print count+0}' "${RESULTS_FILE}")
        echo "Total Samples,$TOTAL"
        
        # Calculate average response time
        AVG_TIME=$(awk -F',' 'NR>1 {sum+=$2; count++} END {if(count>0) print int(sum/count); else print 0}' "${RESULTS_FILE}")
        echo "Average Response Time (ms),$AVG_TIME"
        
        # Calculate success rate
        SUCCESS=$(awk -F',' 'NR>1 && $8=="true" {count++} END {print count+0}' "${RESULTS_FILE}")
        if [ "$TOTAL" -gt 0 ]; then
            SUCCESS_RATE=$(echo "scale=2; $SUCCESS * 100 / $TOTAL" | bc)
        else
            SUCCESS_RATE=0
        fi
        echo "Success Rate (%),$SUCCESS_RATE"
        
        # Calculate throughput over the full test window (including ramp-down) so
        # comparisons across runs with different ramp-down settings stay fair.
        if [ "$JMETER_DURATION" -gt 0 ]; then
            THROUGHPUT=$(echo "scale=2; $TOTAL / $JMETER_DURATION" | bc)
        else
            THROUGHPUT=0
        fi
        echo "Throughput (req/s),$THROUGHPUT"
        
        # Add blockchain metrics from summary
        if [ -f "${SUMMARY_FILE}" ]; then
            # Count /transaction requests: use label col (col 3) since TCP-refused
            # requests never reach the server so the URL col (col 14) is empty for them.
            # This gives the true total fired count including failed connections.
            JMETER_FIRED=$(awk -F',' 'NR>1 && $3 ~ /HTTP Request/ {count++} END {print count+0}' "${RESULTS_FILE}")
            BLOCKS=$(grep "Total Blocks Created:" "${SUMMARY_FILE}" | tail -1 | awk '{print $NF}')
            TX_IN_BLOCKS=$(grep "Total Transactions in Blocks:" "${SUMMARY_FILE}" | tail -1 | awk '{print $NF}')
            UNASSIGNED=$(grep "Total Unassigned Transactions:" "${SUMMARY_FILE}" | tail -1 | awk '{print $NF}')
            
            echo "Transactions Fired by Test,${JMETER_FIRED:-0}"
            echo "Total Blocks Created,${BLOCKS:-0}"
            echo "Transactions in Blocks,${TX_IN_BLOCKS:-0}"
            echo "Unassigned Transactions,${UNASSIGNED:-0}"

            # Drain Rate: fraction of fired transactions that made it into blocks
            if [ "${JMETER_FIRED:-0}" -gt 0 ]; then
                DRAIN_RATE=$(echo "scale=2; ${TX_IN_BLOCKS:-0} * 100 / ${JMETER_FIRED}" | bc)
                echo "Drain Rate (%),${DRAIN_RATE}"
            fi
            
            # Calculate block efficiency
            if [ "$BLOCKS" -gt 0 ] && [ "$TX_IN_BLOCKS" -gt 0 ]; then
                AVG_TX_PER_BLOCK=$(echo "scale=2; $TX_IN_BLOCKS / $BLOCKS" | bc)
                echo "Avg Transactions per Block,$AVG_TX_PER_BLOCK"
            fi
            
            # Blockchain transaction rate over total test+drain time
            if [ "${TOTAL_ELAPSED:-0}" -gt 0 ] && [ "${TX_IN_BLOCKS:-0}" -gt 0 ]; then
                BLOCKCHAIN_TX_RATE=$(echo "scale=2; ${TX_IN_BLOCKS} / ${TOTAL_ELAPSED}" | bc)
                echo "Total Test Elapsed (s),${TOTAL_ELAPSED}"
                echo "Blockchain TX Rate (tx/s),${BLOCKCHAIN_TX_RATE}"
                # Effective TX Rate = Blockchain TX Rate × Drain Fraction
                # = TX_IN_BLOCKS² / (JMETER_FIRED × TOTAL_ELAPSED)
                # Penalizes implementations that score high TX rate by leaving transactions unconfirmed
                if [ "${JMETER_FIRED:-0}" -gt 0 ]; then
                    EFFECTIVE_TX_RATE=$(echo "scale=2; ${TX_IN_BLOCKS} * ${TX_IN_BLOCKS} / (${JMETER_FIRED} * ${TOTAL_ELAPSED})" | bc)
                    echo "Effective TX Rate (tx/s),${EFFECTIVE_TX_RATE}"
                fi
            fi
        fi
        # Config metadata — read back by compare-performance.sh for the report
        echo "Number of Nodes Used,${NUMBER_OF_NODES}"
        echo "Nodes Per Shard,${NUMBER_OF_NODES_PER_SHARD}"
        echo "Faulty Nodes,${NUMBER_OF_FAULTY_NODES}"
        # Read back Nodes Responded from the summary file
        NODES_RESPONDED_STAT=$(grep "^Nodes Responded:" "${SUMMARY_FILE}" | awk '{print $NF}')
        echo "Nodes Responded,${NODES_RESPONDED_STAT:-0}"
    } > "${STATS_FILE}"
    
    log "${GREEN}✓ Results parsed${NC}"
    echo
fi

# Display summary
log "${BLUE}========================================${NC}"
log "${BLUE}Performance Test Complete!${NC}"
log "${BLUE}========================================${NC}"
log "Results saved to:"
log "  - Summary: ${SUMMARY_FILE}"
log "  - Stats: ${STATS_FILE}"
log "  - Raw data: ${RESULTS_FILE}"
log "  - HTML Report: ${RESULTS_DIR}/pbft-rapidchain-${TIMESTAMP}-report/index.html"
echo

if [ -f "${STATS_FILE}" ]; then
    log "${GREEN}Quick Stats:${NC}"
    cat "${STATS_FILE}" | tee -a server.log
fi

log "${BLUE}========================================${NC}"
