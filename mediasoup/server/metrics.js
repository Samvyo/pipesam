// server/metrics.js
const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

// ── Gauges (current state) ─────────────────────────────────────
const workerRoomCount = new client.Gauge({
  name: 'mediasoup_worker_room_count',
  help: 'Rooms per mediasoup worker',
  labelNames: ['worker_index'],
  registers: [register],
});

const activeRooms = new client.Gauge({
  name: 'mediasoup_active_rooms',
  help: 'Total active rooms',
  registers: [register],
});

const activePeers = new client.Gauge({
  name: 'mediasoup_active_peers',
  help: 'Total connected peers across all rooms',
  labelNames: ['room_id'],
  registers: [register],
});

const activeProducers = new client.Gauge({
  name: 'mediasoup_active_producers',
  help: 'Active producers per room and kind',
  labelNames: ['room_id', 'kind'],
  registers: [register],
});

const activeConsumers = new client.Gauge({
  name: 'mediasoup_active_consumers',
  help: 'Active consumers by kind',
  labelNames: ['room_id', 'kind'],
  registers: [register],
});

const activeTransports = new client.Gauge({
  name: 'mediasoup_active_transports',
  help: 'Active WebRTC transports',
  labelNames: ['room_id'],
  registers: [register],
});

// ── Counters (cumulative events) ──────────────────────────────
const peerJoinTotal = new client.Counter({
  name: 'mediasoup_peer_joins_total',
  help: 'Total peer join events',
  registers: [register],
});

const peerLeaveTotal = new client.Counter({
  name: 'mediasoup_peer_leaves_total',
  help: 'Total peer leave events',
  registers: [register],
});

const roomsCreatedTotal = new client.Counter({
  name: 'mediasoup_rooms_created_total',
  help: 'Total rooms ever created',
  registers: [register],
});

const recordingStartTotal = new client.Counter({
  name: 'mediasoup_recordings_started_total',
  help: 'Total recordings started',
  registers: [register],
});

const layerDowngrades = new client.Counter({
  name: 'mediasoup_simulcast_downgrades_total',
  help: 'Simulcast spatial layer downgrades',
  labelNames: ['room_id'],
  registers: [register],
});

const layerUpgrades = new client.Counter({
  name: 'mediasoup_simulcast_upgrades_total',
  help: 'Simulcast spatial layer upgrades',
  labelNames: ['room_id'],
  registers: [register],
});

const videoPauseTotal = new client.Counter({
  name: 'mediasoup_video_pauses_total',
  help: 'Video pauses due to low bandwidth',
  registers: [register],
});

const producerBitrate = new client.Gauge({
  name: 'mediasoup_producer_bitrate_bps',
  help: 'Producer outgoing bitrate',
  labelNames: ['room_id', 'producer_id', 'peer_id', 'kind'],
  registers: [register],
});

const consumerBitrate = new client.Gauge({
  name: 'mediasoup_consumer_bitrate_bps',
  help: 'Consumer incoming bitrate',
  labelNames: ['room_id', 'consumer_id', 'peer_id', 'kind'],
  registers: [register],
});

const consumerScore = new client.Gauge({
  name: 'mediasoup_consumer_score',
  help: 'Consumer quality score',
  labelNames: ['room_id', 'consumer_id', 'peer_id'],
  registers: [register],
});

const transportRecvBitrate = new client.Gauge({
  name: 'mediasoup_transport_recv_bitrate',
  help: 'Transport receive bitrate',
  labelNames: ['room_id', 'direction'],
  registers: [register],
});

const transportSendBitrate = new client.Gauge({
  name: 'mediasoup_transport_send_bitrate',
  help: 'Transport send bitrate',
  labelNames: ['room_id', 'direction'],
  registers: [register],
});

const transportRtt = new client.Gauge({
  name: 'mediasoup_transport_rtt_ms',
  help: 'Transport RTT',
  labelNames: ['room_id', 'peer_id'],
  registers: [register],
});

