import express from 'express'
import bodyparser from 'body-parser'
import { admin } from './firebase-config.js'
import {SimplePool} from 'nostr-tools'
import { verifySignature } from 'nostr-tools'
import { RelayPool } from 'nostr'
import { LRUCache } from 'lru-cache'

import { 
    registerInDatabase, 
    getAllKeys, 
    getAllRelays, 
    getTokensByPubKey, 
    checkIfPubKeyExists, 
    checkIfRelayExists 
} from './database.mjs'

const app = express()
app.use(bodyparser.json())

const port = process.env.PORT || 3000

var relayPool;

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

    register(token, events).then((processed) => {
        res.status(200).send(processed)
    });
})

app.listen(port, () => {
    console.log("Listening to port" + port)
})

// -- registering tokens with pubkeys. 

async function register(token, events) {
    let processed = []

    let newPubKeys = false
    let newRelays = false

    for (const event of events) {
        let veryOk = verifySignature(event)
        
        let tokenTag = event.tags
            .find(tag => tag[0] == "challenge" && tag.length > 1)

        let relayTag = event.tags
            .find(tag => tag[0] == "relay" && tag.length > 1)

        if (tokenTag && veryOk) {
            let keyExist = await checkIfPubKeyExists(event.pubkey)

            if (!keyExist) {
                newPubKeys = true
            }

            let relayExist = await checkIfRelayExists(relayTag[1])
            
            if (!relayExist) {
                newRelays = true
            }

            await registerInDatabase(event.pubkey,relayTag[1],tokenTag[1])
        }    

        processed.push(
            {
                "pubkey": event.pubkey,
                "added": veryOk
            }
        )
    }

    if (newRelays)
        restartRelayPool()
    else if (newPubKeys) {
        restartRelaySubs()
    } 

    return processed
}

// -- notifiying new events to pub keys. 

async function notify(event) {
    if (sentCache.has(event.id)) return

    let pubkeyTag = event.tags.find(tag => tag[0] == "p" && tag.length > 1)
    if (pubkeyTag && pubkeyTag[1]) {
        console.log("New kind", event.kind, "event for", pubkeyTag[1])
        let tokens = await getTokensByPubKey(pubkeyTag[1])

        const message = {
            data: {
                event: JSON.stringify(event),
            },
            tokens: tokens
        };

        sentCache.set(event.id, pubkeyTag[1])

        admin.messaging().sendEachForMulticast(message)
    }
}

var isInRelayPollFunction = false


// -- relay connection
async function restartRelayPool() {
    if (isInRelayPollFunction) return 
    isInRelayPollFunction = true

    if (relayPool) {
        relayPool.close()
    }

    let relays = await getAllRelays()
    let keys = await getAllKeys()

    relayPool = RelayPool( Array.from( relays ), {reconnect: true} )

    relayPool.on('open', relay => {
        relay.subscribe("subid", 
            {
                kinds: [4, 9735],
                since: Math.floor(Date.now() / 1000), 
                "#p": keys
            }
        )
    });
    
    relayPool.on('eose', relay => {
        //console.log("EOSE")
    });
    
    relayPool.on('event', (relay, sub_id, ev) => {
        notify(ev)
    });

    relayPool.on('error', (relay, e) => {
		console.log("Error", relay.url, e.message)
	})

    console.log("Restarted pool with", relays.length, "relays and", keys.length, "keys")
    isInRelayPollFunction = false
}

var isInSubRestartFunction = false

async function restartRelaySubs() {
    if (isInSubRestartFunction) return 
    isInSubRestartFunction = true
    
    let keys = await getAllKeys()

    relayPool.subscribe("subid", 
        {
            kinds: [4, 9735],
            since: Math.floor(Date.now() / 1000), 
            "#p": keys
        }
    );

    console.log("Restarted subs with", keys.length, "keys")
    isInSubRestartFunction = false
}

restartRelayPool()