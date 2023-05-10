import express from 'express'
import bodyparser from 'body-parser'
import { admin } from './firebase-config.js'
import {SimplePool} from 'nostr-tools'
import { verifySignature } from 'nostr-tools'

import { RelayPool } from 'nostr'
import { LRUCache } from 'lru-cache'

const app = express()
app.use(bodyparser.json())

const port = process.env.PORT || 3000

var pool;

var db = new Map();
var relays = new Set();

const sentCache = new LRUCache(
    {
        max: 500,
        maxSize: 5000,
        sizeCalculation: (value, key) => {
            return 1
        },
        // how long to live in ms
        ttl: 1000 * 60 * 5,
    }
)

app.post('/register', (req, res) => {
    const token = req.body.token
    const events = req.body.events

    const processed = register(token, events)

    res.status(200).send(processed)
})

app.listen(port, () => {
    console.log("Listening to port" + port)
})

// -- registering tokens with pubkeys. 

function register(token, events) {
    let processed = []

    let newPubKeys = false
    let newRelays = false

    events.forEach(event => {
        let veryOk = verifySignature(event)
        
        let tokenTag = event.tags
            .find(tag => tag[0] == "challenge" && tag.length > 1)

        let relayTag = event.tags
            .find(tag => tag[0] == "relay" && tag.length > 1)

        if (tokenTag && veryOk) {
            if (db.has(event.pubkey)) {
                let tokens = db.get(event.pubkey)
                if (!tokens.has(tokenTag[1])) {
                    newPubKeys = true 
                    db.set(event.pubkey, tokens.add(tokenTag[1]))
                }
            } else {
                db.set(event.pubkey, new Set().add(tokenTag[1]))
                newPubKeys = true
            }

            if (relayTag && !relays.has(relayTag[1])) {
                newRelays = true
                relays.add(relayTag[1])
            }
        }    

        processed.push(
            {
                "pubkey": event.pubkey,
                "added": veryOk
            }
        )
    });

    if (newRelays)
        restartRelayPool()
    else if (newPubKeys) {
        restartRelaySubs()
    } 

    return processed
}

// -- notifiying new events to pub keys. 

function notify(event) {
    if (sentCache.has(event.id)) return

    let pubkeyTag = event.tags.find(tag => tag[0] == "p" && tag.length > 1)
    if (pubkeyTag && pubkeyTag[1]) {
        console.log("New kind", event.kind, "event for", pubkeyTag[1])
        let tokens = db.get(pubkeyTag[1])

        const message = {
            data: {
                event: JSON.stringify(event),
            },
            tokens: Array.from(tokens)
        };

        sentCache.set(event.id, pubkeyTag[1])

        admin.messaging().sendEachForMulticast(message)
    }
}

// -- relay connection
function restartRelayPool() {
    if (pool) {
        pool.close()
    }

    pool = RelayPool( Array.from( relays ), {reconnect: true} )

    pool.on('open', relay => {
        relay.subscribe("subid", 
            {
                kinds: [4],
                since: Math.floor(Date.now() / 1000), 
                "#p": Array.from( Array.from( db.keys() ) )
            }
        )
    });
    
    pool.on('eose', relay => {
        console.log("EOSE")
    });
    
    pool.on('event', (relay, sub_id, ev) => {
        notify(ev)
    });

    console.log("Restarted pool with", relays.size, "relays and", db.size, "keys")
}

function restartRelaySubs() {
    pool.subscribe("subid", 
        {
            kinds: [4],
            since: Math.floor(Date.now() / 1000), 
            "#p": Array.from( Array.from( db.keys() ) )
        }
    );

    console.log("Restarted subs with", db.size, "keys")
}