const fs = require('fs')
const yaml = require('js-yaml')
// Create a write stream to your desired log file
const logStream = fs.createWriteStream('server.log', { flags: 'a' }) // 'a' = append

// Redirect console.log and console.error
console.log = function (...arguments_) {
  logStream.write(`[LOG ${new Date().toISOString()}] ${arguments_.join(' ')}\n`)
  process.stdout.write(`[LOG] ${arguments_.join(' ')}\n`) // Optional: also log to terminal
}

console.error = function (...arguments_) {
  logStream.write(`[ERROR ${new Date().toISOString()}] ${arguments_.join(' ')}\n`)
  process.stderr.write(`[ERROR] ${arguments_.join(' ')}\n`)
}

// ulimit -n 1228800
// sudo sysctl -w kern.maxfiles=1228800
// sudo sysctl -w kern.maxfilesperproc=614400
// for port in {3001..3032}; do lsof -ti tcp:$port; done | xargs -r kill -9
const NUMBER_OF_NODES = Number(process.env.NUMBER_OF_NODES)
const TRANSACTION_THRESHOLD = Number(process.env.TRANSACTION_THRESHOLD)
const BLOCK_THRESHOLD = Number(process.env.BLOCK_THRESHOLD)
const NUMBER_OF_FAULTY_NODES = Number(process.env.NUMBER_OF_FAULTY_NODES)
const NUMBER_OF_NODES_PER_SHARD = Number(process.env.NUMBER_OF_NODES_PER_SHARD)
const DEFAULT_TTL = Number(process.env.DEFAULT_TTL) || 6
const CPU_LIMIT = Number(process.env.CPU_LIMIT)
const HAS_COMMITTEE_SHARD = Number(process.env.HAS_COMMITTEE_SHARD) === 1 ? 'true' : 'false'
const SHOULD_REDIRECT_FROM_FAULTY_NODES =
  Number(process.env.SHOULD_REDIRECT_FROM_FAULTY_NODES) === 1 ? 'true' : 'false'

const coreServerPort = 4999

const shuffleArray = (array) => {
  const copy = array.slice() // don't modify original
  for (let index = copy.length - 1; index > 0; index--) {
    const index_ = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[index_]] = [copy[index_], copy[index]] // swap
  }
  return copy
}

const splitIntoShardsWithRemaining = (array) => {
  const result = []
  let index = 0

  while (array.length - index >= NUMBER_OF_NODES_PER_SHARD) {
    result.push(array.slice(index, index + NUMBER_OF_NODES_PER_SHARD))
    index += NUMBER_OF_NODES_PER_SHARD
  }

  // Last group with remaining nodes
  result[result.length - 1] = [...result[result.length - 1], ...array.slice(index)]

  return result
}

const getRandomIndicesArrays = (array) => {
  const indices = Array.from({ length: array.length }, (_, index) => index)
  const shuffledArray = shuffleArray(indices)
  const shards = splitIntoShardsWithRemaining(shuffledArray)
  // Adversarial placement: concentrate f+1 faulty nodes into consecutive shards to
  // break the maximum number of shards. For 4-node shards f=floor((4-1)/3)=1, so
  // placing 2 faulty in a shard breaks its consensus — worst case for the protocol.
  const faultyPerShardToBreak = Math.floor(NUMBER_OF_NODES_PER_SHARD / 3) + 1
  const faultyNodes = []
  for (const shard of shards) {
    const toTake = Math.min(faultyPerShardToBreak, NUMBER_OF_FAULTY_NODES - faultyNodes.length)
    if (toTake <= 0) break
    faultyNodes.push(...shard.slice(0, toTake))
  }
  // Identify healthy shards — those with fewer faulty nodes than the break threshold.
  // Honest nodes inside a broken shard cannot make consensus progress, so they are
  // poor committee members: they spend time on shard PBFT that never completes.
  // Restricting the pool to healthy-shard honest nodes maximises committee throughput.
  const healthyShardNodes = new Set(
    shards
      .filter(
        (shard) => shard.filter((n) => faultyNodes.includes(n)).length < faultyPerShardToBreak
      )
      .flat()
      .filter((n) => !faultyNodes.includes(n))
  )
  const committeeShard = HAS_COMMITTEE_SHARD
    ? shuffleArray([...healthyShardNodes]).slice(0, NUMBER_OF_NODES_PER_SHARD)
    : []
  return { shards, faultyNodes, committeeShard }
}

