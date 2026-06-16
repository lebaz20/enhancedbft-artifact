#!/bin/bash

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Starting PBFT-Enhanced Blockchain${NC}"
echo -e "${BLUE}========================================${NC}\n"

# Step 1: Build the Docker images
echo -e "${BLUE}Step 1: Building Docker images...${NC}"
docker build -f Dockerfile.p2p -t lebaz20/blockchain-p2p-server:latest .
docker build -f Dockerfile.core -t lebaz20/blockchain-core-server:latest .
echo -e "${GREEN}✓ Docker images built${NC}\n"

# Push the Docker image to the local registry (optional)
# docker push lebaz20/blockchain-p2p-server:latest
# docker push lebaz20/blockchain-core-server:latest

# Step 2: Generate configuration
echo -e "${BLUE}Step 2: Generating configuration...${NC}"
# Use environment variables if set, otherwise use defaults
NUMBER_OF_NODES=${NUMBER_OF_NODES:-4}
NUMBER_OF_FAULTY_NODES=${NUMBER_OF_FAULTY_NODES:-0}
NUMBER_OF_NODES_PER_SHARD=${NUMBER_OF_NODES_PER_SHARD:-4}
SHOULD_REDIRECT_FROM_FAULTY_NODES=${SHOULD_REDIRECT_FROM_FAULTY_NODES:-1}
ENABLE_SHARD_MERGE=${ENABLE_SHARD_MERGE:-0}
TRANSACTION_THRESHOLD=${TRANSACTION_THRESHOLD:-5}
CPU_LIMIT=${CPU_LIMIT:-0.1}
DEFAULT_TTL=${DEFAULT_TTL:-6}

echo -e "  Nodes: ${NUMBER_OF_NODES}"
echo -e "  Transaction Threshold: ${TRANSACTION_THRESHOLD}"
echo -e "  Faulty Nodes: ${NUMBER_OF_FAULTY_NODES}"
echo -e "  CPU Limit: ${CPU_LIMIT}"
echo -e "  Default TTL: ${DEFAULT_TTL}"

NUMBER_OF_NODES=$NUMBER_OF_NODES \
  TRANSACTION_THRESHOLD=$TRANSACTION_THRESHOLD \
  NUMBER_OF_FAULTY_NODES=$NUMBER_OF_FAULTY_NODES \
  NUMBER_OF_NODES_PER_SHARD=$NUMBER_OF_NODES_PER_SHARD \
  SHOULD_REDIRECT_FROM_FAULTY_NODES=$SHOULD_REDIRECT_FROM_FAULTY_NODES \
  ENABLE_SHARD_MERGE=$ENABLE_SHARD_MERGE \
  CPU_LIMIT=$CPU_LIMIT \
  DEFAULT_TTL=$DEFAULT_TTL \
  node prepare-config.js

echo -e "${GREEN}✓ Configuration generated${NC}\n"

# Step 3: Deploy to Kubernetes
echo -e "${BLUE}Step 3: Deploying to Kubernetes...${NC}"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deleting existing Kubernetes resources..." | tee -a server.log
kubectl delete -f kubeConfig.yml --ignore-not-found --grace-period=0 --force 2>&1 | tee -a server.log || true
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Applying Kubernetes configuration..." | tee -a server.log
APPLIED=$(kubectl apply --server-side --force-conflicts -f kubeConfig.yml 2>&1) || true
APPLIED_COUNT=$(echo "$APPLIED" | wc -l | tr -d ' ')
echo "$APPLIED" >> server.log
echo -e "  Applied ${APPLIED_COUNT} resources"
echo -e "${GREEN}✓ Deployed to Kubernetes${NC}\n"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Kubernetes deployment complete" | tee -a server.log

