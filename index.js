'use strict'
const { DHT } = require('dht-rpc')
const recordCache = require('record-cache')
const { PeersInput, PeersOutput } = require('./messages')
const { ipv4, ipv4WithLength, local } = require('./peers')
const LRU = require('hashlru')
const { ImmutableStore, MutableStore } = require('./stores')
const guardTimeout = require('guard-timeout')
const DEFAULT_BOOTSTRAP = [
  'bootstrap1.hyperdht.org:49737',
  'bootstrap2.hyperdht.org:49737',
  'hyperswarm.beakerbrowser.com:49737'
]

// 20 mins but will be round(EPH_AFTER + random() * EPH_AFTER / 2), so will be between 20-30 mins
const EPH_AFTER = 1000 * 60 * 20

module.exports = opts => new HyperDHT(opts)

class HyperDHT extends DHT {
  constructor (opts) {
    if (!opts) opts = {}
    if (opts.bootstrap === undefined) opts.bootstrap = DEFAULT_BOOTSTRAP
    super(opts)
    const {
      maxAge = 12 * 60 * 1000,
      maxValues = 5000
    } = opts
    const peers = recordCache({
      maxSize: 65536,
      maxAge
    })
    const onpeers = this._onpeers.bind(this)

    this._peers = peers
    this._store = LRU(maxValues)

    this.mutable = new MutableStore(this, this._store)
    this.immutable = new ImmutableStore(this, this._store)

    this.command('mutable-store', this.mutable._command())
    this.command('immutable-store', this.immutable._command())
    this.command('peers', {
      inputEncoding: PeersInput,
      outputEncoding: PeersOutput,
      update: onpeers,
      query: onpeers
    })
    this.once('close', () => {
      clearTimeout(this._adaptiveTimeout)
      this._peers.destroy()
      this._store.clear()
    })

    this._adaptiveTimeout = null

    if (opts.adaptive) {
      if (this.ephemeral !== true) {
        this.destroy()
        throw Error('adaptive mode can only applied when ephemeral: true')
      }
      this.once('ready', () => {
        this._adaptiveTimeout = guardTimeout(() => {
          const able = this.holepunchable()
          if (able === false) return
          this.persistent((err) => {
            if (err) {
              err.message = `Unable to dynamically become non-ephemeral: ${err.message}`
              this.emit('warning', err)
              return
            }
            this.emit('persistent')
          })
        }, Math.round(EPH_AFTER + Math.random() * EPH_AFTER / 2))
      })
    }
  }

  lookup (key, opts, cb) {
    if (typeof opts === 'function') return this.lookup(key, null, opts)
    if (!opts) opts = {}

    const query = {
      port: opts.port,
      localAddress: local.encode(opts.localAddress),
      includeLength: opts.includeLength || opts.length || typeof opts.length === 'number'
    }

    return this.query('peers', key, query, cb).map(mapPeers.bind(null, query.localAddress))
  }

  announce (key, opts, cb) {
    if (typeof opts === 'function') return this.announce(key, null, opts)
    if (!opts) opts = {}

    const length = typeof opts.length === 'function' ? opts.length(key) : opts.length
    const ann = {
      port: opts.port,
      localAddress: local.encode(opts.localAddress),
      length,
      includeLength: opts.includeLength || typeof length === 'number'
    }

    return this.queryAndUpdate('peers', key, ann, cb).map(mapPeers.bind(null, ann.localAddress))
  }

  unannounce (key, opts, cb) {
    if (typeof opts === 'function') return this.unannounce(key, null, opts)
    if (!opts) opts = {}

    const ann = {
      port: opts.port,
      localAddress: local.encode(opts.localAddress),
      unannounce: true
    }

    this.update('peers', key, ann, cb).map(mapPeers.bind(null, ann.localAddress))
  }

  _onpeers (query, cb) {
    const value = query.value
    const from = {
      port: value.port || query.node.port,
      host: query.node.host,
      length: value.length
    }
    if (!(from.port > 0 && from.port < 65536)) return cb(new Error('Invalid port'))

    const localRecord = value.localAddress
    const remoteRecord = ipv4WithLength.encode(from)

    const remoteCache = query.target.toString('hex')
    const localCache = localRecord &&
      remoteCache + '@local.' + localRecord.slice(0, 2).toString('hex')

    const localSuffix = localRecord && localRecord.slice(2)

    if (query.type === DHT.QUERY) {
      const local = localCache ? filter(this._peers.get(localCache, 32), localSuffix) : []
      const remote = filter(this._peers.get(remoteCache, 50 - 2 * local.length), remoteRecord)
      const includeLength = value.includeLength
      this.emit('lookup', query.target, from)

      return cb(null, {
        peersWithLength: (remote.length && includeLength) ? Buffer.concat(remote) : null,
        peers: (remote.length && !includeLength) ? Buffer.concat(trunc(remote)) : null,
        localPeers: local.length ? Buffer.concat(local) : null
      })
    }
    if (value.unannounce) {
      this._peers.remove(remoteCache, remoteRecord.slice(0, 6))
      if (localRecord) this._peers.remove(localCache, localSuffix)
      this.emit('unannounce', query.target, from)
    } else {
      this._peers.add(remoteCache, remoteRecord.slice(0, 6), remoteRecord)
      if (localRecord) this._peers.add(localCache, localSuffix)
      this.emit('announce', query.target, from)
    }

    cb(null, null)
  }
}

function trunc (list) {
  for (let i = 0; i < list.length; i++) {
    list[i] = list[i].slice(0, 6)
  }
  return list
}

function filter (list, item) {
  for (var i = 0; i < list.length; i++) {
    if (list[i].equals(item)) {
      list[i] = list[list.length - 1]
      list.pop()
      break
    }
  }
  return list
}

function mapPeers (prefix, data) {
  const v = data.value
  if (!v || (!v.peers && !v.localPeers && !v.peersWithLength)) return null
  try {
    return {
      node: data.node,
      to: data.to,
      peers: v.peersWithLength ? ipv4WithLength.decodeAll(v.peersWithLength) : ipv4.decodeAll(v.peers),
      localPeers: prefix && local.decodeAll(prefix, v.localPeers)
    }
  } catch (err) {
    return {
      node: data.node,
      to: data.to,
      peers: [],
      localPeers: prefix && local.decodeAll(prefix, v.localPeers)
    }
  }
}