const {
  shards: nodesSubsets,
  faultyNodes,
  committeeShard: committeeSubset
} = getRandomIndicesArrays(Array.from({ length: NUMBER_OF_NODES }, (_, index) => index))
console.log(nodesSubsets, faultyNodes)
const environmentArray = []
// Save environmentVariables to a yml file
const environmentFile = 'nodesEnv.yml'
const kubeFile = 'kubeConfig.yml'
const committeeSubnetIndex = 'SUBSET_COMMITTEE'
nodesSubsets.forEach((nodesSubset, subsetIndex) => {
  console.log(
    'Subset PBFT nodes:',
    nodesSubset.map((index) => parseInt(index, 10) + 5001)
  )
  for (let index = 0; index < NUMBER_OF_NODES; index++) {
    const environmentVariables = {
      // ...process.env, // Keep existing environment variables
      SECRET: `NODE${index}`,
      IS_FAULTY: faultyNodes.includes(index),
      SHOULD_REDIRECT_FROM_FAULTY_NODES,
      P2P_PORT: 5001 + index,
      HTTP_PORT: 3001 + index,
      TRANSACTION_THRESHOLD,
      BLOCK_THRESHOLD,
      NUMBER_OF_NODES_PER_SHARD: NUMBER_OF_NODES_PER_SHARD,
      NUMBER_OF_NODES: NUMBER_OF_NODES,
      NODES_SUBSET: JSON.stringify(nodesSubset),
      SUBSET_INDEX: `SUBSET${subsetIndex + 1}`,
      COMMITTEE_SUBSET_INDEX: committeeSubnetIndex,
      CORE: `ws://core-server:${coreServerPort}`,
      CPU_LIMIT,
      DEFAULT_TTL,
      // Propagate NODE_OPTIONS from the invoking shell into the pod so we can
      // tune V8 heap without changing the Dockerfile. Empty string == unset.
      // Used to pass --max-old-space-size at NPS=100 where the default heap
      // limit collides with the pod memory limit and triggers OOMKill.
      NODE_OPTIONS: process.env.NODE_OPTIONS || ''
    }

    if (index > 0) {
      const peers = Array.from(
        { length: index },
        (_, index_) => `ws://p2p-server-${index_}:${index_ + 5001}`
      )
      const peersSubset = []
      const committeePeersSubset = []
      committeeSubset.forEach((index) => {
        // Check if index is within bounds of peers array
        if (index < peers.length && peers[index]) {
          committeePeersSubset.push(peers[index])
        }
      })
      nodesSubset.forEach((index) => {
        // Check if index is within bounds of peers array
        if (index < peers.length && peers[index]) {
          peersSubset.push(peers[index])
        }
      })
      if (committeePeersSubset.length > 0 && committeeSubset.includes(index)) {
        environmentVariables.COMMITTEE_PEERS = committeePeersSubset.join(',')
      }
      // Set COMMITTEE_SUBSET for ALL committee members regardless of whether they have
      // lower-indexed committee peers. Without this, the lowest-indexed committee member
      // gets COMMITTEE_SUBSET=[] and never calls connectToCore(true), making it invisible
      // to the core's committee broadcast.
      if (committeeSubset.includes(index)) {
        environmentVariables.COMMITTEE_SUBSET = JSON.stringify(committeeSubset)
      }
      if (peersSubset.length > 0 && nodesSubset.includes(index)) {
        environmentVariables.PEERS = peersSubset.join(',')
      }
    }

    if (nodesSubset.includes(index)) {
      environmentArray.push(environmentVariables)
    }
  }
})

environmentArray.sort((a, b) => a.HTTP_PORT - b.HTTP_PORT)

fs.writeFileSync(environmentFile, yaml.dump(environmentArray))