async function collectRoomMetrics(workerPool, roomManager) {

  // ─────────────────────────────────────────────
  // RESET DYNAMIC METRICS
  // ─────────────────────────────────────────────
  const rooms = [...roomManager.list()];
  producerBitrate.reset();
  consumerBitrate.reset();
  consumerScore.reset();
  transportRecvBitrate.reset();
  transportSendBitrate.reset();
  transportRtt.reset();

  activePeers.reset();
  activeConsumers.reset();
  activeTransports.reset();
  activeProducers.reset();

  // ─────────────────────────────────────────────
  // WORKER METRICS
  // ─────────────────────────────────────────────

  workerPool.workers.forEach((entry, i) => {
    workerRoomCount.set(
      { worker_index: i },
      entry.roomCount
    );
  });

  // const rooms = roomManager.list();

  activeRooms.set(rooms.length);

  let totalAudioProducers = 0;
  let totalVideoProducers = 0;

  // ─────────────────────────────────────────────
  // ROOM LOOP
  // ─────────────────────────────────────────────

  for (const [, room] of rooms) {

    const roomId = room.roomId;

    // ─────────────────────────────────────────
    // ROOM COUNTS
    // ─────────────────────────────────────────

    let roomPeers = room.listPeers().length;

    let roomAudioConsumers = 0;
    let roomVideoConsumers = 0;

    let roomTransportCount = 0;

    // ─────────────────────────────────────────
    // PRODUCERS
    // ─────────────────────────────────────────

    for (const [, entry] of (room.producers || new Map())) {

      if (entry.kind === 'audio') {
        totalAudioProducers++;
      } else {
        totalVideoProducers++;
      }
    }

    // ─────────────────────────────────────────
    // CONSUMERS
    // ─────────────────────────────────────────

    for (const [, consumer] of (room.consumers || new Map())) {

      if (consumer.kind === 'audio') {
        roomAudioConsumers++;
      } else {
        roomVideoConsumers++;
      }
    }

    // ─────────────────────────────────────────
    // TRANSPORTS
    // ─────────────────────────────────────────

    for (const [, peerData] of (room.peersData || new Map())) {

      if (peerData.sendTransport) {
        roomTransportCount++;
      }

      if (peerData.recvTransport) {
        roomTransportCount++;
      }
    }

    // ─────────────────────────────────────────
    // ROOM-WISE METRICS
    // ─────────────────────────────────────────

    activePeers.set(
      { room_id: roomId },
      roomPeers
    );

    activeConsumers.set(
      {
        room_id: roomId,
        kind: 'audio'
      },
      roomAudioConsumers
    );

    activeConsumers.set(
      {
        room_id: roomId,
        kind: 'video'
      },
      roomVideoConsumers
    );

    activeTransports.set(
      { room_id: roomId },
      roomTransportCount
    );
  }

  // ─────────────────────────────────────────────
  // GLOBAL PRODUCER METRICS
  // ─────────────────────────────────────────────


  activeProducers.set(
    { kind: 'audio' },
    totalAudioProducers
  );

  activeProducers.set(
    { kind: 'video' },
    totalVideoProducers
  );

  // ─────────────────────────────────────────────
  // REAL MEDIASOUP STATS
  // ─────────────────────────────────────────────

  for (const [, room] of rooms) {

    // ─────────────────────────────────────────
    // PRODUCER STATS
    // ─────────────────────────────────────────

    for (const [, producerEntry] of (room.producers || new Map())) {

      try {

        const producer =
          producerEntry.producer || producerEntry;

        const stats = await producer.getStats();

        for (const stat of stats) {

          if (stat.type === 'outbound-rtp') {

            producerBitrate.set(
              {
                room_id: room.roomId,
                producer_id: producer.id,
                peer_id:
                  producer.appData?.peerId || 'unknown',
                kind: producer.kind
              },
              stat.bitrate || 0
            );
          }
        }

      } catch (err) {

        console.error(
          'Producer stats error:',
          err.message
        );
      }
    }

    // ─────────────────────────────────────────
    // CONSUMER STATS
    // ─────────────────────────────────────────

    for (const [consumerId, consumer] of (room.consumers || new Map())) {

      try {

        const stats = await consumer.getStats();

        consumerScore.set(
          {
            room_id: room.roomId,
            consumer_id: consumerId,
            peer_id:
              consumer.appData?.consumingPeerId ||
              'unknown'
          },
          consumer.score?.score || 0
        );

        for (const s of stats) {

          if (s.type === 'inbound-rtp') {

            consumerBitrate.set(
              {
                room_id: room.roomId,
                consumer_id: consumerId,
                peer_id:
                  consumer.appData?.consumingPeerId ||
                  'unknown',
                kind: consumer.kind
              },
              s.bitrate || 0
            );
          }
        }

      } catch (e) {

        console.error(
          'Consumer stats error:',
          e.message
        );
      }
    }

    // ─────────────────────────────────────────
    // TRANSPORT STATS
    // ─────────────────────────────────────────

    for (const [peerId, peerData] of (room.peersData || new Map())) {

      for (const dir of ['sendTransport', 'recvTransport']) {

        const transport = peerData[dir];

        if (!transport) continue;

        try {

          const stats = await transport.getStats();

          for (const s of stats) {

            transportSendBitrate.set(
              {
                room_id: room.roomId,
                direction: dir
              },
              s.sendBitrate || 0
            );

            transportRecvBitrate.set(
              {
                room_id: room.roomId,
                direction: dir
              },
              s.recvBitrate || 0
            );

            transportRtt.set(
              {
                room_id: room.roomId,
                peer_id: peerId
              },
              s.rtt || 0
            );
          }

        } catch (e) {}
      }
    }
  }
}


module.exports = {
  register,
  collectRoomMetrics,

  // gauges
  activeRooms,
  activePeers,
  activeConsumers,
  activeTransports,
  activeProducers,

  peerJoinTotal,
  peerLeaveTotal,
  roomsCreatedTotal,
  recordingStartTotal,
  layerDowngrades,
  layerUpgrades,
  videoPauseTotal,

  producerBitrate,
  consumerBitrate,
  consumerScore,
  transportRecvBitrate,
  transportSendBitrate,
  transportRtt,
};