# Step 4: Wait for the pods to be ready
echo -e "${BLUE}Step 4: Waiting for pods to be ready...${NC}"
TOTAL_EXPECTED=$((NUMBER_OF_NODES + 1))  # p2p pods + core-server
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Waiting for all $TOTAL_EXPECTED pods to be Running..." | tee -a server.log
# Scale timeout with node count
TIMEOUT=$((NUMBER_OF_NODES * 3))
[ $TIMEOUT -lt 600 ] && TIMEOUT=600
ELAPSED=0
while true; do
    running_pods=$(kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | grep 'Running' | wc -l | tr -d ' ')
    total_pods=$(kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | wc -l | tr -d ' ')
    not_running=$(kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | grep -v 'Running' | wc -l | tr -d ' ')
    if [ "$total_pods" -gt 0 ] && [ "$not_running" -eq 0 ]; then
        break
    fi
    if [ $ELAPSED -ge $TIMEOUT ]; then
        echo -e "${RED}Timeout: $running_pods/$total_pods running (need all $TOTAL_EXPECTED)${NC}"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Timeout - pod state summary:" | tee -a server.log
        kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | awk '{print $3}' | sort | uniq -c | tee -a server.log
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Non-running pods:" | tee -a server.log
        kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | grep -v 'Running' | head -20 | tee -a server.log
        exit 1
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
    pct=0; [ "$TOTAL_EXPECTED" -gt 0 ] && pct=$((running_pods * 100 / TOTAL_EXPECTED))
    pending=$(kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | grep -c 'Pending' || true)
    creating=$(kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | grep -c 'ContainerCreating' || true)
    crashloop=$(kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | grep -c 'CrashLoopBackOff' || true)
    errstate=$(kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | grep -cE 'Error|Failed' || true)
    if (( ELAPSED % 30 == 0 )); then
        echo ""
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pods: $running_pods/$TOTAL_EXPECTED Running ($pct%) | Pending=$pending ContainerCreating=$creating CrashLoopBackOff=$crashloop Error/Failed=$errstate | ${ELAPSED}s elapsed" | tee -a server.log
        kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | awk '{print $3}' | sort | uniq -c | tee -a server.log
    elif (( ELAPSED % 10 == 0 )); then
        echo ""
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pods: $running_pods/$TOTAL_EXPECTED Running ($pct%) | Pending=$pending Creating=$creating CrashLoop=$crashloop Err=$errstate | ${ELAPSED}s" | tee -a server.log
    else
        echo -ne "  Waiting... ${ELAPSED}s — Running: $running_pods/$TOTAL_EXPECTED ($pct%) | Pending=$pending Creating=$creating\r"
    fi
done
kubectl get pods -l domain=blockchain 2>&1 | tee -a server.log
echo -e "${GREEN}All $running_pods/$total_pods pods running${NC}\n"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] All $running_pods pods ready" | tee -a server.log

# Step 5: Set up port forwarding (skip when using host networking)
if [ "${USE_HOST_NETWORK:-}" = "true" ]; then
  echo -e "${GREEN}Step 5: Skipping port forwarding (hostNetwork mode)${NC}\n"
else
  echo -e "${BLUE}Step 5: Setting up port forwarding...${NC}"
  # Kill any existing port forwarding processes to avoid conflicts
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Cleaning up any existing port forwarding..." | tee -a server.log
  pkill -f "kubectl port-forward" 2>/dev/null || true
  sleep 2
  # Raise file-descriptor and inotify limits — each port-forward needs an fd + inotify instance
  ulimit -n 65536 2>/dev/null || true
  if [ -f /proc/sys/fs/inotify/max_user_instances ]; then
      sudo sysctl -w fs.inotify.max_user_instances=8192 2>/dev/null || true
      sudo sysctl -w fs.inotify.max_user_watches=524288 2>/dev/null || true
  fi
  for ((i=0; i<NUMBER_OF_NODES; i++)); do
    kubectl port-forward pod/p2p-server-$i $((3001+i)):$((3001+i)) > /dev/null 2>&1 &
  done
  echo -e "${GREEN}✓ Port forwarding established (ports $((3001))-$((3000+NUMBER_OF_NODES)))${NC}\n"
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}Blockchain is running!${NC}"
echo -e "${BLUE}========================================${NC}"

if [ "${AUTOMATED_TEST:-}" = "true" ]; then
  # In automated mode, stream logs to file in background and return.
  # Streaming ALL pods (256+) at once produces 26 000+ lines in server.log,
  # making it nearly impossible to trace individual shard behaviour.
  # Instead, pick a small representative sample from nodesEnv.yml:
  #   • core-server (always)
  #   • 4 nodes of one fully-healthy shard  (no faulty nodes in the shard)
  #   • 4 nodes of one clearly-dead shard   (≥2 faulty nodes in the shard)
  # This gives ~9 pods total (~3.5 % of 256) while covering every meaningful
  # code path: proposer/non-proposer, EMA scaling, redirect drain, view change.
  # Metrics collection is unaffected — it uses HTTP /stats calls, not server.log.
  DIAG_PODS=""
  if [ -f nodesEnv.yml ]; then
    DIAG_PODS=$(python3 - <<'PYEOF'
import re, sys, collections

# Parse nodesEnv.yml (list of dicts separated by leading "- ")
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

# Group by SUBSET_INDEX
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
  fi

  # Always include core-server; fall back to full-cluster stream if parsing failed.
  if [ -n "$DIAG_PODS" ]; then
    echo -e "Diagnostic log streaming to server.log (core + healthy shard + dead shard)\n"
    echo -e "  Pods: core-server $DIAG_PODS\n"
    kubectl logs core-server -f --prefix >> server.log 2>&1 &
    for _POD in $DIAG_PODS; do
      kubectl logs "$_POD" -f --prefix >> server.log 2>&1 &
    done
  else
    echo -e "Logs streaming to server.log in background (all pods — nodesEnv.yml not parseable)\n"
    kubectl logs -l domain=blockchain -f --prefix --max-log-requests=10000 >> server.log 2>&1 &
  fi
else
  echo -e "Streaming logs... (Press Ctrl+C to stop)\n"
  echo -e "Logs are also being written to: server.log\n"
  kubectl logs -l domain=blockchain -f --prefix --max-log-requests=10000 2>&1 | tee -a server.log
fi