// Memory scales with NPS: 256Mi handles a 4-node shard, but at NPS=100 the
// P2P mesh + PBFT vote pools + inflight-block state exceed that limit and
// pods OOMKill under load. journal-comparison.sh sets POD_MEMORY_MIB when
// scaling per NPS; falls back to 256Mi for small standalone runs.
const memory = `${process.env.POD_MEMORY_MIB || 256}Mi`
// Core-server needs much more memory than p2p pods: it's the committee
// coordinator that buffers *all* shard blocks from every shard until the
// committee finalises them. Observed 2026-08-01 at N=128 NPS=25: core-server
// hit Node.js heap limit (~660 MiB) after processing 449 committee messages
// and crashed with "Reached heap limit" — killed the whole committee flow.
// Core-server targets the control-plane node via nodeAffinity (Exists on the
// node-role.kubernetes.io/control-plane label) with tolerations for the common
// NoSchedule taint. Cap 2048 MiB fits on a c6i.large (4 GiB) master alongside
// k3s, OS, and JMeter. NODE_OPTIONS pins V8's heap ceiling to 80% of the cap.
const _corePodMib = Math.min(
  2048,
  Math.max(512, Number(process.env.POD_MEMORY_MIB || 256))
)
const coreMemory = `${_corePodMib}Mi`
const coreNodeOptions = `--max-old-space-size=${Math.floor(_corePodMib * 0.8)}`
const cpu = `${Number(CPU_LIMIT) * 1000}m`
// Build array of individual k8s resources (pods + services).
// Written as multi-document YAML (--- separators) instead of a single kind:List
// so kubectl apply processes each resource individually — avoids API server
// payload size limits that silently drop items at 512+ nodes.
const k8sItems = [
  ...environmentArray.flatMap((environmentVariables, index) => [
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: `p2p-server-${index}`,
        // `pod-index` is the per-pod unique label used by the per-pod headless
        // Service selector below. Without it, `p2p-server-N` Service would
        // select every p2p-server pod (all share app=p2p-server), and DNS for
        // `p2p-server-0` would return ALL 100 pod endpoints. On single-EC2
        // this was harmless (every pod shares one hostIP, port uniquely
        // identifies target). On multi-EC2 hostNetwork, each pod has a
        // different hostIP, so ws://p2p-server-0:5001 lands on a random
        // agent's hostIP:5001 — only pod 0's agent listens on 5001, others
        // refuse → mesh convergence collapses to shardSize:3.
        labels: { app: 'p2p-server', domain: 'blockchain', 'pod-index': String(index) }
      },
      spec: {
        ...(process.env.USE_HOST_NETWORK === 'true'
          ? { hostNetwork: true, dnsPolicy: 'ClusterFirstWithHostNet' }
          : {}),
        // Spread pods 1-per-node on multi-EC2 clusters. When enabled, kube-scheduler
        // refuses to place two p2p-server pods on the same node — required so each
        // pod gets its dedicated t3.small worker instead of piling up on whichever
        // node has spare CPU. Off by default (single-EC2 clusters intentionally
        // pack many pods per host).
        ...(process.env.SPREAD_PODS_ACROSS_NODES === 'true'
          ? {
              affinity: {
                podAntiAffinity: {
                  requiredDuringSchedulingIgnoredDuringExecution: [
                    {
                      labelSelector: {
                        matchExpressions: [
                          { key: 'app', operator: 'In', values: ['p2p-server'] }
                        ]
                      },
                      topologyKey: 'kubernetes.io/hostname'
                    }
                  ]
                }
              }
            }
          : {}),
        containers: [
          {
            name: 'p2p-server',
            image: 'lebaz20/blockchain-rapidchain-p2p-server:latest',
            imagePullPolicy: 'Never',
            resources: {
              limits: {
                memory,
                cpu
              }
            },
            env: Object.entries(environmentVariables).map(([key, value]) => ({
              name: key,
              value: String(value)
            })),
            ports: [
              {
                containerPort: environmentVariables.HTTP_PORT
                  ? Number(environmentVariables.HTTP_PORT)
                  : 3001
              },
              {
                containerPort: environmentVariables.P2P_PORT
                  ? Number(environmentVariables.P2P_PORT)
                  : 5001
              }
            ],
            readinessProbe: {
              httpGet: {
                path: '/health',
                port: environmentVariables.HTTP_PORT ? Number(environmentVariables.HTTP_PORT) : 3001
              },
              initialDelaySeconds: 10,
              periodSeconds: 10,
              timeoutSeconds: 5,
              failureThreshold: 6
            }
          }
        ],
        restartPolicy: 'OnFailure'
      }
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: `p2p-server-${index}`,
        labels: { app: 'p2p-server', domain: 'blockchain' }
      },
      spec: {
        clusterIP: 'None',
        selector: {
          app: 'p2p-server',
          'pod-index': String(index)
        },
        ports: [
          {
            name: environmentVariables.P2P_PORT.toString(),
            protocol: 'TCP',
            port: environmentVariables.P2P_PORT ? Number(environmentVariables.P2P_PORT) : 5001,
            targetPort: environmentVariables.P2P_PORT ? Number(environmentVariables.P2P_PORT) : 5001
          },
          {
            name: environmentVariables.HTTP_PORT.toString(),
            protocol: 'TCP',
            port: environmentVariables.HTTP_PORT ? Number(environmentVariables.HTTP_PORT) : 3001,
            targetPort: environmentVariables.HTTP_PORT
              ? Number(environmentVariables.HTTP_PORT)
              : 3001
          }
        ]
      }
    }
  ]),
  {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `core-server`,
      labels: { app: 'core-server', domain: 'blockchain' }
    },
    spec: {
      tolerations: [
        { key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' },
        { key: 'node-role.kubernetes.io/master', operator: 'Exists', effect: 'NoSchedule' }
      ],
      affinity: {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: [{
              matchExpressions: [{
                key: 'node-role.kubernetes.io/control-plane',
                operator: 'Exists'
              }]
            }]
          }
        }
      },
      ...(process.env.USE_HOST_NETWORK === 'true'
        ? { hostNetwork: true, dnsPolicy: 'ClusterFirstWithHostNet' }
        : {}),
      containers: [
        {
          name: 'core-server',
          image: 'lebaz20/blockchain-rapidchain-core-server:latest',
          imagePullPolicy: 'Never',
          resources: {
            limits: {
              memory: coreMemory,
              cpu
            }
          },
          env: [
            {
              name: 'SHOULD_REDIRECT_FROM_FAULTY_NODES',
              value: String(SHOULD_REDIRECT_FROM_FAULTY_NODES)
            },
            {
              name: 'COMMITTEE_SUBSET_INDEX',
              value: String(committeeSubnetIndex)
            },
            {
              name: 'BLOCK_THRESHOLD',
              value: String(BLOCK_THRESHOLD)
            },
            {
              name: 'NODE_OPTIONS',
              value: coreNodeOptions
            }
          ],
          ports: [{ containerPort: coreServerPort }]
        }
      ],
      restartPolicy: 'OnFailure'
    }
  },
  {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: 'core-server',
      labels: { app: 'core-server', domain: 'blockchain' }
    },
    spec: {
      clusterIP: 'None',
      selector: {
        app: 'core-server'
      },
      ports: [
        {
          name: coreServerPort.toString(),
          protocol: 'TCP',
          port: coreServerPort,
          targetPort: coreServerPort
        }
      ]
    }
  }
]
fs.writeFileSync(kubeFile, k8sItems.map((item) => yaml.dump(item)).join('---\n'))

// Exclude faulty nodes from JMeter targeting — they accept TX but never commit
// them, so including them introduces random variance based on how many faulty
// ports happen to get high weights. Filtering them out makes results consistent.
const ports = environmentArray
  .filter((environment) => !environment.IS_FAULTY)
  .map((environment) => environment.HTTP_PORT)
const weights = ports.map(() => Math.floor(Math.random() * 10) + 1) // random weight 1-10

const weightedPorts = []
ports.forEach((endpoint, index) => {
  for (let w = 0; w < weights[index]; w++) {
    weightedPorts.push(endpoint)
  }
})

// Write weighted ports to CSV for JMeter
fs.writeFileSync('jmeter_ports.csv', weightedPorts.join('\n'))
